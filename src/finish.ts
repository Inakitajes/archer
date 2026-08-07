import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  commitAsUser,
  commitsBetween,
  convoyAuthorEmail,
  currentBranch,
  detectBaseRef,
  diffStat,
  dirtyFilesPreview,
  findSuspiciousStagedFiles,
  isAncestor,
  mainWorktreeDir,
  mergeBase,
  pushBranch,
  resetSoft,
  resolveCommit,
  statusPorcelain,
  updateRef,
  upstreamRef,
  type CommitInfo,
} from "./git"
import { proposeCommitMessage, type ConventionalMessage } from "./commit-message"
import type { FinishSeam } from "./progress"
import { listRuns } from "./runs"

/**
 * Closing a run: collapse the per-step commits convoy made on this branch into
 * one conventional commit created by the user, so the branch lands in history
 * semantic and signed instead of as a stack of "convoy(security): Security
 * audit" machine commits.
 */

/** Why a branch can't be squashed. Each maps to a message the UI shows verbatim. */
export type SquashBlockReason = "detached" | "dirty" | "no-commits" | "no-base" | "already-pushed"

export type SquashPlan = {
  branch: string
  /** Commit the branch resets to; the squashed commit is written on top of it. */
  base: string
  /** Branch tip at planning time, stashed as the backup ref before the rewrite. */
  head: string
  /** The convoy commits to be replaced, newest first. */
  commits: CommitInfo[]
  /** The user's own commit the walk stopped at, when one interrupted the convoy run. */
  stoppedAt?: CommitInfo
  diffStat: string
}

export type SquashRange = ({ ok: true } & SquashPlan) | { ok: false; reason: SquashBlockReason; message: string }

export type SquashResult = {
  /** The squashed commit. */
  sha: string
  branch: string
  /** Ref holding the pre-squash tip, so the rewrite stays undoable. */
  backupRef: string
  replaced: number
}

export function backupRefFor(branch: string) {
  return `refs/convoy/finish/${branch}`
}

/**
 * Works out which commits `finish` would replace.
 *
 * The range is anchored on authorship rather than on state persisted at run
 * time: agents are denied `git commit` outright (see bash-policy), so every
 * commit convoy is responsible for carries the convoy@local identity, including
 * the "apply manual iteration" commits from human review gates. Walking back
 * from HEAD while that holds therefore captures exactly this run's work, and
 * stops dead at the first commit the user wrote themselves — their history is
 * never rewritten.
 *
 * The merge-base with the run's base ref floors the walk, which is what keeps a
 * repo convoy bootstrapped itself (whose root commit is authored by convoy)
 * from having its root swallowed.
 */
export async function resolveSquashRange(cwd: string, baseRef: string): Promise<SquashRange> {
  const branch = await currentBranch(cwd)
  if (!branch) {
    return { ok: false, reason: "detached", message: "HEAD is detached; check out the run's branch before finishing it" }
  }

  const porcelain = await statusPorcelain(cwd)
  if (porcelain.trim() !== "") {
    return {
      ok: false,
      reason: "dirty",
      message: `the working tree has uncommitted changes; commit or stash them first\n${dirtyFilesPreview(porcelain)}`,
    }
  }

  const head = await resolveCommit("HEAD", cwd)
  if (!head) return { ok: false, reason: "no-commits", message: "this branch has no commits yet" }

  const floor = await mergeBase(baseRef, "HEAD", cwd)
  const history = await commitsBetween(floor ?? "", head, cwd)

  const commits: CommitInfo[] = []
  let stoppedAt: CommitInfo | undefined
  for (const commit of history) {
    if (commit.authorEmail !== convoyAuthorEmail) {
      stoppedAt = commit
      break
    }
    commits.push(commit)
  }

  if (commits.length === 0) {
    return { ok: false, reason: "no-commits", message: `nothing to squash: no convoy commits on ${branch} above ${baseRef}` }
  }

  // Reset target: the user's commit the walk stopped at, or the merge-base when
  // the whole range is convoy's. Using a commit that exists (never `<sha>^`)
  // means a convoy-authored root commit simply has no base and is refused,
  // rather than failing mid-rewrite.
  const base = stoppedAt?.sha ?? floor
  if (!base) {
    return {
      ok: false,
      reason: "no-base",
      message: `couldn't find a commit to squash onto (no merge-base with "${baseRef}"); pass an explicit base ref`,
    }
  }

  const upstream = await upstreamRef(cwd)
  const oldest = commits[commits.length - 1]!
  if (upstream && (await isAncestor(oldest.sha, upstream, cwd))) {
    return {
      ok: false,
      reason: "already-pushed",
      message: `these commits are already on ${upstream}; squashing them now would need a force-push, so convoy won't rewrite them`,
    }
  }

  return { ok: true, branch, base, head, commits, ...(stoppedAt ? { stoppedAt } : {}), diffStat: await diffStat(base, head, cwd) }
}

export type ApplySquashInput = {
  cwd: string
  plan: SquashPlan
  message: string
  /** Forces `-S` when the user signs deliberately rather than via commit.gpgsign. */
  sign?: boolean
  /** Skips hooks; they already ran on each step commit being replaced. */
  noVerify?: boolean
  /** Opens the user's editor on the message before committing. */
  edit?: boolean
}

/**
 * Rewrites the branch as one commit. The pre-squash tip is stashed under
 * refs/convoy/finish/<branch> first, so the whole operation stays undoable, and
 * a commit that fails (declined signature, rejected hook, emptied editor)
 * restores the branch instead of leaving it reset halfway.
 */
export async function applySquash(input: ApplySquashInput): Promise<SquashResult> {
  const { cwd, plan } = input
  const backupRef = backupRefFor(plan.branch)
  await updateRef(backupRef, plan.head, cwd)
  await resetSoft(plan.base, cwd)

  // Scan staged files for secrets before committing, matching the same
  // protection addAllAndCommit provides (git.ts:277-283). The squash commit
  // would otherwise be the one path that bypasses secret scanning.
  const squashStatus = await statusPorcelain(cwd)
  const suspicious = findSuspiciousStagedFiles(squashStatus)
  if (suspicious.length > 0) {
    // Restore the branch to the pre-squash state so the user can investigate.
    await resetSoft(plan.head, cwd)
    throw new Error(
      `refusing to squash: the following files look like they contain secrets: ${suspicious.join(", ")}. ` +
        `Add them to .gitignore (or remove them) and re-run \`convoy finish\`.`,
    )
  }

  try {
    await commitAsUser(input.message, cwd, {
      ...(input.sign ? { sign: true } : {}),
      ...(input.edit ? { edit: true } : {}),
      ...(input.noVerify ? { noVerify: true } : {}),
    })
  } catch (error) {
    await resetSoft(plan.head, cwd)
    throw error
  }

  const sha = (await resolveCommit("HEAD", cwd)) ?? plan.head
  return { sha, branch: plan.branch, backupRef, replaced: plan.commits.length }
}

export type FinishContext = {
  /** The worktree/repo holding the run's branch. */
  cwd: string
  baseRef: string
  /** Run workspace, when the caller has it; otherwise it is discovered from the run history. */
  runDir?: string
  commitMessageModel?: string
  signal?: AbortSignal
}

export type FinishPreparation =
  | { ok: false; reason: SquashBlockReason; message: string }
  | {
      ok: true
      plan: SquashPlan
      message: ConventionalMessage
      messageSource: "model" | "template"
      /** Set when the writing model failed and the message is the deterministic fallback. */
      messageError?: string
    }

/**
 * Everything `finish` needs before it can ask the user to confirm: the commits
 * it would replace, and a proposed message for the one that replaces them.
 * Shared by `convoy finish` and the dashboard's finish screen so both offer
 * exactly the same operation.
 */
export async function prepareFinish(context: FinishContext): Promise<FinishPreparation> {
  const range = await resolveSquashRange(context.cwd, context.baseRef)
  if (!range.ok) return range

  const { ok: _ok, ...plan } = range
  const runDir = context.runDir ?? (await findRunDir(context.cwd))
  const [summary, prompt] = await Promise.all([readRunFile(runDir, "SUMMARY.md"), readRunFile(runDir, "prd.md")])

  const proposal = await proposeCommitMessage({
    targetDir: context.cwd,
    branch: plan.branch,
    commits: plan.commits.map((commit) => commit.subject),
    diffStat: plan.diffStat,
    ...(summary ? { summary } : {}),
    ...(prompt ? { prompt } : {}),
    ...(context.commitMessageModel ? { model: context.commitMessageModel } : {}),
    ...(context.signal ? { signal: context.signal } : {}),
  })

  return {
    ok: true,
    plan,
    message: proposal.message,
    messageSource: proposal.source,
    ...(proposal.error ? { messageError: proposal.error } : {}),
  }
}

/** The newest run recorded against this directory, so a standalone `convoy finish` still finds its reports. */
async function findRunDir(cwd: string): Promise<string | undefined> {
  try {
    const runs = await listRuns()
    return runs.find((run) => run.targetDir === cwd)?.dir
  } catch {
    return undefined
  }
}

async function readRunFile(runDir: string | undefined, name: string): Promise<string | undefined> {
  if (!runDir) return undefined
  try {
    return await readFile(join(runDir, name), "utf8")
  } catch {
    return undefined
  }
}

/**
 * Wires `finish` up for the run dashboard's [f]. Everything git- and
 * model-shaped stays on this side, so tui.ts only ever sees plain data — the
 * same seam the launcher uses for branch naming.
 */
export function createFinishSeam(input: { cwd: string; baseRef?: string; runDir?: string }): FinishSeam {
  let plan: SquashPlan | undefined

  return {
    async prepare() {
      const { loadMergedConvoyConfig } = await import("./config")
      const config = await loadMergedConvoyConfig(input.cwd)
      const prepared = await prepareFinish({
        cwd: input.cwd,
        baseRef: input.baseRef ?? (await resolveFinishBase(input.cwd, config?.defaults.baseRef)),
        ...(input.runDir ? { runDir: input.runDir } : {}),
        ...(config?.defaults.commitMessageModel ? { commitMessageModel: config.defaults.commitMessageModel } : {}),
      })
      if (!prepared.ok) return { ok: false, message: prepared.message }

      plan = prepared.plan
      const notes: string[] = []
      if (prepared.plan.stoppedAt) {
        notes.push(`stops at ${prepared.plan.stoppedAt.sha.slice(0, 8)} "${prepared.plan.stoppedAt.subject}" — your own commit, left untouched`)
      }
      if (prepared.messageError) notes.push("the writing model failed; this message is derived from the branch and the step commits")

      return {
        ok: true as const,
        proposal: {
          branch: prepared.plan.branch,
          commitCount: prepared.plan.commits.length,
          subject: formatSubject(prepared.message),
          body: prepared.message.body,
          notes,
        },
      }
    },

    async apply(message) {
      if (!plan) throw new Error("finish was applied before it was prepared")
      const result = await applySquash({ cwd: input.cwd, plan, message: joinMessage(message) })
      // The branch has been rewritten; a second apply would squash the commit
      // it just made onto the base again.
      plan = undefined
      return result
    },

    async edit(message) {
      return await editMessageInEditor(joinMessage(message))
    },

    async push(branch) {
      await pushBranch(branch, defaultRemote, input.cwd)
    },

    canOpenPullRequest,

    async openPullRequest(message) {
      await openPullRequest(input.cwd, message)
    },
  }
}

export const defaultRemote = "origin"

/** A PR needs the GitHub CLI; without it the offer is never made rather than failing at the prompt. */
export function canOpenPullRequest(): boolean {
  return Boolean(Bun.which("gh"))
}

export async function openPullRequest(cwd: string, message: { subject: string; body: string[] }) {
  const body = message.body.map((line) => `- ${line}`).join("\n")
  const proc = Bun.spawn(["gh", "pr", "create", "--title", message.subject, "--body", body], {
    cwd,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  })
  if ((await proc.exited) !== 0) throw new Error("gh pr create didn't complete")
}

/**
 * The base must be detected in the main checkout: inside a worktree the
 * current-branch fallback would answer with the run's own branch, which would
 * floor the squash at HEAD and find nothing to do.
 */
export async function resolveFinishBase(cwd: string, configured?: string): Promise<string> {
  if (configured) return configured
  const detectionDir = (await mainWorktreeDir(cwd)) ?? cwd
  const detected = await detectBaseRef(detectionDir)
  return detected?.ref ?? "HEAD"
}

function formatSubject(message: ConventionalMessage): string {
  return `${message.type}${message.scope ? `(${message.scope})` : ""}: ${message.subject}`
}

function joinMessage(message: { subject: string; body: string[] }): string {
  if (message.body.length === 0) return message.subject
  return `${message.subject}\n\n${message.body.map((line) => `- ${line}`).join("\n")}`
}

/**
 * Hands the whole message to $EDITOR, because a multi-line body can't be edited
 * in the modal's one-line field. Returns undefined when the user emptied the
 * file, which is git's own "abort the commit" convention.
 */
export async function editMessageInEditor(message: string): Promise<{ subject: string; body: string[] } | undefined> {
  const { mkdtemp, readFile: read, rm, writeFile } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")

  const dir = await mkdtemp(join(tmpdir(), "convoy-finish-"))
  const path = join(dir, "COMMIT_EDITMSG")
  try {
    await writeFile(path, `${message}\n\n# Lines starting with '#' are ignored.\n# An empty message cancels the commit.\n`)
    const editor = process.env.GIT_EDITOR || process.env.VISUAL || process.env.EDITOR || "vi"
    const proc = Bun.spawn(["sh", "-c", `${editor} "$1"`, "sh", path], { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env })
    if ((await proc.exited) !== 0) return undefined
    return parseMessage(await read(path, "utf8"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Splits an edited message back into subject + body, dropping git's comment lines. */
export function parseMessage(raw: string): { subject: string; body: string[] } | undefined {
  const lines = raw
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .map((line) => line.trimEnd())
  const subject = lines.find((line) => line.trim())?.trim() ?? ""
  if (!subject) return undefined
  const rest = lines.slice(lines.findIndex((line) => line.trim()) + 1)
  const body = rest.map((line) => line.trim().replace(/^[-*]\s*/, "")).filter(Boolean)
  return { subject, body }
}

/** Human-readable "what would happen", shared by the CLI print and the TUI modal. */
export function describeSquashPlan(plan: SquashPlan): string[] {
  const lines = [`${plan.commits.length} convoy commit${plan.commits.length === 1 ? "" : "s"} on ${plan.branch} → 1`]
  for (const commit of plan.commits) lines.push(`  ${commit.sha.slice(0, 8)} ${commit.subject}`)
  if (plan.stoppedAt) {
    lines.push(`  stops at ${plan.stoppedAt.sha.slice(0, 8)} (${plan.stoppedAt.subject}) — your own commit, left untouched`)
  }
  return lines
}
