import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

import { describe, expect, test } from "bun:test"

import { createWorkspace, isValidRunID, renderScoreboard, runDir, runsRoot, writeSummary } from "../src/workspace"
import type { ScoreboardRow } from "../src/workspace"

describe("workspace run IDs", () => {
  test("accepts generated run ID shape", () => {
    expect(isValidRunID("20260519-103045-x7q2")).toBe(true)
  })

  test("rejects traversal and arbitrary names", () => {
    expect(isValidRunID("../20260519-103045-x7q2")).toBe(false)
    expect(isValidRunID("latest")).toBe(false)
    expect(() => runDir("../20260519-103045-x7q2")).toThrow("invalid run id")
  })

  test("resolves run dirs under the convoy runs root", () => {
    const id = "20260519-103045-x7q2"
    const pathFromRoot = relative(runsRoot(), runDir(id))

    expect(pathFromRoot).toBe(id)
    expect(pathFromRoot.startsWith("..")).toBe(false)
    expect(isAbsolute(pathFromRoot)).toBe(false)
  })

  test("creates private run directories and prompt files", async () => {
    if (process.platform === "win32") return
    const root = await mkdtemp(join(tmpdir(), "convoy-private-workspace-"))
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = root

    try {
      const workspace = await createWorkspace("confidential prompt")
      expect((await stat(workspace.dir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(workspace.dir, "prd.md"))).mode & 0o777).toBe(0o600)
      expect(await readFile(join(workspace.dir, "prd.md"), "utf8")).toBe("confidential prompt")
    } finally {
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe("renderScoreboard", () => {
  test("returns undefined when all rows have no diff", () => {
    const rows: ScoreboardRow[] = [
      { name: "review", status: "completed", diff: undefined },
      { name: "security", status: "completed", diff: undefined },
    ]
    expect(renderScoreboard(rows)).toBeUndefined()
  })

  test("returns undefined for an empty row list", () => {
    expect(renderScoreboard([])).toBeUndefined()
  })

  test("renders a scoreboard with one phase that has diff data", () => {
    const rows: ScoreboardRow[] = [
      { name: "implement", status: "completed", diff: { files: 2, insertions: 41, deletions: 3 } },
    ]
    const result = renderScoreboard(rows)
    expect(result).toBeDefined()
    expect(result).toContain("## Scoreboard")
    expect(result).toContain("| implement | 2 | +41 | −3 | +38 |")
    expect(result).toContain("| **Total** | **2** | **+41** | **−3** | **+38** |")
  })

  test("renders dashes for phases without diff data", () => {
    const rows: ScoreboardRow[] = [
      { name: "implement", status: "completed", diff: { files: 2, insertions: 41, deletions: 3 } },
      { name: "security", status: "completed", diff: undefined },
    ]
    const result = renderScoreboard(rows)
    expect(result).toBeDefined()
    expect(result).toContain("| implement | 2 | +41 | −3 | +38 |")
    expect(result).toContain("| security | — | — | — | — |")
    expect(result).toContain("| **Total** | **2** | **+41** | **−3** | **+38** |")
  })

  test("renders negative delta correctly", () => {
    const rows: ScoreboardRow[] = [
      { name: "fixer", status: "completed", diff: { files: 1, insertions: 3, deletions: 10 } },
    ]
    const result = renderScoreboard(rows)
    expect(result).toContain("| fixer | 1 | +3 | −10 | -7 |")
    expect(result).toContain("| **Total** | **1** | **+3** | **−10** | **-7** |")
  })

  test("aggregates totals across multiple phases with data", () => {
    const rows: ScoreboardRow[] = [
      { name: "implement", status: "completed", diff: { files: 2, insertions: 41, deletions: 3 } },
      { name: "tests", status: "completed", diff: { files: 3, insertions: 20, deletions: 5 } },
      { name: "review", status: "completed", diff: undefined },
    ]
    const result = renderScoreboard(rows)
    expect(result).toBeDefined()
    expect(result).toContain("| **Total** | **5** | **+61** | **−8** | **+53** |")
  })
})

describe("writeSummary scoreboard integration", () => {
  test("inserts scoreboard after header when provided", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-summary-scoreboard-"))
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = root

    try {
      const workspace = await createWorkspace("test prompt")
      const scoreboard = "## Scoreboard\n\n| Phase | Files | + | − | Δ net |\n|---|---|---|---|---|\n| implement | 1 | +5 | −0 | +5 |\n| **Total** | **1** | **+5** | **−0** | **+5** |"

      await writeSummary(workspace, ["implement"], [], scoreboard)

      const content = await readFile(join(workspace.dir, "SUMMARY.md"), "utf8")
      const headerIndex = content.indexOf("# convoy run")
      const scoreboardIndex = content.indexOf("## Scoreboard")
      const phaseIndex = content.indexOf("## implement")

      expect(headerIndex).toBeGreaterThanOrEqual(0)
      expect(scoreboardIndex).toBeGreaterThan(headerIndex)
      expect(phaseIndex).toBeGreaterThan(scoreboardIndex)
    } finally {
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })

  test("produces identical output to the current contract when no scoreboard is given", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-summary-no-scoreboard-"))
    const previousHome = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = root

    try {
      const workspace = await createWorkspace("test prompt")

      // Without scoreboard
      await writeSummary(workspace, ["implement"], [])
      const withoutScoreboard = await readFile(join(workspace.dir, "SUMMARY.md"), "utf8")

      // With undefined (same as not passing)
      await writeSummary(workspace, ["implement"], [], undefined)
      const withUndefined = await readFile(join(workspace.dir, "SUMMARY.md"), "utf8")

      expect(withUndefined).toBe(withoutScoreboard)
      expect(withoutScoreboard).not.toContain("## Scoreboard")
    } finally {
      if (previousHome === undefined) delete process.env.CONVOY_HOME
      else process.env.CONVOY_HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
})
