import { describe, expect, test } from "bun:test"

import { agentsHelp, help, initHelp, listValue, parseArgs, splitFlag, updateHelp, writeUpdateResult } from "../src/cli"

describe("help", () => {
  test("returns help text", () => {
    const text = help()
    expect(text).toContain("convoy")
    expect(text).toContain("Usage:")
  })
})

describe("initHelp", () => {
  test("returns init help text", () => {
    const text = initHelp()
    expect(text).toContain("convoy init")
    expect(text).toContain("--global")
  })
})

describe("updateHelp", () => {
  test("returns update help text", () => {
    const text = updateHelp()
    expect(text).toContain("convoy update")
  })
})

describe("agentsHelp", () => {
  test("returns agents help text", () => {
    const text = agentsHelp()
    expect(text).toContain("convoy agents")
  })
})

describe("splitFlag", () => {
  test("splits --flag=value", () => {
    expect(splitFlag("--branch=main")).toEqual({ flag: "--branch", value: "main" })
  })

  test("splits --flag without value", () => {
    expect(splitFlag("--yes")).toEqual({ flag: "--yes", value: undefined })
  })

  test("handles short flags", () => {
    expect(splitFlag("-p=test")).toEqual({ flag: "-p", value: "test" })
  })

  test("handles -- flag as separator", () => {
    expect(splitFlag("--")).toEqual({ flag: "--", value: undefined })
  })
})

describe("listValue", () => {
  test("splits comma-separated values", () => {
    expect(listValue("a,b,c")).toEqual(["a", "b", "c"])
  })

  test("handles single value", () => {
    expect(listValue("step1")).toEqual(["step1"])
  })

  test("trims whitespace", () => {
    expect(listValue(" a , b , c ")).toEqual(["a", "b", "c"])
  })
})

describe("parseArgs", () => {
  test("parses help flag", () => {
    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })

  test("parses prompt-file", () => {
    const result = parseArgs(["--prompt-file", "prompt.md"])
    expect(result.promptFile).toBe("prompt.md")
  })

  test("parses pipeline name", () => {
    const result = parseArgs(["-p", "ultra"])
    expect(result.pipeline).toBe("ultra")
  })

  test("parses --file with multiple files", () => {
    const result = parseArgs(["-f", "file1.ts", "--file", "file2.ts"])
    expect(result.files).toEqual(["file1.ts", "file2.ts"])
  })

  test("parses --only with comma list", () => {
    const result = parseArgs(["--only", "step1,step2"])
    expect(result.onlySteps).toEqual(["step1", "step2"])
  })

  test("parses positional arguments as prompt", () => {
    const result = parseArgs(["start", "my-prompt"])
    expect(result.prompt).toBe("start my-prompt")
  })

  test("stops parsing at --", () => {
    const result = parseArgs(["-p", "ultra", "--", "--help"])
    expect(result.pipeline).toBe("ultra")
    expect(result.prompt).toBe("--help")
    expect(result.help).toBeUndefined()
  })

  test("throws for missing required value", () => {
    expect(() => parseArgs(["--prompt-file"])).toThrow("requires a value")
  })

  test("throws for unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow("unknown flag")
  })
})

describe("writeUpdateResult", () => {
  test("writes update result text", () => {
    const writes: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => { writes.push(chunk); return true }) as typeof process.stdout.write
    try {
      writeUpdateResult({ status: "up-to-date", currentVersion: "0.5.0", latestVersion: "0.5.0" })
      const output = writes.join("")
      expect(output).toContain("is up to date")
    } finally {
      process.stdout.write = origWrite
    }
  })
})