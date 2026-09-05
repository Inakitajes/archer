import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  commitAsUser,
  currentBranch,
  detectBaseRef,
  diffStat,
  execFile,
  findSuspiciousStagedFiles,
  isAncestor,
  mainWorktreeDir,
  findWorktreeDirForBranch,
  mergeBase,
  resolveCommit,
  statusPorcelain,
} from "./git"
import { branchIdFromBranch, isOpenSpecChangeId, openspecDirName } from "./openspec"
import {
  clearCloseJournal,
  closeCommonDir,
  closeCandidateRef,
  closeFeatureTipRef,
  protectCloseRef,
  isLandingReachable,
  readCloseJournal,
  writeCloseJournal,
  type CloseJournal,
} from "./close-journal"
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
 * `feature-close`, design D6): preflight → sync (merge the base branch into
 * the feature branch) → archive (through the OpenSpec CLI, the tool that owns
 * that state) → squash-merge (stage a one-parent candidate commit in a private
 * integration worktree at the captured base, then advance the base onto it
 * with a guarded fast-forward-only ref update). Each step checks its own
 * precondition, so `close --resume` after a mid-sequence stop continues from
 * the first incomplete step without redoing completed ones.
 *
 * The landing is always exactly one regular commit on the base branch whose
 * tree is the feature's post-archive tree. The feature branch is never
 * rewritten — its history (operator proposal commits, run-compaction commits,
 * sync/archive work) survives untouched — and published history is never
 * rewritten by construction: the candidate's parent is the captured base, so
 * landing is a pure fast-forward of the base ref, guarded by an expected-old
 * value that refuses when the base moved.
 *
 * The sequence narrates itself through one-way `CloseEvent`s (design D8) and
 * gates the candidate commit behind a separate `resolveMessage` resolver, so
 * the TTY checklist and the headless formatter consume the same stream.
 */

export type CloseStep = "sync" | "archive" | "squash-merge"

/**
 * The squash-merge step's typed sub-states (design D8): stable identifiers the
 * renderers map to their own copy, so semantic operation state stays in the
 * orchestrator instead of being inferred from which renderer is waiting.
 */
export type CloseSquashPhase = "composing-message" | "awaiting-message-review" | "creating-commit"

/** How the close ended, stated once (design D8: no dual merge-shape narration). */
export type CloseDisposition =
  /** The base advanced onto the one candidate commit. */
  | "landed"
  /** The feature's post-archive tree equals the captured base tree — nothing to land, no empty commit. */
  | "no-content-to-land"
  /** A verified receipt shows this exact feature already landed; nothing was redone. */
  | "already-landed"

export type CloseEvent =
  | { type: "preflight"; summary: string }
  | { type: "preflight-failed"; blockers: readonly ClosePreflightBlocker[] }
  | { type: "step-started"; step: CloseStep }
  | { type: "step-completed"; step: CloseStep; detail?: string }
  | { type: "step-skipped"; step: CloseStep; reason: string }
  | { type: "step-failed"; step: CloseStep; message: string }
  | { type: "squash-phase"; phase: CloseSquashPhase }
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
  /** Override for the landing commit's message; wins verbatim and bypasses composition. */
  message?: string
  /** One-way narration of the sequence (design D8); safe to ignore for scripted calls. */
  onEvent?: (event: CloseEvent) => void
  /**
   * The two-way gate before the candidate commit is created: receives the
   * composed message and returns the message to commit, or undefined to stop
   * the sequence before the landing. Headless callers omit it (the proposal is
   * accepted unchanged); `--message` never reaches it.
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
  check: "clean-tree" | "tasks" | "live-run" | "main-checkout" | "unrelated-base"
  message: string
}

export type CloseStop = {
  /** The step the sequence stopped at, so --resume knows where to pick up. */
  step: CloseStep
  message: string
}

export type CloseResult = {
  changeID: string
  branch: string
  worktreeDir: string
  baseRef: string
  disposition: CloseDisposition
  /** Present when the disposition is "landed" or "already-landed". */
  landing?: { sha: string }
}

export type CloseTarget = {
  worktreeDir: string
  branch: string
  changeID: string
}

/**
 * Resolves the feature the close sequence operates on. Explicit worktree and
 * branch (the board's handoff) win; a bare `--branch` resolves its worktree
 * from the repo's worktree list; running inside the worktree is enough on its
 * own. The change id follows the shared branch↔change rule unless `--change`
 * pins it. A completed receipt lets cleanup-only resumes proceed without a
 * worktree (design D7): the caller names the branch, the receipt supplies the
 * rest, and no worktree is demanded.
 */
export async function resolveCloseTarget(input: CloseInput): Promise<CloseTarget> {
  const { targetDir } = input
  let worktreeDir = input.worktreeDir
  let branch = input.branch

  if (!worktreeDir && branch) worktreeDir = (await findWorktreeDirForBranch(branch, targetDir)) ?? undefined
  if (!worktreeDir && !input.resume) {
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
 * remediation) plus the one-line summary the checklist renders (design D8:
 * `clean tree · 24/24 tasks · no live runs`, plus the factual remote context
 * when the feature is published).
 */
export type ClosePreflightState = {
  blockers: ClosePreflightBlocker[]
  summary: string
}

/**
 * The blocking preflight conditions, each with its concrete remediation.
 * Returned (not thrown) so the caller can print them all at once; an empty
 * list means the sequence may start. Both worktrees are checked before any
 * mutation: the feature tree must be clean, and the main checkout must sit
 * clean and on the base branch the landing will advance (design D6, task 5.2).
 * A published feature branch is disclosed factually, never treated as a
 * blocker — and an upstream alone is never described as proof of anything.
 */
export async function closePreflight(input: CloseInput, target: CloseTarget): Promise<ClosePreflightBlocker[]> {
  return (await closePreflightState(input, target)).blockers
}

export async function closePreflightState(input: CloseInput, target: CloseTarget): Promise<ClosePreflightState> {
  const blockers: ClosePreflightBlocker[] = []
  const baseRef = await closeBaseRef(input.targetDir)

  // Fail closed: a git status that cannot be read must not be read as "clean",
  // because the sequence that follows moves the base branch. If we cannot
  // verify the tree, we refuse (SC-6).
  let porcelain: string
  let treeVerifiable = true
  try {
    porcelain = await statusPorcelain(target.worktreeDir)
  } catch (error) {
    porcelain = ""
    treeVerifiable = false
    blockers.push({
      check: "clean-tree",
      message: `couldn't verify the worktree at ${target.worktreeDir} is clean (${error instanceof Error ? error.message : error}) — refusing to move history under an unverifiable tree`,
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

  // The landing advances the base branch from the main checkout (design D6,
  // task 5.2): that checkout must be verifiably clean and already on the base
  // branch — close never moves the operator's own checkout out from under
  // them. This check lives in preflight so a stop happens before any sync or
  // archive mutation, not after the feature work has been prepared.
  const mainDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir
  const mainBranch = await currentBranch(mainDir).catch(() => undefined)
  if (mainBranch !== baseRef) {
    blockers.push({
      check: "main-checkout",
      message: `the main checkout is on ${mainBranch ?? "a detached HEAD"}, not ${baseRef} — check out ${baseRef} there, then run \`convoy close --resume\``,
    })
  } else {
    const mainStatus = await statusPorcelain(mainDir).catch(() => "unreadable")
    if (mainStatus.trim() !== "") {
      blockers.push({ check: "main-checkout", message: "the main checkout has uncommitted changes — commit or stash them first, then run `convoy close --resume`" })
    }
  }

  // The fork relationship is derived from git, never from a branch timestamp
  // or a configurable boundary (design D6, task 5.2): unrelated or ambiguous
  // histories are refused rather than falling back to HEAD.
  const related = await mergeBase(baseRef, target.branch, target.worktreeDir).catch(() => undefined)
  if (!related) {
    blockers.push({
      check: "unrelated-base",
      message: `${target.branch} and ${baseRef} share no merge-base — close refuses to land across unrelated histories`,
    })
  }

  const parts: string[] = [treeVerifiable ? "clean tree" : "tree unverifiable"]
  if (taskSummary) parts.push(taskSummary)
  parts.push(liveCount === 0 ? "no live runs" : `${liveCount} live run${liveCount === 1 ? "" : "s"}`)
  // Factual remote disclosure (design D7): an upstream is reported, never
  // interpreted — close neither blocks on it nor claims a PR exists.
  const upstream = await import("./git").then((git) => git.branchUpstream(target.branch, target.worktreeDir).catch(() => undefined))
  if (upstream) parts.push(`${target.branch} tracks ${upstream}`)
  return { blockers, summary: parts.join(" · ") }
}

/**
 * The full closing sequence. Throws `Error` on every stop (preflight
 * blockers, sync conflict, archive failure, declined message, stale base,
 * landing failure); the error message names the step and the remediation, and
 * `close --resume` picks up from the first incomplete step. Every state
 * change the renderers need travels through `input.onEvent` (design D8) — the
 * TTY checklist and the headless formatter consume the same stream, so
 * narration has one source.
 */
export async function runClose(input: CloseInput): Promise<CloseResult> {
  const emit = (event: CloseEvent) => input.onEvent?.(event)
  const baseRef = await closeBaseRef(input.targetDir)
  const mainDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir
  const commonDir = await closeCommonDir(input.targetDir)

  // Receipt fast path (design D7, task 5.1): a resume against a completed
  // receipt skips completed work before any worktree is demanded, even when
  // the worktree was already removed and cleanup is all that remains.
  if (input.resume && input.branch && commonDir) {
    const receipt = await readCloseJournal(commonDir, input.branch, input.changeID ?? branchIdFromBranch(input.branch) ?? "")
    if (receipt?.phase === "landed" && receipt.landingSha && receipt.postArchiveTip) {
      const reachable = await isLandingReachable(receipt.landingSha, baseRef, mainDir)
      const tip = await resolveCommit(receipt.branch, mainDir).catch(() => undefined)
      const tipUnchanged = tip === undefined || tip === receipt.postArchiveTip
      if (reachable && tipUnchanged) {
        const summary = `landing ${receipt.landingSha.slice(0, 8)} already recorded for ${receipt.branch} → ${baseRef}`
        emit({ type: "preflight", summary: `${summary} · nothing to redo` })
        for (const step of ["sync", "archive", "squash-merge"] as const) {
          emit({ type: "step-skipped", step, reason: "a verified landing receipt covers this sequence" })
        }
        const result: CloseResult = {
          changeID: receipt.changeID,
          branch: receipt.branch,
          worktreeDir: input.worktreeDir ?? (await findWorktreeDirForBranch(receipt.branch, input.targetDir)) ?? mainDir,
          baseRef,
          disposition: "already-landed",
          landing: { sha: receipt.landingSha },
        }
        emit({ type: "result", result })
        return result
      }
      if (!reachable) {
        throw new Error(
          `close receipt invalid: landing ${receipt.landingSha.slice(0, 8)} is no longer reachable from ${baseRef} — ` +
            "inspect the branch history before closing again; a revert is an explicit git revert, never a re-land",
        )
      }
      throw new Error(
        `close receipt invalid: ${receipt.branch}'s tip moved past the landed state (${receipt.postArchiveTip.slice(0, 8)}) — ` +
          "inspect the branch, then plan a new close",
      )
    }
  }

  const target = await resolveCloseTarget(input)

  // Preflight: refuse to touch anything until the feature is ready to close.
  const preflight = await closePreflightState(input, target)
  if (preflight.blockers.length > 0) {
    emit({ type: "preflight-failed", blockers: preflight.blockers })
    throw new Error(`close preflight failed:\n  ${preflight.blockers.map((blocker) => blocker.message).join("\n  ")}`)
  }
  emit({ type: "preflight", summary: preflight.summary })

  const journalState = await openJournal(commonDir, target, baseRef, input)
  const journal = journalState.record

  // Sync: bring the base branch's tip in before archiving, so the canonical
  // specs the archive produces land against a fresh base. The base revision
  // is captured (pinned) here and revalidated before the landing (task 5.6).
  const baseSha = journal.baseSha
  let preSyncTip: string | undefined
  if (await isAncestor(baseRef, target.branch, target.worktreeDir)) {
    emit({ type: "step-skipped", step: "sync", reason: `${baseRef} is already an ancestor of ${target.branch}` })
  } else {
    emit({ type: "step-started", step: "sync" })
    preSyncTip = (await resolveCommit(target.branch, target.worktreeDir)) ?? undefined
    const merge = await execFile("git", ["merge", "--no-edit", baseSha], { cwd: target.worktreeDir, allowFailure: true })
    if (merge.exitCode !== 0) {
      const message = `sync: merging ${baseRef} into ${target.branch} conflicted — resolve the conflicts and commit inside the worktree, then run \`convoy close --resume\`\n${merge.stderr || merge.stdout}`
      emit({ type: "step-failed", step: "sync", message })
      throw new Error(message)
    }
    emit({ type: "step-completed", step: "sync", detail: `merged ${baseSha.slice(0, 8)} into ${target.branch}` })
    if (journal.phase === "prepared" && !journal.postArchiveTip) await persistJournal(journalState, { preSyncTip })
  }

  // Snapshot the message inputs before the first archive mutation (design D6):
  // the archive moves the live change, and the archive layout's naming is an
  // implementation detail the message must never discover. A resume reuses the
  // persisted context so a retry never degrades to archive-only text.
  const archiveSubject = `chore(openspec): archive ${target.changeID}`
  const snapshot: CloseContextSnapshot = journal.messageContext
    ? { ...journal.messageContext, changeID: target.changeID }
    : await snapshotCloseContext(target, baseSha, { archiveSubject })
  if (!journal.messageContext) await persistJournal(journalState, { messageContext: snapshot })

  // Archive: through the OpenSpec CLI only — convoy never edits openspec/.
  const changeDir = join(target.worktreeDir, openspecDirName, "changes", target.changeID)
  if (await exists(changeDir)) {
    emit({ type: "step-started", step: "archive" })
    const archive = await execFile("openspec", ["archive", target.changeID, "--yes"], { cwd: target.worktreeDir, allowFailure: true })
    if (archive.exitCode !== 0) {
      const message = `archive: openspec archive ${target.changeID} failed — the sequence stops before any squash-merge\n${archive.stderr || archive.stdout}`
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

  // The post-archive feature tip is the squash-merge source (design D6): the
  // candidate folds sync resolutions, archive output, and every author's
  // feature content by tree, not by walking authors. Protect it create-only
  // before anything else happens to the branch (design D7).
  const postArchiveTip = (await resolveCommit(target.branch, target.worktreeDir)) ?? ""
  if (!postArchiveTip) {
    const message = `squash-merge: ${target.branch} has no commits — nothing to land`
    emit({ type: "step-failed", step: "squash-merge", message })
    throw new Error(message)
  }
  try {
    await protectCloseRef(closeFeatureTipRef(target.branch, journal.attemptID), postArchiveTip, mainDir)
  } catch (error) {
    const message = `squash-merge: couldn't protect the feature tip ref (${error instanceof Error ? error.message : String(error)}) — the sequence stops before the landing`
    emit({ type: "step-failed", step: "squash-merge", message })
    throw new Error(message)
  }
  const preparedTree = (await treeOf(postArchiveTip, target.worktreeDir)) ?? ""
  await persistJournal(journalState, { postArchiveTip, preparedTree })

  // Squash-merge: stage the one-parent candidate on the captured base in a
  // private detached integration worktree, then advance the base onto it. The
  // main checkout's index is never left half-staged by a failed signature or
  // hook, because the staging happens away from it (design D6, task 5.4).
  emit({ type: "step-started", step: "squash-merge" })
  await assertBaseUnchanged(baseSha, baseRef, mainDir)

  if (preparedTree === (await treeOf(baseSha, mainDir))) {
    // Identical trees: nothing to land, no empty commit, and no cleanup
    // authorization from that fact alone (design D6/D7).
    emit({ type: "step-skipped", step: "squash-merge", reason: "the archived feature's tree equals the captured base tree — no content to land" })
    await clearCloseJournal(commonDir ?? "", target.branch, target.changeID)
    const result: CloseResult = { changeID: target.changeID, branch: target.branch, worktreeDir: target.worktreeDir, baseRef, disposition: "no-content-to-land" }
    emit({ type: "result", result })
    return result
  }

  // A crash after candidate creation resumes the landing without a new
  // compose/review round-trip (design D6, task 5.7): the candidate is
  // verified against the journal before it is trusted.
  const reconciled = await reconcileCandidate(journal, baseSha, preparedTree, mainDir)
  let message: string | undefined
  let candidateSha: string | undefined
  if (reconciled.ok && reconciled.candidateSha) {
    candidateSha = reconciled.candidateSha
    message = journal.message ?? reconciled.message
    if (message) emit({ type: "squash-phase", phase: "creating-commit" })
  }

  if (!candidateSha) {
    // `--message ""` is still an explicit override and must win verbatim, so
    // presence is `!== undefined`, never truthiness (SC-8). The override
    // bypasses composition, normalization, and the review gate entirely.
    if (input.message !== undefined) {
      message = input.message
    } else {
      // The composition await is real work the renderer must see as such
      // (design D8): a slow model produces no intermediate event of its own.
      emit({ type: "squash-phase", phase: "composing-message" })
      const proposal = await composeCloseMessage({ target, snapshot, baseSha, diffStat: await diffStat(baseSha, postArchiveTip, target.worktreeDir) }, input.writer)
      if (input.resolveMessage) {
        emit({ type: "squash-phase", phase: "awaiting-message-review" })
        message = await input.resolveMessage(proposal)
      } else {
        // Headless: the proposal is accepted unchanged.
        message = proposal.message
      }
    }
    if (message === undefined) {
      const stop = "close stopped: the landing commit's message wasn't confirmed — rerun `convoy close --resume` to retry the squash-merge"
      emit({ type: "step-failed", step: "squash-merge", message: stop })
      await persistJournal(journalState, { message: undefined })
      throw new Error(stop)
    }
    const confirmedMessage = message
    await persistJournal(journalState, { message: confirmedMessage })
    emit({ type: "squash-phase", phase: "creating-commit" })
    try {
      candidateSha = await createCandidate(journalState, target, confirmedMessage, baseSha, postArchiveTip, mainDir, input.withTerminal)
    } catch (error) {
      // A failed candidate (declined signature, rejected hook) must still mark
      // the squash-merge row failed; the failed event carries the remediation (SC-5).
      const detail = error instanceof Error ? error.message : String(error)
      emit({ type: "step-failed", step: "squash-merge", message: `squash-merge: ${detail}` })
      throw error
    }
  }

  // Land: advance the base branch onto the verified candidate. The candidate's
  // parent is the captured base, so this is a pure fast-forward of the base
  // ref — guarded by the expected old value, so a base that moved after the
  // candidate was built refuses instead of merging or forcing (task 5.5/5.6).
  const baseNow = (await resolveCommit(baseRef, mainDir)) ?? ""
  if (baseNow !== baseSha) {
    const message = `squash-merge: ${baseRef} moved to ${baseNow.slice(0, 8)} while the close was in progress — run \`convoy close\` to re-sync against the new base`
    emit({ type: "step-failed", step: "squash-merge", message })
    throw new Error(message)
  }
  const mainStatus = await statusPorcelain(mainDir).catch(() => "unreadable")
  if (mainStatus.trim() !== "") {
    const message = "squash-merge: the main checkout has uncommitted changes — commit or stash them first, then run `convoy close --resume`"
    emit({ type: "step-failed", step: "squash-merge", message })
    throw new Error(message)
  }
  try {
    // The guarded fast-forward-only update (design D6, task 5.5): the
    // candidate's parent is the captured base, so this can only fast-forward
    // the base branch — and it updates the main checkout's index and working
    // tree together with the ref. A base that moved between candidate
    // creation and landing makes this refuse (no merge, no force); the
    // clean-tree preflight guarantees the checkout has nothing to lose.
    const land = await execFile("git", ["merge", "--ff-only", candidateSha], { cwd: mainDir, allowFailure: true })
    if (land.exitCode !== 0) throw new Error(land.stderr || land.stdout || "git merge --ff-only refused the landing")
  } catch (error) {
    const message = `squash-merge: landing ${baseRef} at ${candidateSha.slice(0, 8)} failed (${error instanceof Error ? error.message : String(error)}) — the base is unadvanced; run \`convoy close --resume\``
    emit({ type: "step-failed", step: "squash-merge", message })
    throw new Error(message)
  }
  await persistJournal(journalState, { phase: "landed", landingSha: candidateSha })

  emit({ type: "step-completed", step: "squash-merge", detail: `landed ${candidateSha.slice(0, 8)} on ${baseRef}` })
  const result: CloseResult = {
    changeID: target.changeID,
    branch: target.branch,
    worktreeDir: target.worktreeDir,
    baseRef,
    disposition: "landed",
    landing: { sha: candidateSha },
  }
  emit({ type: "result", result })
  return result
}

// --- journal handling ---------------------------------------------------------

/**
 * Opens (or starts) the close journal for this attempt. A fresh close starts
 * a new attempt; a resume with a matching base continues the recorded one so
 * completed work and the reviewed message survive. A resume whose recorded
 * base differs stops — the base moved, and the sequence must re-sync against
 * the new base rather than land a stale candidate (task 5.6).
 */
type CloseJournalState = { record: CloseJournal; commonDir?: string }

async function openJournal(
  commonDir: string | undefined,
  target: CloseTarget,
  baseRef: string,
  input: CloseInput,
): Promise<CloseJournalState> {
  const mainDir = (await mainWorktreeDir(input.targetDir).catch(() => undefined)) ?? input.targetDir
  const baseSha = (await resolveCommit(baseRef, mainDir)) ?? (await resolveCommit(baseRef, input.targetDir)) ?? ""
  if (!baseSha) throw new Error(`close: couldn't resolve the base branch ${baseRef}`)

  if (commonDir && input.resume) {
    const existing = await readCloseJournal(commonDir, target.branch, target.changeID)
    if (existing) {
      if (existing.baseSha !== baseSha) {
        throw new Error(
          `close resume: the base moved since this attempt was recorded (${existing.baseSha.slice(0, 8)} → ${baseSha.slice(0, 8)}) — ` +
            "run `convoy close` without --resume to re-sync against the new base",
        )
      }
      return { record: existing, commonDir }
    }
  }

  const attemptID = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  const journal: CloseJournal = {
    schemaVersion: 1,
    attemptID,
    branch: target.branch,
    changeID: target.changeID,
    baseRef,
    baseSha,
    phase: "prepared",
    recordedAt: Date.now(),
    updatedAt: Date.now(),
  }
  const record: CloseJournal = {
    schemaVersion: 1,
    attemptID,
    branch: target.branch,
    changeID: target.changeID,
    baseRef,
    baseSha,
    phase: "prepared",
    recordedAt: Date.now(),
    updatedAt: Date.now(),
  }
  return { record, commonDir }
}

async function persistJournal(state: CloseJournalState, patch: Partial<CloseJournal>): Promise<void> {
  Object.assign(state.record, patch, { updatedAt: Date.now() })
  if (!state.commonDir) return
  await writeCloseJournal(state.commonDir, { ...state.record })
}

/**
 * Verifies the recorded candidate still exists with exactly the journal's
 * parent (the captured base) and tree. Anything else is not trusted (task
 * 5.7): a stale or foreign commit is never reused, and the caller falls back
 * to building a fresh candidate.
 */
async function reconcileCandidate(
  journal: CloseJournal,
  baseSha: string,
  preparedTree: string,
  cwd: string,
): Promise<{ ok: true; candidateSha?: string; message?: string } | { ok: false }> {
  if (journal.phase !== "candidate" || !journal.candidateSha) return { ok: true }
  const sha = await resolveCommit(journal.candidateSha, cwd).catch(() => undefined)
  if (!sha) return { ok: true }
  const parents = await commitParents(sha, cwd)
  const tree = await treeOf(sha, cwd)
  if (parents.length !== 1 || parents[0] !== baseSha || tree !== preparedTree) return { ok: true }
  return { ok: true, candidateSha: sha, ...(journal.message ? { message: journal.message } : {}) }
}

async function commitParents(sha: string, cwd: string): Promise<string[]> {
  const result = await execFile("git", ["rev-list", "--parents", "-n", "1", sha], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout.trim().split(/\s+/).slice(1)
}

async function treeOf(sha: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

async function assertBaseUnchanged(baseSha: string, baseRef: string, mainDir: string): Promise<void> {
  const baseNow = (await resolveCommit(baseRef, mainDir)) ?? ""
  if (baseNow !== baseSha) {
    throw new Error(
      `squash-merge: ${baseRef} moved to ${baseNow.slice(0, 8)} (captured ${baseSha.slice(0, 8)}) — run \`convoy close\` to re-sync against the new base`,
    )
  }
}

/**
 * Builds the one-parent candidate commit in a private detached integration
 * worktree at the captured base (design D6, task 5.4): `git merge --squash`
 * stages the feature's post-archive tree, the staged content is scanned for
 * secrets exactly like step commits, and the commit is made under the
 * operator's identity — signing and hooks effective — with the terminal
 * released for interactive close. The worktree is always removed afterwards.
 */
async function createCandidate(
  state: CloseJournalState,
  target: CloseTarget,
  message: string,
  baseSha: string,
  postArchiveTip: string,
  mainDir: string,
  withTerminal?: CloseInput["withTerminal"],
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "convoy-close-integration-"))
  try {
    await execFile("git", ["worktree", "add", "--detach", scratch, baseSha], { cwd: mainDir })
    try {
      const squash = await execFile("git", ["merge", "--squash", postArchiveTip], { cwd: scratch, allowFailure: true })
      if (squash.exitCode !== 0) {
        throw new Error(
          `staging the feature tree onto ${state.record.baseRef} failed — the feature and the captured base diverged unexpectedly\n${squash.stderr || squash.stdout}`,
        )
      }

      // The candidate commit must not be the one path that bypasses secret
      // scanning (the same protection step commits get).
      const porcelain = await statusPorcelain(scratch)
      const suspicious = findSuspiciousStagedFiles(porcelain)
      if (suspicious.length > 0) {
        throw new Error(
          `refusing to land: the following files look like they contain secrets: ${suspicious.join(", ")}. ` +
            `Add them to .gitignore (or remove them) and re-run \`convoy close\`.`,
        )
      }

      const commitCandidate = () => commitAsUser(message, scratch)
      if (withTerminal) await withTerminal(commitCandidate)
      else await commitCandidate()

      const candidateSha = (await resolveCommit("HEAD", scratch)) ?? ""
      if (!candidateSha) throw new Error("the candidate commit could not be resolved after creation")
      const parents = await commitParents(candidateSha, scratch)
      const tree = await treeOf(candidateSha, scratch)
      if (parents.length !== 1 || parents[0] !== baseSha) {
        throw new Error(`the candidate commit must have exactly one parent, the captured base ${baseSha.slice(0, 8)} (got ${parents.length})`)
      }
      if (tree !== state.record.preparedTree) {
        throw new Error(`the candidate commit's tree does not match the prepared feature tree (${tree?.slice(0, 8)} vs ${state.record.preparedTree?.slice(0, 8)})`)
      }

      // Protect the candidate create-only, then record it in the journal
      // before the base is advanced (design D6/D7, task 5.5) — a crash after
      // this point resumes the landing instead of rebuilding the commit.
      await protectCloseRef(closeCandidateRef(state.record.branch, state.record.attemptID), candidateSha, mainDir)
      await persistJournal(state, { phase: "candidate", candidateSha })
      return candidateSha
    } finally {
      await execFile("git", ["worktree", "remove", "--force", scratch], { cwd: mainDir, allowFailure: true })
    }
  } catch (error) {
    // The scratch dir is removed by `git worktree remove`; a failure before
    // registration leaves only the empty mkdtemp dir behind.
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Snapshot + final diffstat → normalized message proposal (design D6). The
 * writer's answer is a proposal, not authority: the scope rule is enforced
 * here, and a writer that answered nothing usable degrades to the
 * deterministic close fallback without blocking the sequence.
 */
async function composeCloseMessage(
  context: { target: CloseTarget; snapshot: CloseContextSnapshot; baseSha: string; diffStat: string },
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

/** The message inputs, captured before archive moves the live change (design D6). */
export type CloseContextSnapshot = {
  changeID: string
  /** The proposal document's content, read while the live path still existed. */
  proposalExcerpt?: string
  /** The capability names under the change's delta specs — the scope rule's candidates. */
  scopeCandidates: string[]
  /** The feature-exclusive commit subjects, captured before the archive commit exists. */
  commitSubjects: string[]
}

async function snapshotCloseContext(
  target: CloseTarget,
  baseSha: string,
  opts: { archiveSubject: string },
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
    commitSubjects: await featureCommitSubjects(target, baseSha),
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
 * The feature-exclusive commit subjects (base-exclusive reachability, design
 * D6): every commit on the branch not reachable from the base — operator
 * commits, run-compaction commits, sync merge resolutions — because the
 * landing includes all authors' content. A failure here only costs the
 * message its commit summaries.
 */
async function featureCommitSubjects(target: CloseTarget, baseSha: string): Promise<string[]> {
  try {
    const head = (await resolveCommit(target.branch, target.worktreeDir)) ?? ""
    if (!head) return []
    const result = await execFile("git", ["log", "--format=%s", `${baseSha}..${head}`], { cwd: target.worktreeDir, allowFailure: true })
    if (result.exitCode !== 0) return []
    return result.stdout.split("\n").filter(Boolean)
  } catch {
    return []
  }
}

/**
 * The remediation for a probably-merged-but-unarchived change: archive in the
 * main checkout, commit on the base branch, and nothing else — there is
 * nothing left to sync, squash-merge, or land (design D7).
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

/** The base ref the close sequence syncs and lands against. */
export async function closeBaseRef(targetDir: string): Promise<string> {
  const mainDir = (await mainWorktreeDir(targetDir).catch(() => undefined)) ?? targetDir
  const detected = await detectBaseRef(mainDir).catch(() => undefined)
  return detected?.ref ?? "HEAD"
}

/**
 * The verified landing receipt for a branch/change, resolved by callers that
 * gate cleanup on evidence (design D7, task 6.3): a receipt counts only when
 * its landing commit is still reachable from the base branch. Everything else
 * (no receipt, stale tip, unreachable landing) is no evidence at all.
 */
export async function verifiedCloseReceipt(
  targetDir: string,
  branch: string,
  changeID: string,
): Promise<{ landingSha: string; postArchiveTip: string } | undefined> {
  const commonDir = await closeCommonDir(targetDir)
  if (!commonDir) return undefined
  const journal = await readCloseJournal(commonDir, branch, changeID)
  if (!journal || journal.phase !== "landed" || !journal.landingSha || !journal.postArchiveTip) return undefined
  const mainDir = (await mainWorktreeDir(targetDir).catch(() => undefined)) ?? targetDir
  if (!(await isLandingReachable(journal.landingSha, journal.baseRef, mainDir))) return undefined
  return { landingSha: journal.landingSha, postArchiveTip: journal.postArchiveTip }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Re-exported so cleanup surfaces can quote guarded commands from the same evidence. */
export { isLandingReachable, readCloseJournal, closeCandidateRef, closeFeatureTipRef }
