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

  test("parseCommand parses opencode install|status|uninstall as a subcommand", async () => {
    const install = await parseCommand(["opencode", "install"])
    expect(install.type).toBe("opencode")
    if (install.type === "opencode") {
      expect(install.action).toBe("install")
    }

    const status = await parseCommand(["opencode", "status"])
    expect(status.type).toBe("opencode")
    if (status.type === "opencode") expect(status.action).toBe("status")

    const uninstall = await parseCommand(["opencode", "uninstall", "--dir", "/tmp/oc"])
    expect(uninstall.type).toBe("opencode")
    if (uninstall.type === "opencode") {
      expect(uninstall.action).toBe("uninstall")
      expect(uninstall.options.dir).toBe("/tmp/oc")
    }
  })

  test("parseCommand rejects an unknown opencode subcommand and unknown flags", async () => {
    await expect(parseCommand(["opencode", "frobnicate"])).rejects.toThrow("usage: convoy opencode")
    await expect(parseCommand(["opencode", "install", "--bogus"])).rejects.toThrow("unknown opencode flag")
  })

  test("parseCommand surfaces opencode help with no subcommand", async () => {
    const cmd = await parseCommand(["opencode"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") expect(cmd.text).toContain("convoy opencode install|status|uninstall")
  })
})
