import { describe, expect, test } from "bun:test"

import { parseArgs, parseCommand, resolveRunOptions } from "../src/cli"

describe("resolveRunOptions", () => {
  test("returns options with defaults applied", async () => {
    const parsed = {
      files: [],
      onlySteps: [],
      skipSteps: [],
      targetDir: process.cwd(),
      keepRunDir: undefined,
      modelOverride: undefined,
      advisorOverride: undefined,
      advisorDisabled: undefined,
      tui: undefined,
      notify: undefined,
      humanReview: undefined,
      maxConcurrent: undefined,
      baseRef: undefined,
      worktree: undefined,
      branch: undefined,
      baseDetectionDir: undefined,
      includeDirty: undefined,
      yolo: undefined,
      smart: undefined,
      smartModel: undefined,
      gateway: undefined,
      planOnly: undefined,
      noConfirm: undefined,
      resumeRunID: undefined,
      pipeline: undefined,
      prompt: undefined,
      promptFile: undefined,
      help: undefined,
      advisor: undefined,
      change: undefined,
    }

    const options = await resolveRunOptions(parsed)
    expect(options.targetDir).toBe(process.cwd())
    expect(options.files).toEqual([])
    expect(options.pipeline).toBeDefined()
    expect(options.pipeline.steps.length).toBeGreaterThan(0)
    expect(typeof options.gateway).toBe("string")
  })

  test("--change carries into resolved run options", async () => {
    const options = await resolveRunOptions({
      files: [],
      onlySteps: [],
      skipSteps: [],
      targetDir: process.cwd(),
      keepRunDir: undefined,
      modelOverride: undefined,
      advisorOverride: undefined,
      advisorDisabled: undefined,
      tui: undefined,
      notify: undefined,
      humanReview: undefined,
      maxConcurrent: undefined,
      baseRef: undefined,
      worktree: undefined,
      branch: undefined,
      baseDetectionDir: undefined,
      includeDirty: undefined,
      yolo: undefined,
      smart: undefined,
      smartModel: undefined,
      gateway: undefined,
      planOnly: undefined,
      noConfirm: undefined,
      resumeRunID: undefined,
      pipeline: undefined,
      prompt: undefined,
      promptFile: undefined,
      help: undefined,
      change: "add-login",
    })
    expect(options.change).toBe("add-login")
  })

  test("parseArgs turns --change add-foo into parsed.change", () => {
    expect(parseArgs(["--change", "add-foo"]).change).toBe("add-foo")
    expect(parseArgs(["--change=add-bar"]).change).toBe("add-bar")
  })

  test("parseCommand rejects the removed opencode plugin with a pointer to the launcher", async () => {
    await expect(parseCommand(["opencode"])).rejects.toThrow("OpenCode slash-command plugin was removed")
    await expect(parseCommand(["opencode", "install"])).rejects.toThrow("--change")
  })
})
