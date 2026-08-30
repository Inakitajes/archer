import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { SpecsResolution } from "../src/specs"

// The routing halves in cli.ts's openSpecsBrowser are thin, but tasks 3.2/3.3
// call for asserting the handoffs directly: apply-change must pass the preset
// change into launchRunTui, iterate-change must open the standalone session
// rooted at the repo dir with the change's planning files. bun runs every test
// file's top-level code before any tests execute, so mock.module here is
// visible process-wide; each mock therefore DELEGATES to the real module
// unless this file's tests have raised `capturing`, keeping sibling files
// (opencode.test.ts, specs.test.ts, launch-tui.test.ts) on real behavior.

const actualSpecs = await import("../src/specs")
const actualLaunchTui = await import("../src/launch-tui")
const actualOpencode = await import("../src/opencode")

// Snapshot the real functions BEFORE mock.module: bun patches the module
// record in place, so the namespace objects above reflect the mock once
// registered and would recurse if consulted through them.
const realBrowseSpecs = actualSpecs.browseSpecs
const realLoadSpecsView = actualSpecs.loadSpecsView
const realLaunchRunTui = actualLaunchTui.launchRunTui
const realOpenIterateWindow = actualOpencode.openIterateOpencodeWindow

let capturing = false
let nextResolution: SpecsResolution = { type: "exit" }
const launchCalls: Record<string, unknown>[] = []
const iterateCalls: Record<string, unknown>[] = []

mock.module("../src/specs", () => ({
  ...actualSpecs,
  browseSpecs: async (targetDir: string) => {
    if (!capturing) return realBrowseSpecs(targetDir)
    return nextResolution
  },
}))

mock.module("../src/launch-tui", () => ({
  ...actualLaunchTui,
  launchRunTui: async (options: Record<string, unknown>) => {
    if (!capturing) return realLaunchRunTui(options as never)
    launchCalls.push(options)
    return undefined
  },
}))

mock.module("../src/opencode", () => ({
  ...actualOpencode,
  openIterateOpencodeWindow: async (input: Record<string, unknown>) => {
    if (!capturing) return realOpenIterateWindow(input as never)
    iterateCalls.push(input)
    return undefined
  },
}))

const { openSpecsBrowser } = await import("../src/cli")

let root: string

beforeEach(async () => {
  capturing = true
  launchCalls.length = 0
  iterateCalls.length = 0
  root = await makeChangeRepo()
})

afterEach(async () => {
  capturing = false
  await rm(root, { recursive: true, force: true })
})

async function makeChangeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-specs-routing-"))
  const change = join(dir, "openspec", "changes", "add-login")
  await mkdir(join(change, "specs", "cli"), { recursive: true })
  await writeFile(join(change, "proposal.md"), "---\n---\n# Add Login\n\nwhy\n")
  await writeFile(join(change, "design.md"), "# Design\n\napproach\n")
  await writeFile(join(change, "tasks.md"), "# Tasks\n\n- [ ] do it\n")
  await writeFile(join(change, "specs", "cli", "spec.md"), "## ADDED Requirements\n")
  return dir
}

describe("openSpecsBrowser routing (specs viewer handoffs)", () => {
  test("the loaded view carries the normalized target directory", async () => {
    const view = await realLoadSpecsView(join(root, "."))
    expect(view.targetDir).toBe(root)
  })

  test("apply-change hands the change id to the launcher as the preset", async () => {
    nextResolution = { type: "apply-change", changeID: "add-login" }
    await openSpecsBrowser(root)
    expect(launchCalls).toHaveLength(1)
    expect(launchCalls[0]?.targetDir).toBe(root)
    expect(launchCalls[0]?.presetChange).toBe("add-login")
    expect(typeof launchCalls[0]?.prepareRun).toBe("function")
    expect(iterateCalls).toHaveLength(0)
  })

  test("iterate-change opens the standalone session rooted at the repo dir with the change's files", async () => {
    nextResolution = { type: "iterate-change", changeID: "add-login" }
    await openSpecsBrowser(root)
    expect(iterateCalls).toHaveLength(1)
    const input = iterateCalls[0] as { targetDir: string; runDir: string; prompt: string }
    // Repo-rooted on purpose: the session reads surrounding code and specs.
    expect(input.targetDir).toBe(root)
    expect(input.runDir).toBe(root)
    for (const file of [
      join("openspec", "changes", "add-login", "proposal.md"),
      join("openspec", "changes", "add-login", "design.md"),
      join("openspec", "changes", "add-login", "tasks.md"),
      join("openspec", "changes", "add-login", "specs", "cli", "spec.md"),
    ]) {
      expect(input.prompt).toContain(file)
    }
    expect(launchCalls).toHaveLength(0) // no launcher was involved
  })

  test("exit ends quietly without touching the launcher or the session opener", async () => {
    nextResolution = { type: "exit" }
    await openSpecsBrowser(root)
    expect(launchCalls).toHaveLength(0)
    expect(iterateCalls).toHaveLength(0)
  })
})
