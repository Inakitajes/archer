import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TuiProgress, autoFollowGroup, comparisonColumnCount, initialContentTab, iteratePrompt, phaseCapabilityBadges, phaseCapabilityLabel, pickBadge, pipelineSelectionTargets } from "../src/tui"
import { displayWidth, formatMoney, limitsRow } from "../src/tui-theme"
import { shortVersion } from "../src/version"

import type { ClipboardResult } from "../src/clipboard"
import type { LimitsSnapshot } from "../src/limits"
import type { FinishSeam, ProgressPhase } from "../src/progress"
import type { AdvisorEvent } from "../src/advisor-events"

async function createDashboard(
  width = 120,
  height = 40,
  phases: ProgressPhase[] = [{ name: "implement", description: "" }],
  options: {
    observer?: boolean
    onPauseToggle?: () => void
    onKeepAwakeToggle?: () => void
    copyResult?: ClipboardResult
    finishSeam?: FinishSeam
  } = {},
) {
  const testRenderer = await createTestRenderer({ width, height })
  const copied: string[] = []
  const dashboard = new TuiProgress(testRenderer.renderer, phases, undefined, undefined, false, options.observer ?? false, "session", async (text) => {
    copied.push(text)
    return options.copyResult ?? "copied-native"
  }, options.onPauseToggle, options.onKeepAwakeToggle, options.finishSeam)
  testRenderer.renderer.copyToClipboardOSC52 = (text) => {
    copied.push(text)
    return true
  }
  return { ...testRenderer, dashboard, copied }
}

function textCoordinates(frame: string, text: string) {
  const lines = frame.split("\n")
  const y = lines.findIndex((line) => line.includes(text))
  expect(y).toBeGreaterThanOrEqual(0)
  const x = lines[y]!.indexOf(text)
  expect(x).toBeGreaterThanOrEqual(0)
  return { x, y }
}

function lineContaining(frame: string, text: string) {
  const line = frame.split("\n").find((row) => row.includes(text))
  expect(line).toBeDefined()
  return line!
}

async function selectText(
  mockMouse: Awaited<ReturnType<typeof createTestRenderer>>["mockMouse"],
  captureCharFrame: () => string,
  text: string,
) {
  const { x, y } = textCoordinates(captureCharFrame(), text)
  await mockMouse.drag(x, y, x + text.length, y)
}

async function createReportRunDir(body: string) {
  const runDir = await mkdtemp(join(tmpdir(), "convoy-tui-"))
  await mkdir(join(runDir, "reports"))
  await writeFile(join(runDir, "reports", "implement.md"), body)
  return runDir
}

async function openShortcuts(
  mockInput: Awaited<ReturnType<typeof createTestRenderer>>["mockInput"],
  waitForFrame: Awaited<ReturnType<typeof createTestRenderer>>["waitForFrame"],
) {
  mockInput.pressKey("p", { ctrl: true })
  await mockInput.typeText("Keyboard shortcuts")
  mockInput.pressEnter()
  return waitForFrame((frame) => frame.includes("keyboard shortcuts"))
}

async function waitForRenderedFrame(
  renderOnce: () => Promise<void>,
  captureCharFrame: () => string,
  predicate: (frame: string) => boolean,
) {
  let frame = captureCharFrame()
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate(frame)) return frame
    await Bun.sleep(2)
    await renderOnce()
    frame = captureCharFrame()
  }
  throw new Error(`timed out waiting for rendered frame:\n${frame}`)
}

describe("run dashboard defaults", () => {
  test("starts live runs on session and historical runs on reports, never logs", () => {
    const live = initialContentTab("live")
    const historical = initialContentTab("historical")

    expect(live).toBe("session")
    expect(historical).toBe("reports")
    expect([live, historical]).not.toContain("logs")
  })

  test("brands the header with the running version and keeps it inside a narrow panel", async () => {
    const wide = await createDashboard(120, 40)
    const narrow = await createDashboard(60, 40)
    try {
      await wide.renderOnce()
      expect(wide.captureCharFrame()).toContain(`◆ convoy ${shortVersion()}`)

      // The complete title and the panel's closing border remain visible at the
      // narrow width instead of the title being clipped by the totals column.
      await narrow.renderOnce()
      const line = lineContaining(narrow.captureCharFrame(), `◆ convoy ${shortVersion()}`)
      expect(displayWidth(line)).toBeLessThanOrEqual(60)
      expect(line.match(/│/g)?.length).toBe(2)
    } finally {
      wide.dashboard.stop()
      narrow.dashboard.stop()
    }
  })

  test("labels audit-only phases without tagging writable work", () => {
    expect(phaseCapabilityLabel({ readOnly: true })).toBe("audit · read-only")
    expect(phaseCapabilityLabel({})).toBeUndefined()
    expect(phaseCapabilityBadges({ readOnly: true })).toEqual(["audit · read-only", "read-only", "ro"])
    expect(phaseCapabilityBadges({})).toEqual([])
    expect(phaseCapabilityLabel({ plannedAdvisor: "anthropic/opus" })).toBe("advisor")
    expect(phaseCapabilityBadges({ plannedAdvisor: "anthropic/opus" })).toEqual(["advisor", "adv"])
  })

  test("renders the advisor timeline with lifecycle details after selecting its tab", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{
      name: "implement",
      description: "",
      plannedAdvisor: "anthropic/opus",
      advisorMaxCalls: 2,
    }])
    try {
      const base = {
        timestamp: new Date(0).toISOString(),
        callId: "call-1",
        phase: "implement",
        attempt: 1,
        trigger: "on-demand" as const,
        budget: { used: 1, max: 2 },
      }
      const events: AdvisorEvent[] = [
        { ...base, id: "1", type: "advisor.requested", model: "anthropic/opus" },
        {
          ...base,
          id: "2",
          type: "advisor.completed",
          model: "anthropic/opus",
          latencyMs: 15,
          adviceChars: 4,
          usage: { model: "anthropic/opus", cost: 0.02, tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
        },
        { ...base, id: "3", type: "advisor.delivered", delivery: "tool" },
        { ...base, id: "4", type: "advisor.feedback", outcome: "adopted" },
        { ...base, id: "5", callId: "call-2", type: "advisor.failed", model: "anthropic/opus", latencyMs: 8, error: { code: "unavailable" } },
      ]
      for (const event of events) dashboard.phaseAdvisorEvent("implement", event)

      mockInput.pressKey("4")
      await renderOnce()

      const frame = captureCharFrame()
      expect(frame).toContain("4 advisor")
      expect(frame).toContain("requested")
      expect(frame).toContain("on-demand")
      expect(frame).toContain("completed")
      expect(frame).toContain("$0.02")
      expect(frame).toContain("tool")
      expect(frame).toContain("adopted")
      expect(frame).toContain("unavailable")
    } finally {
      dashboard.stop()
    }
  })

  test("stacks narrow dashboards and keeps an overlong top pipeline scrollable", async () => {
    const phases = Array.from({ length: 10 }, (_, index) => ({ name: `step-${index + 1}`, description: "" }))
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(80, 24, phases)
    try {
      await renderOnce()
      const first = captureCharFrame()
      expect(first.indexOf("step-1")).toBeLessThan(first.indexOf("scheduled"))

      for (let index = 0; index < 8; index++) mockInput.pressArrow("down")
      await renderOnce()
      const scrolled = captureCharFrame()
      expect(scrolled).toMatch(/▸ .*step-9/)
      expect(scrolled).not.toContain("step-1")
    } finally {
      dashboard.stop()
    }
  })

  test("the tree badge degrades to shorter forms and then disappears, never costing the name a column", () => {
    const badges = phaseCapabilityBadges({ readOnly: true })

    expect(pickBadge(badges, 20, false)).toBe("audit · read-only")
    expect(pickBadge(badges, 12, false)).toBe("read-only")
    expect(pickBadge(badges, 4, false)).toBe("ro")
    expect(pickBadge(badges, 1, false)).toBeUndefined()

    // With meta following, each form also pays for its ` · ` separator.
    expect(pickBadge(badges, 12, true)).toBe("read-only")
    expect(pickBadge(badges, 11, true)).toBe("ro")
    expect(pickBadge(badges, 4, true)).toBeUndefined()

    // A writable phase never grows a badge, however much room there is.
    expect(pickBadge(phaseCapabilityBadges({}), 40, false)).toBeUndefined()
  })

  test("p delegates pause control and renders pausing and paused states", async () => {
    let toggles = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onPauseToggle: () => toggles++ })
    try {
      mockInput.pressKey("p")
      expect(toggles).toBe(1)

      dashboard.runControlState("pausing", 2)
      await renderOnce()
      expect(captureCharFrame()).toContain("pausing · 2 active")

      dashboard.runControlState("paused", 0)
      await renderOnce()
      const paused = captureCharFrame()
      expect(paused).toContain("paused · p resume")
      expect(paused).toContain("ctrl+p")
    } finally {
      dashboard.stop()
    }
  })

  test("p explains why pause is unavailable on an attached observer dashboard", async () => {
    let toggles = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { observer: true, onPauseToggle: () => toggles++ })
    try {
      mockInput.pressKey("p")
      mockInput.pressKey("3")
      await renderOnce()

      expect(toggles).toBe(0)
      expect(captureCharFrame()).toContain("pause isn't available while attached read-only")
    } finally {
      dashboard.stop()
    }
  })

  test("ctrl+p opens commands without triggering pause, while p still pauses", async () => {
    let pauses = 0
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onPauseToggle: () => pauses++ })
    try {
      await renderOnce()
      expect(captureCharFrame()).toContain("ctrl+p")

      mockInput.pressKey("p", { ctrl: true })
      await renderOnce()
      expect(captureCharFrame()).toContain("commands")
      expect(pauses).toBe(0)

      mockInput.pressEscape()
      // An isolated Escape needs a beat to settle before the next printable key;
      // otherwise terminal parsers legitimately read the pair as Meta+P.
      await Bun.sleep(20)
      mockInput.pressKey("p")
      expect(pauses).toBe(1)
    } finally {
      dashboard.stop()
    }
  })

  test("the command palette toggles keep-awake through its callback", async () => {
    let toggles = 0
    const { dashboard, mockInput } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onKeepAwakeToggle: () => toggles++ })
    try {
      mockInput.pressKey("p", { ctrl: true })
      // Keep Mac awake is the first live-run command.
      mockInput.pressEnter()

      expect(toggles).toBe(1)
    } finally {
      dashboard.stop()
    }
  })
})

describe("footer hints and the command palette", () => {
  test("the footer stays inside the panel at every terminal width", async () => {
    // The footer is one unwrapped line in a fixed-height box: anything wider
    // than the panel is silently chopped off against the border.
    for (const width of [160, 120, 100, 90, 80, 70, 60, 50, 46]) {
      const { dashboard, renderOnce, captureCharFrame } = await createDashboard(width, 40)
      try {
        dashboard.start("abc1234", process.cwd())
        dashboard.serverReady("http://127.0.0.1:41234")
        dashboard.phaseRunning("implement")
        await renderOnce()
        const row = lineContaining(captureCharFrame(), "ctrl+p")
        expect(displayWidth(row), `width ${width}`).toBeLessThanOrEqual(width)
        expect(row.match(/│/g)?.length).toBe(2)
      } finally {
        dashboard.stop()
      }
    }
  })

  test("a narrow footer keeps the way to the rest of the shortcuts", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(60, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      dashboard.phaseRunning("implement")
      await renderOnce()
      // Hints were dropped, so the pinned hint says where they went.
      const frame = captureCharFrame()
      expect(frame).toContain("ctrl+p")
      expect(frame).toContain("all shortcuts")
    } finally {
      dashboard.stop()
    }
  })

  test("a wide footer keeps its hints and says ctrl+p opens commands", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(160, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      dashboard.phaseRunning("implement")
      await renderOnce()
      const row = lineContaining(captureCharFrame(), "ctrl+p")
      expect(row).toContain("[↑↓] step")
      expect(row).toContain("[enter] read")
      expect(row).toContain("[o] session")
      expect(row).toContain("[ctrl+p] commands")
      expect(row).not.toContain("all shortcuts")
    } finally {
      dashboard.stop()
    }
  })

  test("[MF-1] a permission footer suppresses review actions that route to the permission", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      const permission = dashboard.askPermission({ id: "permission-1", permission: "bash", command: "ls", patterns: [] })
      const review = dashboard.askHumanReview({ stepName: "implement", iterations: 0 })
      await renderOnce()

      // Permission routing runs first, so [a] means "always" here rather than
      // the review gate's advertised "abort" action.
      const row = lineContaining(captureCharFrame(), "always")
      expect(row).toContain("always")

      mockInput.pressKey("a")
      expect(await permission).toBe("always")

      // The review remains queued until the next [a], proving the first one
      // answered the permission prompt rather than aborting the review gate.
      let reviewReply: string | undefined
      void review.then((reply) => {
        reviewReply = reply
      })
      await Promise.resolve()
      expect(reviewReply).toBeUndefined()
      mockInput.pressKey("a")
      expect(await review).toBe("abort")

      expect(row).not.toContain("open OpenCode")
      expect(row).not.toContain("abort")
    } finally {
      dashboard.stop()
    }
  })

  test("[SF-1] a narrow permission footer marks choices hidden from the row", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(46, 40)
    try {
      void dashboard.askPermission({ id: "permission-1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      expect(captureCharFrame()).toMatch(/\+\d/)
    } finally {
      dashboard.stop()
    }
  })

  test("[SF-1] a narrow review footer marks choices hidden from the row", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(46, 40)
    try {
      void dashboard.askHumanReview({ stepName: "implement", iterations: 0 })
      await renderOnce()

      expect(captureCharFrame()).toMatch(/\+\d/)
    } finally {
      dashboard.stop()
    }
  })

  // Regression: the palette gated every action behind `!finished`, so the
  // finish screen offered a single entry while five actions sat on the keyboard.
  test("the finish screen's palette lists its own actions", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      void dashboard.runFinished({ status: "completed", runDir: "" })
      await renderOnce()

      mockInput.pressKey("p", { ctrl: true })
      await renderOnce()
      const text = captureCharFrame()
      expect(text).toContain("Iterate in a new session")
      expect(text).toContain("Open lazygit")
      expect(text).toContain("Close the dashboard")
      expect(text).toContain("Keyboard shortcuts")
    } finally {
      dashboard.stop()
    }
  })

  test("the finish screen's footer points at the palette too", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      void dashboard.runFinished({ status: "completed", runDir: "" })
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("ctrl+p")
      expect(frame).toContain("[q] close")
    } finally {
      dashboard.stop()
    }
  })

  test("the shortcuts view documents every content tab, not just three", async () => {
    const { dashboard, mockInput, captureCharFrame, waitForFrame } = await createDashboard(120, 40)
    try {
      dashboard.start("abc1234", process.cwd())
      await openShortcuts(mockInput, waitForFrame)

      const rows = [captureCharFrame()]
      for (let index = 0; index < 20; index++) {
        mockInput.pressKey("j")
        rows.push(await waitForFrame((frame) => frame.includes("keyboard shortcuts")))
      }
      const help = rows.join("\n")
      expect(help).toContain("show the session tab")
      expect(help).toContain("show the reports tab")
      expect(help).toContain("show the logs tab")
      expect(help).toContain("show the advisor tab")
      expect(help).toContain("open the fullscreen reader")
      expect(help).toContain("abort the run")
    } finally {
      dashboard.stop()
    }
  })

  test("the shortcuts view fits the terminal and scrolls instead of overflowing it", async () => {
    const { dashboard, mockInput, waitForFrame } = await createDashboard(120, 24)
    try {
      dashboard.start("abc1234", process.cwd())
      const first = await openShortcuts(mockInput, waitForFrame)
      expect(first.split("\n")).toHaveLength(25)
      mockInput.pressKey("j")
      const second = await waitForFrame((frame) => frame !== first && frame.includes("keyboard shortcuts"))
      expect(second.split("\n")).toHaveLength(25)
    } finally {
      dashboard.stop()
    }
  })

  test("[MF-2] the focused reader's palette still offers the selected session", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(120, 40)
    try {
      mockInput.pressEnter()
      mockInput.pressKey("p", { ctrl: true })
      await renderOnce()
      const palette = captureCharFrame()

      expect(palette).toContain("Open session")
      expect(palette).toContain("commands")
    } finally {
      dashboard.stop()
    }
  })
})

describe("dashboard content selection", () => {
  test("copies selected session text and clears the successful selection", async () => {
    const { dashboard, mockMouse, renderer, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      const text = "session selection payload"
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      await selectText(mockMouse, captureCharFrame, text)

      expect(copied).toEqual([text])
      expect(renderer.hasSelection).toBeFalse()
    } finally {
      dashboard.stop()
    }
  })

  test("copies selected report text", async () => {
    const text = "report selection payload"
    const runDir = await createReportRunDir(text)
    const { dashboard, mockInput, mockMouse, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      dashboard.start("run", process.cwd(), runDir)
      mockInput.pressKey("2")
      await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes(text))

      await selectText(mockMouse, captureCharFrame, text)

      expect(copied).toEqual([text])
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("renders markdown in the session and report views", async () => {
    const runDir = await createReportRunDir("## Report\n\n- `result`")
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard()
    try {
      dashboard.phaseStarted("implement")
      // Blank lines between the blocks on purpose: without one, the quote is a
      // lazy continuation *inside* the list item and the test would be pinning
      // that nesting rather than the markdown structure it means to check.
      dashboard.phaseMessage("implement", { channel: "response", text: "# Answer\n\n- **first**\n\n> quoted" })
      dashboard.phaseActivity("implement", "response received")
      await renderOnce()

      const session = captureCharFrame()
      expect(session).toContain("Answer")
      expect(session).toContain("• first")
      expect(session).toContain("▎ quoted")
      expect(session).not.toContain("# Answer")
      expect(session).not.toContain("**first**")

      dashboard.start("run", process.cwd(), runDir)
      mockInput.pressKey("2")
      const report = await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Report") && frame.includes("• result"))

      expect(report).not.toContain("## Report")
      expect(report).not.toContain("`result`")
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("wraps a long log message under the message column instead of cutting it", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(90, 40)
    try {
      dashboard.phaseStarted("implement")
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", "wrapped ".repeat(20).trim())
      dashboard.phaseActivity("implement", "ready")
      await renderOnce()

      const rendered = captureCharFrame().split("\n").filter((line) => line.includes("wrapped"))
      expect(rendered.length).toBeGreaterThan(1)
      // Continuation rows hang under the message column rather than restarting
      // at column 0, so the timestamp gutter stays a column.
      const gutter = rendered[0]!.indexOf("wrapped")
      expect(gutter).toBeGreaterThan(0)
      expect(rendered[1]!.indexOf("wrapped")).toBe(gutter)
    } finally {
      dashboard.stop()
    }
  })

  test("renders log messages as prose, applying typography but not block markdown", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(90, 40)
    try {
      dashboard.phaseStarted("implement")
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", "- ran `bun test` twice")
      dashboard.phaseActivity("implement", "ready")
      await renderOnce()

      // A message starting with "- " is a message, not a bullet.
      const frame = captureCharFrame()
      const row = lineContaining(frame, "- ran bun test twice")
      expect(row).not.toContain("`bun test`")
      expect(row).not.toContain("• ran")
    } finally {
      dashboard.stop()
    }
  })

  test("elides a log message that would outgrow its row budget", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(60, 40)
    try {
      dashboard.phaseStarted("implement")
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", "verbose ".repeat(40).trim())
      dashboard.phaseActivity("implement", "ready")
      await renderOnce()

      const rendered = captureCharFrame().split("\n").filter((line) => line.includes("verbose"))
      expect(rendered.length).toBe(3)
      expect(rendered[2]).toContain("…")
    } finally {
      dashboard.stop()
    }
  })

  test("separate reasoning summaries stay separate bullets under one label", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard()
    try {
      dashboard.phaseStarted("implement")
      // Each summary is its own provider part; merging them would read as
      // "…diff scope inspectionInspecting rules…".
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "Planning diff scope inspection", partID: "reasoning:1" })
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "Inspecting rules", partID: "reasoning:2" })
      dashboard.phaseMessage("implement", { channel: "reasoning", text: " and loading skills", partID: "reasoning:2" })
      dashboard.phaseMessage("implement", { channel: "response", text: "done", partID: "text:1" })
      dashboard.phaseActivity("implement", "streamed")
      await renderOnce()

      const text = captureCharFrame()
      expect(text).toContain("· Planning diff scope inspection")
      // Deltas of the same part still concatenate into one bullet.
      expect(text).toContain("· Inspecting rules and loading skills")
      expect(text).not.toContain("inspectionInspecting")
      // One label for the whole reasoning stretch, then the response block.
      expect(text.match(/reasoning/g)).toHaveLength(1)
      expect(text).toContain("response")
    } finally {
      dashboard.stop()
    }
  })

  test("re-wraps transcript lines when the panel width changes", async () => {
    const { dashboard, renderOnce, resize, captureCharFrame } = await createDashboard(200, 40)
    try {
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "wrap ".repeat(30).trim(), partID: "reasoning:1" })
      dashboard.phaseActivity("implement", "streamed")
      await renderOnce()
      const wide = captureCharFrame().split("\n").filter((line) => line.includes("wrap")).length

      resize(90, 40)
      dashboard.phaseActivity("implement", "still streaming")
      await renderOnce()
      const narrow = captureCharFrame().split("\n").filter((line) => line.includes("wrap")).length

      expect(narrow).toBeGreaterThan(wide)
    } finally {
      dashboard.stop()
    }
  })

  test("opens reports, session history, and logs with v; the reader scrolls with j and k", async () => {
    const report = "# Result\n\n- first\n- second"
    const runDir = await createReportRunDir(report)
    const { dashboard, copied, mockInput, renderOnce, captureCharFrame, waitForFrame } = await createDashboard()
    try {
      dashboard.start("run", process.cwd(), runDir)
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: "# Session\n\nmessage history" })
      mockInput.pressKey("2")
      await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Result") && frame.includes("• first"))

      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("report · implement")

      mockInput.pressKey("c")
      await waitForFrame((frame) => frame.includes("copied"))
      expect(copied).toEqual([report])

      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("2 reports")

      mockInput.pressKey("1")
      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("session · implement")
      expect(captureCharFrame()).toContain("message history")
      mockInput.pressEscape()
      await Bun.sleep(20)
      await renderOnce()
      expect(captureCharFrame()).toContain("1 session")

      for (let index = 0; index < 50; index++) dashboard.phaseActivity("implement", `log item ${index}`)
      mockInput.pressKey("3")
      mockInput.pressKey("v")
      await renderOnce()
      const top = captureCharFrame()
      expect(top).toContain("logs · implement")
      expect(top).toContain("log item 49")
      expect(top).toContain("top")

      mockInput.pressKey("j")
      const scrolled = await waitForFrame((frame) => frame.includes("logs · implement") && frame !== top)
      expect(scrolled).not.toContain("log item 49")
      mockInput.pressKey("k")
      await waitForFrame((frame) => frame.includes("log item 49"))

      mockInput.pressEscape()
      await Bun.sleep(20)
      await renderOnce()
      expect(captureCharFrame()).toContain("3 logs")
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("paints a modal over the open reader without losing it", async () => {
    const runDir = await createReportRunDir("# Result\n\n- only line")
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 50)
    try {
      dashboard.start("run", process.cwd(), runDir)
      mockInput.pressKey("2")
      await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Result"))

      // Open the reader — the opaque overlay takes over the screen.
      mockInput.pressKey("v")
      await renderOnce()
      expect(captureCharFrame()).toContain("report · implement")

      // A permission prompt arriving while the reader is open must still paint
      // over it rather than being swallowed by fullscreen input handling.
      const permission = dashboard.askPermission({ id: "1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      const prompted = captureCharFrame()
      expect(prompted).toContain("permission required")
      expect(prompted).toContain("bash")

      mockInput.pressKey("r")
      expect(await permission).toBe("reject")
      await renderOnce()
      expect(captureCharFrame()).toContain("report · implement")

      mockInput.pressEscape()
      await Bun.sleep(20)
      await renderOnce()
      expect(captureCharFrame()).toContain("2 reports")
    } finally {
      dashboard.stop()
      await rm(runDir, { recursive: true, force: true })
    }
  })

  test("shows the specific report copy failure in the fullscreen reader", async () => {
    for (const [result, label] of [
      ["unsupported", "terminal clipboard (OSC52) unavailable"],
      ["transport-failed", "couldn't copy report; report is too large for this terminal transport"],
    ] as const) {
      const runDir = await createReportRunDir("# Result")
      const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(240, 40, [{ name: "implement", description: "" }], { copyResult: result })
      try {
        dashboard.start("run", process.cwd(), runDir)
        mockInput.pressKey("2")
        await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes("Result"))

        mockInput.pressKey("v")
        await renderOnce()
        mockInput.pressKey("c")
        expect(await waitForRenderedFrame(renderOnce, captureCharFrame, (frame) => frame.includes(label))).toContain(label)
      } finally {
        dashboard.stop()
        await rm(runDir, { recursive: true, force: true })
      }
    }
  })

  test("copies selected log text", async () => {
    const { dashboard, mockInput, mockMouse, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      const text = "Next command: /mr-comment 20260717-122207-c4cn 90"
      mockInput.pressKey("3")
      dashboard.phaseActivity("implement", text)
      await renderOnce()

      await selectText(mockMouse, captureCharFrame, text)

      expect(copied).toEqual([text])
    } finally {
      dashboard.stop()
    }
  })

  test("does not copy tab-strip or cross-panel selections", async () => {
    const { dashboard, mockMouse, renderOnce, captureCharFrame, copied } = await createDashboard()
    try {
      const sessionText = "session selection payload"
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: sessionText })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      const frame = captureCharFrame()
      const tab = textCoordinates(frame, "1 session")
      await mockMouse.drag(tab.x, tab.y, tab.x + "1 session".length, tab.y)

      const session = textCoordinates(frame, sessionText)
      const pipeline = textCoordinates(frame, "implement")
      await mockMouse.drag(session.x, session.y, pipeline.x, pipeline.y)

      expect(copied).toEqual([])
    } finally {
      dashboard.stop()
    }
  })

  test("retains the selection when OSC52 copying is unavailable", async () => {
    const { dashboard, mockMouse, renderer, renderOnce, captureCharFrame } = await createDashboard()
    try {
      const text = "uncopied session selection"
      const failedCopies: string[] = []
      renderer.copyToClipboardOSC52 = (selectedText) => {
        failedCopies.push(selectedText)
        return false
      }
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      await selectText(mockMouse, captureCharFrame, text)

      expect(failedCopies).toEqual([text])
      expect(renderer.hasSelection).toBeTrue()
    } finally {
      dashboard.stop()
    }
  })

  test("removes its selection listener when stopped", async () => {
    const { dashboard, renderer } = await createDashboard()
    try {
      expect(renderer.listenerCount("selection")).toBe(1)

      dashboard.stop()

      expect(renderer.listenerCount("selection")).toBe(0)
    } finally {
      if (!renderer.isDestroyed) dashboard.stop()
    }
  })
})

describe("finish modal follow-ups", () => {
  type SeamOptions = { canPr?: boolean; pushFails?: boolean; prFails?: boolean }

  function fakeSeam(options: SeamOptions = {}) {
    const calls = { push: 0, pr: 0 }
    const seam: FinishSeam = {
      async prepare() {
        return {
          ok: true as const,
          proposal: { branch: "convoy/run", commitCount: 3, subject: "feat: a thing", body: ["did a thing"], notes: [] },
        }
      },
      async apply() {
        return { sha: "abcdef1234567890", branch: "convoy/run", backupRef: "refs/convoy/finish-backup", replaced: 3 }
      },
      async edit() {
        return undefined
      },
      async push() {
        calls.push++
        if (options.pushFails) throw new Error("no write access")
      },
      canOpenPullRequest: () => options.canPr ?? true,
      async openPullRequest() {
        calls.pr++
        if (options.prFails) throw new Error("gh pr create didn't complete")
      },
    }
    return { seam, calls }
  }

  /** Drives [f] through prepare and the commit, landing on the "done" screen. */
  async function commit(options: SeamOptions & { width?: number } = {}) {
    const { seam, calls } = fakeSeam(options)
    const harness = await createDashboard(options.width ?? 120, 40, [{ name: "implement", description: "" }], { finishSeam: seam })
    harness.dashboard.start("run", process.cwd())
    void harness.dashboard.runFinished({ status: "completed", runDir: "" })
    harness.mockInput.pressKey("f")
    await harness.waitForFrame((frame) => frame.includes("feat: a thing"))
    harness.mockInput.pressEnter()
    await harness.waitForFrame((frame) => frame.includes("abcdef12 on convoy/run"))
    return { ...harness, calls }
  }

  test("offers push and push-and-PR as one fork after the commit", async () => {
    const { dashboard, captureCharFrame, calls } = await commit()
    try {
      const text = captureCharFrame()
      // Both branches are visible at once rather than push unlocking the PR.
      expect(text).toContain("p push")
      expect(text).toContain("r push and PR")
      expect(calls).toEqual({ push: 0, pr: 0 })
    } finally {
      dashboard.stop()
    }
  })

  test("push alone settles without ever offering a pull request", async () => {
    const { dashboard, mockInput, waitForFrame, calls } = await commit()
    try {
      mockInput.pressKey("p")
      const text = await waitForFrame((frame) => frame.includes("pushed to origin/convoy/run"))

      expect(calls).toEqual({ push: 1, pr: 0 })
      expect(text).toContain("pushed to origin/convoy/run")
      expect(text).toContain("press any key to close")
      expect(text).not.toContain("pull request")
    } finally {
      dashboard.stop()
    }
  })

  test("push and PR settles, and a second r closes instead of re-creating it", async () => {
    const { dashboard, mockInput, waitForFrame, calls } = await commit()
    try {
      mockInput.pressKey("r")
      const text = await waitForFrame((frame) => frame.includes("pull request opened"))

      expect(calls).toEqual({ push: 1, pr: 1 })
      expect(text).toContain("pull request opened")
      expect(text).toContain("press any key to close")

      // The regression: the settled screen used to keep offering the PR, so a
      // second r ran `gh pr create` again on a branch that already had one.
      mockInput.pressKey("r")
      await waitForFrame((frame) => !frame.includes("finish run"))
      expect(calls).toEqual({ push: 1, pr: 1 })
    } finally {
      dashboard.stop()
    }
  })

  test("a failed push keeps the fork up and never reaches the pull request", async () => {
    const { dashboard, mockInput, waitForFrame, calls } = await commit({ pushFails: true })
    try {
      mockInput.pressKey("r")
      const text = await waitForFrame((frame) => frame.includes("push failed: no write access"))

      expect(calls).toEqual({ push: 1, pr: 0 })
      expect(text).toContain("push failed: no write access")
      expect(text).toContain("p push")
      expect(text).toContain("r push and PR")
    } finally {
      dashboard.stop()
    }
  })

  test("a failed gh keeps the push and offers just the retry", async () => {
    const { dashboard, mockInput, waitForFrame, calls } = await commit({ prFails: true })
    try {
      mockInput.pressKey("r")
      const text = await waitForFrame((frame) => frame.includes("r retry pull request"))
      const flattened = text.replace(/\s+/g, " ")

      expect(calls).toEqual({ push: 1, pr: 1 })
      expect(flattened).toContain("pushed to origin/convoy/run")
      expect(flattened).toContain("gh pr create failed")
      expect(flattened).toContain("gh pr create didn't")
      expect(text).toContain("r retry pull request")
      // The push is done, so re-offering it would only fail on an up-to-date ref.
      expect(text).not.toContain("p push")

      mockInput.pressKey("r")
      await waitForFrame((frame) => frame.includes("r retry pull request"))
      expect(calls).toEqual({ push: 1, pr: 2 })
    } finally {
      dashboard.stop()
    }
  })

  test("keeps both follow-up keys visible on a compact terminal", async () => {
    const { dashboard, captureCharFrame } = await commit({ width: 70 })
    try {
      const frame = captureCharFrame()
      expect(frame).toContain("p push")
      expect(frame).toContain("r push and PR")
    } finally {
      dashboard.stop()
    }
  })

  test("without gh the fork is push only", async () => {
    const { dashboard, mockInput, captureCharFrame, waitForFrame, calls } = await commit({ canPr: false })
    try {
      const text = captureCharFrame()
      expect(text).toContain("p push")
      expect(text).not.toContain("push and PR")

      // r is not on offer, so it falls through to closing the modal.
      mockInput.pressKey("r")
      await waitForFrame((frame) => !frame.includes("finish run"))
      expect(calls).toEqual({ push: 0, pr: 0 })
    } finally {
      dashboard.stop()
    }
  })
})

describe("iterate prompt", () => {
  test("names the run, lists every context file, and stays on one line", () => {
    const files = ["/runs/x/prd.md", "/runs/x/reports/plan.md", "/runs/x/reports/implement.md"]
    const prompt = iteratePrompt("20260713-101010-abcd", files)

    expect(prompt).toContain("20260713-101010-abcd")
    for (const file of files) expect(prompt).toContain(file)
    // The command travels through `zsh -lc`; a newline would break quoting assumptions.
    expect(prompt).not.toContain("\n")
    // The agent must know to wait instead of acting on the reports alone.
    expect(prompt.toLowerCase()).toContain("wait")
  })
})

describe("header limits row", () => {
  const now = Date.now()
  const full: LimitsSnapshot = {
    gpt: { sessionPct: 42, sessionResetsAt: now + 130 * 60_000, weeklyPct: 18 },
    openrouter: { kind: "remaining", amount: 12.34 },
    fetchedAt: now,
  }
  const text = (snapshot: LimitsSnapshot | undefined, width: number) =>
    limitsRow(snapshot, now, width)
      .chunks.map((chunk) => chunk.text)
      .join("")

  test("wide row shows the bar, reset countdown, weekly percent, and credits", () => {
    const row = text(full, 100)

    expect(row).toContain("GPT ")
    expect(row).toContain("█")
    expect(row).toContain("42%")
    expect(row).toContain("resets 2h 10m")
    expect(row).toContain("wk 18%")
    expect(row).toContain("OpenRouter $12.34 left")
    expect(row.length).toBeGreaterThanOrEqual(100)
  })

  test("narrow widths drop weekly first, then the countdown", () => {
    // Bar segment (18) + countdown (16) + weekly (9) + credits (22+1 gap):
    // at 60 the weekly text no longer fits, at 40 the countdown goes too.
    const at60 = text(full, 60)
    expect(at60).toContain("resets")
    expect(at60).not.toContain("wk 18%")

    const at40 = text(full, 40)
    expect(at40).toContain("42%")
    expect(at40).not.toContain("resets")
    expect(at40).toContain("OpenRouter $12.34 left")
  })

  test("monthly fallback labels the amount as spend, not balance", () => {
    const row = text({ ...full, openrouter: { kind: "monthly", amount: 4.2 } }, 100)

    expect(row).toContain("OpenRouter $4.20/mo")
  })

  test("auth problems surface a dim hint instead of a meter", () => {
    const row = text({ gptHint: "codex login", fetchedAt: now }, 80)

    expect(row).toContain("GPT — codex login")
    expect(row).not.toContain("█")
  })

  test("no data renders a quiet placeholder, never a crash", () => {
    expect(text(undefined, 80)).toBe("…")
    expect(text({ fetchedAt: now }, 80)).toBe("…")
  })
})

describe("cost formatting", () => {
  test("always shows exactly two decimal places", () => {
    expect(formatMoney(12)).toBe("$12.00")
    expect(formatMoney(0.004)).toBe("$0.00")
    expect(formatMoney(0.126)).toBe("$0.13")
  })
})

describe("pipeline group selection", () => {
  test("includes model and parallel headers in the same order as their child rows", () => {
    const phases: ProgressPhase[] = [
      { name: "prepare", description: "" },
      { name: "review__opus", description: "", groupId: "models", stepName: "review", plannedModel: "anthropic/claude-opus" },
      { name: "review__gpt", description: "", groupId: "models", stepName: "review", plannedModel: "openai/gpt" },
      { name: "lint", description: "", groupId: "parallel", stepName: "lint" },
      { name: "test__fast", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/fast" },
      { name: "test__deep", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/deep" },
      { name: "finish", description: "" },
    ]

    expect(pipelineSelectionTargets(phases)).toEqual([
      { kind: "phase", name: "prepare" },
      { kind: "group", groupId: "models", stepName: "review" },
      { kind: "phase", name: "review__opus" },
      { kind: "phase", name: "review__gpt" },
      { kind: "group", groupId: "parallel" },
      { kind: "phase", name: "lint" },
      { kind: "group", groupId: "parallel", stepName: "test" },
      { kind: "phase", name: "test__fast" },
      { kind: "phase", name: "test__deep" },
      { kind: "phase", name: "finish" },
    ])
  })

  test("auto-follow rests on the group header while any member of a concurrent group is active", () => {
    const phases: ProgressPhase[] = [
      { name: "prepare", description: "", groupId: "g1" },
      { name: "review__opus", description: "", groupId: "models", stepName: "review", plannedModel: "anthropic/claude-opus" },
      { name: "review__gpt", description: "", groupId: "models", stepName: "review", plannedModel: "openai/gpt" },
      { name: "lint", description: "", groupId: "parallel", stepName: "lint" },
      { name: "test__fast", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/fast" },
      { name: "test__deep", description: "", groupId: "parallel", stepName: "test", plannedModel: "provider/deep" },
      { name: "finish", description: "" },
    ]

    // Sequential steps (unique or missing groupId) follow the leaf itself.
    expect(autoFollowGroup(phases, phases[0]!)).toBeUndefined()
    expect(autoFollowGroup(phases, phases[6]!)).toBeUndefined()

    // A pure models: fan-out follows its step header, whichever member emits.
    expect(autoFollowGroup(phases, phases[1]!)).toEqual({ kind: "group", groupId: "models", stepName: "review" })
    expect(autoFollowGroup(phases, phases[2]!)).toEqual({ kind: "group", groupId: "models", stepName: "review" })

    // A parallel block of distinct steps follows its top header — the same
    // stable node no matter which child (plain or fanned-out) was active last.
    expect(autoFollowGroup(phases, phases[3]!)).toEqual({ kind: "group", groupId: "parallel" })
    expect(autoFollowGroup(phases, phases[4]!)).toEqual({ kind: "group", groupId: "parallel" })
    expect(autoFollowGroup(phases, phases[5]!)).toEqual({ kind: "group", groupId: "parallel" })
  })

  test("uses readable adaptive comparison columns", () => {
    expect(comparisonColumnCount(40, 3)).toBe(1)
    expect(comparisonColumnCount(70, 3)).toBe(2)
    expect(comparisonColumnCount(100, 3)).toBe(3)
    expect(comparisonColumnCount(200, 5)).toBe(3)
  })
})

describe("permission modal [e] explain and [i] inspect", () => {
  test("[e] without explain callback reports that no safety judge is configured", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      const permission = dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      mockInput.pressKey("e")
      await renderOnce()
      const frame = captureCharFrame()
      expect(frame).toContain("permission required")
      expect(frame).toContain("no safety judge configured to explain this")

      mockInput.pressKey("o")
      expect(await permission).toBe("once")
    } finally {
      dashboard.stop()
    }
  })

  test("[e] with explain renders thinking then the wrapped text", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      let resolveExplain: (text: string) => void = () => {}
      const explain = (_signal?: AbortSignal) => new Promise<string>((resolve) => { resolveExplain = resolve })
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [], explain })
      await renderOnce()

      // Press [e] → thinking state
      mockInput.pressKey("e")
      await renderOnce()
      expect(captureCharFrame()).toContain("thinking")

      // Resolve the explain promise
      resolveExplain("This command lists files. It is safe because it is read-only.")
      // Wait for promise microtask
      await new Promise((resolve) => setTimeout(resolve, 0))
      await renderOnce()

      const frame = captureCharFrame()
      expect(frame).toContain("lists files")
      expect(frame).toContain("read-only")
    } finally {
      dashboard.stop()
    }
  })

  test("[o] resolves during an explain in flight and aborts it", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      const explain = (_signal?: AbortSignal) => new Promise<string>(() => {})
      const promise = dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [], explain })
      await renderOnce()

      // Press [e] → thinking
      mockInput.pressKey("e")
      await renderOnce()
      expect(captureCharFrame()).toContain("thinking")

      // Press [o] to resolve the permission
      mockInput.pressKey("o")
      const reply = await promise
      expect(reply).toBe("once")
      // The explain promise is still pending — the resolve function won't be called
      // because the queue was shifted. This is fine; the cancelled promise is gc'd.
    } finally {
      dashboard.stop()
    }
  })

  test("[i] without serverUrl reports the error inside the modal", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [], sessionID: "sess-1" })
      await renderOnce()

      // serverUrl defaults to "" (empty), so [i] should report no live server
      mockInput.pressKey("i")
      await renderOnce()

      expect(captureCharFrame()).toContain("no live opencode server")
    } finally {
      dashboard.stop()
    }
  })

  test("[i] without sessionID reports the error inside the modal", async () => {
    const { dashboard, mockInput, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      // No sessionID on the info
      mockInput.pressKey("i")
      await renderOnce()

      expect(captureCharFrame()).toContain("no session to inspect")
    } finally {
      dashboard.stop()
    }
  })

  test("a wide footer contains [e] and [i] hints", async () => {
    const { dashboard, renderOnce, captureCharFrame } = await createDashboard(200, 40)
    try {
      void dashboard.askPermission({ id: "p1", permission: "bash", command: "ls", patterns: [] })
      await renderOnce()

      const row = lineContaining(captureCharFrame(), "inspect")
      // Glued style: keys and hint are concatenated (e.g. "inspect" = "i" + "nspect")
      expect(row).toContain("inspect")
      expect(row).toContain("explain")
    } finally {
      dashboard.stop()
    }
  })
})
