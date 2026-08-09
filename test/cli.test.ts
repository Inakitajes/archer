import { describe, expect, test } from "bun:test"
import { beforeEach } from "bun:test"
import { spyOn } from "bun:test"

import { __testing, parseArgs, parseCommand, resolveRunOptions } from "../src/cli"

const { listValue, parseInitArgs, resolveBaseRef, resolveWorktreeOption, splitFlag, writeUpdateResult } = __testing

const validRunID = "20240101-120000-abcd"

const release = {
  tagName: "v2.0.0",
  version: { major: 2, minor: 0, patch: 0, prerelease: [] },
  publishedAt: "2026-01-01T00:00:00Z",
  assets: [],
}

const assets = {
  binary: { name: "convoy-darwin-arm64", browserDownloadUrl: "https://github.com/Inakitajes/convoy/releases/download/v2.0.0/convoy-darwin-arm64" },
  checksumFile: { name: "SHA256SUMS", browserDownloadUrl: "https://github.com/Inakitajes/convoy/releases/download/v2.0.0/SHA256SUMS" },
}

describe("parseArgs", () => {
  test("parses a positional prompt", () => {
    const result = parseArgs(["add onboarding"])
    expect(result.prompt).toBe("add onboarding")
  })

  test("parses --prompt-file", () => {
    const result = parseArgs(["--prompt-file", "prd.md"])
    expect(result.promptFile).toBe("prd.md")
  })

  test("parses --file", () => {
    const result = parseArgs(["--file", "lib/main.dart", "-f", "test/main_test.dart"])
    expect(result.files).toEqual(["lib/main.dart", "test/main_test.dart"])
  })

  test("parses --pipeline", () => {
    const result = parseArgs(["-p", "bug-fix"])
    expect(result.pipeline).toBe("bug-fix")
  })

  test("parses --only and --skip with comma-separated values", () => {
    const result = parseArgs(["--only", "design,security", "--skip", "tests"])
    expect(result.onlySteps).toEqual(["design", "security"])
    expect(result.skipSteps).toEqual(["tests"])
  })

  test("parses --resume", () => {
    const result = parseArgs(["--resume", "run-abc123"])
    expect(result.resumeRunID).toBe("run-abc123")
  })

  test("parses --model", () => {
    const result = parseArgs(["--model", "anthropic/claude-sonnet-4-5#thinking"])
    expect(result.modelOverride).toBe("anthropic/claude-sonnet-4-5#thinking")
  })

  test("parses --advisor", () => {
    const result = parseArgs(["--advisor", "openai/gpt-5"])
    expect(result.advisorOverride).toBe("openai/gpt-5")
    expect(result.advisorDisabled).toBe(false)
  })

  test("parses --no-advisor", () => {
    const result = parseArgs(["--no-advisor"])
    expect(result.advisorDisabled).toBe(true)
    expect(result.advisorOverride).toBeUndefined()
  })

  test("parses --gateway", () => {
    const result = parseArgs(["--gateway", "openrouter"])
    expect(result.gateway).toBe("openrouter")
  })

  test("throws for invalid --gateway", () => {
    expect(() => parseArgs(["--gateway", "invalid"])).toThrow()
  })

  test("parses --plan", () => {
    const result = parseArgs(["--plan"])
    expect(result.planOnly).toBe(true)
  })

  test("parses --no-confirm", () => {
    const result = parseArgs(["--no-confirm"])
    expect(result.noConfirm).toBe(true)
  })

  test("parses --tui and --no-tui", () => {
    expect(parseArgs(["--tui"]).tui).toBe(true)
    expect(parseArgs(["--no-tui"]).tui).toBe(false)
  })

  test("parses --worktree and --no-worktree", () => {
    expect(parseArgs(["--worktree"]).worktree).toBe(true)
    expect(parseArgs(["--no-worktree"]).worktree).toBe(false)
  })

  test("parses --branch", () => {
    const result = parseArgs(["--branch", "feat/my-feature"])
    expect(result.branch).toBe("feat/my-feature")
  })

  test("parses --base", () => {
    const result = parseArgs(["--base", "develop"])
    expect(result.baseRef).toBe("develop")
  })

  test("parses --include-dirty", () => {
    const result = parseArgs(["--include-dirty"])
    expect(result.includeDirty).toBe(true)
  })

  test("parses --yolo", () => {
    const result = parseArgs(["--yolo"])
    expect(result.yolo).toBe(true)
  })

  test("parses --smart", () => {
    const result = parseArgs(["--smart"])
    expect(result.smart).toBe(true)
  })

  test("parses --smart-model", () => {
    const result = parseArgs(["--smart-model", "anthropic/claude-opus-5"])
    expect(result.smartModel).toBe("anthropic/claude-opus-5")
  })

  test("parses --notify and --no-notify", () => {
    expect(parseArgs(["--notify"]).notify).toBe(true)
    expect(parseArgs(["--no-notify"]).notify).toBe(false)
  })

  test("parses --human-review", () => {
    expect(parseArgs(["--human-review"]).humanReview).toBe(true)
    expect(parseArgs(["--no-human-review"]).humanReview).toBe(false)
  })

  test("parses --max-concurrent", () => {
    const result = parseArgs(["--max-concurrent", "5"])
    expect(result.maxConcurrent).toBe(5)
  })

  test("throws for invalid --max-concurrent", () => {
    expect(() => parseArgs(["--max-concurrent", "0"])).toThrow()
    expect(() => parseArgs(["--max-concurrent", "abc"])).toThrow()
  })

  test("parses --keep-run-dir and --no-keep-run-dir", () => {
    expect(parseArgs(["--keep-run-dir"]).keepRunDir).toBe(true)
    expect(parseArgs(["--no-keep-run-dir"]).keepRunDir).toBe(false)
  })

  test("parses --dir", () => {
    const result = parseArgs(["--dir", "/some/repo"])
    expect(result.targetDir).toBe("/some/repo")
  })

  test("parses --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help?.toString()).toBe("true")
  })

  test("stops parsing at -- and treats everything after as positional", () => {
    const result = parseArgs(["--", "add", "login", "--verbose"])
    expect(result.prompt).toBe("add login --verbose")
  })

  test("throws for unknown flags", () => {
    expect(() => parseArgs(["--foobar"])).toThrow("unknown flag")
  })

  test("parses --model with = syntax", () => {
    const result = parseArgs(["--model=anthropic/claude-sonnet-4-5"])
    expect(result.modelOverride).toBe("anthropic/claude-sonnet-4-5")
  })

  test("parses --pipeline with = syntax", () => {
    const result = parseArgs(["--pipeline=bug-fix"])
    expect(result.pipeline).toBe("bug-fix")
  })

  test("parses --base with = syntax", () => {
    const result = parseArgs(["--base=main"])
    expect(result.baseRef).toBe("main")
  })

  test("parses --branch with = syntax", () => {
    const result = parseArgs(["--branch=feat/foo"])
    expect(result.branch).toBe("feat/foo")
  })

  test("parses --dir with = syntax", () => {
    const result = parseArgs(["--dir=/some/repo"])
    expect(result.targetDir).toBe("/some/repo")
  })

  test("parses --gateway with = syntax", () => {
    const result = parseArgs(["--gateway=direct"])
    expect(result.gateway).toBe("direct")
  })

  test("parses --only with = syntax", () => {
    const result = parseArgs(["--only=design,security"])
    expect(result.onlySteps).toEqual(["design", "security"])
  })

  test("parses --advisor with = syntax", () => {
    const result = parseArgs(["--advisor=openai/gpt-5"])
    expect(result.advisorOverride).toBe("openai/gpt-5")
  })

  test("parses --resume with = syntax", () => {
    const result = parseArgs(["--resume=run-abc123"])
    expect(result.resumeRunID).toBe("run-abc123")
  })

  test("parses -f with = syntax", () => {
    const result = parseArgs(["-f=lib/main.dart"])
    expect(result.files).toEqual(["lib/main.dart"])
  })

  test("--no-advisor does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-advisor=foo"])).toThrow("--no-advisor does not take a value")
  })

  test("--no-worktree does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-worktree=true"])).toThrow("--no-worktree does not take a value")
  })

  test("--plan does not take a value with = syntax", () => {
    expect(() => parseArgs(["--plan=1"])).toThrow("--plan does not take a value")
  })

  test("--no-confirm does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-confirm=1"])).toThrow("--no-confirm does not take a value")
  })

  test("--notify does not take a value with = syntax", () => {
    expect(() => parseArgs(["--notify=1"])).toThrow("--notify does not take a value")
  })

  test("--worktree does not take a value with = syntax", () => {
    expect(() => parseArgs(["--worktree=1"])).toThrow("--worktree does not take a value")
  })

  test("stops parsing at -- with just separator and positional", () => {
    const result = parseArgs(["--", "some prompt"])
    expect(result.prompt).toBe("some prompt")
  })

  test("-- separator with no positional args", () => {
    const result = parseArgs(["--model", "gpt-4", "--"])
    expect(result.modelOverride).toBe("gpt-4")
    expect(result.prompt).toBeUndefined()
  })

  test("-- separator with no args at all", () => {
    const result = parseArgs([])
    expect(result.prompt).toBeUndefined()
    expect(result.files).toEqual([])
    expect(result.onlySteps).toEqual([])
    expect(result.skipSteps).toEqual([])
  })
})

describe("splitFlag", () => {
  test("splits --flag=value", () => {
    const { flag, value } = splitFlag("--model=gpt-4")
    expect(flag).toBe("--model")
    expect(value).toBe("gpt-4")
  })

  test("splits --flag with no value", () => {
    const { flag, value } = splitFlag("--model")
    expect(flag).toBe("--model")
    expect(value).toBeUndefined()
  })

  test("splits short flag with =", () => {
    const { flag, value } = splitFlag("-f=test.txt")
    expect(flag).toBe("-f")
    expect(value).toBe("test.txt")
  })

  test("handles empty value after =", () => {
    const { flag, value } = splitFlag("--flag=")
    expect(flag).toBe("--flag")
    expect(value).toBe("")
  })

  test("handles multiple = signs", () => {
    const { flag, value } = splitFlag("--model=provider/model=extra")
    expect(flag).toBe("--model")
    expect(value).toBe("provider/model=extra")
  })
})

describe("listValue", () => {
  test("splits comma-separated values", () => {
    expect(listValue("a,b,c")).toEqual(["a", "b", "c"])
  })

  test("handles single value", () => {
    expect(listValue("a")).toEqual(["a"])
  })

  test("trims whitespace around items", () => {
    expect(listValue(" a , b , c ")).toEqual(["a", "b", "c"])
  })

  test("filters out empty items", () => {
    expect(listValue("a,,b")).toEqual(["a", "b"])
  })

  test("returns empty for empty string", () => {
    expect(listValue("")).toEqual([])
  })

  test("returns empty for only commas", () => {
    expect(listValue(",,,")).toEqual([])
  })
})

describe("writeUpdateResult", () => {
  test("source-install status prints message", () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })
    try {
      writeUpdateResult({ status: "source-install", message: "source install message" })
      expect(writes).toEqual(["source install message\n"])
    } finally {
      spy.mockRestore()
    }
  })

  test("up-to-date status prints version info", () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })
    try {
      writeUpdateResult({ status: "up-to-date", currentVersion: "1.0.0", latestVersion: "1.0.0", release, assets })
      expect(writes).toEqual(["convoy 1.0.0 is up to date (latest: v1.0.0)\n"])
    } finally {
      spy.mockRestore()
    }
  })

  test("update-available status prints asset info", () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })
    try {
      writeUpdateResult({ status: "update-available", currentVersion: "1.0.0", latestVersion: "2.0.0", release, assets })
      expect(writes).toEqual(["update available: 1.0.0 → v2.0.0 (convoy-darwin-arm64)\n"])
    } finally {
      spy.mockRestore()
    }
  })

  test("updated status prints success message", () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })
    try {
      writeUpdateResult({ status: "updated", currentVersion: "1.0.0", latestVersion: "2.0.0", assetName: "convoy-darwin-arm64" })
      expect(writes).toEqual(["updated convoy 1.0.0 → v2.0.0 (convoy-darwin-arm64)\n"])
    } finally {
      spy.mockRestore()
    }
  })
})

describe("parseCommand", () => {
  test("--help returns help text", async () => {
    const cmd = await parseCommand(["--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy [prompt]")
      expect(cmd.text).toContain("Commands:")
      expect(cmd.text).toContain("Flags:")
    }
  })

  test("-h returns help text", async () => {
    const cmd = await parseCommand(["-h"])
    expect(cmd.type).toBe("help")
  })

  test("parses --version", async () => {
    const cmd = await parseCommand(["--version"])
    expect(cmd.type).toBe("version")
  })

  test("parses -V", async () => {
    const cmd = await parseCommand(["-V"])
    expect(cmd.type).toBe("version")
  })

  test("parses update command", async () => {
    const cmd = await parseCommand(["update"])
    expect(cmd.type).toBe("update")
    expect((cmd as { checkOnly: boolean }).checkOnly).toBe(false)
  })

  test("parses update --check", async () => {
    const cmd = await parseCommand(["update", "--check"])
    expect(cmd.type).toBe("update")
    expect((cmd as { checkOnly: boolean }).checkOnly).toBe(true)
  })

  test("parses update --help", async () => {
    const cmd = await parseCommand(["update", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy update [--check]")
      expect(cmd.text).toContain("--check")
    }
  })

  test("parses update -h", async () => {
    const cmd = await parseCommand(["update", "-h"])
    expect(cmd.type).toBe("help")
  })

  test("throws for unknown update args", async () => {
    await expect(parseCommand(["update", "--unknown"])).rejects.toThrow("usage: convoy update")
  })

  test("parses auth status", async () => {
    const cmd = await parseCommand(["auth"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("status")
    }
  })

  test("parses auth openrouter", async () => {
    const cmd = await parseCommand(["auth", "openrouter"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("set")
    }
  })

  test("parses auth openrouter --remove", async () => {
    const cmd = await parseCommand(["auth", "openrouter", "--remove"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("remove")
    }
  })

  test("throws for invalid auth subcommand", async () => {
    await expect(parseCommand(["auth", "invalid"])).rejects.toThrow("usage: convoy auth")
  })

  test("parses init", async () => {
    const cmd = await parseCommand(["init"])
    expect(cmd.type).toBe("init")
  })

  test("parses init --global", async () => {
    const cmd = await parseCommand(["init", "--global"])
    expect(cmd.type).toBe("init")
    if (cmd.type === "init") {
      expect(cmd.options.global).toBe(true)
    }
  })

  test("parses init --help", async () => {
    const cmd = await parseCommand(["init", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy init [--global]")
    }
  })

  test("parses init -h", async () => {
    const cmd = await parseCommand(["init", "-h"])
    expect(cmd.type).toBe("help")
  })

  test("parses runs", async () => {
    const cmd = await parseCommand(["runs"])
    expect(cmd.type).toBe("runs")
    if (cmd.type === "runs") {
      expect(cmd.runID).toBeUndefined()
    }
  })

  test("parses runs with a run ID", async () => {
    const cmd = await parseCommand(["runs", validRunID])
    expect(cmd.type).toBe("runs")
    if (cmd.type === "runs") {
      expect(cmd.runID).toBe(validRunID)
    }
  })

  test("throws for runs with extra args", async () => {
    await expect(parseCommand(["runs", validRunID, "extra"])).rejects.toThrow("usage: convoy runs")
  })

  test("throws for an invalid run ID", async () => {
    await expect(parseCommand(["runs", "../../malicious"])).rejects.toThrow("invalid run id")
  })

  test("parses config", async () => {
    const cmd = await parseCommand(["config"])
    expect(cmd.type).toBe("config")
  })

  test("throws for config with extra args", async () => {
    await expect(parseCommand(["config", "extra"])).rejects.toThrow("usage: convoy config")
  })

  test("agents without subcommand shows help", async () => {
    const cmd = await parseCommand(["agents"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy agents eject")
    }
  })

  test("agents --help shows help", async () => {
    const cmd = await parseCommand(["agents", "--help"])
    expect(cmd.type).toBe("help")
  })

  test("agents eject with no agent name throws", async () => {
    await expect(parseCommand(["agents", "eject"])).rejects.toThrow("usage: convoy agents eject")
  })

  test("agents eject with --help shows help", async () => {
    const cmd = await parseCommand(["agents", "eject", "--help"])
    expect(cmd.type).toBe("help")
  })

  test("agents with invalid subcommand throws", async () => {
    await expect(parseCommand(["agents", "invalid"])).rejects.toThrow("usage: convoy agents eject")
  })

  test("finish --help returns help", async () => {
    const cmd = await parseCommand(["finish", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy finish")
    }
  })

  test("rejects both --prompt and --prompt-file", async () => {
    await expect(parseCommand(["prompt arg", "--prompt-file", "prd.md"])).rejects.toThrow("use either a positional prompt or --prompt-file")
  })

  test("rejects --resume with a new prompt", async () => {
    await expect(parseCommand(["--resume", validRunID, "new prompt"])).rejects.toThrow("can't take a new prompt")
  })

  test("rejects a run without prompt", async () => {
    await expect(parseCommand([])).rejects.toThrow("need a prompt")
  })

  test("parses a run command with prompt", async () => {
    const cmd = await parseCommand(["add login"])
    expect(cmd.type).toBe("run")
  })
})

describe("parseInitArgs", () => {
  test("defaults to cwd and non-global", () => {
    const result = parseInitArgs([])
    expect(result.global).toBe(false)
    expect(result.force).toBe(false)
    expect(result.quiet).toBe(false)
    expect(result.help).toBeUndefined()
  })

  test("parses --help", () => {
    const result = parseInitArgs(["--help"])
    expect(result.help).toBe(true)
  })

  test("parses -h", () => {
    const result = parseInitArgs(["-h"])
    expect(result.help).toBe(true)
  })

  test("parses --global", () => {
    const result = parseInitArgs(["--global"])
    expect(result.global).toBe(true)
  })

  test("parses --force", () => {
    const result = parseInitArgs(["--force"])
    expect(result.force).toBe(true)
  })

  test("parses --quiet", () => {
    const result = parseInitArgs(["--quiet"])
    expect(result.quiet).toBe(true)
  })

  test("parses --dir with relative path", () => {
    const result = parseInitArgs(["--dir", "some/repo"])
    expect(result.targetDir).toContain("some/repo")
  })

  test("throws for --global and --dir combo", () => {
    expect(() => parseInitArgs(["--global", "--dir", "/some/repo"])).toThrow("use either --global or --dir, not both")
  })

  test("throws for non-flag arg", () => {
    expect(() => parseInitArgs(["positional"])).toThrow("usage: convoy init")
  })

  test("throws for unknown flag", () => {
    expect(() => parseInitArgs(["--unknown"])).toThrow("unknown init flag")
  })

  test("throws when flag without value is last arg", () => {
    expect(() => parseInitArgs(["--dir"])).toThrow("requires a value")
  })

  test("help short-circuits before validation", () => {
    const result = parseInitArgs(["--global", "--help"])
    expect(result.help).toBe(true)
  })
})

describe("resolveBaseRef", () => {
  test("uses explicit flag over config defaults", async () => {
    const parsed = parseArgs(["--base", "develop"])
    const ref = await resolveBaseRef(parsed, {})
    expect(ref).toBe("develop")
  })

  test("uses config default baseRef when no flag", async () => {
    const parsed = parseArgs([])
    const ref = await resolveBaseRef(parsed, { baseRef: "main" })
    expect(ref).toBe("main")
  })
})

describe("resolveWorktreeOption", () => {
  test("uses explicit --worktree flag", async () => {
    const parsed = parseArgs(["--worktree"])
    const result = await resolveWorktreeOption(parsed, {})
    expect(result).toBe(true)
  })

  test("uses explicit --no-worktree flag", async () => {
    const parsed = parseArgs(["--no-worktree"])
    const result = await resolveWorktreeOption(parsed, {})
    expect(result).toBe(false)
  })

  test("uses config defaults.worktree", async () => {
    const parsed = parseArgs([])
    const result = await resolveWorktreeOption(parsed, { worktree: false })
    expect(result).toBe(false)
  })
})

describe("resolveRunOptions", () => {
  test("uses explicit maxConcurrentAgents", async () => {
    const parsed = parseArgs(["--max-concurrent", "5"])
    const options = await resolveRunOptions(parsed)
    expect(options.maxConcurrentAgents).toBe(5)
  })

  test("resolves humanReview from TTY", async () => {
    const parsed = parseArgs(["--no-human-review"])
    const options = await resolveRunOptions(parsed)
    expect(options.humanReview).toBe(false)
  })

  test("resolves planOnly from flag", async () => {
    const parsed = parseArgs(["--plan"])
    const options = await resolveRunOptions(parsed)
    expect(options.planOnly).toBe(true)
  })

  test("resolves noConfirm from flag", async () => {
    const parsed = parseArgs(["--no-confirm"])
    const options = await resolveRunOptions(parsed)
    expect(options.noConfirm).toBe(true)
  })
})
