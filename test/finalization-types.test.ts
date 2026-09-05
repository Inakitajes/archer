import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  readCommitLedger,
  readFinalizationRecord,
  readLedgerEntry,
  readRunBoundary,
  type CommitLedgerEntry,
  type FinalizationRecord,
  type RunBoundary,
} from "../src/finalization/types"
import { openRunMetadata } from "../src/metadata"
import type { Pipeline } from "../src/types"

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("run boundary reader", () => {
  test("round-trips a complete boundary", () => {
    const boundary: RunBoundary = {
      schemaVersion: 1,
      worktreeDir: "/repo",
      branch: "feat/x",
      startHead: "a".repeat(40),
      commonDir: "/repo/.git",
      includeDirty: true,
      recordedAt: 100,
    }
    const read = readRunBoundary(JSON.parse(JSON.stringify(boundary)))
    expect(read).toEqual(boundary)
  })

  test("tolerates missing optional fields", () => {
    const read = readRunBoundary({ startHead: "b".repeat(40), recordedAt: 5 })
    expect(read?.branch).toBeUndefined()
    expect(read?.includeDirty).toBe(false)
    expect(read?.worktreeDir).toBe("")
  })

  test("undefined for absent or garbage shapes so legacy runs stay readable", () => {
    expect(readRunBoundary(undefined)).toBeUndefined()
    expect(readRunBoundary({})).toBeUndefined()
    expect(readRunBoundary("nope")).toBeUndefined()
    expect(readRunBoundary({ startHead: 42 })).toBeUndefined()
  })
})

describe("commit ledger reader", () => {
  const valid: CommitLedgerEntry = {
    schemaVersion: 1,
    mode: "phase",
    step: "implement",
    beforeSha: "c".repeat(40),
    afterSha: "d".repeat(40),
    afterTree: "e".repeat(40),
    recordedAt: 1,
  }

  test("round-trips entries and drops malformed ones", () => {
    expect(
      readCommitLedger([JSON.parse(JSON.stringify(valid)), { mode: "bogus" }, null, { mode: "human", step: "review", beforeSha: "x", recordedAt: 2 }]),
    ).toHaveLength(2)
  })

  test("no-change entries survive the round trip", () => {
    const entry = readLedgerEntry({ ...valid, afterSha: undefined, noChange: true, afterTree: undefined })
    expect(entry?.noChange).toBe(true)
    expect(entry?.afterSha).toBeUndefined()
  })

  test("a non-array ledger reads as empty, never throws", () => {
    expect(readCommitLedger(undefined)).toEqual([])
    expect(readCommitLedger("x")).toEqual([])
  })

  test("unknown modes are rejected, not guessed", () => {
    expect(readLedgerEntry({ mode: "machine", step: "s", beforeSha: "x" })).toBeUndefined()
  })
})

describe("finalization record reader", () => {
  test("round-trips every state including recovery-required", () => {
    const states: FinalizationRecord["state"][] = ["pending", "running", "completed", "skipped", "blocked", "failed"]
    for (const state of states) {
      const record: FinalizationRecord = { schemaVersion: 1, state, updatedAt: 9, ...(state === "failed" ? { recoveryRequired: true } : {}) }
      expect(readFinalizationRecord(JSON.parse(JSON.stringify(record)))?.state).toBe(state)
    }
  })

  test("unknown or missing states read as undefined (no compaction outcome)", () => {
    expect(readFinalizationRecord(undefined)).toBeUndefined()
    expect(readFinalizationRecord({ state: "exploded" })).toBeUndefined()
  })

  test("the pipeline result and the compaction result are separate records", () => {
    // A blocked finalization record carries no pipeline-failure semantics of
    // its own: nothing in its shape can masquerade as a pipeline verdict.
    const blocked = readFinalizationRecord({ state: "blocked", reason: "published commits" })!
    expect(blocked.state).toBe("blocked")
    expect(Object.keys(blocked)).not.toContain("goal")
  })
})

describe("run metadata store: boundary, ledger, and finalization", () => {
  async function workspace() {
    const dir = await mkdtemp(join(tmpdir(), "convoy-finalization-meta-"))
    dirs.push(dir)
    const ws = { dir: join(dir, "run"), runID: "20260905-000000-test" }
    await mkdir(ws.dir, { recursive: true })
    const pipeline: Pipeline = { name: "test", steps: [] } as unknown as Pipeline
    return { dir, ws, store: await openRunMetadata(ws, "/target", pipeline) }
  }

  test("recordBoundary is immutable across repeat calls (resume never replaces it)", async () => {
    const { ws, store } = await workspace()
    const first: RunBoundary = { schemaVersion: 1, worktreeDir: "/target", branch: "feat/a", startHead: "a".repeat(40), commonDir: "/target/.git", includeDirty: false, recordedAt: 1 }
    await store.recordBoundary(first)
    const changed = { ...first, startHead: "b".repeat(40), branch: "feat/b" }
    await store.recordBoundary(changed)
    expect(store.boundary()?.startHead).toBe(first.startHead)
    expect(store.boundary()?.branch).toBe("feat/a")

    // The persisted file agrees with the store view.
    const raw = JSON.parse(await readFile(join(ws.dir, "metadata.json"), "utf8"))
    expect(raw.schemaVersion).toBe(5)
    expect(raw.boundary.startHead).toBe(first.startHead)
  })

  test("appendLedgerEntry keeps insertion order and the ledger reader stays lossless", async () => {
    const { store } = await workspace()
    const entry: CommitLedgerEntry = { schemaVersion: 1, mode: "phase", step: "design", beforeSha: "a".repeat(40), afterSha: "b".repeat(40), recordedAt: 1 }
    const recovery: CommitLedgerEntry = { schemaVersion: 1, mode: "recovery", step: "design", beforeSha: "b".repeat(40), afterSha: "c".repeat(40), recordedAt: 2 }
    const noChange: CommitLedgerEntry = { schemaVersion: 1, mode: "human", step: "review", beforeSha: "c".repeat(40), noChange: true, recordedAt: 3 }
    await store.appendLedgerEntry(entry)
    await store.appendLedgerEntry(recovery)
    await store.appendLedgerEntry(noChange)
    expect(store.ledger().map((e) => e.mode)).toEqual(["phase", "recovery", "human"])
    expect(store.ledger()[2]?.noChange).toBe(true)
  })

  test("setFinalization persists the outcome independently of phases", async () => {
    const { ws, store } = await workspace()
    const record: FinalizationRecord = { schemaVersion: 1, state: "blocked", reason: "published commits", updatedAt: 7 }
    await store.setFinalization(record)
    expect(store.finalization()?.state).toBe("blocked")
    const raw = JSON.parse(await readFile(join(ws.dir, "metadata.json"), "utf8"))
    expect(raw.finalization.state).toBe("blocked")
    expect(raw.phases).toEqual({})
  })

  test("a legacy v4 metadata file stays readable with no finalization-era fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-finalization-legacy-"))
    dirs.push(dir)
    await writeFile(
      join(dir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 4,
        runID: "legacy",
        targetDir: "/target",
        createdAt: 1,
        updatedAt: 2,
        control: { state: "running" },
        phases: { design: { status: "completed" } },
      }),
    )
    const { readRunMetadata } = await import("../src/metadata")
    const raw = await readRunMetadata(join(dir, "metadata.json"))
    expect(raw?.schemaVersion).toBe(4)
    expect(raw?.boundary).toBeUndefined()
    expect(raw?.commitLedger).toBeUndefined()
    expect(raw?.finalization).toBeUndefined()
  })
})
