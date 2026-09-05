import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { currentHead, execFile, resolveCommit } from "../src/git"
import { runFinalization } from "../src/finalization/compact"
import { verifyRunInterval } from "../src/finalization/interval"
import { preCompactionRef, protectAttemptTip, runRefPrefix } from "../src/finalization/refs"
import { restoreBestEffort } from "../src/goal-policy"
import type { CommitLedgerEntry, RunBoundary } from "../src/finalization/types"

/**
 * Goal settlement restores the best measured state (capability run-finalization,
 * scenario "Goal settlement selects an earlier state"): the branch is reset back
 * to a ledgered attempt commit, so the durable ledger now records attempts that
 * were discarded after HEAD. Finalization must compact the surviving final
 * state — the ledger chain truncated at the restored HEAD — instead of blocking
 * with a ledger gap. The discarded attempt tips are protected by per-run refs
 * before the restore, so the rewrite still loses nothing inspectable.
 */

const dirs: string[] = []
const runID = "20260905-130000-restore"
const convoyEnv = { GIT_AUTHOR_NAME: "convoy", GIT_AUTHOR_EMAIL: "convoy@local", GIT_COMMITTER_NAME: "convoy", GIT_COMMITTER_EMAIL: "convoy@local" }
let savedHome: string | undefined

// runFinalization writes the cleanup-surviving index under
// <convoy-home>/run-records, so isolate the home or a real record leaks into
// other tests that read the index.
beforeAll(async () => {
  savedHome = process.env.CONVOY_HOME
  const home = await mkdtemp(join(tmpdir(), "convoy-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function git(args: string[], cwd: string, env: Record<string, string> = {}) {
  return await execFile("git", args, { cwd, env })
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-restore-"))
  dirs.push(dir)
  await git(["init", "-q", "-b", "main"], dir)
  await git(["config", "user.name", "Test Operator"], dir)
  await git(["config", "user.email", "op@example.com"], dir)
  await writeFile(join(dir, "base.txt"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", "base"], dir, convoyEnv)
  return dir
}

async function runCommit(dir: string, file: string, content: string, step: string) {
  await writeFile(join(dir, file), content)
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", `convoy(${step}): ${file}\n\nConvoy-Run: ${runID}`], dir, convoyEnv)
}

async function ledgerFor(dir: string, startHead: string): Promise<CommitLedgerEntry[]> {
  const entries: CommitLedgerEntry[] = []
  const log = await git(["log", "--reverse", "--format=%H%x1f%s%x1f%P", `${startHead}..HEAD`], dir)
  for (const line of log.stdout.split("\n").filter(Boolean)) {
    const [sha = "", subject = "", parents = ""] = line.split("\x1f")
    const step = /convoy\(([^)]*)\)/.exec(subject)?.[1] ?? "step"
    const tree = await git(["rev-parse", `${sha}^{tree}`], dir)
    entries.push({ schemaVersion: 1, mode: "phase", step, beforeSha: parents.trim() || startHead, afterSha: sha, afterTree: tree.stdout.trim(), recordedAt: 1 })
  }
  return entries
}

describe("finalization after goal settlement restores an earlier state", () => {
  test("the restored surviving attempt compacts instead of blocking on a ledger gap", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    const boundary: RunBoundary = { schemaVersion: 1, worktreeDir: dir, branch: "main", startHead, commonDir: "", includeDirty: false, recordedAt: 1 }

    // Attempt one improves the repository (the best measured state, score 84).
    await runCommit(dir, "attempt-one.txt", "attempt one\n", "fix")
    const bestHead = (await currentHead(dir))!
    // Attempt two measures lower and is discarded by goal settlement.
    await runCommit(dir, "attempt-two.txt", "attempt two\n", "fix")
    const finalHeadBeforeRestore = (await currentHead(dir))!
    const ledger = await ledgerFor(dir, startHead)
    expect(ledger).toHaveLength(2)

    // Goal settlement restores the best measured state: the branch goes back to
    // the attempt-one commit exactly as restoreRepoSnapshot does.
    await git(["reset", "--hard", bestHead], dir)
    expect(await currentHead(dir)).toBe(bestHead)

    // The surviving interval is the restored attempt alone; the ledger entries
    // past it were discarded by settlement, not lost by an external mutation.
    const interval = await verifyRunInterval(boundary, ledger, runID, dir)
    expect(interval.ok).toBe(true)
    if (!interval.ok) return
    expect(interval.commits.map((commit) => commit.sha)).toEqual([bestHead])
    expect(interval.startHead).toBe(startHead)
    expect(interval.headSha).toBe(bestHead)

    // Finalization compacts the surviving state into one operator commit.
    const record = await runFinalization({
      runID,
      targetDir: dir,
      boundary,
      ledger,
      branch: "main",
      composeMessage: async () => "feat: attempt one\n\nConvoy-Change: restore",
    })
    expect(record.state).toBe("completed")
    expect(record.producedSha).toBeDefined()
    const producedParent = (await execFile("git", ["rev-parse", `${record.producedSha}^`], { cwd: dir, allowFailure: true })).stdout.trim()
    expect(producedParent).toBe(startHead)
    // The discarded attempt's commit survives behind the protected ref created
    // during finalization (its ledger tip), not on the branch.
    expect(await resolveCommit(finalHeadBeforeRestore, dir)).toBe(finalHeadBeforeRestore)
    expect(await currentHead(dir)).toBe(record.producedSha)
  })

  test("a restore to a non-ledgered commit still refuses the rewrite", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    const boundary: RunBoundary = { schemaVersion: 1, worktreeDir: dir, branch: "main", startHead, commonDir: "", includeDirty: false, recordedAt: 1 }
    await runCommit(dir, "attempt-one.txt", "attempt one\n", "fix")
    const ledger = await ledgerFor(dir, startHead)

    // Someone (not goal settlement) moved the branch to an unrelated commit:
    // the ledger cannot account for it, so finalization must still refuse.
    await git(["checkout", "--detach", startHead], dir)
    await runCommit(dir, "foreign.txt", "foreign\n", "other")
    await git(["checkout", "-q", "-B", "main", "HEAD"], dir)

    const interval = await verifyRunInterval(boundary, ledger, runID, dir)
    expect(interval.ok).toBe(false)
    if (interval.ok) return
    expect(interval.kind).not.toBe("no-boundary")
  })
})

describe("goal attempt tip protection gates restoration", () => {
  test("an already-protected tip stays protected and a fresh tip is created create-only", async () => {
    const dir = await repo()
    const sha = (await currentHead(dir))!
    const ref = `${runRefPrefix(runID)}/goal-attempts/${sha.slice(0, 12)}`
    expect(await protectAttemptTip(ref, sha, dir)).toBe(true)
    expect(await resolveCommit(ref, dir)).toBe(sha)
    // Restoring the same best state twice must not fail on the existing ref.
    expect(await protectAttemptTip(ref, sha, dir)).toBe(true)
  })

  test("a protection failure refuses the restoration instead of resetting the tip away", async () => {
    // Outside any repository every ref write fails, exactly like a failing
    // evidence-ref write in a real worktree.
    const outside = await mkdtemp(join(tmpdir(), "convoy-norepo-"))
    dirs.push(outside)
    const ref = `${runRefPrefix(runID)}/goal-attempts/abc123def456`
    expect(await protectAttemptTip(ref, "abc123def456abc123def456abc123def456abc1", outside)).toBe(false)

    // The runner's restoreSnapshot dep throws on that failure, so
    // restoreBestEffort reports the restoration as refused and leaves the
    // branch untouched — the discarded tip is never reset away unprotected.
    const deferredLogs: { level: "info" | "warn"; message: string }[] = []
    const restored = await restoreBestEffort(
      { score: 84, snapshot: { head: "abc123def456abc123def456abc123def456abc1" } },
      outside,
      async () => {
        const ok = await protectAttemptTip(ref, "abc123def456abc123def456abc123def456abc1", outside)
        if (!ok) throw new Error(`couldn't protect the goal attempt tip abc123def456 behind its evidence ref; refusing to restore the best measured state`)
      },
      async () => true,
      undefined,
      async () => "abc123def456abc123def456abc123def456abc1",
      deferredLogs,
    )
    expect(restored).toBe(false)
    expect(deferredLogs.some((entry) => entry.message.includes("could not restore the best measured state"))).toBe(true)
    expect(await protectAttemptTip(preCompactionRef(runID), "abc123def456abc123def456abc123def456abc1", outside)).toBe(false)
  })
})
