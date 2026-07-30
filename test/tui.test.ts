import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import type { Selection } from "@opentui/core"

import { TuiProgress, autoFollowGroup, comparisonColumnCount, initialContentTab, iteratePrompt, phaseCapabilityBadges, phaseCapabilityLabel, pickBadge, pipelineSelectionTargets, type ContentTab } from "../src/tui"
import { displayWidth, formatMoney, limitsRow } from "../src/tui-theme"
import { shortVersion } from "../src/version"

import type { ClipboardResult } from "../src/clipboard"
import type { LimitsSnapshot } from "../src/limits"
import type { FinishSeam, ProgressPhase } from "../src/progress"
import type { AdvisorEvent } from "../src/advisor-events"

type DashboardInternals = {
  bodyBox: { primaryAxis: "row" | "column" }
  feedText: { x: number; y: number; plainText: string }
  headerText: { plainText: string }
  footerText: { plainText: string }
  pipelineBox: { width: number; height: number; x: number; y: number }
  pipelineScroll: number
  rightBox: { x: number; y: number }
  reports: Map<string, string[] | "loading" | "missing">
  contentTab: ContentTab
  fullscreen?: { phase: string; tab: ContentTab; scroll: number }
  fullscreenScrollbar: { visible: boolean; scrollSize: number; viewportSize: number; slider: { value: number } }
  reportOverlay: { title: string; visible: boolean }
  overlay: { visible: boolean }
  modalText: { plainText: string }
  permissionQueue: unknown[]
  feed: Array<{ message: string }>
  reportLines: WeakMap<string[], { values: Map<number, unknown> }>
  reportPanelLines(...args: unknown[]): unknown
  wrappedReport(report: string[], width: number): unknown
  dirty: boolean
  lastRenderAt: number
  render(): void
  animationTick(): void
  handleFullscreenKey(key: { name: string; preventDefault(): void; stopPropagation(): void }): void
  handleNavKey(key: { name: string; preventDefault(): void; stopPropagation(): void }): void
  handleFullscreenWheel(event: {
    scroll?: { direction: string; delta: number }
    preventDefault(): void
    stopPropagation(): void
  }): void
  finishModal?: { kind: string; stage?: string; note?: string }
  handleFinishKey(key: { name: string; preventDefault(): void; stopPropagation(): void }): void
  openFinishModal(): Promise<void>
}

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

async function selectText(
  dashboard: TuiProgress,
  mockMouse: Awaited<ReturnType<typeof createTestRenderer>>["mockMouse"],
  text: string,
) {
  const feedText = (dashboard as unknown as DashboardInternals).feedText
  const lines = feedText.plainText.split("\n")
  const row = lines.findIndex((line) => line.includes(text))
  expect(row).toBeGreaterThanOrEqual(2)
  const column = lines[row]!.indexOf(text)
  await mockMouse.drag(
    feedText.x + column,
    feedText.y + row,
    feedText.x + column + text.length,
    feedText.y + row,
  )
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
    await wide.renderOnce()

    expect((wide.dashboard as unknown as DashboardInternals).headerText.plainText).toContain(`◆ convoy ${shortVersion()}`)

    // The version lengthens the left side of padBetween, which clips the right;
    // no header line may outgrow the panel and get chopped by its border.
    const narrow = await createDashboard(60, 40)
    await narrow.renderOnce()
    const lines = (narrow.dashboard as unknown as DashboardInternals).headerText.plainText.split("\n")

    expect(lines[0]).toContain(shortVersion())
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(54)
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
    const { dashboard, mockInput, renderOnce } = await createDashboard(120, 40, [{
      name: "implement",
      description: "",
      plannedAdvisor: "anthropic/opus",
      advisorMaxCalls: 2,
    }])
    try {
      const internals = dashboard as unknown as DashboardInternals
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

      expect(internals.contentTab).toBe("advisor")
      expect(internals.feedText.plainText).toContain("requested")
      expect(internals.feedText.plainText).toContain("on-demand")
      expect(internals.feedText.plainText).toContain("completed")
      expect(internals.feedText.plainText).toContain("$0.02")
      expect(internals.feedText.plainText).toContain("tool")
      expect(internals.feedText.plainText).toContain("adopted")
      expect(internals.feedText.plainText).toContain("unavailable")
    } finally {
      dashboard.stop()
    }
  })

  test("gives the pipeline sidebar one third of the dashboard width", async () => {
    const { dashboard } = await createDashboard()
    try {
      const internals = dashboard as unknown as DashboardInternals
      // Renderer width (120) less the shell chrome (6), split 1/3 for pipeline.
      expect(internals.pipelineBox.width).toBe(38)
    } finally {
      dashboard.stop()
    }
  })

  test("caps the pipeline sidebar on very wide terminals", async () => {
    const { dashboard } = await createDashboard(240)
    try {
      const internals = dashboard as unknown as DashboardInternals
      expect(internals.pipelineBox.width).toBe(44)
    } finally {
      dashboard.stop()
    }
  })

  test("stacks narrow dashboards and keeps an overlong top pipeline scrollable", async () => {
    const phases = Array.from({ length: 10 }, (_, index) => ({ name: `step-${index + 1}`, description: "" }))
    const { dashboard, renderOnce } = await createDashboard(80, 24, phases)
    try {
      const internals = dashboard as unknown as DashboardInternals
      await renderOnce()

      expect(internals.bodyBox.primaryAxis).toBe("column")
      expect(internals.pipelineBox.width).toBe(78)
      expect(internals.pipelineBox.height).toBe(6)
      expect(internals.rightBox.x).toBe(internals.pipelineBox.x)
      expect(internals.rightBox.y).toBeGreaterThan(internals.pipelineBox.y)

      for (let index = 0; index < 8; index++) internals.handleNavKey({ name: "down", preventDefault() {}, stopPropagation() {} })
      expect(internals.pipelineScroll).toBeGreaterThan(0)
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
    const { dashboard, mockInput, renderOnce } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onPauseToggle: () => toggles++ })
    try {
      const internals = dashboard as unknown as DashboardInternals
      mockInput.pressKey("p")
      expect(toggles).toBe(1)

      dashboard.runControlState("pausing", 2)
      await renderOnce()
      expect(internals.headerText.plainText).toContain("pausing · 2 active")

      dashboard.runControlState("paused", 0)
      await renderOnce()
      expect(internals.headerText.plainText).toContain("paused · p resume")
      expect(internals.footerText.plainText).toContain("ctrl+p")
    } finally {
      dashboard.stop()
    }
  })

  test("p reports why pause is unavailable on an attached observer dashboard", async () => {
    let toggles = 0
    const { dashboard, mockInput } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { observer: true, onPauseToggle: () => toggles++ })
    try {
      const internals = dashboard as unknown as DashboardInternals
      mockInput.pressKey("p")

      expect(toggles).toBe(0)
      expect(internals.feed.map((entry) => entry.message)).toContain("pause isn't available while attached read-only")
    } finally {
      dashboard.stop()
    }
  })

  test("ctrl+p opens commands without triggering pause, while p still pauses", async () => {
    let pauses = 0
    const { dashboard, mockInput, renderOnce } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { onPauseToggle: () => pauses++ })
    try {
      const internals = dashboard as unknown as DashboardInternals & { commandPalette?: { view: string } }
      await renderOnce()
      expect(internals.footerText.plainText).toContain("ctrl+p")

      mockInput.pressKey("p", { ctrl: true })
      expect(internals.commandPalette?.view).toBe("commands")
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

describe("dashboard content selection", () => {
  test("copies selected session text and clears the successful selection", async () => {
    const { dashboard, mockMouse, renderer, renderOnce, copied } = await createDashboard()
    try {
      const text = "session selection payload"
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      await selectText(dashboard, mockMouse, text)

      expect(copied).toEqual([text])
      expect(renderer.hasSelection).toBeFalse()
    } finally {
      dashboard.stop()
    }
  })

  test("copies selected report text", async () => {
    const { dashboard, mockMouse, renderOnce, copied } = await createDashboard()
    try {
      const text = "report selection payload"
      const internals = dashboard as unknown as DashboardInternals
      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", [text])
      internals.contentTab = "reports"
      dashboard.phaseActivity("implement", "report ready")
      await renderOnce()

      await selectText(dashboard, mockMouse, text)

      expect(copied).toEqual([text])
    } finally {
      dashboard.stop()
    }
  })

  test("renders markdown in the session and report views", async () => {
    const { dashboard, renderOnce } = await createDashboard()
    try {
      const internals = dashboard as unknown as DashboardInternals
      dashboard.phaseStarted("implement")
      // Blank lines between the blocks on purpose: without one, the quote is a
      // lazy continuation *inside* the list item and the test would be pinning
      // that nesting rather than the markdown structure it means to check.
      dashboard.phaseMessage("implement", { channel: "response", text: "# Answer\n\n- **first**\n\n> quoted" })
      dashboard.phaseActivity("implement", "response received")
      await renderOnce()

      expect(internals.feedText.plainText).toContain("Answer")
      expect(internals.feedText.plainText).toContain("  • first")
      expect(internals.feedText.plainText).toContain("  ▎ quoted")
      expect(internals.feedText.plainText).not.toContain("# Answer")
      expect(internals.feedText.plainText).not.toContain("**first**")

      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", ["## Report", "", "- `result`"])
      internals.contentTab = "reports"
      dashboard.phaseActivity("implement", "report ready")
      await renderOnce()

      expect(internals.feedText.plainText).toContain("Report\n\n• result")
      expect(internals.feedText.plainText).not.toContain("## Report")
      expect(internals.feedText.plainText).not.toContain("`result`")
    } finally {
      dashboard.stop()
    }
  })

  test("wraps a long log message under the message column instead of cutting it", async () => {
    const { dashboard, renderOnce } = await createDashboard(90, 40)
    try {
      const internals = dashboard as unknown as DashboardInternals
      dashboard.phaseStarted("implement")
      internals.contentTab = "logs"
      dashboard.phaseActivity("implement", "wrapped ".repeat(20).trim())
      await renderOnce()

      const rendered = internals.feedText.plainText.split("\n").filter((line) => line.includes("wrapped"))
      expect(rendered.length).toBeGreaterThan(1)
      // Continuation rows hang under the message column rather than restarting
      // at column 0, so the timestamp gutter stays a column.
      const gutter = rendered[0]!.indexOf("wrapped")
      expect(gutter).toBeGreaterThan(0)
      expect(rendered[1]!.startsWith(" ".repeat(gutter))).toBeTrue()
    } finally {
      dashboard.stop()
    }
  })

  test("renders log messages as prose, applying typography but not block markdown", async () => {
    const { dashboard, renderOnce } = await createDashboard(90, 40)
    try {
      const internals = dashboard as unknown as DashboardInternals
      dashboard.phaseStarted("implement")
      internals.contentTab = "logs"
      dashboard.phaseActivity("implement", "- ran `bun test` twice")
      await renderOnce()

      // A message starting with "- " is a message, not a bullet.
      expect(internals.feedText.plainText).toContain("- ran bun test twice")
      expect(internals.feedText.plainText).not.toContain("`bun test`")
      expect(internals.feedText.plainText).not.toContain("• ran")
    } finally {
      dashboard.stop()
    }
  })

  test("elides a log message that would outgrow its row budget", async () => {
    const { dashboard, renderOnce } = await createDashboard(60, 40)
    try {
      const internals = dashboard as unknown as DashboardInternals
      dashboard.phaseStarted("implement")
      internals.contentTab = "logs"
      dashboard.phaseActivity("implement", "verbose ".repeat(40).trim())
      await renderOnce()

      const rendered = internals.feedText.plainText.split("\n").filter((line) => line.includes("verbose"))
      expect(rendered.length).toBe(3)
      expect(rendered[2]!.endsWith("…")).toBeTrue()
    } finally {
      dashboard.stop()
    }
  })

  test("the animation ticker repaints running spinners and idles otherwise", async () => {
    const { dashboard } = await createDashboard()
    try {
      const internals = dashboard as unknown as DashboardInternals

      // Nothing started: no spinner on screen, so a tick right after a repaint
      // does nothing (the 1 Hz clock fallback is the only other repaint).
      internals.dirty = false
      internals.lastRenderAt = Date.now()
      internals.animationTick()
      expect(Date.now() - internals.lastRenderAt).toBeLessThan(50)
      const idleAt = internals.lastRenderAt

      // A running phase animates a spinner, so every tick repaints it.
      dashboard.phaseStarted("implement")
      internals.dirty = false
      internals.lastRenderAt = 0
      internals.animationTick()
      expect(internals.lastRenderAt).toBeGreaterThanOrEqual(idleAt)

      // The finish screen is frozen: no spinners, no clock, no repaints. Its
      // promise only settles when the reader quits, so it is not awaited here.
      dashboard.phaseCompleted("implement")
      void dashboard.runFinished?.({ status: "completed", runDir: "/run" })
      await Bun.sleep(0)
      internals.dirty = false
      const frozenAt = internals.lastRenderAt - 10_000
      internals.lastRenderAt = frozenAt
      internals.animationTick()
      expect(internals.lastRenderAt).toBe(frozenAt)
    } finally {
      dashboard.stop()
    }
  })

  test("separate reasoning summaries stay separate bullets under one label", async () => {
    const { dashboard, renderOnce } = await createDashboard()
    try {
      const internals = dashboard as unknown as DashboardInternals
      dashboard.phaseStarted("implement")
      // Each summary is its own provider part; merging them would read as
      // "…diff scope inspectionInspecting rules…".
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "Planning diff scope inspection", partID: "reasoning:1" })
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "Inspecting rules", partID: "reasoning:2" })
      dashboard.phaseMessage("implement", { channel: "reasoning", text: " and loading skills", partID: "reasoning:2" })
      dashboard.phaseMessage("implement", { channel: "response", text: "done", partID: "text:1" })
      dashboard.phaseActivity("implement", "streamed")
      await renderOnce()

      const text = internals.feedText.plainText
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

  test("re-wraps memoized transcript lines when the panel width changes", async () => {
    const { dashboard, renderOnce, resize } = await createDashboard(200, 40)
    try {
      const internals = dashboard as unknown as DashboardInternals
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "reasoning", text: "wrap ".repeat(30).trim(), partID: "reasoning:1" })
      dashboard.phaseActivity("implement", "streamed")
      await renderOnce()
      const wide = internals.feedText.plainText.split("\n").filter((line) => line.includes("wrap")).length

      resize(90, 40)
      dashboard.phaseActivity("implement", "still streaming")
      await renderOnce()
      const narrow = internals.feedText.plainText.split("\n").filter((line) => line.includes("wrap")).length

      expect(narrow).toBeGreaterThan(wide)
    } finally {
      dashboard.stop()
    }
  })

  test("opens reports, session history, and logs with v; the reader scrolls by mouse and shows a scrollbar", async () => {
    const { dashboard, copied, mockInput, renderOnce } = await createDashboard()
    try {
      const internals = dashboard as unknown as DashboardInternals
      const report = ["# Result", "", "- first", "- second"]
      dashboard.start("run", "/target", "/run")
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: "# Session\n\nmessage history" })
      internals.reports.set("implement", report)
      internals.contentTab = "reports"

      mockInput.pressKey("v")
      expect(internals.fullscreen).toMatchObject({ phase: "implement", tab: "reports" })

      mockInput.pressKey("c")
      await Bun.sleep(0)
      expect(copied).toEqual([report.join("\n")])

      mockInput.pressKey("v")
      expect(internals.fullscreen).toBeUndefined()

      internals.contentTab = "session"
      mockInput.pressKey("v")
      expect(internals.fullscreen).toMatchObject({ phase: "implement", tab: "session" })
      internals.handleFullscreenKey({ name: "escape", preventDefault() {}, stopPropagation() {} })
      expect(internals.fullscreen).toBeUndefined()

      for (let index = 0; index < 50; index++) dashboard.phaseActivity("implement", `log item ${index}`)
      internals.contentTab = "logs"
      mockInput.pressKey("v")
      await renderOnce()
      expect(internals.fullscreen).toMatchObject({ phase: "implement", tab: "logs", scroll: 0 })
      expect(internals.fullscreenScrollbar.visible).toBeTrue()
      expect(internals.fullscreenScrollbar.scrollSize).toBeGreaterThan(internals.fullscreenScrollbar.viewportSize)

      let prevented = false
      let stopped = false
      internals.handleFullscreenWheel({
        scroll: { direction: "down", delta: 3 },
        preventDefault() {
          prevented = true
        },
        stopPropagation() {
          stopped = true
        },
      })
      expect(internals.fullscreen?.scroll).toBe(3)
      expect(prevented).toBeTrue()
      expect(stopped).toBeTrue()

      // Slider value changes come from track clicks and thumb drags.
      internals.fullscreenScrollbar.slider.value = 8
      expect(internals.fullscreen?.scroll).toBe(8)

      internals.handleFullscreenKey({ name: "escape", preventDefault() {}, stopPropagation() {} })
      expect(internals.fullscreen).toBeUndefined()
    } finally {
      dashboard.stop()
    }
  })

  test("caches inline and fullscreen report wraps while coalescing reader scrolls", async () => {
    const { dashboard, mockInput, renderOnce } = await createDashboard(200, 50)
    try {
      const internals = dashboard as unknown as DashboardInternals
      const report = ["# Result", "", ...Array.from({ length: 100 }, (_, index) => `- report line ${index + 1}`)]
      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", report)
      internals.contentTab = "reports"
      await renderOnce()

      mockInput.pressKey("v")
      const memo = internals.reportLines.get(report)
      expect(memo?.values.size).toBe(2)
      const cachedWraps = [...memo!.values.entries()]

      let renders = 0
      let hiddenPanelRenders = 0
      const render = internals.render.bind(dashboard)
      internals.render = () => {
        renders++
        render()
      }
      const reportPanelLines = internals.reportPanelLines.bind(dashboard)
      internals.reportPanelLines = (...args) => {
        hiddenPanelRenders++
        return reportPanelLines(...args)
      }
      for (let index = 0; index < 10; index++) {
        internals.handleFullscreenWheel({
          scroll: { direction: "down", delta: 1 },
          preventDefault() {},
          stopPropagation() {},
        })
      }

      expect(renders).toBe(0)
      expect(internals.dirty).toBeTrue()
      await renderOnce()

      expect(renders).toBe(1)
      expect(hiddenPanelRenders).toBe(0)
      for (const [width, value] of cachedWraps) expect(memo!.values.get(width)).toBe(value)
    } finally {
      dashboard.stop()
    }
  })

  test("bounds the per-width wrap cache to the most recent widths", async () => {
    const { dashboard } = await createDashboard(200, 50)
    try {
      const internals = dashboard as unknown as DashboardInternals
      const report = ["# Result", "", ...Array.from({ length: 20 }, (_, index) => `- report line ${index + 1}`)]
      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", report)
      // Wrapping more widths than the cap simulates a resize drag: each width
      // the panel passes through would otherwise accumulate a permanent wrap.
      const wraps: unknown[] = []
      for (const width of [40, 50, 60, 70, 80, 90]) wraps.push(internals.wrappedReport(report, width))
      const memo = internals.reportLines.get(report)
      expect(memo?.values.size).toBe(4)
      // FIFO eviction: the two oldest widths drop, the four newest survive and
      // keep the exact wrap values returned to their callers — the most recent
      // width the panel lands on stays cached, so no re-wrap on the next frame.
      for (const width of [40, 50]) expect(memo!.values.has(width)).toBeFalse()
      for (let index = 0; index < 4; index++) expect(memo!.values.get([60, 70, 80, 90][index]!)).toBe(wraps[index + 2])
    } finally {
      dashboard.stop()
    }
  })

  test("bounds the wrap cache under a resize drag while always keeping the width on screen", async () => {
    const { dashboard, mockInput, renderOnce, resize } = await createDashboard(200, 50)
    try {
      const internals = dashboard as unknown as DashboardInternals
      const report = ["# Result", "", ...Array.from({ length: 60 }, (_, index) => `- report line ${index + 1}`)]
      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", report)
      internals.contentTab = "reports"
      await renderOnce()
      // The inline panel wraps once at its own width; capture that key.
      const panelWidth = [...internals.reportLines.get(report)!.values.keys()][0]!

      mockInput.pressKey("v")
      expect(internals.fullscreen).toBeDefined()
      // Opening the reader adds a second, distinct width; both survive.
      expect(internals.reportLines.get(report)!.values.has(panelWidth)).toBeTrue()
      expect(internals.reportLines.get(report)!.values.size).toBe(2)

      // A resize drag while reading re-wraps only the reader's new width — the
      // dashboard pass is skipped under the opaque overlay, so the panel's wrap
      // is never re-touched. In production a running phase's ticker repaints
      // after the resize; here we mark the screen dirty the way scheduleRender
      // does, then let renderOnce flush the frame.
      const readerWidth = (terminal: number) => Math.max(20, terminal - 9)
      const drag = async (terminal: number) => {
        resize(terminal, 50)
        internals.dirty = true
        await renderOnce()
      }

      // A short drag stays inside the cap, so the panel's wrap is still there.
      await drag(160)
      await drag(120)
      const memo = internals.reportLines.get(report)!
      expect(memo.values.has(panelWidth)).toBeTrue()
      expect(memo.values.has(readerWidth(120))).toBeTrue()
      expect(memo.values.size).toBeLessThanOrEqual(4)

      // A long drag ages the panel's wrap out — only the reader's width is live
      // under the overlay, so nothing refreshes the panel entry. That is the
      // intended trade: bounded memory, at the cost of one re-wrap when the
      // reader closes. What must never break is the invariant below.
      for (const terminal of [110, 100, 90, 80]) await drag(terminal)
      expect(memo.values.has(panelWidth)).toBeFalse()

      // The invariant: the cache stays at the cap no matter how long the drag
      // runs, and the width the overlay just painted is always still cached, so
      // no frame is ever forced to re-wrap the document it just rendered.
      expect(memo.values.size).toBe(4)
      expect(memo.values.has(readerWidth(80))).toBeTrue()
    } finally {
      dashboard.stop()
    }
  })

  test("coalesces keyboard scrolls in the fullscreen reader one frame per burst", async () => {
    const { dashboard, mockInput, renderOnce } = await createDashboard(200, 50)
    try {
      const internals = dashboard as unknown as DashboardInternals
      const report = ["# Result", "", ...Array.from({ length: 100 }, (_, index) => `- report line ${index + 1}`)]
      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", report)
      internals.contentTab = "reports"
      await renderOnce()

      mockInput.pressKey("v")
      expect(internals.fullscreen).toBeDefined()
      const startScroll = internals.fullscreen!.scroll

      // A flick of j/k repeats must not paint synchronously per keypress: each
      // press only marks the screen dirty and defers to the next frame, so a
      // burst collapses to a single render — matching the wheel path.
      let renders = 0
      const render = internals.render.bind(dashboard)
      internals.render = () => {
        renders++
        render()
      }
      for (const name of ["j", "j", "k", "pageup", "pagedown", "down"]) {
        internals.handleFullscreenKey({ name, preventDefault() {}, stopPropagation() {} })
      }

      expect(renders).toBe(0)
      expect(internals.dirty).toBeTrue()
      expect(internals.fullscreen!.scroll).not.toBe(startScroll)
      await renderOnce()

      expect(renders).toBe(1)
    } finally {
      dashboard.stop()
    }
  })

  test("closes the fullscreen reader with an immediate render, not a deferred one", async () => {
    const { dashboard, mockInput, renderOnce } = await createDashboard(200, 50)
    try {
      const internals = dashboard as unknown as DashboardInternals
      const report = ["# Result", "", "- only line"]
      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", report)
      internals.contentTab = "reports"
      await renderOnce()

      mockInput.pressKey("v")
      expect(internals.fullscreen).toBeDefined()

      // Non-scroll keys (close/quit) paint right away so the dashboard reappears
      // in the same input tick instead of waiting for the next frame.
      let renders = 0
      const render = internals.render.bind(dashboard)
      internals.render = () => {
        renders++
        render()
      }
      internals.handleFullscreenKey({ name: "escape", preventDefault() {}, stopPropagation() {} })

      expect(internals.fullscreen).toBeUndefined()
      expect(renders).toBe(1)
      expect(internals.dirty).toBeFalse()
    } finally {
      dashboard.stop()
    }
  })

  test("paints a modal over the open reader without losing it", async () => {
    const { dashboard, mockInput, renderOnce } = await createDashboard(200, 50)
    try {
      const internals = dashboard as unknown as DashboardInternals
      const report = ["# Result", "", "- only line"]
      dashboard.start("run", "/target", "/run")
      internals.reports.set("implement", report)
      internals.contentTab = "reports"
      await renderOnce()

      // Open the reader — the opaque overlay takes over the screen.
      mockInput.pressKey("v")
      expect(internals.fullscreen).toBeDefined()
      expect(internals.reportOverlay.visible).toBeTrue()

      // A permission prompt arriving while the reader is open must still paint
      // over it: the reader does not swallow modal state. The new early-return
      // branch in render() still calls renderModal(), so the overlay flips on.
      void dashboard.askPermission({ id: "1", permission: "bash", command: "ls", patterns: [] })
      expect(internals.permissionQueue.length).toBe(1)
      await renderOnce()

      expect(internals.overlay.visible).toBeTrue()
      // The modal text carries the permission label, proving renderModal ran.
      expect(internals.modalText.plainText).toContain("bash")
      // The reader stays mounted underneath — closing the reader does not drop
      // the queued prompt.
      expect(internals.fullscreen).toBeDefined()
      expect(internals.reportOverlay.visible).toBeTrue()
    } finally {
      dashboard.stop()
    }
  })

  test("shows the specific report copy failure in the fullscreen reader", async () => {
    for (const [result, label] of [
      ["unsupported", "terminal clipboard (OSC52) unavailable"],
      ["transport-failed", "couldn't copy report; report is too large for this terminal transport"],
    ] as const) {
      const { dashboard, mockInput, renderOnce } = await createDashboard(120, 40, [{ name: "implement", description: "" }], { copyResult: result })
      try {
        const internals = dashboard as unknown as DashboardInternals
        dashboard.start("run", "/target", "/run")
        internals.reports.set("implement", ["# Result"])
        internals.contentTab = "reports"

        mockInput.pressKey("v")
        mockInput.pressKey("c")
        await Bun.sleep(0)
        await renderOnce()

        expect(internals.reportOverlay.title).toContain(label)
      } finally {
        dashboard.stop()
      }
    }
  })

  test("copies selected log text", async () => {
    const { dashboard, mockMouse, renderOnce, copied } = await createDashboard()
    try {
      const text = "Next command: /mr-comment 20260717-122207-c4cn 90"
      const internals = dashboard as unknown as DashboardInternals
      internals.contentTab = "logs"
      dashboard.phaseActivity("implement", text)
      await renderOnce()

      await selectText(dashboard, mockMouse, text)

      expect(copied).toEqual([text])
    } finally {
      dashboard.stop()
    }
  })

  test("does not copy tab-strip, empty, or cross-panel selections", async () => {
    const { dashboard, mockMouse, renderer, renderOnce, copied } = await createDashboard()
    try {
      const sessionText = "session selection payload"
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: sessionText })
      dashboard.phaseActivity("implement", "session ready")
      await renderOnce()

      const feedText = (dashboard as unknown as DashboardInternals).feedText
      await mockMouse.drag(feedText.x, feedText.y, feedText.x + 3, feedText.y)
      await mockMouse.drag(feedText.x, feedText.y + 2, feedText.x - 10, feedText.y + 2)
      renderer.emit("selection", {
        bounds: { x: feedText.x, y: feedText.y + 2, width: 0, height: 0 },
        selectedRenderables: [feedText],
        getSelectedText: () => "",
      } as unknown as Selection)

      expect(copied).toEqual([])
    } finally {
      dashboard.stop()
    }
  })

  test("does not copy selections that include another renderable", async () => {
    const { dashboard, renderer, renderOnce, copied } = await createDashboard()
    try {
      dashboard.phaseStarted("implement")
      dashboard.phaseMessage("implement", { channel: "response", text: "session selection payload" })
      await renderOnce()

      const feedText = (dashboard as unknown as DashboardInternals).feedText
      renderer.emit("selection", {
        bounds: { x: feedText.x, y: feedText.y + 2, width: 1, height: 1 },
        selectedRenderables: [feedText, {}],
        getSelectedText: () => "mixed selection",
      } as unknown as Selection)

      expect(copied).toEqual([])
    } finally {
      dashboard.stop()
    }
  })

  test("retains the selection when OSC52 copying is unavailable", async () => {
    const { dashboard, mockMouse, renderer, renderOnce } = await createDashboard()
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

      await selectText(dashboard, mockMouse, text)

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

  const press = (name: string) => ({ name, preventDefault() {}, stopPropagation() {} })
  // The handlers fire their follow-ups with `void`, so the awaits inside them
  // need a turn of the loop before the modal is asserted on.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  /** Drives [f] through prepare and the commit, landing on the "done" screen. */
  async function commit(options: SeamOptions & { width?: number } = {}) {
    const { seam, calls } = fakeSeam(options)
    const harness = await createDashboard(options.width ?? 120, 40, [{ name: "implement", description: "" }], { finishSeam: seam })
    const internals = harness.dashboard as unknown as DashboardInternals
    await internals.openFinishModal()
    internals.handleFinishKey(press("return"))
    await settle()
    return { ...harness, internals, calls }
  }

  test("offers push and push-and-PR as one fork after the commit", async () => {
    const { internals, dashboard, calls } = await commit()
    try {
      expect(internals.finishModal).toMatchObject({ kind: "done", stage: "choose" })
      const text = internals.modalText.plainText
      // Both branches are visible at once rather than push unlocking the PR.
      expect(text).toContain("p push")
      expect(text).toContain("r push and PR")
      expect(calls).toEqual({ push: 0, pr: 0 })
    } finally {
      dashboard.stop()
    }
  })

  test("push alone settles without ever offering a pull request", async () => {
    const { internals, dashboard, calls } = await commit()
    try {
      internals.handleFinishKey(press("p"))
      await settle()

      expect(calls).toEqual({ push: 1, pr: 0 })
      expect(internals.finishModal).toMatchObject({ kind: "done", stage: "settled" })
      const text = internals.modalText.plainText
      expect(text).toContain("pushed to origin/convoy/run")
      expect(text).toContain("press any key to close")
      expect(text).not.toContain("pull request")
    } finally {
      dashboard.stop()
    }
  })

  test("push and PR settles, and a second r closes instead of re-creating it", async () => {
    const { internals, dashboard, calls } = await commit()
    try {
      internals.handleFinishKey(press("r"))
      await settle()

      expect(calls).toEqual({ push: 1, pr: 1 })
      expect(internals.finishModal).toMatchObject({ kind: "done", stage: "settled" })
      const text = internals.modalText.plainText
      expect(text).toContain("pull request opened")
      expect(text).toContain("press any key to close")

      // The regression: the settled screen used to keep offering the PR, so a
      // second r ran `gh pr create` again on a branch that already had one.
      internals.handleFinishKey(press("r"))
      await settle()
      expect(calls).toEqual({ push: 1, pr: 1 })
      expect(internals.finishModal).toBeUndefined()
    } finally {
      dashboard.stop()
    }
  })

  test("a failed push keeps the fork up and never reaches the pull request", async () => {
    const { internals, dashboard, calls } = await commit({ pushFails: true })
    try {
      internals.handleFinishKey(press("r"))
      await settle()

      expect(calls).toEqual({ push: 1, pr: 0 })
      expect(internals.finishModal).toMatchObject({ kind: "done", stage: "choose" })
      const text = internals.modalText.plainText
      expect(text).toContain("push failed: no write access")
      expect(text).toContain("p push")
      expect(text).toContain("r push and PR")
    } finally {
      dashboard.stop()
    }
  })

  test("a failed gh keeps the push and offers just the retry", async () => {
    const { internals, dashboard, calls } = await commit({ prFails: true })
    try {
      internals.handleFinishKey(press("r"))
      await settle()

      expect(calls).toEqual({ push: 1, pr: 1 })
      expect(internals.finishModal).toMatchObject({ kind: "done", stage: "retry-pr" })
      // Both halves are reported: the push landed even though gh didn't. Read
      // off the state, since the rendered note wraps at the modal's width.
      expect(internals.finishModal?.note).toBe("pushed to origin/convoy/run · gh pr create failed: gh pr create didn't complete")
      const text = internals.modalText.plainText
      expect(text).toContain("pushed to origin/convoy/run")
      expect(text).toContain("r retry pull request")
      // The push is done, so re-offering it would only fail on an up-to-date ref.
      expect(text).not.toContain("p push")

      internals.handleFinishKey(press("r"))
      await settle()
      expect(calls).toEqual({ push: 1, pr: 2 })
    } finally {
      dashboard.stop()
    }
  })

  test("keeps both keys on a narrow terminal by dropping the hint", async () => {
    const { internals, dashboard } = await commit({ width: 48 })
    try {
      const row = internals.modalText.plainText.split("\n").at(-1)
      // The row is one unwrapped line, so the hint gives way before the keys do.
      expect(row).toBe("p push · r push and PR")
    } finally {
      dashboard.stop()
    }
  })

  test("without gh the fork is push only", async () => {
    const { internals, dashboard, calls } = await commit({ canPr: false })
    try {
      const text = internals.modalText.plainText
      expect(text).toContain("p push")
      expect(text).not.toContain("push and PR")

      // r is not on offer, so it falls through to closing the modal.
      internals.handleFinishKey(press("r"))
      await settle()
      expect(calls).toEqual({ push: 0, pr: 0 })
      expect(internals.finishModal).toBeUndefined()
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
