import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import {
  createWorkspace,
  resumeWorkspace,
  cleanupWorkspace,
  writeSummary,
  runDir,
} from "../src/workspace"

let origHome: string | undefined
let tempRoot: string

beforeAll(async () => {
  origHome = process.env.CONVOY_HOME
  tempRoot = await mkdtemp(join(tmpdir(), "convoy-ws-ext-test-"))
  process.env.CONVOY_HOME = tempRoot
})

afterAll(async () => {
  try {
    if (origHome === undefined) delete process.env.CONVOY_HOME
    else process.env.CONVOY_HOME = origHome
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
})

describe("createWorkspace", () => {
  test("creates a workspace with a valid runID and writes prd.md", async () => {
    const ws = await createWorkspace("test prompt content")
    expect(ws.runID).toMatch(/^\d{8}-\d{6}-[a-z0-9]{4}$/)
    expect(ws.dir).toContain(ws.runID)

    const prd = await readFile(join(ws.dir, "prd.md"), "utf8")
    expect(prd).toBe("test prompt content")
  })

  test("creates subdirectories (logs, reports, diffs, events)", async () => {
    const ws = await createWorkspace("prompt")
    for (const sub of ["logs", "reports", "diffs", "events"]) {
      const subDir = join(ws.dir, sub)
      const d = await import("node:fs/promises").then((m) => m.stat(subDir))
      expect(d.isDirectory()).toBe(true)
    }
  })
})

describe("resumeWorkspace", () => {
  test("resumes an existing workspace dir by runID", async () => {
    const ws = await createWorkspace("prompt")
    const resumed = await resumeWorkspace(ws.runID)
    expect(resumed.runID).toBe(ws.runID)
    expect(resumed.dir).toBe(ws.dir)
  })

  test("throws for a non-existent runID", async () => {
    await expect(resumeWorkspace("20240101-120000-abcd")).rejects.toThrow(
      "doesn't exist",
    )
  })

  test("throws for an invalid runID", async () => {
    await expect(resumeWorkspace("bad-id")).rejects.toThrow("invalid run id")
  })
})

describe("cleanupWorkspace", () => {
  test("removes the workspace directory", async () => {
    const ws = await createWorkspace("prompt")
    await cleanupWorkspace(ws)
    await expect(import("node:fs/promises").then((m) => m.stat(ws.dir))).rejects.toThrow()
  })

  test("throws for a directory outside runs root", async () => {
    const outsideDir = join(tempRoot, "outside-test")
    await mkdir(outsideDir, { recursive: true })
    await expect(cleanupWorkspace({ dir: outsideDir, runID: "test" })).rejects.toThrow()
  })

  test("is idempotent (does not throw if dir already gone)", async () => {
    const ws = await createWorkspace("prompt")
    await cleanupWorkspace(ws)
    await expect(cleanupWorkspace(ws)).resolves.toBeUndefined()
  })
})

describe("writeSummary", () => {
  test("creates SUMMARY.md with phase names", async () => {
    const ws = await createWorkspace("prompt")
    await writeSummary(ws, ["plan", "code", "test"])
    const summary = await readFile(join(ws.dir, "SUMMARY.md"), "utf8")
    expect(summary).toContain(`# convoy run ${ws.runID} - summary`)
    expect(summary).toContain("## plan")
    expect(summary).toContain("## code")
    expect(summary).toContain("## test")
  })

  test("includes extra sections before phases", async () => {
    const ws = await createWorkspace("prompt")
    await writeSummary(ws, ["plan"], ["extra line 1", "extra line 2"])
    const summary = await readFile(join(ws.dir, "SUMMARY.md"), "utf8")
    expect(summary).toContain("extra line 1")
    expect(summary).toContain("extra line 2")
    const planIndex = summary.indexOf("## plan")
    const extraIndex = summary.indexOf("extra line 1")
    expect(extraIndex).toBeLessThan(planIndex)
  })

  test("includes report content when reports exist", async () => {
    const ws = await createWorkspace("prompt")
    await mkdir(join(ws.dir, "reports"), { recursive: true })
    await writeFile(join(ws.dir, "reports", "plan.md"), "## Plan content")
    await writeSummary(ws, ["plan"])
    const summary = await readFile(join(ws.dir, "SUMMARY.md"), "utf8")
    expect(summary).toContain("## Plan content")
  })

  test("shows (no report) when report file does not exist", async () => {
    const ws = await createWorkspace("prompt")
    await writeSummary(ws, ["plan"])
    const summary = await readFile(join(ws.dir, "SUMMARY.md"), "utf8")
    expect(summary).toContain("_(no report)_")
  })
})

describe("runDir", () => {
  test("returns the expected path for a valid runID", () => {
    const path = runDir("20240101-120000-abcd")
    expect(path).toContain("runs")
    expect(path).toContain("20240101-120000-abcd")
  })

  test("throws for an invalid runID", () => {
    expect(() => runDir("bad-id")).toThrow("invalid run id")
  })
})
