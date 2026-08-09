import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

// The log module has module-level state (`muted`), so we need fresh imports per
// test file.  We also avoid pre-loading it via env.ts.
const origConsoleError = console.error

describe("log", () => {
  let captured: string[]

  beforeEach(() => {
    captured = []
    console.error = mock((...args: string[]) => {
      captured.push(args.join(" "))
    })
  })

  afterEach(() => {
    console.error = origConsoleError
    // Un-mute after each test so the next test starts clean.
    const { log } = require("../src/log") as typeof import("../src/log")
    log.mute(false)
  })

  test("info writes a cyan-prefixed message to stderr", () => {
    const { log } = require("../src/log") as typeof import("../src/log")
    log.info("hello")
    expect(captured).toEqual([expect.stringContaining("-> hello")])
  })

  test("warn writes a yellow-prefixed message to stderr", () => {
    const { log } = require("../src/log") as typeof import("../src/log")
    log.warn("something off")
    expect(captured).toEqual([expect.stringContaining("! something off")])
  })

  test("error writes a bold-red-prefixed message to stderr regardless of mute", () => {
    const { log } = require("../src/log") as typeof import("../src/log")
    log.mute(true)
    log.error("oh no")
    // error is never muted
    expect(captured).toEqual([expect.stringContaining("✗ oh no")])
  })

  test("error writes even when muted", () => {
    const { log } = require("../src/log") as typeof import("../src/log")
    log.mute(true)
    log.info("should be silent")
    expect(captured).toEqual([])
  })

  test("section writes a blank line then a green message", () => {
    const { log } = require("../src/log") as typeof import("../src/log")
    log.section("Section Heading")
    expect(captured.length).toBe(2)
    expect(captured[0]).toBe("")
    expect(captured[1]).toContain("Section Heading")
  })

  test("mute(true) suppresses info, warn, and section", () => {
    const { log } = require("../src/log") as typeof import("../src/log")
    log.mute(true)
    log.info("a")
    log.warn("b")
    log.section("c")
    expect(captured).toEqual([])
  })

  test("mute(false) re-enables info", () => {
    const { log } = require("../src/log") as typeof import("../src/log")
    log.mute(true)
    log.info("silent")
    log.mute(false)
    log.info("loud")
    expect(captured).toEqual([expect.stringContaining("-> loud")])
  })
})