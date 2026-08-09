import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"

import { finishHelp, parseFinishArgs } from "../src/finish-command"

describe("finishHelp", () => {
  test("returns a help string containing the command signature", () => {
    const help = finishHelp()
    expect(help).toContain("convoy finish")
    expect(help).toContain("--branch")
    expect(help).toContain("--base")
  })
})

describe("parseFinishArgs", () => {
  const cwd = process.cwd()

  test("returns defaults with no arguments", () => {
    const opts = parseFinishArgs([])
    expect(opts).toEqual({ targetDir: cwd })
  })

  test("parses --help and returns immediately", () => {
    const opts = parseFinishArgs(["--help"])
    expect(opts.help).toBe(true)
    // --help returns early, so later args in the array are never reached.
    // (This also means unknown flags after --help are never checked.)
  })

  test("parses -h as help", () => {
    const opts = parseFinishArgs(["-h"])
    expect(opts.help).toBe(true)
  })

  test("parses --branch", () => {
    const opts = parseFinishArgs(["--branch", "feat/foo"])
    expect(opts.branch).toBe("feat/foo")
  })

  test("parses --branch=value inline", () => {
    const opts = parseFinishArgs(["--branch=feat/bar"])
    expect(opts.branch).toBe("feat/bar")
  })

  test("parses --base", () => {
    const opts = parseFinishArgs(["--base", "main"])
    expect(opts.baseRef).toBe("main")
  })

  test("parses --base=value inline", () => {
    const opts = parseFinishArgs(["--base=develop"])
    expect(opts.baseRef).toBe("develop")
  })

  test("parses --sign", () => {
    const opts = parseFinishArgs(["--sign"])
    expect(opts.sign).toBe(true)
  })

  test("parses --no-verify", () => {
    const opts = parseFinishArgs(["--no-verify"])
    expect(opts.noVerify).toBe(true)
  })

  test("parses --edit", () => {
    const opts = parseFinishArgs(["--edit"])
    expect(opts.edit).toBe(true)
  })

  test("parses --yes and -y", () => {
    expect(parseFinishArgs(["--yes"]).yes).toBe(true)
    expect(parseFinishArgs(["-y"]).yes).toBe(true)
  })

  test("parses --dry-run", () => {
    const opts = parseFinishArgs(["--dry-run"])
    expect(opts.dryRun).toBe(true)
  })

  test("parses --dir with a relative path", () => {
    const opts = parseFinishArgs(["--dir", "some/repo"])
    expect(opts.targetDir).toBe(resolve(cwd, "some/repo"))
  })

  test("parses --dir=path inline", () => {
    const opts = parseFinishArgs(["--dir=/abs/path"])
    expect(opts.targetDir).toBe(resolve(cwd, "/abs/path"))
  })

  test("throws for --branch without a value", () => {
    expect(() => parseFinishArgs(["--branch"])).toThrow("requires a value")
  })

  test("throws for --base without a value", () => {
    expect(() => parseFinishArgs(["--base"])).toThrow("requires a value")
  })

  test("throws for --dir without a value", () => {
    expect(() => parseFinishArgs(["--dir"])).toThrow("requires a value")
  })

  test("throws for an unknown flag", () => {
    expect(() => parseFinishArgs(["--bogus"])).toThrow("unknown flag")
  })

  test("throws for --branch where the next argument is another flag", () => {
    expect(() => parseFinishArgs(["--branch", "--sign"])).toThrow("requires a value")
  })

  test("parses multiple flags together", () => {
    const opts = parseFinishArgs(["--branch", "feat/x", "--sign", "--dry-run", "--yes"])
    expect(opts.branch).toBe("feat/x")
    expect(opts.sign).toBe(true)
    expect(opts.dryRun).toBe(true)
    expect(opts.yes).toBe(true)
  })

  test("parses --branch followed by --base", () => {
    const opts = parseFinishArgs(["--branch", "fix/y", "--base", "staging"])
    expect(opts.branch).toBe("fix/y")
    expect(opts.baseRef).toBe("staging")
  })
})

describe("runFinishCommand (through exported internals)", () => {
  // runFinishCommand has many side-effect-only paths that are better exercised
  // through integration tests.  Here we verify the pure helpers it relies on are
  // correct.

  test("finishHelp is a defined string", () => {
    expect(typeof finishHelp()).toBe("string")
    expect(finishHelp().length).toBeGreaterThan(100)
  })

  test("parseFinishArgs with --dry-run sets the flag", () => {
    const opts = parseFinishArgs(["--dry-run"])
    expect(opts.dryRun).toBe(true)
  })
})

describe("indent", () => {
  test("indents every line with two spaces", () => {
    const { indent } = require("../src/finish-command") as typeof import("../src/finish-command")
    expect(indent("hello")).toBe("  hello")
    expect(indent("line1\nline2")).toBe("  line1\n  line2")
    expect(indent("")).toBe("  ")
    expect(indent("a\nb\nc")).toBe("  a\n  b\n  c")
  })
})