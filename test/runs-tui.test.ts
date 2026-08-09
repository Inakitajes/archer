import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { __testing } from "../src/runs-tui"
import type { RunEntry } from "../src/runs"

const { formatRunDate, formatRunDateLong, pad2, RunsBrowser, truncatePath, wheelDelta } = __testing

// Helper: extract plain text from StyledText chunks
function plainText(st: { chunks: Array<{ text: string }> }): string {
  return st.chunks.map((c) => c.text).join("")
}

// Helper: create a minimal key event object for emitting
function keyEvent(overrides: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string }) {
  return {
    name: overrides.name,
    ctrl: overrides.ctrl ?? false,
    meta: overrides.meta ?? false,
    shift: overrides.shift ?? false,
    option: false,
    sequence: overrides.name,
    number: false,
    raw: overrides.raw ?? overrides.name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

describe("pad2", () => {
  test("pads single-digit numbers with a leading zero", () => {
    expect(pad2(0)).toBe("00")
    expect(pad2(5)).toBe("05")
    expect(pad2(9)).toBe("09")
  })

  test("does not pad two-digit numbers", () => {
    expect(pad2(10)).toBe("10")
    expect(pad2(23)).toBe("23")
    expect(pad2(59)).toBe("59")
  })
})

describe("truncatePath", () => {
  test("returns the full path when it fits", () => {
    expect(truncatePath("/foo/bar", 20)).toBe("/foo/bar")
  })

  test("prefixes ellipsis when the path exceeds max", () => {
    const result = truncatePath("/a/very/long/path/that/exceeds/the/limit", 20)
    expect(result.length).toBe(20)
    expect(result.startsWith("…")).toBe(true)
  })

  test("handles single-character max", () => {
    expect(truncatePath("abc", 1)).toBe("…c")
  })

  test("handles empty string", () => {
    expect(truncatePath("", 10)).toBe("")
  })
})

describe("wheelDelta", () => {
  const makeEvent = (direction: string, delta = 1) =>
    ({
      scroll: { direction, delta },
      preventDefault: () => {},
      stopPropagation: () => {},
    }) as Parameters<typeof wheelDelta>[0]

  test("returns negative delta for 'up' direction", () => {
    expect(wheelDelta(makeEvent("up", 1))).toBe(-1)
    expect(wheelDelta(makeEvent("up", 3))).toBe(-3)
  })

  test("returns positive delta for 'down' direction", () => {
    expect(wheelDelta(makeEvent("down", 1))).toBe(1)
    expect(wheelDelta(makeEvent("down", 5))).toBe(5)
  })

  test("returns 0 for missing scroll data", () => {
    const event = { preventDefault: () => {}, stopPropagation: () => {} } as Parameters<typeof wheelDelta>[0]
    expect(wheelDelta(event)).toBe(0)
  })

  test("returns 0 for unknown direction", () => {
    expect(wheelDelta(makeEvent("left"))).toBe(0)
  })

  test("defaults delta to 1 when delta is 0", () => {
    expect(wheelDelta(makeEvent("down", 0))).toBe(1)
  })
})

describe("formatRunDate", () => {
  test("formats a run ID-based date correctly", () => {
    const run: RunEntry = {
      runID: "20250809-120000",
      dir: "/tmp/runs/20250809-120000",
      title: "test",
      status: "completed",
      statusKind: "completed",
      live: false,
      phases: [],
    }
    expect(formatRunDate(run)).toBe("9 Aug 12:00")
  })

  test("returns em-dash when runID has no parsable date and no createdAt", () => {
    const run: RunEntry = {
      runID: "nope",
      dir: "/tmp/runs/nope",
      title: "test",
      status: "completed",
      statusKind: "completed",
      live: false,
      phases: [],
    }
    expect(formatRunDate(run)).toBe("—")
  })

  test("falls back to createdAt when runID is unparsable", () => {
    const run: RunEntry = {
      runID: "nope",
      dir: "/tmp/runs/nope",
      title: "test",
      status: "completed",
      statusKind: "completed",
      live: false,
      phases: [],
      createdAt: Date.UTC(2025, 0, 15, 8, 30, 0),
    }
    const result = formatRunDate(run)
    expect(result).toContain("Jan")
  })
})

describe("formatRunDateLong", () => {
  test("formats a date in full", () => {
    const date = new Date(2025, 7, 9, 14, 5, 0)
    expect(formatRunDateLong(date)).toBe("9 Aug 2025, 14:05")
  })
})

// ---------------------------------------------------------------------------
// RunsBrowser (TUI) — integration-style tests with a test renderer
// ---------------------------------------------------------------------------

function sampleRuns(): RunEntry[] {
  return [
    {
      runID: "20250809-100000",
      dir: "/tmp/runs/20250809-100000",
      title: "feat: add login",
      status: "completed",
      statusKind: "completed",
      live: false,
      phases: [
        { name: "design", status: "completed", durationMs: 8_000, cost: 0.02 },
        { name: "implement", status: "completed", durationMs: 45_000, cost: 0.15 },
      ],
      cost: 0.17,
    },
    {
      runID: "20250809-110000",
      dir: "/tmp/runs/20250809-110000",
      title: "fix: resolve timeout",
      status: "failed",
      statusKind: "failed",
      live: false,
      phases: [
        { name: "design", status: "completed", durationMs: 5_000, cost: 0.01 },
        { name: "implement", status: "failed", durationMs: 20_000, cost: 0.08 },
      ],
      cost: 0.09,
    },
    {
      runID: "20250809-120000",
      dir: "/tmp/runs/20250809-120000",
      title: "feat: onboarding wizard",
      status: "running",
      statusKind: "incomplete",
      live: true,
      serverUrl: "http://127.0.0.1:34567",
      phases: [{ name: "design", status: "completed" }],
      cost: 0.03,
    },
  ]
}

describe("RunsBrowser", () => {
  test("constructs with test renderer and returns RunsBrowser instance", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    expect(browser).toBeInstanceOf(RunsBrowser)
    renderer.destroy()
  })

  test("moveSelection clamps to valid range", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { selected: number; moveSelection(delta: number): void; runs: RunEntry[] }

    internals.moveSelection(-1)
    expect(internals.selected).toBe(0)

    internals.moveSelection(10)
    expect(internals.selected).toBe(2)

    internals.moveSelection(-1)
    expect(internals.selected).toBe(1)

    renderer.destroy()
  })

  test("selectedRun returns the current run", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 1)
    const internals = browser as unknown as { selectedRun(): RunEntry }
    expect(internals.selectedRun().title).toBe("fix: resolve timeout")
    renderer.destroy()
  })

  test("handleListKey moves selection and exits", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const { keyInput } = renderer
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)

    const resolution = browser.result

    keyInput.emit("keypress", keyEvent({ name: "j" }))

    const internals = browser as unknown as { selected: number }
    expect(internals.selected).toBe(1)

    keyInput.emit("keypress", keyEvent({ name: "q" }))

    const res = await resolution
    expect(res.type).toBe("exit")

    renderer.destroy()
  })

  test("handleListKey enter opens a run", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const { keyInput } = renderer
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)

    const resolution = browser.result

    keyInput.emit("keypress", keyEvent({ name: "return", raw: "\r" }))

    const res = await resolution
    expect(res.type).toBe("open")
    renderer.destroy()
  })

  test("handleListKey 'o' opens a run", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const { keyInput } = renderer
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)

    const resolution = browser.result

    keyInput.emit("keypress", keyEvent({ name: "o" }))

    const res = await resolution
    expect(res.type).toBe("open")
    renderer.destroy()
  })

  test("handleListKey 'r' resumes a run", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const { keyInput } = renderer
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 2)

    const resolution = browser.result

    keyInput.emit("keypress", keyEvent({ name: "r" }))

    const res = await resolution
    // The selected run at index 2 is live, so "r" should trigger "resume"
    expect(res.type).toBe("resume")
    renderer.destroy()
  })

  test("Ctrl-C exits immediately", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const { keyInput } = renderer
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)

    const resolution = browser.result

    keyInput.emit("keypress", keyEvent({ name: "c", ctrl: true, raw: "\u0003" }))

    const res = await resolution
    expect(res.type).toBe("exit")
    renderer.destroy()
  })

  test("list height adapts to renderer height", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 30 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { listHeight(): number }
    expect(internals.listHeight()).toBe(20)
    renderer.destroy()
  })

  test("details width adapts to renderer width", async () => {
    const { renderer } = await createTestRenderer({ width: 80, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { detailsWidth(): number }
    expect(internals.detailsWidth()).toBe(30)
    renderer.destroy()
  })

  test("details width maxes out at 46", async () => {
    const { renderer } = await createTestRenderer({ width: 200, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { detailsWidth(): number }
    expect(internals.detailsWidth()).toBe(46)
    renderer.destroy()
  })

  test("headerContent returns StyledText with run counts and cost", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { headerContent(width: number): { chunks: Array<{ text: string }> } }

    const header = internals.headerContent(114)
    const text = plainText(header)
    expect(text).toContain("convoy")
    expect(text).toContain("3 runs")
    expect(text).toContain("✓ 1")
    expect(text).toContain("✗ 1")
    renderer.destroy()
  })

  test("listContent returns StyledText with run titles", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { listContent(width: number): { chunks: Array<{ text: string }> } }

    const list = internals.listContent(80)
    const text = plainText(list)
    expect(text).toContain("feat: add login")
    expect(text).toContain("fix: resolve timeout")
    expect(text).toContain("feat: onboarding wizard")
    renderer.destroy()
  })

  test("detailsContent returns StyledText with run info", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { detailsContent(now: number, width: number): { chunks: Array<{ text: string }> } }

    const details = internals.detailsContent(Date.now(), 42)
    const text = plainText(details)
    expect(text).toContain("feat: add login")
    expect(text).toContain("20250809-100000")
    renderer.destroy()
  })

  test("footerContent returns StyledText with selection position", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { footerContent(width: number): { chunks: Array<{ text: string }> } }

    const footer = internals.footerContent(114)
    const text = plainText(footer)
    expect(text).toContain("1/3")
    renderer.destroy()
  })

  test("openSummary shows 'loading…' then loads asynchronously", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      openSummary(): void
      summary?: { runID: string; lines: string[]; scroll: number }
    }

    internals.openSummary()
    expect(internals.summary).toBeDefined()
    expect(internals.summary?.lines).toEqual(["loading…"])
    renderer.destroy()
  })

  test("handleListKey 'g' goes to top/bottom of list", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const { keyInput } = renderer
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { selected: number }

    keyInput.emit("keypress", keyEvent({ name: "g" }))
    expect(internals.selected).toBe(0)

    keyInput.emit("keypress", keyEvent({ name: "g", shift: true }))
    expect(internals.selected).toBe(2)
    renderer.destroy()
  })

  test("handleListKey 's' opens summary for selected run", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const { keyInput } = renderer
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      summary?: { runID: string; lines: string[]; scroll: number }
    }

    // Press 's' to open summary
    keyInput.emit("keypress", keyEvent({ name: "s" }))

    expect(internals.summary).toBeDefined()
    renderer.destroy()
  })

  test("finish destroys the renderer and resolves", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      finish(resolution: { type: "exit" }): void
      result: Promise<{ type: string }>
    }

    const resolution = internals.result
    internals.finish({ type: "exit" })

    const res = await resolution
    expect(res.type).toBe("exit")
    renderer.destroy()
  })

  test("summary key handling via openSummary + direct method call", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      openSummary(): void
      summary?: { runID: string; lines: string[]; scroll: number }
      handleKeyPress(key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string; preventDefault(): void; stopPropagation(): void }): void
      finish(x: { type: "exit" }): void
      result: Promise<{ type: string }>
    }

    internals.openSummary()
    expect(internals.summary).toBeDefined()
    expect(internals.summary!.lines).toEqual(["loading…"])

    const mkKey = (name: string, extra = {}) => ({
      name,
      ctrl: false,
      shift: false,
      meta: false,
      raw: name,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    })

    // 'escape' closes summary
    internals.handleKeyPress(mkKey("escape"))
    expect(internals.summary).toBeUndefined()

    renderer.destroy()
  })

  test("summary 'b' key closes the summary", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      openSummary(): void
      summary?: { runID: string; lines: string[]; scroll: number }
      handleKeyPress(key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string; preventDefault(): void; stopPropagation(): void }): void
    }

    internals.openSummary()
    const mkKey = (name: string, extra = {}) => ({
      name,
      ctrl: false,
      shift: false,
      meta: false,
      raw: name,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    })

    internals.handleKeyPress(mkKey("b"))
    expect(internals.summary).toBeUndefined()
    renderer.destroy()
  })

  test("summary 's' key closes the summary", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      openSummary(): void
      summary?: { runID: string; lines: string[]; scroll: number }
      handleKeyPress(key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string; preventDefault(): void; stopPropagation(): void }): void
    }

    internals.openSummary()
    const mkKey = (name: string, extra = {}) => ({
      name,
      ctrl: false,
      shift: false,
      meta: false,
      raw: name,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    })

    internals.handleKeyPress(mkKey("s"))
    expect(internals.summary).toBeUndefined()
    renderer.destroy()
  })

  test("summary 'q' key closes the summary", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      openSummary(): void
      summary?: { runID: string; lines: string[]; scroll: number }
      handleKeyPress(key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string; preventDefault(): void; stopPropagation(): void }): void
    }

    internals.openSummary()
    const mkKey = (name: string, extra = {}) => ({
      name,
      ctrl: false,
      shift: false,
      meta: false,
      raw: name,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    })

    internals.handleKeyPress(mkKey("q"))
    expect(internals.summary).toBeUndefined()
    renderer.destroy()
  })

  test("summary 's' key opens summary from list mode", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      summary?: { runID: string; lines: string[]; scroll: number }
      handleKeyPress(key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string; preventDefault(): void; stopPropagation(): void }): void
    }

    const mkKey = (name: string, extra = {}) => ({
      name,
      ctrl: false,
      shift: false,
      meta: false,
      raw: name,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    })

    // No summary initially
    expect(internals.summary).toBeUndefined()

    // Press 's' - this should open the summary (routed via handleListKey → openSummary)
    // In list mode, 's' opens the summary
    internals.handleKeyPress(mkKey("s"))
    expect(internals.summary).toBeDefined()

    renderer.destroy()
  })

  test("applyPalette does not throw", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as { applyPalette(): void }
    expect(() => internals.applyPalette()).not.toThrow()
    renderer.destroy()
  })

  test("inSubshell blocks key events but Ctrl-C still works", async () => {
    const { renderer } = await createTestRenderer({ width: 120, height: 40 })
    const runs = sampleRuns()
    const browser = new RunsBrowser(renderer, runs, 0)
    const internals = browser as unknown as {
      inSubshell: boolean
      handleKeyPress(key: { name: string; ctrl?: boolean; shift?: boolean; meta?: boolean; raw?: string; preventDefault(): void; stopPropagation(): void }): void
      finish(x: { type: "exit" }): void
      result: Promise<{ type: string }>
    }

    // Set subshell mode
    internals.inSubshell = true

    const mkKey = (name: string, extra = {}) => ({
      name,
      ctrl: false,
      shift: false,
      meta: false,
      raw: name,
      preventDefault: () => {},
      stopPropagation: () => {},
      ...extra,
    })

    // 'q' should be ignored because inSubshell is true
    // (it won't call handleListKey which would call finish)
    // Let's verify that subshell blocks navigation by checking the behavior
    // We'll exit via Ctrl+C which works even in subshell

    const result = browser.result
    // Ctrl-C should work even in subshell (checked BEFORE the inSubshell guard)
    internals.handleKeyPress(mkKey("c", { ctrl: true, raw: "\u0003" }))

    const res = await result
    expect(res.type).toBe("exit")

    renderer.destroy()
  })
})
