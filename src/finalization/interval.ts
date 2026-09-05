import { currentBranch, execFile, resolveCommit, statusPorcelain } from "../git"
import type { CommitLedgerEntry, RunBoundary } from "./types"

/**
 * Verified current-run interval selection (design D2, task 2.2). Eligibility
 * comes from the durable run boundary and the commit ledger's ownership chain,
 * never from authorship alone: the interval is exactly the linear range from
 * the run-start HEAD to the surviving final HEAD where every commit was
 * created by a ledgered Convoy commit carrying the run's authoritative
 * `Convoy-Run` trailer. Independent operator commits, foreign-run commits,
 * unexpected merges, and missing boundary evidence all refuse the whole
 * operation — a suffix must never be compacted as though it were the run.
 */

export const convoyRunTrailerPrefix = "Convoy-Run:"

export type IntervalBlockKind =
  | "no-boundary"
  | "detached"
  | "branch-changed"
  | "dirty"
  | "missing-head"
  | "unaccounted-commit"
  | "merge-commit"
  | "trailer-mismatch"
  | "ledger-gap"

export type VerifiedCommit = {
  sha: string
  subject: string
  step: string
  mode: CommitLedgerEntry["mode"]
}

export type RunInterval =
  | {
      ok: true
      /** The verified current-run commits, oldest first. */
      commits: VerifiedCommit[]
      startHead: string
      headSha: string
      startTree: string
      headTree: string
    }
  | { ok: false; kind: IntervalBlockKind; reason: string }

type RawCommit = {
  sha: string
  parents: string[]
  body: string
  subject: string
}

/** Reads the full commit range (oldest first) with parents and complete bodies. */
async function readRangeCommits(startHead: string, headSha: string, cwd: string): Promise<RawCommit[]> {
  const result = await execFile("git", ["log", "--format=%H%x1f%P%x1f%B%x1e", `${startHead}..${headSha}`], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  return result.stdout
    .split("\x1e")
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha = "", parents = "", ...bodyParts] = chunk.split("\x1f")
      const body = bodyParts.join("\x1f")
      const subject = body.split("\n").find((line) => line.trim()) ?? ""
      return { sha, parents: parents.trim().split(/\s+/).filter(Boolean), body, subject }
    })
    .filter((commit) => commit.sha)
    .reverse()
}

async function treeOf(rev: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

/**
 * Resolves and verifies the current-run commit interval. `requireCleanTree`
 * keeps the dirty-tree check beside the other guards so one call answers the
 * full eligibility question; callers that already checked cleanliness can
 * disable it.
 */
export async function verifyRunInterval(
  boundary: RunBoundary | undefined,
  ledger: readonly CommitLedgerEntry[],
  runID: string,
  cwd: string,
  options: { requireCleanTree?: boolean } = {},
): Promise<RunInterval> {
  if (!boundary) {
    return { ok: false, kind: "no-boundary", reason: "no durable run boundary was recorded for this run; automatic compaction cannot determine its commit range" }
  }

  const branch = await currentBranch(cwd)
  if (!branch) {
    return { ok: false, kind: "detached", reason: "HEAD is detached; automatic compaction only runs on the run's branch" }
  }
  if (boundary.branch && branch !== boundary.branch) {
    return { ok: false, kind: "branch-changed", reason: `the worktree moved from "${boundary.branch}" to "${branch}" since the run started` }
  }

  if ((options.requireCleanTree ?? true) && (await statusPorcelain(cwd)).trim() !== "") {
    return { ok: false, kind: "dirty", reason: "the working tree has uncommitted changes; commit or stash them first" }
  }

  const headSha = await resolveCommit("HEAD", cwd)
  if (!headSha) {
    return { ok: false, kind: "missing-head", reason: "the branch has no commits to compact" }
  }
  const startExists = await resolveCommit(boundary.startHead, cwd)
  if (!startExists) {
    return { ok: false, kind: "missing-head", reason: `the recorded run-start commit ${boundary.startHead.slice(0, 8)} no longer exists` }
  }

  const [startTree, headTree] = [await treeOf(boundary.startHead, cwd), await treeOf(headSha, cwd)]
  if (!startTree || !headTree) {
    return { ok: false, kind: "missing-head", reason: "could not read the trees of the run boundary or HEAD" }
  }

  const rangeCommits = await readRangeCommits(boundary.startHead, headSha, cwd)

  // The ledger's ownership chain: every committed entry must chain from the
  // run-start HEAD (no-change entries carry no commit and stay transparent),
  // consecutive entries must touch, and the chain must end exactly at HEAD.
  // Goal settlement (capability run-finalization) restores the branch to the
  // best measured state — a ledgered attempt commit — so ledger entries past
  // it were discarded by settlement, not mutated externally. When HEAD lands
  // exactly on a ledgered afterSha, the effective chain is the prefix ending
  // there; the discarded tips stay inspectable behind their protected refs.
  const committedAll = ledger.filter((entry) => entry.afterSha)
  const restoredAtIndex = committedAll.findIndex((entry) => entry.afterSha === headSha)
  const committed = restoredAtIndex === -1 ? committedAll : committedAll.slice(0, restoredAtIndex + 1)
  let cursor = boundary.startHead
  for (const [index, entry] of committed.entries()) {
    if (entry.beforeSha !== cursor) {
      return {
        ok: false,
        kind: "ledger-gap",
        reason: `the run's commit ledger does not chain from its boundary (entry ${index + 1} starts at ${entry.beforeSha.slice(0, 8)}, expected ${cursor.slice(0, 8)})`,
      }
    }
    cursor = entry.afterSha!
  }
  if (committed.length > 0 && cursor !== headSha) {
    return {
      ok: false,
      kind: "ledger-gap",
      reason: `the run's commit ledger ends at ${cursor.slice(0, 8)} but the branch tip is ${headSha.slice(0, 8)}`,
    }
  }

  // Every commit in the git range must be a ledgered current-run commit, and
  // every ledgered commit must exist in the range.
  const ledgerBySha = new Map(committed.map((entry) => [entry.afterSha!, entry]))
  const rangeShas = new Set(rangeCommits.map((commit) => commit.sha))
  for (const commit of rangeCommits) {
    const entry = ledgerBySha.get(commit.sha)
    if (!entry) {
      return {
        ok: false,
        kind: "unaccounted-commit",
        reason: `commit ${commit.sha.slice(0, 8)} "${commit.subject}" is not owned by this run; automatic compaction refuses to rewrite history it did not record`,
      }
    }
    if (commit.parents.length !== 1) {
      return { ok: false, kind: "merge-commit", reason: `commit ${commit.sha.slice(0, 8)} is a merge; automatic compaction only rewrites linear run work` }
    }
    const expectedTrailer = `${convoyRunTrailerPrefix} ${runID}`
    const hasTrailer = commit.body.split("\n").some((line) => line.trim() === expectedTrailer)
    if (!hasTrailer) {
      return { ok: false, kind: "trailer-mismatch", reason: `commit ${commit.sha.slice(0, 8)} does not carry this run's ${convoyRunTrailerPrefix} trailer` }
    }
  }
  for (const sha of ledgerBySha.keys()) {
    if (!rangeShas.has(sha)) {
      return { ok: false, kind: "ledger-gap", reason: `ledgered commit ${sha.slice(0, 8)} is no longer on the branch between the boundary and HEAD` }
    }
  }

  // Authoritative fallback cross-check: the ledger and git must agree on the
  // total count even for a run whose entries were recorded out of order.
  if (committed.length !== rangeCommits.length) {
    return { ok: false, kind: "ledger-gap", reason: "the commit ledger and the branch history disagree on the run's commits" }
  }

  return {
    ok: true,
    startHead: boundary.startHead,
    headSha,
    startTree,
    headTree,
    commits: rangeCommits.map((commit) => ({
      sha: commit.sha,
      subject: commit.subject,
      step: ledgerBySha.get(commit.sha)?.step ?? "",
      mode: ledgerBySha.get(commit.sha)!.mode,
    })),
  }
}

