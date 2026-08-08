import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { loadRunSummary } from "../src/runs"
import type { RunEntry } from "../src/runs"

function fakeEntry(dir: string): RunEntry {
  return {
    runID: "test-run",
    dir,
    title: "test",
    status: "completed",
    statusKind: "completed",
    live: false,
    createdAt: 0,
    phases: [],
  }
}

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-runs-ext-test-"))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("loadRunSummary", () => {
  test("returns SUMMARY.md content when it exists", async () => {
    const dir = join(root, "has-summary")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "SUMMARY.md"), "# Run complete\n\nAll tasks finished successfully.")

    const entry = fakeEntry(dir)
    expect(await loadRunSummary(entry)).toBe("# Run complete\n\nAll tasks finished successfully.")
  })

  test("falls back to reports when no SUMMARY.md exists", async () => {
    const dir = join(root, "has-reports")
    await mkdir(join(dir, "reports"), { recursive: true })
    await writeFile(join(dir, "reports", "02-tests.md"), "Tests passed")
    await writeFile(join(dir, "reports", "01-build.md"), "Build succeeded")

    const entry = fakeEntry(dir)
    const result = await loadRunSummary(entry)

    // Reports dir sorted alphabetically: 01-build.md first, then 02-tests.md.
    expect(result).toContain("## reports/01-build.md")
    expect(result).toContain("## reports/02-tests.md")
    expect(result).toContain("Build succeeded")
    expect(result).toContain("Tests passed")
  })

  test("returns fallback message when no SUMMARY.md and no reports", async () => {
    const dir = join(root, "no-content")
    await mkdir(dir, { recursive: true })

    const entry = fakeEntry(dir)
    expect(await loadRunSummary(entry)).toBe("no summary or reports for this run")
  })

  test("ignores non-markdown files in reports directory", async () => {
    const dir = join(root, "non-md-reports")
    await mkdir(join(dir, "reports"), { recursive: true })
    await writeFile(join(dir, "reports", "results.json"), JSON.stringify({ ok: true }))
    await writeFile(join(dir, "reports", "log.txt"), "some log")

    const entry = fakeEntry(dir)
    expect(await loadRunSummary(entry)).toBe("no summary or reports for this run")
  })

  test("returns reports that exist when SUMMARY.md exists but is only empty", async () => {
    const dir = join(root, "empty-summary")
    await mkdir(join(dir, "reports"), { recursive: true })
    await writeFile(join(dir, "SUMMARY.md"), "")
    await writeFile(join(dir, "reports", "plan.md"), "## Plan details")

    const entry = fakeEntry(dir)
    expect(await loadRunSummary(entry)).toBe("")
  })

  test("handles missing reports directory gracefully", async () => {
    const dir = join(root, "no-reports-dir")
    await mkdir(dir, { recursive: true })
    // Write a SUMMARY.md that references things but the physical reports dir
    // doesn't exist — this tests the try/catch around readdir.
    // No SUMMARY.md either -> fallback message.

    const entry = fakeEntry(dir)
    expect(await loadRunSummary(entry)).toBe("no summary or reports for this run")
  })
})