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

  test("parseCommand accepts specs with no arguments and rejects extras", async () => {
    expect(await parseCommand(["specs"])).toEqual({ type: "specs", targetDir: process.cwd() })
    await expect(parseCommand(["specs", "--flag"])).rejects.toThrow("usage: convoy specs")
    await expect(parseCommand(["specs", "extra"])).rejects.toThrow("usage: convoy specs")
  })

  test("parseCommand opens the board through control, with specs kept as an alias", async () => {
    expect(await parseCommand(["control"])).toEqual({ type: "specs", targetDir: process.cwd() })
    await expect(parseCommand(["control", "extra"])).rejects.toThrow("usage: convoy control")
  })

  test("parseCommand parses spin flags into SpinOptions", async () => {
    const command = await parseCommand(["spin", "--change", "add-foo", "--prefix", "fix"])
    expect(command.type).toBe("spin")
    const options = (command as { options: { changeID?: string; prefix?: string; targetDir: string } }).options
    expect(options.changeID).toBe("add-foo")
    expect(options.prefix).toBe("fix")
    expect(options.targetDir).toBe(process.cwd())
    expect((await parseCommand(["spin"])).type).toBe("spin")
    expect(((await parseCommand(["spin", "--change=add-bar"])) as { options: { changeID?: string } }).options.changeID).toBe("add-bar")
  })

  test("parseCommand rejects malformed spin arguments", async () => {
    await expect(parseCommand(["spin", "--change"])).rejects.toThrow("--change requires a change id")
    await expect(parseCommand(["spin", "--prefix"])).rejects.toThrow("--prefix requires")
    await expect(parseCommand(["spin", "surprise"])).rejects.toThrow("usage: convoy spin")
  })

  test("spin --help explains its usage", async () => {
    const command = await parseCommand(["spin", "--help"])
    expect(command.type).toBe("help")
    if (command.type === "help") expect(command.text).toContain("convoy spin")
  })
})
