import {
  commitAsUser,
  commitsBetween,
  convoyAuthorEmail,
  currentBranch,
  diffStat,
  dirtyFilesPreview,
  findSuspiciousStagedFiles,
  isAncestor,
  mergeBase,
  resetSoft,
  resolveCommit,
  statusPorcelain,
  updateRef,
  upstreamRef,
  type CommitInfo,
} from "./git"

/**
 * Close's squash primitives (capability feature-close): resolve the
 * authorship-anchored range of convoy commits on a feature branch and collapse
 * it into one operator-authored commit. This is retained for `convoy close`
 * only — the manual finish command and the dashboard's finish seam are removed
 * (capability run-finalization, design D5), and close's own replacement, the
 * true squash landing, will retire this authorship walk entirely.
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
 * the run-linked commits from human review gates. Multiline bodies and
 * `Convoy-Run` trailers do not participate in the walk — it reads subjects
 * only — so run-linked step commits select exactly like legacy one-liners.
 * Walking back from HEAD while that holds therefore captures exactly this
 * run's work, and stops dead at the first commit the user wrote themselves —
 * their history is never rewritten.
 *
 * The merge-base with the run's base ref floors the walk, which is what keeps a
 * repo convoy bootstrapped itself (whose root commit is authored by convoy)
 * from having its root swallowed.
 */
export async function resolveSquashRange(cwd: string, baseRef: string, options: { extraSquashable?: (commit: CommitInfo) => boolean } = {}): Promise<SquashRange> {
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
    // `extraSquashable` lets a caller fold in specific user-identity commits
    // it created itself (close's archive commit) without weakening the rule
    // for anything the operator wrote.
    if (commit.authorEmail !== convoyAuthorEmail && !options.extraSquashable?.(commit)) {
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
