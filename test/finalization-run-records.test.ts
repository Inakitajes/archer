import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { listRuns, loadRunSummary, readRunIndexEntry } from "../src/runs"

/**
 * The cleanup-surviving run-record index (capability run-finalization, task
 * 1.5): deleting a disposable run workspace must not delete the run's
 * discoverability, its finalization evidence, or the exact Git inspection
 * commands the historical views quote from the retained endpoints.
 */

const dirs: string[] = []
let savedHome: string | undefined

afterAll(async () => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const runID = "20260905-140000-ab12"
const startHead = "aaaa0000aaaa0000aaaa0000aaaa0000aaaa0000"
const preCompactionHead = "bbbb1111bbbb1111bbbb1111bbbb1111bbbb1111"
const producedSha = "cccc2222cccc2222cccc2222cccc2222cccc2222"
const recoveryRef = `refs/convoy/runs/${runID}/pre-compaction`

async function writeRunIndex(dir: string, body: Record<string, unknown>) {
  await mkdir(join(dir, ".convoy", "run-records"), { recursive: true })
  await writeFile(join(dir, ".convoy", "run-records", `${runID}.json`), JSON.stringify(body, null, 2))
}

describe("run discovery merges the run-record index", () => {
  test("a run whose workspace was cleaned stays discoverable with its evidence", async () => {
    const home = await mkdtemp(join(tmpdir(), "convoy-home-"))
    dirs.push(home)
    savedHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = home

    // No workspace runs exist; only the index record does.
    await writeRunIndex(home, {
      schemaVersion: 1,
      runID,
      title: "Fix the compaction interval",
      worktreeDir: "/repo/worktrees/feat",
      branch: "feat/compaction",
      manifestPath: "/repo/.git/convoy/finalization/manifest.json",
      startHead,
      preCompactionHead,
      producedSha,
      disposition: "compacted",
      state: "completed",
      recoveryRef,
      recordedAt: 1,
      updatedAt: 2,
    })

    const runs = await listRuns()
    const entry = runs.find((run) => run.runID === runID)
    expect(entry).toBeDefined()
    expect(entry!.statusKind).toBe("completed")
    expect(entry!.title).toBe("Fix the compaction interval")
    expect(entry!.finalization?.state).toBe("completed")
    expect(entry!.finalization?.recoveryRef).toBe(recoveryRef)
    expect(entry!.finalization?.preCompactionHead).toBe(preCompactionHead)

    // The historical view quotes exact, guarded Git inspection commands from
    // the retained endpoints — never an unconditional hard reset.
    const summary = await loadRunSummary(entry!)
    expect(summary).toContain(`git diff ${startHead} ${preCompactionHead}`)
    expect(summary).toContain(`git show ${producedSha}`)
    expect(summary).toContain(`git branch recover/${runID} ${recoveryRef}`)
    expect(summary).not.toMatch(/git reset --hard/)
  })

  test("a malformed index record never breaks run discovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "convoy-home-"))
    dirs.push(home)
    await mkdir(join(home, ".convoy", "run-records"), { recursive: true })
    await writeFile(join(home, ".convoy", "run-records", "20260905-150000-ba1.json"), "{not json")
    const runs = await listRuns()
    expect(runs.find((run) => run.runID === "20260905-150000-ba1")).toBeUndefined()
  })

  test("the cleanup-surviving index preserves the reviewed feature link (task 5.1)", async () => {
    const home = await mkdtemp(join(tmpdir(), "convoy-home-"))
    dirs.push(home)
    savedHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = home

    await writeRunIndex(home, {
      schemaVersion: 1,
      runID,
      title: "Feature-backed run",
      worktreeDir: "/repo/worktrees/feat/add-widget",
      branch: "feat/add-widget",
      feature: {
        featureId: "aaaaaaaa-0000-4000-8000-00000000abc1",
        associationRevision: 3,
        branch: "feat/add-widget",
        baseRef: "main",
        contracts: ["add-widget"],
      },
      disposition: "compacted",
      state: "completed",
      recordedAt: 1,
      updatedAt: 2,
    })

    const record = await readRunIndexEntry(runID)
    expect(record).toBeDefined()
    expect(record!.feature).toEqual({
      featureId: "aaaaaaaa-0000-4000-8000-00000000abc1",
      associationRevision: 3,
      branch: "feat/add-widget",
      baseRef: "main",
      contracts: ["add-widget"],
    })
  })

  test("a malformed feature link is dropped without inventing identity (task 5.1)", async () => {
    const home = await mkdtemp(join(tmpdir(), "convoy-home-"))
    dirs.push(home)
    savedHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = home

    // writeRunIndex writes under the module-level runID; a fresh home keeps it
    // isolated from the happy-parse test above.
    await writeRunIndex(home, {
      schemaVersion: 1,
      runID,
      title: "Run with a malformed feature link",
      // featureId is not a string, so the link is dropped rather than
      // interpreted — readers never invent identity.
      feature: { featureId: 42, associationRevision: "nope", branch: ["bad"] },
      state: "completed",
    })

    const record = await readRunIndexEntry(runID)
    expect(record).toBeDefined()
    expect(record!.feature).toBeUndefined()
    expect(record!.state).toBe("completed")
  })
})
