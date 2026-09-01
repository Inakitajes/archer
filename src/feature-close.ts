import { readdir, readFile, stat } from "node:fs/promises"
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
import {
  closeFallbackCommitMessage,
  formatCommitMessage,
  normalizeComposedMessage,
  proposeCommitMessage,
  type CommitMessageProposal,
} from "./commit-message"
import { stripControlBytes } from "./commit-text"
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
 *
 * The sequence narrates itself through one-way `CloseEvent`s (design D3) and
 * gates the squashed commit behind a separate `resolveMessage` resolver, so
 * the TTY checklist and the headless formatter consume the same stream.
 */

export type CloseStep = "sync" | "archive" | "squash" | "merge"

/**
 * The squash step's typed sub-phases (design D1): stable identifiers the
 * renderers map to their own copy, so semantic operation state stays in the
 * orchestrator instead of being inferred from which renderer is waiting.
 */
export type CloseSquashPhase = "composing-message" | "awaiting-message-review" | "creating-commit"

/** How the feature branch landed on the base branch (design D5: derived from git state, narrated). */
export type CloseMergeShape = "fast-forward" | "merge-commit" | "already-up-to-date"

export type CloseEvent =
  | { type: "preflight"; summary: string }
  | { type: "preflight-failed"; blockers: readonly ClosePreflightBlocker[] }
  | { type: "step-started"; step: CloseStep }
  | { type: "step-completed"; step: CloseStep; detail?: string }
  | { type: "step-skipped"; step: CloseStep; reason: string }
  | { type: "step-failed"; step: CloseStep; message: string }
  | { type: "squash-phase"; phase: CloseSquashPhase }
  | { type: "merge-shape"; shape: CloseMergeShape }
  | { type: "result"; result: CloseResult }

/** What the message gate hands the operator: the normalized proposal, and where it came from. */
export type CloseMessageProposal = {
  message: string
  source: "model" | "fallback"
  /** Set when the writing model failed and the message is the deterministic fallback. */
  error?: string
}

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
  /** Override for the squashed conventional commit's message; wins verbatim and bypasses composition. */
  message?: string
  /** One-way narration of the sequence (design D3); safe to ignore for scripted calls. */
  onEvent?: (event: CloseEvent) => void
  /**
   * The two-way gate before the squash lands: receives the composed message and
   * returns the message to commit, or undefined to stop the sequence before the
   * squash. Headless callers omit it (the proposal is accepted unchanged);
   * `--message` never reaches it.
   */
  resolveMessage?: (proposal: CloseMessageProposal) => Promise<string | undefined>
  /**
   * Releases an interactive renderer while a user-owned git command may need
   * the terminal (commit signing, hooks, credential prompts). Headless callers
   * omit it and execute the action directly.
   */
  withTerminal?: <T>(action: () => Promise<T>) => Promise<T>
  /** Test seam: the commit writer behind composition. Defaults to `proposeCommitMessage`. */
  writer?: (input: Parameters<typeof proposeCommitMessage>[0]) => Promise<CommitMessageProposal>
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
  /** How the merge landed (design D5); "already-up-to-date" when nothing moved. */
  mergeShape: CloseMergeShape
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
      "couldn't locate the feature worktree: pass --branch <name>, run inside the worktree, or continue from the specs board's row action",
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
 * The preflight state: the blocking conditions (each with its concrete
 * remediation) plus the one-line summary the checklist renders (design D6:
 * `clean tree · 24/24 tasks · no live runs`).
 */
export type ClosePreflightState = {
  blockers: ClosePreflightBlocker[]
  summary: string
}

/**
 * The three blocking preflight conditions, each with its concrete remediation.
 * Returned (not thrown) so the caller can print them all at once; an empty
 * list means the sequence may start.
 */
export async function closePreflight(input: CloseInput, target: CloseTarget): Promise<ClosePreflightBlocker[]> {
  return (await closePreflightState(input, target)).blockers
}

export async function closePreflightState(input: CloseInput, target: CloseTarget): Promise<ClosePreflightState> {
  const blockers: ClosePreflightBlocker[] = []

  // Fail closed: a git status that cannot be read must not be read as "clean",
  // because the sequence that follows rewrites history (squash) and merges it
  // onto the base. If we cannot verify the tree, we refuse (SC-6).
  let porcelain: string
  let treeVerifiable = true
  try {
    porcelain = await statusPorcelain(target.worktreeDir)
  } catch (error) {
    porcelain = ""
    treeVerifiable = false
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
  let taskSummary: string | undefined
  if (changeStillPresent) {
    const tasks = (await openspecTaskCounts(target.worktreeDir)).get(target.changeID)
    if (!tasks || tasks.total === 0) {
      blockers.push({ check: "tasks", message: `no task list found for change ${target.changeID}; finish the tasks before closing` })
      taskSummary = "no task list"
    } else if (tasks.done < tasks.total) {
      blockers.push({ check: "tasks", message: `${tasks.total - tasks.done} of ${tasks.total} tasks are incomplete — finish them before closing` })
      taskSummary = `${tasks.done}/${tasks.total} tasks`
    } else {
      taskSummary = `${tasks.done}/${tasks.total} tasks`
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

  const parts: string[] = [treeVerifiable ? "clean tree" : "tree unverifiable"]
  if (taskSummary) parts.push(taskSummary)
  parts.push(liveCount === 0 ? "no live runs" : `${liveCount} live run${liveCount === 1 ? "" : "s"}`)
  return { blockers, summary: parts.join(" · ") }
}

/**
 * The full closing sequence. Throws `Error` on every stop (preflight
 * blockers, sync conflict, archive failure, declined message, merge conflict);
 * the error message names the step and the remediation, and `close --resume`
 * picks up from the first incomplete step. Every state change the renderers
 * need travels through `input.onEvent` (design D3) — the TTY checklist and the
 * headless formatter consume the same stream, so narration has one source.
 */
export async function runClose(input: CloseInput): Promise<CloseResult> {
  const emit = (event: CloseEvent) => input.onEvent?.(event)
  const target = await resolveCloseTarget(input)
  const baseRef = await closeBaseRef(input.targetDir)

  // Preflight: refuse to touch anything until the feature is ready to close.
  const preflight = await closePreflightState(input, target)
  if (preflight.blockers.length > 0) {
    emit({ type: "preflight-failed", blockers: preflight.blockers })
    throw new Error(`close preflight failed:\n  ${preflight.blockers.map((blocker) => blocker.message).join("\n  ")}`)
  }
  emit({ type: "preflight", summary: preflight.summary })

  // Sync: bring the base branch's tip in before archiving, so the canonical
  // specs the archive produces land against a fresh base.
  let syncMergeSha: string | undefined
  if (await isAncestor(baseRef, target.branch, target.worktreeDir)) {
    emit({ type: "step-skipped", step: "sync", reason: `${baseRef} is already an ancestor of ${target.branch}` })
    // A resume arrives here after the sync merge already landed, so this step
    // is detected as done rather than redone. That merge is an operator-identity
    // commit the squash below must fold (design D5); it isn't persisted, so
    // re-discover it — without it the plain walk would leave the sync merge and
    // the raw convoy commits to leak onto the base branch (SC-1).
    if (input.resume) syncMergeSha = await detectPendingSyncMerge(target.worktreeDir)
  } else {
    emit({ type: "step-started", step: "sync" })
    const merge = await execFile("git", ["merge", "--no-edit", baseRef], { cwd: target.worktreeDir, allowFailure: true })
    if (merge.exitCode !== 0) {
      const message = `sync: merging ${baseRef} into ${target.branch} conflicted — resolve the conflicts and commit inside the worktree, then run \`convoy close --resume\`\n${merge.stderr || merge.stdout}`
      emit({ type: "step-failed", step: "sync", message })
      throw new Error(message)
    }
    // The clean sync just wrote an operator-identity merge commit. The squash
    // below must fold it (plus the convoy commits beneath it) into the one
    // conventional commit, or the raw `convoy(...)` steps leak onto the base
    // branch unchanged.
    syncMergeSha = (await resolveCommit("HEAD", target.worktreeDir)) ?? undefined
    emit({ type: "step-completed", step: "sync", detail: `merged ${baseRef} into ${target.branch}` })
  }

  // Snapshot the message inputs before the first archive mutation (design D1):
  // the archive moves the live change, and the archive layout's naming is an
  // implementation detail the message must never discover.
  const archiveSubject = `chore(openspec): archive ${target.changeID}`
  const snapshot = await snapshotCloseContext(target, baseRef, { syncMergeSha, archiveSubject })

  // Archive: through the OpenSpec CLI only — convoy never edits openspec/.
  const changeDir = join(target.worktreeDir, openspecDirName, "changes", target.changeID)
  if (await exists(changeDir)) {
    emit({ type: "step-started", step: "archive" })
    const archive = await execFile("openspec", ["archive", target.changeID, "--yes"], { cwd: target.worktreeDir, allowFailure: true })
    if (archive.exitCode !== 0) {
      const message = `archive: openspec archive ${target.changeID} failed — the sequence stops before any squash or merge\n${archive.stderr || archive.stdout}`
      emit({ type: "step-failed", step: "archive", message })
      throw new Error(message)
    }
    // The archive result is committed on the feature branch under the
    // operator's identity (staged explicitly; commitAsUser adds nothing).
    try {
      await execFile("git", ["add", openspecDirName], { cwd: target.worktreeDir })
      const commitArchive = () => commitAsUser(archiveSubject, target.worktreeDir)
      if (input.withTerminal) await input.withTerminal(commitArchive)
      else await commitArchive()
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const message =
        `archive: change ${target.changeID} was archived but committing the result failed — resolve the git error in the worktree, ` +
        `commit the archive result, then run \`convoy close --resume\`\n${detail}`
      emit({ type: "step-failed", step: "archive", message })
      throw new Error(message)
    }
    emit({ type: "step-completed", step: "archive", detail: `archived ${target.changeID}` })
  } else {
    emit({ type: "step-skipped", step: "archive", reason: `change ${target.changeID} is already archived` })
  }

  // Squash: the same authorship-anchored walk `convoy finish` uses, so the
  // operator's own commits (the proposal commit) survive while convoy's — and
  // close's own archive commit, made under the operator identity — collapse
  // into one conventional commit. A branch with no convoy commits skips the
  // squash and merges as-is.
  let squashed: CloseResult["squashed"]
  const range = syncMergeSha
    ? await closeSyncSquashRange(target.worktreeDir, baseRef, { syncMergeSha, archiveSubject })
    : await resolveSquashRange(target.worktreeDir, baseRef, { extraSquashable: (commit) => commit.subject === archiveSubject })
  if (range.ok) {
    emit({ type: "step-started", step: "squash" })
    // `--message ""` is still an explicit override and must win verbatim, so
    // presence is `!== undefined`, never truthiness (SC-8). The override
    // bypasses composition, normalization, and the review gate entirely.
    let message: string | undefined
    if (input.message !== undefined) {
      message = input.message
    } else {
      // The composition await is real work the renderer must see as such
      // (design D1): a slow model produces no intermediate event of its own.
      emit({ type: "squash-phase", phase: "composing-message" })
      const proposal = await composeCloseMessage({ target, snapshot, diffStat: range.diffStat }, input.writer)
      if (input.resolveMessage) {
        emit({ type: "squash-phase", phase: "awaiting-message-review" })
        message = await input.resolveMessage(proposal)
      } else {
        // Headless: the proposal is accepted unchanged.
        message = proposal.message
      }
    }
    if (message === undefined) {
      const stop = "close stopped: the squashed commit message wasn't confirmed — rerun `convoy close --resume` to retry the squash"
      emit({ type: "step-failed", step: "squash", message: stop })
      throw new Error(stop)
    }
    const confirmedMessage = message
    emit({ type: "squash-phase", phase: "creating-commit" })
    try {
      const squash = () => applySquash({ cwd: target.worktreeDir, plan: range, message: confirmedMessage })
      const result = input.withTerminal ? await input.withTerminal(squash) : await squash()
      squashed = { sha: result.sha, replaced: result.replaced }
      emit({ type: "step-completed", step: "squash", detail: `${result.replaced} commit${result.replaced === 1 ? "" : "s"} → ${result.sha.slice(0, 8)}` })
    } catch (error) {
      // A failed rewrite (declined signature, rejected hook) must still mark
      // the squash row failed; the failed event carries the remediation (SC-5).
      const detail = error instanceof Error ? error.message : String(error)
      emit({ type: "step-failed", step: "squash", message: `squash: ${detail}` })
      throw error
    }
  } else if (range.reason === "no-commits") {
    emit({ type: "step-skipped", step: "squash", reason: "no convoy commits to squash" })
  } else {
    const message = `squash: ${range.message}`
    emit({ type: "step-failed", step: "squash", message })
    throw new Error(message)
  }

  // Merge: into the base branch from the main checkout. The main checkout
  // must already sit on the base branch and be clean — close never moves the
  // operator's own checkout out from under them.
  const mainDir = (await mainWorktreeDir(input.targetDir)) ?? input.targetDir
  const mainBranch = await currentBranch(mainDir)
  if (mainBranch !== baseRef) {
    const message = `merge: the main checkout is on ${mainBranch ?? "a detached HEAD"}, not ${baseRef} — check out ${baseRef} there, then run \`convoy close --resume\``
    emit({ type: "step-failed", step: "merge", message })
    throw new Error(message)
  }
  const mainStatus = await statusPorcelain(mainDir).catch(() => "dirty")
  if (mainStatus.trim() !== "") {
    const message = "merge: the main checkout has uncommitted changes — commit or stash them first, then run `convoy close --resume`"
    emit({ type: "step-failed", step: "merge", message })
    throw new Error(message)
  }

  let mergeShape: CloseMergeShape
  if (await isAncestor(target.branch, baseRef, mainDir)) {
    emit({ type: "step-skipped", step: "merge", reason: `${target.branch} is already contained in ${baseRef}` })
    mergeShape = "already-up-to-date"
    emit({ type: "merge-shape", shape: mergeShape })
  } else {
    emit({ type: "step-started", step: "merge" })
    const baseBefore = (await resolveCommit(baseRef, mainDir)) ?? ""
    const merge = await execFile("git", ["merge", "--no-edit", target.branch], { cwd: mainDir, allowFailure: true })
    if (merge.exitCode !== 0) {
      const message = `merge: merging ${target.branch} into ${baseRef} failed — resolve in the main checkout, then run \`convoy close --resume\`\n${merge.stderr || merge.stdout}`
      emit({ type: "step-failed", step: "merge", message })
      throw new Error(message)
    }
    mergeShape = await deriveMergeShape(baseBefore, baseRef, mainDir)
    emit({ type: "merge-shape", shape: mergeShape })
    emit({ type: "step-completed", step: "merge", detail: mergeShapeDetail(mergeShape) })
  }

  const result: CloseResult = {
    changeID: target.changeID,
    branch: target.branch,
    worktreeDir: target.worktreeDir,
    baseRef,
    ...(squashed ? { squashed } : {}),
    merged: true,
    mergeShape,
  }
  emit({ type: "result", result })
  return result
}

/**
 * Snapshot + final diffstat → normalized message proposal (design D1). The
 * writer's answer is a proposal, not authority: the scope rule is enforced
 * here, and a writer that answered nothing usable degrades to the
 * deterministic close fallback without blocking the sequence.
 */
async function composeCloseMessage(
  context: { target: CloseTarget; snapshot: CloseContextSnapshot; diffStat: string },
  writer?: CloseInput["writer"],
): Promise<CloseMessageProposal> {
  const writerInput = {
    targetDir: context.target.worktreeDir,
    branch: context.target.branch,
    commits: context.snapshot.commitSubjects,
    ...(context.diffStat.trim() ? { diffStat: context.diffStat } : {}),
    ...(context.snapshot.proposalExcerpt ? { proposalExcerpt: context.snapshot.proposalExcerpt } : {}),
    ...(context.snapshot.scopeCandidates.length > 0 ? { scopeCandidates: context.snapshot.scopeCandidates } : {}),
  }
  const proposal = await (writer ?? proposeCommitMessage)(writerInput)
  if (proposal.source === "template") {
    const message = closeFallbackCommitMessage({
      branch: context.target.branch,
      proposal: context.snapshot.proposalExcerpt,
      changeID: context.target.changeID,
      scopeCandidates: context.snapshot.scopeCandidates,
      commits: context.snapshot.commitSubjects,
    })
    return { message: stripControlBytes(formatCommitMessage(message)), source: "fallback", ...(proposal.error ? { error: proposal.error } : {}) }
  }
  const normalized = normalizeComposedMessage(proposal.message, {
    scopeCandidates: context.snapshot.scopeCandidates,
    changeID: context.target.changeID,
  })
  return { message: stripControlBytes(formatCommitMessage(normalized)), source: "model" }
}

/** The message inputs, captured before archive moves the live change (task 2.1, design D1). */
export type CloseContextSnapshot = {
  changeID: string
  /** The proposal document's content, read while the live path still existed. */
  proposalExcerpt?: string
  /** The capability names under the change's delta specs — the scope rule's candidates. */
  scopeCandidates: string[]
  /** The collapsible commit subjects, captured before the archive commit exists. */
  commitSubjects: string[]
}

async function snapshotCloseContext(
  target: CloseTarget,
  baseRef: string,
  opts: { syncMergeSha?: string; archiveSubject: string },
): Promise<CloseContextSnapshot> {
  const changeDir = join(target.worktreeDir, openspecDirName, "changes", target.changeID)
  let proposalExcerpt: string | undefined
  try {
    proposalExcerpt = await readFile(join(changeDir, "proposal.md"), "utf8")
  } catch {
    // A change without a readable proposal still closes; the message just
    // loses that seed.
  }
  return {
    changeID: target.changeID,
    ...(proposalExcerpt ? { proposalExcerpt } : {}),
    scopeCandidates: await listChangeCapabilities(changeDir),
    commitSubjects: await collapsibleCommitSubjects(target, baseRef, opts),
  }
}

/** The capability directories of the change's delta specs, sorted. */
async function listChangeCapabilities(changeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(join(changeDir, "specs"), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

/**
 * The pre-archive walk of what will collapse. The archive commit doesn't exist
 * yet, so the plain authorship-anchored walk already lists every convoy commit;
 * the sync-aware first-parent walk covers a branch that just synced. A failure
 * here only costs the message its commit summaries.
 */
async function collapsibleCommitSubjects(
  target: CloseTarget,
  baseRef: string,
  opts: { syncMergeSha?: string; archiveSubject: string },
): Promise<string[]> {
  try {
    const range = opts.syncMergeSha
      ? await closeSyncSquashRange(target.worktreeDir, baseRef, { syncMergeSha: opts.syncMergeSha, archiveSubject: opts.archiveSubject })
      : await resolveSquashRange(target.worktreeDir, baseRef)
    return range.ok ? range.commits.map((commit) => commit.subject) : []
  } catch {
    return []
  }
}

/** The merge shape from git state alone (design D5): SHA movement plus parent count. */
async function deriveMergeShape(baseBefore: string, baseRef: string, cwd: string): Promise<CloseMergeShape> {
  const baseAfter = (await resolveCommit(baseRef, cwd)) ?? ""
  if (!baseBefore || !baseAfter || baseAfter === baseBefore) return "already-up-to-date"
  const parents = await commitParentCount(baseAfter, cwd)
  return parents > 1 ? "merge-commit" : "fast-forward"
}

async function commitParentCount(sha: string, cwd: string): Promise<number> {
  const result = await execFile("git", ["rev-list", "--parents", "-n", "1", sha], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return 1
  return Math.max(1, result.stdout.trim().split(/\s+/).length - 1)
}

function mergeShapeDetail(shape: CloseMergeShape): string {
  if (shape === "fast-forward") return "merged (fast-forward)"
  if (shape === "merge-commit") return "merged (merge commit)"
  return "already up to date"
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
  // Opening `convoy specs` inside a feature worktree (a supported scenario)
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

/**
 * Re-discovers close's sync merge after a resume (SC-1). The sync step creates
 * exactly one operator-identity merge commit; nothing close added above it
 * (the archive commit) is a merge, so the newest first-parent merge is that
 * merge. The branch's own first-parent line descends into the base's history,
 * so a merge there — which the squash never reaches (the walk anchors below
 * the operator's surviving commit) — wouldn't fold anyway; returning one is
 * harmless. Returns undefined when no first-parent merge exists at all.
 */
async function detectPendingSyncMerge(cwd: string): Promise<string | undefined> {
  const head = (await resolveCommit("HEAD", cwd)) ?? ""
  if (!head) return undefined
  const result = await execFile("git", ["log", "--first-parent", "--format=%H %P", head], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return undefined
  for (const line of result.stdout.split("\n")) {
    const [sha = "", ...parents] = line.trim().split(/\s+/)
    if (sha && parents.length > 1) return sha
  }
  return undefined
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
