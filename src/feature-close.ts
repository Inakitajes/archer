import { stat } from "node:fs/promises"
import { join } from "node:path"

import {
  commitAsUser,
  convoyAuthorEmail,
  currentBranch,
  detectBaseRef,
  diffStat,
  execFile,
  findWorktreeDirForBranch,
  isAncestor,
  mainWorktreeDir,
  mergeBase,
  resolveCommit,
  statusPorcelain,
  type CommitInfo,
} from "./git"
import { branchIdFromBranch, isOpenSpecChangeId, openspecDirName } from "./openspec"
import { applySquash, resolveSquashRange, type SquashRange } from "./finish"
import { listRuns } from "./runs"

/**
 * `convoy close` — the death of a feature, one resumable sequence (capability
 * `feature-close`, design D5): preflight → sync (merge the base branch into
 * the feature branch) → archive (through the OpenSpec CLI, the tool that owns
 * that state) → squash (the same authorship-anchored walk `convoy finish`
 * uses) → merge into the base branch from the main checkout. Each step checks
 * its own precondition, so `close --resume` after a mid-sequence stop — a
 * conflicting sync, a manual archive — continues from the first incomplete
 * step without redoing completed ones. Push, branch delete, and worktree
 * removal are offered separately and never happen automatically.
 */

export type CloseInput = {
  /** The repo (used to detect the base branch and reach the main checkout). */
  targetDir: string
  /** The feature worktree; resolved from `branch` or the current directory when omitted. */
  worktreeDir?: string
  /** The feature branch; defaults to the worktree's checked-out branch. */
  branch?: string
  /** The change to archive; defaults to the branch's change id (the shared resolver rule). */
  changeID?: string
  /** Continue a previously stopped sequence: completed steps are detected, not repeated. */
  resume?: boolean
  /** Override for the squashed conventional commit's subject. */
  message?: string
}

export type ClosePreflightBlocker = {
  check: "clean-tree" | "tasks" | "live-run"
  message: string
}

export type CloseStop = {
  /** The step the sequence stopped at, so --resume knows where to pick up. */
  step: "sync" | "archive" | "squash" | "merge"
  message: string
}

export type CloseResult = {
  changeID: string
  branch: string
  worktreeDir: string
  baseRef: string
  /** The squash outcome; skipped when the branch carried no convoy commits. */
  squashed?: { sha: string; replaced: number }
  merged: boolean
}

export type CloseTarget = {
  worktreeDir: string
  branch: string
  changeID: string
}

/**
 * Resolves the feature the close sequence operates on. Explicit worktree and
 * branch (the board's handoff) win; a bare `--branch` resolves its worktree
 * from the repo's worktree list (the same lookup `finish --branch` uses);
 * running inside the worktree is enough on its own. The change id follows the
 * shared branch↔change rule unless `--change` pins it.
 */
export async function resolveCloseTarget(input: CloseInput): Promise<CloseTarget> {
  const { targetDir } = input
  let worktreeDir = input.worktreeDir
  let branch = input.branch

  if (!worktreeDir && branch) worktreeDir = (await findWorktreeDirForBranch(branch, targetDir)) ?? undefined
  if (!worktreeDir) {
    // Running inside the feature worktree is the natural `convoy close` cwd.
    const main = await mainWorktreeDir(targetDir).catch(() => undefined)
    if (main && (await resolveSame(main, targetDir)) === false) {
      worktreeDir = targetDir
    }
  }
  if (!worktreeDir) {
    throw new Error(
      "couldn't locate the feature worktree: pass --branch <name>, run inside the worktree, or continue from the control board's row action",
    )
  }

  if (!branch) branch = await currentBranch(worktreeDir)
  if (!branch) throw new Error(`the worktree at ${worktreeDir} has a detached HEAD; check out the feature branch first`)

  const changeID = input.changeID ?? branchIdFromBranch(branch)
  if (!changeID || !isOpenSpecChangeId(changeID)) {
    throw new Error(`branch "${branch}" carries no change id (expected <type>/<change-id>); pass --change <id>`)
  }
  return { worktreeDir, branch, changeID }
}

async function resolveSame(a: string, b: string): Promise<boolean> {
  try {
    const { realpath } = await import("node:fs/promises")
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return a === b
  }
}

/**
 * The three blocking preflight conditions, each with its concrete remediation.
 * Returned (not thrown) so the caller can print them all at once; an empty
 * list means the sequence may start.
 */
export async function closePreflight(input: CloseInput, target: CloseTarget): Promise<ClosePreflightBlocker[]> {
  const blockers: ClosePreflightBlocker[] = []

  // Fail closed: a git status that cannot be read must not be read as "clean",
  // because the sequence that follows rewrites history (squash) and merges it
  // onto the base. If we cannot verify the tree, we refuse (SC-6).
  let porcelain: string
  try {
    porcelain = await statusPorcelain(target.worktreeDir)
  } catch (error) {
    porcelain = ""
    blockers.push({
      check: "clean-tree",
      message: `couldn't verify the worktree at ${target.worktreeDir} is clean (${error instanceof Error ? error.message : error}) — refusing to rewrite history under an unverifiable tree`,
    })
  }
  if (porcelain.trim() !== "") {
    blockers.push({ check: "clean-tree", message: `the worktree at ${target.worktreeDir} has uncommitted changes — commit or stash them first` })
  }

  const { openspecTaskCounts } = await import("./control-board")
  // An already-archived change (a resumed sequence) has no task list to
  // check — its precondition was satisfied and archived away with the change.
  const changeStillPresent = await exists(join(target.worktreeDir, openspecDirName, "changes", target.changeID))
  if (changeStillPresent) {
    const tasks = (await openspecTaskCounts(target.worktreeDir)).get(target.changeID)
    if (!tasks || tasks.total === 0) {
      blockers.push({ check: "tasks", message: `no task list found for change ${target.changeID}; finish the tasks before closing` })
    } else if (tasks.done < tasks.total) {
      blockers.push({ check: "tasks", message: `${tasks.total - tasks.done} of ${tasks.total} tasks are incomplete — finish them before closing` })
    }
  }

  let liveCount = 0
  try {
    const runs = await listRuns()
    // Compare by resolved physical path: the worktree dir recorded in a run
    // plan and the one resolved from `git worktree list` can differ textually
    // (/var vs /private/var on macOS) while naming the same checkout — a raw
    // string comparison would let a live agent be missed (SC-6).
    for (const run of runs) {
      if (run.live && run.targetDir && (await resolveSame(run.targetDir, target.worktreeDir))) liveCount += 1
    }
  } catch (error) {
    blockers.push({
      check: "live-run",
      message: `couldn't verify no live run is attached to ${target.branch} (${error instanceof Error ? error.message : error}) — refusing while run state is unreadable`,
    })
  }
  if (liveCount > 0) {
    blockers.push({ check: "live-run", message: `${liveCount} live run${liveCount === 1 ? " is" : "s are"} attached to ${target.branch} — wait for or stop ${liveCount === 1 ? "it" : "them"} first` })
  }

  return blockers
}

/**
 * The full closing sequence. Throws `Error` on every stop (preflight
 * blockers, sync conflict, archive failure, merge conflict); the error
 * message names the step and the remediation, and `close --resume` picks up
 * from the first incomplete step.
 */
export async function runClose(input: CloseInput): Promise<CloseResult> {
  const target = await resolveCloseTarget(input)
  const baseRef = await closeBaseRef(input.targetDir)

  // Preflight: refuse to touch anything until the feature is ready to close.
  const blockers = await closePreflight(input, target)
  if (blockers.length > 0) {
    throw new Error(`close preflight failed:\n  ${blockers.map((blocker) => blocker.message).join("\n  ")}`)
  }

  // Sync: bring the base branch's tip in before archiving, so the canonical
  // specs the archive produces land against a fresh base.
  let syncMergeSha: string | undefined
  if (!(await isAncestor(baseRef, target.branch, target.worktreeDir))) {
    const merge = await execFile("git", ["merge", "--no-edit", baseRef], { cwd: target.worktreeDir, allowFailure: true })
    if (merge.exitCode !== 0) {
      throw new Error(
        `sync: merging ${baseRef} into ${target.branch} conflicted — resolve the conflicts and commit inside the worktree, then run \`convoy close --resume\`\n${merge.stderr || merge.stdout}`,
      )
    }
    // The clean sync just wrote an operator-identity merge commit. The squash
    // below must fold it (plus the convoy commits beneath it) into the one
    // conventional commit, or the raw `convoy(...)` steps leak onto the base
    // branch unchanged.
    syncMergeSha = (await resolveCommit("HEAD", target.worktreeDir)) ?? undefined
  }

  // Archive: through the OpenSpec CLI only — convoy never edits openspec/.
  const changeDir = join(target.worktreeDir, openspecDirName, "changes", target.changeID)
  if (await exists(changeDir)) {
    const archive = await execFile("openspec", ["archive", target.changeID, "--yes"], { cwd: target.worktreeDir, allowFailure: true })
    if (archive.exitCode !== 0) {
      throw new Error(
        `archive: openspec archive ${target.changeID} failed — the sequence stops before any squash or merge\n${archive.stderr || archive.stdout}`,
      )
    }
    // The archive result is committed on the feature branch under the
    // operator's identity (staged explicitly; commitAsUser adds nothing).
    await execFile("git", ["add", openspecDirName], { cwd: target.worktreeDir })
    await commitAsUser(`chore(openspec): archive ${target.changeID}`, target.worktreeDir)
  }

  // Squash: the same authorship-anchored walk `convoy finish` uses, so the
  // operator's own commits (the proposal commit) survive while convoy's — and
  // close's own archive commit, made under the operator identity — collapse
  // into one conventional commit. A branch with no convoy commits skips the
  // squash and merges as-is.
  const archiveSubject = `chore(openspec): archive ${target.changeID}`
  let squashed: CloseResult["squashed"]
  if (syncMergeSha) {
    // A clean sync left a merge commit on the branch that resolveSquashRange's
    // authorship-anchored walk would stop dead at (it's operator-identity and
    // never extraSquashable), farming the merge *and* the raw convoy commits
    // onto the base. Walk the first-parent line instead — the base side of
    // the merge lives on the second parent and never enters it — folding the
    // sync merge, the archive commit, and every convoy commit down to the
    // operator's own proposal commit, which survives.
    const range = await closeSyncSquashRange(target.worktreeDir, baseRef, { syncMergeSha, archiveSubject })
    if (range.ok) {
      const message = input.message ?? `${branchPrefix(target.branch)}: ${target.changeID}`
      const result = await applySquash({ cwd: target.worktreeDir, plan: range, message })
      squashed = { sha: result.sha, replaced: result.replaced }
    } else if (range.reason !== "no-commits") {
      throw new Error(`squash: ${range.message}`)
    }
  } else {
    const range = await resolveSquashRange(target.worktreeDir, baseRef, {
      extraSquashable: (commit) => commit.subject === archiveSubject,
    })
    if (range.ok) {
      const message = input.message ?? `${branchPrefix(target.branch)}: ${target.changeID}`
      const result = await applySquash({ cwd: target.worktreeDir, plan: range, message })
      squashed = { sha: result.sha, replaced: result.replaced }
    } else if (range.reason !== "no-commits") {
      throw new Error(`squash: ${range.message}`)
    }
  }

  // Merge: into the base branch from the main checkout. The main checkout
  // must already sit on the base branch and be clean — close never moves the
  // operator's own checkout out from under them.
  const mainDir = (await mainWorktreeDir(input.targetDir)) ?? input.targetDir
  const mainBranch = await currentBranch(mainDir)
  if (mainBranch !== baseRef) {
    throw new Error(`merge: the main checkout is on ${mainBranch ?? "a detached HEAD"}, not ${baseRef} — check out ${baseRef} there, then run \`convoy close --resume\``)
  }
  const mainStatus = await statusPorcelain(mainDir).catch(() => "dirty")
  if (mainStatus.trim() !== "") {
    throw new Error(`merge: the main checkout has uncommitted changes — commit or stash them first, then run \`convoy close --resume\``)
  }
  const merge = await execFile("git", ["merge", "--no-edit", target.branch], { cwd: mainDir, allowFailure: true })
  if (merge.exitCode !== 0) {
    throw new Error(`merge: merging ${target.branch} into ${baseRef} failed — resolve in the main checkout, then run \`convoy close --resume\`\n${merge.stderr || merge.stdout}`)
  }

  return {
    changeID: target.changeID,
    branch: target.branch,
    worktreeDir: target.worktreeDir,
    baseRef,
    ...(squashed ? { squashed } : {}),
    merged: true,
  }
}

/**
 * The remediation for a probably-merged-but-unarchived change: archive in the
 * main checkout, commit on the base branch, and nothing else — there is
 * nothing left to sync, squash, or merge (design D6).
 */
export async function archiveChangeOnMain(input: { targetDir: string; changeID: string }): Promise<{ committed: boolean }> {
  const { changeID } = input
  // Archive always lands on the base branch's checkout — the repo's main
  // worktree, not whatever directory the board happened to be launched from.
  // Opening `convoy control` inside a feature worktree (a supported scenario)
  // must not archive and commit on that feature branch instead (SC-4).
  const targetDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir

  const status = await statusPorcelain(targetDir).catch(() => "dirty" as const)
  if (status.trim() !== "") {
    throw new Error("archive on main: the checkout has uncommitted changes — commit or stash them first")
  }

  const changeDir = join(targetDir, openspecDirName, "changes", changeID)
  if (!(await exists(changeDir))) {
    throw new Error(`archive on main: change ${changeID} is not present under ${openspecDirName}/changes/ — nothing to archive`)
  }

  const archive = await execFile("openspec", ["archive", changeID, "--yes"], { cwd: targetDir, allowFailure: true })
  if (archive.exitCode !== 0) {
    throw new Error(`archive on main: openspec archive ${changeID} failed\n${archive.stderr || archive.stdout}`)
  }

  await execFile("git", ["add", openspecDirName], { cwd: targetDir })
  const staged = await execFile("git", ["diff", "--cached", "--quiet"], { cwd: targetDir, allowFailure: true })
  if (staged.exitCode === 0) {
    return { committed: false }
  }
  await commitAsUser(`chore(openspec): archive ${changeID}`, targetDir)
  return { committed: true }
}

/** The base ref the close sequence syncs and merges against. */
export async function closeBaseRef(targetDir: string): Promise<string> {
  const mainDir = (await mainWorktreeDir(targetDir).catch(() => undefined)) ?? targetDir
  const detected = await detectBaseRef(mainDir).catch(() => undefined)
  return detected?.ref ?? "HEAD"
}

/** The conventional type the squash commit inherits from the branch's own prefix. */
function branchPrefix(branch: string): string {
  const slash = branch.indexOf("/")
  const prefix = slash === -1 ? "" : branch.slice(0, slash)
  return /^(feat|fix|refactor|perf|docs|test|chore|build|ci|change)$/.test(prefix) ? prefix : "feat"
}

/**
 * The squash range for a branch that just cleanly synced — the one
 * `resolveSquashRange` can't serve, because its `commitsBetween` walk crosses
 * the sync merge's second parent and stops at the operator-identity merge
 * commit, leaving the merge and the raw convoy commits unsquashed. This walks
 * the first-parent line instead (the base side of the merge never appears on
 * it) and folds everything from the operator's own proposal commit up through
 * the sync merge, the archive commit, and convoy's step commits into one
 * conventional commit (design D5: operator commits survive, convoy's collapse).
 */
async function closeSyncSquashRange(
  cwd: string,
  baseRef: string,
  opts: { syncMergeSha: string; archiveSubject: string },
): Promise<SquashRange> {
  const branch = await currentBranch(cwd)
  if (!branch) {
    return { ok: false, reason: "detached", message: "HEAD is detached; check out the feature branch before closing it" }
  }

  const head = (await resolveCommit("HEAD", cwd)) ?? ""
  if (!head) return { ok: false, reason: "no-commits", message: "this branch has no commits yet" }

  const firstParent = await firstParentLog(head, cwd)
  const floor = (await mergeBase(baseRef, "HEAD", cwd)) ?? ""

  const isFoldable = (commit: CommitInfo) =>
    commit.sha === opts.syncMergeSha || commit.authorEmail === convoyAuthorEmail || commit.subject === opts.archiveSubject

  const commits: CommitInfo[] = []
  let anchor: string | undefined
  for (const commit of firstParent) {
    if (commit.sha === floor) {
      // Never descend below the branch's fork from the base.
      anchor = commit.sha
      break
    }
    if (isFoldable(commit)) {
      commits.push(commit)
      continue
    }
    // The operator's own commit — the surviving proposal commit.
    anchor = commit.sha
    break
  }
  if (!anchor) anchor = floor

  if (commits.length === 0) {
    return { ok: false, reason: "no-commits", message: `nothing to squash above the operator's commit` }
  }
  if (!anchor) {
    return { ok: false, reason: "no-base", message: `couldn't find a commit to squash onto (no merge-base with "${baseRef}")` }
  }

  return { ok: true, branch, base: anchor, head, commits, diffStat: await diffStat(anchor, head, cwd) }
}

/** The branch's first-parent history, newest first — base-side commits from a sync merge never appear. */
async function firstParentLog(head: string, cwd: string): Promise<CommitInfo[]> {
  const result = await execFile("git", ["log", "--first-parent", "--format=%H%x1f%ae%x1f%s", head], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", authorEmail = "", ...rest] = line.split("\x1f")
      return { sha, authorEmail, subject: rest.join("\x1f") }
    })
    .filter((commit) => commit.sha !== "")
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
