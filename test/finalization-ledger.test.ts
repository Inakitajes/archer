import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { currentHead, execFile, resolveCommit } from "../src/git"
import { runFinalization } from "../src/finalization/compact"
import { gitCommonDir, preCompactionRef, resolveRef } from "../src/finalization/refs"
import { recordLedgeredCommit } from "../src/finalization/ledger"
import type { CommitLedgerEntry } from "../src/finalization/types"
import { persistRunBoundary } from "../src/runner"
import type { Pipeline, RunOptions } from "../src/types"

const dirs: string[] = []
const runID = "20260905-130000-ledger"
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
  const dir = await mkdtemp(join(tmpdir(), "convoy-ledger-"))
  dirs.push(dir)
  await git(["init", "-q", "-b", "main"], dir)
  await git(["config", "user.name", "Test Operator"], dir)
  await git(["config", "user.email", "op@example.com"], dir)
  await Bun.write(join(dir, "base.txt"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", "base"], dir, convoyEnv)
  return dir
}

function pipelineWith(steps: Array<{ type: "agent"; name: string; readOnly?: boolean }>): Pipeline {
  return { name: "test", steps } as unknown as Pipeline
}

describe("recordLedgeredCommit", () => {
  test("records before/after endpoints and the tree for a committing action", async () => {
    const dir = await repo()
    const before = (await currentHead(dir))!
    const entries: CommitLedgerEntry[] = []
    await recordLedgeredCommit(
      async (entry) => {
        entries.push(entry)
      },
      { mode: "phase", step: "design", cwd: dir },
      async () => {
        await Bun.write(join(dir, "a.txt"), "a\n")
        await git(["add", "-A"], dir)
        await git(["commit", "-qm", `convoy(design): a.txt\n\nConvoy-Run: ${runID}`], dir, convoyEnv)
      },
    )
    expect(entries).toHaveLength(1)
    const entry = entries[0]!
    expect(entry.mode).toBe("phase")
    expect(entry.step).toBe("design")
    expect(entry.beforeSha).toBe(before)
    expect(entry.afterSha).toBe(await currentHead(dir))
    expect(entry.afterTree).toBeTruthy()
    expect(entry.noChange).toBeUndefined()
  })

  test("records an explicit no-change entry when the action commits nothing", async () => {
    const dir = await repo()
    const before = (await currentHead(dir))!
    const entries: CommitLedgerEntry[] = []
    await recordLedgeredCommit(
      async (entry) => {
        entries.push(entry)
      },
      { mode: "human", step: "review", cwd: dir },
      async () => {},
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]!.noChange).toBe(true)
    expect(entries[0]!.afterSha).toBeUndefined()
    expect(entries[0]!.beforeSha).toBe(before)
  })
})

describe("persistRunBoundary", () => {
  test("refuses to start writable execution when the boundary cannot be persisted", async () => {
    const dir = await repo()
    const failing = {
      recordBoundary: () => Promise.reject(new Error("disk full")),
    }
    const options = { targetDir: dir, includeDirty: false } as unknown as RunOptions
    const writable = pipelineWith([{ type: "agent", name: "design" }])
    await expect(persistRunBoundary(failing as never, options, writable)).rejects.toThrow("refusing to start writable work")
  })

  test("a read-only-only pipeline proceeds when the boundary cannot be persisted", async () => {
    const dir = await repo()
    const failing = {
      recordBoundary: () => Promise.reject(new Error("disk full")),
    }
    const options = { targetDir: dir, includeDirty: false } as unknown as RunOptions
    const readOnly = pipelineWith([{ type: "agent", name: "score", readOnly: true }])
    await expect(persistRunBoundary(failing as never, options, readOnly)).resolves.toBeUndefined()
  })

  test("records the run-start HEAD, branch, and common dir", async () => {
    const dir = await repo()
    const recorded: unknown[] = []
    const store = { recordBoundary: (b: unknown) => (recorded.push(b), Promise.resolve()) }
    const options = { targetDir: dir, includeDirty: true } as unknown as RunOptions
    await persistRunBoundary(store as never, options, pipelineWith([{ type: "agent", name: "design" }]))
    const boundary = recorded[0] as { startHead: string; branch: string; includeDirty: boolean; worktreeDir: string }
    expect(boundary.startHead).toBe((await currentHead(dir))!)
    expect(boundary.branch).toBe("main")
    expect(boundary.includeDirty).toBe(true)
    expect(boundary.worktreeDir).toBe(dir)
  })
})

describe("prepared-journal reconciliation", () => {
  test("a crash after the soft reset restores the branch and the fresh attempt compacts", async () => {
    const dir = await repo()
    const startHead = (await currentHead(dir))!
    await Bun.write(join(dir, "a.txt"), "a\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-qm", `convoy(design): a.txt\n\nConvoy-Run: ${runID}`], dir, convoyEnv)
    const preHead = (await currentHead(dir))!

    // Build the truthful ledger, then simulate a stopped attempt: journal says
    // "prepared" and the branch sits at the run start with the original tree staged.
    const tree = (await git(["rev-parse", `${preHead}^{tree}`], dir)).stdout.trim()
    const ledger: CommitLedgerEntry[] = [
      { schemaVersion: 1, mode: "phase", step: "design", beforeSha: startHead, afterSha: preHead, afterTree: tree, recordedAt: 1 },
    ]
    const common = (await gitCommonDir(dir))!
    const journalPath = join(common, "convoy", "finalization", `${runID}.json`)
    await Bun.write(
      journalPath,
      JSON.stringify({ schemaVersion: 1, runID, branch: "main", originalHead: preHead, startHead, headTree: tree, phase: "prepared", updatedAt: 1 }),
    )
    await git(["reset", "--soft", startHead], dir)

    const record = await runFinalization({
      runID,
      targetDir: dir,
      boundary: { schemaVersion: 1, worktreeDir: dir, branch: "main", startHead, commonDir: "", includeDirty: false, recordedAt: 1 },
      ledger,
      branch: "main",
      composeMessage: async () => "feat: add the thing",
    })
    expect(record.state).toBe("completed")
    const head = (await currentHead(dir))!
    expect(head).not.toBe(preHead)
    expect(await resolveRef(preCompactionRef(runID), dir)).toBe(preHead)
    // The journal was cleared by the reconciliation.
    expect(await Bun.file(journalPath).exists()).toBe(true) // rewritten as "committed" by the fresh attempt
    const journal = JSON.parse(await Bun.file(journalPath).text())
    expect(journal.phase).toBe("committed")
  })
})
