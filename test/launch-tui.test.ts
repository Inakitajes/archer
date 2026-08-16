import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { LaunchPicker, adjustGoalTarget, branchActionForKey, branchProposalNote, compactLaunchMaxWidth, cursorPosition, defaultGoalTarget, emptyPromptField, hookLines, launcherStepModelLabel, markPromptEdited, nextPromptSuggestion, pipelineChoices, pipelineRow, prefillPromptField, promptAfterPipelineSwitch, promptEnterAction, reviewActionForKey, sanitizePaste, stepTree, trimPromptField, typedText, wrapPromptLines } from "../src/launch-tui"

import { builtInAgents, builtInPipelines, hasWritableStep, resolvePipeline } from "../src/pipeline"
import { parseConvoyConfig } from "../src/config"
import { consensusStep } from "../src/quality-score"
import { displayWidth } from "../src/tui-theme"
import type { KeyEvent } from "@opentui/core"

function key(partial: Partial<KeyEvent>): KeyEvent {
  return partial as KeyEvent
}

function plainLines(lines: ReturnType<typeof stepTree>): string[] {
  return lines.map((line) => line.chunks.map((chunk) => chunk.text).join(""))
}

function launcherChoices(count = 1) {
  return Array.from({ length: count }, (_, index) => ({
    name: `pipeline-${index + 1}`,
    description: "A test pipeline.",
    source: "built-in" as const,
    isDefault: index === 0,
    steps: [],
    hooks: [],
    valid: true,
    advisedSteps: 0,
    scored: false,
  }))
}

async function createLauncher(width: number, height = 30, choiceCount = 1) {
  const testRenderer = await createTestRenderer({ width, height })
  const picker = new LaunchPicker(
    testRenderer.renderer,
    process.cwd(),
    launcherChoices(choiceCount),
    "configured",
    { isolate: false, reason: "test" },
    {} as never,
  )
  return { ...testRenderer, picker }
}

async function closeLauncher(launcher: Awaited<ReturnType<typeof createLauncher>>) {
  launcher.mockInput.pressKey("c", { ctrl: true })
  await expect(launcher.picker.result).resolves.toBeUndefined()
}

type LaunchPickerView = {
  mode: string
  prompt: string
  optionIndex: number
  modalWidth(): number
  promptDetail(width: number): { chunks: Array<{ text: string }> }
  optionsDetail(width: number): { chunks: Array<{ text: string }> }
}

function launchView(picker: LaunchPicker): LaunchPickerView {
  return picker as unknown as LaunchPickerView
}

function panelRow(frame: string, title: string) {
  const row = frame.split("\n").findIndex((line) => line.includes(title))
  expect(row, `missing ${title} panel`).toBeGreaterThanOrEqual(0)
  return row
}

describe("launch TUI compact layout", () => {
  test("switches panels at the 84-column breakpoint", async () => {
    const compact = await createLauncher(compactLaunchMaxWidth)
    const wide = await createLauncher(compactLaunchMaxWidth + 1)
    try {
      await compact.renderOnce()
      await wide.renderOnce()
      const compactFrame = compact.captureCharFrame()
      const wideFrame = wide.captureCharFrame()
      const compactPipelines = panelRow(compactFrame, "pipelines")
      const compactDetail = panelRow(compactFrame, "run setup")
      const widePipelines = panelRow(wideFrame, "pipelines")
      const wideDetail = panelRow(wideFrame, "run setup")

      expect(compactPipelines).toBeLessThan(compactDetail)
      expect(compactDetail - compactPipelines - 1).toBeGreaterThanOrEqual(5)
      expect(compactDetail - compactPipelines - 1).toBeLessThanOrEqual(9)
      expect(displayWidth(compactFrame.split("\n")[compactPipelines]!)).toBe(compactLaunchMaxWidth)
      expect(displayWidth(compactFrame.split("\n")[compactDetail]!)).toBe(compactLaunchMaxWidth)

      expect(widePipelines).toBe(wideDetail)
      expect(wideFrame.split("\n")[wideDetail]!.indexOf("run setup")).toBeGreaterThan(wideFrame.split("\n")[widePipelines]!.indexOf("pipelines"))
    } finally {
      await closeLauncher(compact)
      await closeLauncher(wide)
    }
  })

  test("updates the layout and preserves scrolling after a resize", async () => {
    const launcher = await createLauncher(90, 24, 10)
    try {
      await launcher.renderOnce()
      expect(panelRow(launcher.captureCharFrame(), "pipelines")).toBe(panelRow(launcher.captureCharFrame(), "run setup"))

      launcher.resize(80, 24)
      launcher.mockInput.pressKey("j")
      await launcher.renderOnce()
      expect(panelRow(launcher.captureCharFrame(), "pipelines")).toBeLessThan(panelRow(launcher.captureCharFrame(), "run setup"))

      for (let index = 0; index < 7; index++) launcher.mockInput.pressKey("j")
      await launcher.renderOnce()
      const frame = launcher.captureCharFrame()
      expect(frame).toContain("pipeline-9")
      expect(frame).not.toContain("pipeline-1")

      launcher.resize(90, 24)
      launcher.mockInput.pressKey("k")
      await launcher.renderOnce()
      expect(panelRow(launcher.captureCharFrame(), "pipelines")).toBe(panelRow(launcher.captureCharFrame(), "run setup"))

      launcher.resize(80, 24)
      launcher.mockInput.pressEnter()
      await launcher.renderOnce()
      const promptField = launcher.captureCharFrame().split("\n").find((line) => line.includes("┌"))!
      expect(displayWidth(promptField)).toBe(80)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("keeps detail content and narrow affordances within their row budgets", async () => {
    const launcher = await createLauncher(80)
    try {
      const view = launchView(launcher.picker)
      const choice = launcherChoices()[0]!

      expect(pipelineRow(choice, true, 32).chunks.map((chunk) => chunk.text).join("")).toContain("default")
      expect(pipelineRow(choice, true, 28).chunks.map((chunk) => chunk.text).join("")).not.toContain("default")

      view.mode = "prompt"
      view.prompt = "first\nsecond"
      const promptHint = view.promptDetail(40).chunks.map((chunk) => chunk.text).join("").split("\n").find((line) => line.includes("shift+enter"))!
      expect(displayWidth(promptHint)).toBeLessThanOrEqual(40)

      view.mode = "options"
      // The toggle list is taller than the compact panel, so the flags
      // summary only scrolls into view once the selection reaches the end.
      view.optionIndex = 6
      const flags = view.optionsDetail(40).chunks.map((chunk) => chunk.text).join("").split("\n").find((line) => line.includes("will run with"))!
      expect(displayWidth(flags)).toBeLessThanOrEqual(40)
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("keeps the selected toggle inside the options window when the list overflows", async () => {
    const launcher = await createLauncher(80, 24)
    try {
      const view = launchView(launcher.picker)
      view.mode = "options"

      view.optionIndex = 0
      const top = view.optionsDetail(60).chunks.map((chunk) => chunk.text).join("")
      expect(top).toContain("▸ ━━● on  Smart auto-accept")
      expect(top).not.toContain("will run with")

      view.optionIndex = 6
      const bottom = view.optionsDetail(60).chunks.map((chunk) => chunk.text).join("")
      expect(bottom).toContain("▸ ●━━ off Isolate in a worktree")
      expect(bottom).toContain("will run with")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("degrades the stage trail and clamps modal widths on narrow renderers", async () => {
    const narrow = await createLauncher(55)
    const wide = await createLauncher(80)
    const modal = await createLauncher(100)
    try {
      await narrow.renderOnce()
      await wide.renderOnce()
      expect(narrow.captureCharFrame()).not.toContain("→")
      expect(wide.captureCharFrame()).toContain("→")

      const view = launchView(modal.picker)
      expect(view.modalWidth()).toBe(80)
      modal.resize(50, 30)
      expect(view.modalWidth()).toBe(42)
      modal.resize(40, 30)
      expect(view.modalWidth()).toBe(34)
    } finally {
      await closeLauncher(narrow)
      await closeLauncher(wide)
      await closeLauncher(modal)
    }
  })

  test("pageup and pagedown page by the compact pipeline window, not the wide list height", async () => {
    // At 80×24 the compact pipeline panel shows 3 rows (compactPipelineHeight 5
    // minus its 2-row chrome), so paging moves the selection by 3 — not the 15
    // rows the wide layout would move. Pressing the escape sequences directly
    // because the mock-keys helper has no PageUp/PageDown entry in its KeyCodes.
    const launcher = await createLauncher(80, 24, 10)
    try {
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("● pipeline-1")

      launcher.mockInput.pressKey("\x1B[6~")
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("● pipeline-4")
      expect(launcher.captureCharFrame()).not.toContain("● pipeline-1")

      launcher.mockInput.pressKey("\x1B[5~")
      await launcher.renderOnce()
      expect(launcher.captureCharFrame()).toContain("● pipeline-1")
      expect(launcher.captureCharFrame()).not.toContain("● pipeline-4")
    } finally {
      await closeLauncher(launcher)
    }
  })

  test("mouse selection tracks the pipeline panel after it moves to the top", async () => {
    // selectFromList maps event.y through pipelineText.y, which compact mode
    // relocates from the body row to the top of the screen. Clicking a row that
    // only exists at its new stacked position verifies the y-adjustment survived
    // the layout switch.
    const launcher = await createLauncher(80, 24, 3)
    try {
      await launcher.renderOnce()
      const before = launcher.captureCharFrame()
      expect(before).toContain("● pipeline-1")
      expect(before).not.toContain("● pipeline-2")

      const lines = before.split("\n")
      const targetY = lines.findIndex((line) => line.includes("pipeline-2"))
      expect(targetY, "pipeline-2 row visible in compact stack").toBeGreaterThanOrEqual(0)
      const targetX = lines[targetY]!.indexOf("pipeline-2")
      await launcher.mockMouse.click(targetX, targetY)
      await launcher.renderOnce()

      const after = launcher.captureCharFrame()
      expect(after).toContain("● pipeline-2")
      expect(after).not.toContain("● pipeline-1")
    } finally {
      await closeLauncher(launcher)
    }
  })
})

describe("launch TUI narrow-width row budgets", () => {
  // The launcher's supported minimum terminal width is 46 columns, so the sweep
  // covers the full range the feature must look right in. Every row helper must
  // keep its display width inside the panel it's rendered against — anything
  // wider is silently chopped by the panel border, the bug this feature fixes.
  const widths = [160, 120, 100, 90, 80, 70, 60, 50, 46]

  test("pipelineRow never exceeds its panel width, with or without a badge", () => {
    const defaultChoice = { ...launcherChoices()[0]!, isDefault: true }
    const customChoice = { ...launcherChoices()[0]!, source: "configured" as const }
    const bareChoice = { ...launcherChoices()[0]!, isDefault: false, source: "built-in" as const }
    for (const width of widths) {
      for (const choice of [defaultChoice, customChoice, bareChoice]) {
        for (const selected of [true, false]) {
          const row = pipelineRow(choice, selected, width)
          const rowText = row.chunks.map((chunk) => chunk.text).join("")
          expect(displayWidth(rowText), `pipelineRow width ${width}`).toBeLessThanOrEqual(width)
        }
      }
    }
  })

  test("stepTree never exceeds its panel width across the supported range", () => {
    const steps = [
      { stepName: "implement", groupId: "g1", kind: "agent" as const, modelLabel: "gpt-5.6 xhigh", advisorLabel: "" },
      { stepName: "design", groupId: "g2", kind: "agent" as const, modelLabel: "claude-opus-4-8", advisorLabel: "" },
      { stepName: "implement", groupId: "g3", kind: "agent" as const, modelLabel: "gpt-5", advisorLabel: "claude-opus-5 advisor ×3" },
      { stepName: "implement", groupId: "g3", kind: "agent" as const, modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "implement", groupId: "g3", kind: "agent" as const, modelLabel: "gemini-3", advisorLabel: "" },
      { stepName: "audit-a", groupId: "g4", kind: "agent" as const, modelLabel: "gpt-5", advisorLabel: "" },
      { stepName: "audit-b", groupId: "g4", kind: "agent" as const, modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "approve", groupId: "", kind: "human" as const, modelLabel: "", advisorLabel: "" },
    ] satisfies Parameters<typeof stepTree>[0]
    for (const width of widths) {
      for (const line of stepTree(steps, width)) {
        const lineText = line.chunks.map((chunk) => chunk.text).join("")
        expect(displayWidth(lineText), `stepTree width ${width} line=${JSON.stringify(lineText)}`).toBeLessThanOrEqual(width)
      }
    }
  })

  test("hookLines never exceeds its panel width across the supported range", () => {
    const hooks = [
      { stage: "pre" as const, label: "lint" },
      { stage: "post" as const, label: "notify-slack", when: "failure" as const },
      { stage: "post" as const, label: "bun run build" },
      { stage: "post" as const, label: "a-really-long-hook-name-that-should-be-truncated", when: "always" as const },
    ] satisfies Parameters<typeof hookLines>[0]
    for (const width of widths) {
      for (const line of hookLines(hooks, width)) {
        const lineText = line.chunks.map((chunk) => chunk.text).join("")
        expect(displayWidth(lineText), `hookLines width ${width} line=${JSON.stringify(lineText)}`).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("launch TUI prompt input", () => {
  test("sanitizes pasted prompt text while preserving unlimited multi-line content", () => {
    const longLine = "x".repeat(5_000)
    const pasted = `first\r\nsecond\rthird\t${longLine}\u0000\u001b[31mred\u001b[0m`

    expect(sanitizePaste(pasted)).toBe(`first\nsecond\nthird ${longLine}[31mred[0m`)
  })

  test("sanitizePaste handles empty string", () => {
    expect(sanitizePaste("")).toBe("")
  })

  test("sanitizePaste handles string with only control characters", () => {
    expect(sanitizePaste("\x00\x01\x02\x7f")).toBe("")
  })

  test("sanitizePaste handles string without special characters", () => {
    expect(sanitizePaste("normal text")).toBe("normal text")
  })

  test("wraps long and multi-line prompts for the visible text field", () => {
    expect(wrapPromptLines("abcdef\n\nxyz", 3)).toEqual(["abc", "def", "", "xyz"])
    expect(wrapPromptLines("", 10)).toEqual([""])
    expect(wrapPromptLines("anything", 0)).toEqual([""])
  })

  test("wrapPromptLines handles single character width", () => {
    expect(wrapPromptLines("abc", 1)).toEqual(["a", "b", "c"])
  })

  test("wrapPromptLines handles text shorter than width", () => {
    expect(wrapPromptLines("hi", 10)).toEqual(["hi"])
  })

  test("wrapPromptLines handles multiple newlines", () => {
    expect(wrapPromptLines("\n\n\n", 5)).toEqual(["", "", "", ""])
  })

  test("maps cursor position across wrapped and pasted new-line content", () => {
    const text = "abcd\nefghij"

    expect(cursorPosition(text, 0, 4)).toEqual({ row: 0, col: 0 })
    expect(cursorPosition(text, 4, 4)).toEqual({ row: 0, col: 4 })
    expect(cursorPosition(text, 5, 4)).toEqual({ row: 1, col: 0 })
    expect(cursorPosition(text, text.length, 4)).toEqual({ row: 2, col: 2 })
  })

  test("cursorPosition for empty text", () => {
    expect(cursorPosition("", 0, 10)).toEqual({ row: 0, col: 0 })
  })

  test("cursorPosition at the start", () => {
    expect(cursorPosition("hello", 0, 5)).toEqual({ row: 0, col: 0 })
  })

  test("cursorPosition wraps at width boundary", () => {
    expect(cursorPosition("abcdef", 3, 3)).toEqual({ row: 0, col: 3 })
    expect(cursorPosition("abcdef", 4, 3)).toEqual({ row: 1, col: 1 })
  })

  test("cursorPosition with cursor beyond text length", () => {
    expect(cursorPosition("abc", 10, 2)).toEqual({ row: 1, col: 1 })
  })

  test("accepts normal text and plain raw paste, but ignores controls and named keys", () => {
    expect(typedText(key({ name: "a", raw: "a" }))).toBe("a")
    expect(typedText(key({ name: "space", raw: " " }))).toBe(" ")
    expect(typedText(key({ name: "", raw: "pasted text" }))).toBe("pasted text")
    expect(typedText(key({ name: "left", raw: "\u001b[D" }))).toBeUndefined()
    expect(typedText(key({ name: "v", raw: "v", ctrl: true }))).toBeUndefined()
  })

  test("typedText filters control bytes from raw paste", () => {
    expect(typedText(key({ name: "", raw: "\x00a\x01b\x7fc" }))).toBe("abc")
  })

  test("typedText returns undefined for empty raw after filtering", () => {
    expect(typedText(key({ name: "", raw: "\x00\x01\x02" }))).toBeUndefined()
  })

  test("typedText returns undefined for empty raw", () => {
    expect(typedText(key({ name: "", raw: "" }))).toBeUndefined()
  })

  test("uses Shift+Enter for prompt new-lines and Enter for continuing", () => {
    expect(promptEnterAction(key({ name: "return" }))).toBe("submit")
    expect(promptEnterAction(key({ name: "linefeed" }))).toBe("submit")
    expect(promptEnterAction(key({ name: "return", shift: true }))).toBe("newline")
    expect(promptEnterAction(key({ name: "a" }))).toBeUndefined()
  })

  test("promptEnterAction handles linefeed with shift", () => {
    expect(promptEnterAction(key({ name: "linefeed", shift: true }))).toBe("newline")
  })
})

describe("launch TUI review", () => {
  test("maps review controls to start, back, cancellation, and scrolling actions", () => {
    expect(reviewActionForKey(key({ name: "return" }))).toBe("start")
    expect(reviewActionForKey(key({ name: "s" }))).toBe("start")
    expect(reviewActionForKey(key({ name: "escape" }))).toBe("back")
    expect(reviewActionForKey(key({ name: "q" }))).toBe("cancel")
    expect(reviewActionForKey(key({ name: "p" }))).toBe("toggle-prompt")
    expect(reviewActionForKey(key({ name: "up" }))).toBe("scroll-back")
    expect(reviewActionForKey(key({ name: "pagedown" }))).toBe("page-forward")
    expect(reviewActionForKey(key({ name: "home" }))).toBe("top")
    expect(reviewActionForKey(key({ name: "end" }))).toBe("bottom")
  })

  test("review scroll controls include k and j vim keys", () => {
    expect(reviewActionForKey(key({ name: "k" }))).toBe("scroll-back")
    expect(reviewActionForKey(key({ name: "j" }))).toBe("scroll-forward")
  })

  test("review handles space as page-forward", () => {
    expect(reviewActionForKey(key({ name: "space" }))).toBe("page-forward")
  })

  test("review returns undefined for unrecognized key", () => {
    expect(reviewActionForKey(key({ name: "x" }))).toBeUndefined()
  })
})

describe("launch TUI branch step", () => {
  test("maps branch controls to editing, regeneration, and navigation", () => {
    expect(branchActionForKey(key({ name: "return" }))).toBe("submit")
    expect(branchActionForKey(key({ name: "tab" }))).toBe("next-field")
    expect(branchActionForKey(key({ name: "tab", shift: true }))).toBe("previous-field")
    expect(branchActionForKey(key({ name: "backtab" }))).toBe("previous-field")
    expect(branchActionForKey(key({ name: "r", ctrl: true }))).toBe("regenerate")
    expect(branchActionForKey(key({ name: "u", ctrl: true }))).toBe("clear")
    expect(branchActionForKey(key({ name: "backspace" }))).toBe("delete-back")
    expect(branchActionForKey(key({ name: "left" }))).toBe("cursor-left")
    expect(branchActionForKey(key({ name: "escape" }))).toBe("back")
  })

  test("branch recognizes home, end, ctrl+a, ctrl+e, ctrl+h", () => {
    expect(branchActionForKey(key({ name: "home" }))).toBe("line-start")
    expect(branchActionForKey(key({ name: "end" }))).toBe("line-end")
    expect(branchActionForKey(key({ name: "a", ctrl: true }))).toBe("line-start")
    expect(branchActionForKey(key({ name: "e", ctrl: true }))).toBe("line-end")
    expect(branchActionForKey(key({ name: "h", ctrl: true }))).toBe("delete-back")
  })

  test("leaves printable keys unbound so both fields stay typable", () => {
    for (const name of ["s", "q", "p", "r", "j", "k", "space"]) {
      expect(branchActionForKey(key({ name }))).toBeUndefined()
    }
  })

  test("branch returns undefined for unrecognized ctrl key", () => {
    expect(branchActionForKey(key({ name: "x", ctrl: true }))).toBeUndefined()
  })

  test("attributes the proposal and says when the name had to move", () => {
    expect(branchProposalNote({ branch: "feat/x", source: "declared" }, { branch: "feat/x", dir: "/w/feat-x" })).toBe(
      "taken from the document",
    )
    expect(branchProposalNote({ branch: "feat/x", source: "model", model: "anthropic/claude-haiku-4-5" }, { branch: "feat/x", dir: "/w/feat-x" })).toBe(
      "proposed by anthropic/claude-haiku-4-5",
    )
    expect(branchProposalNote({ branch: "feat/x", source: "prompt" }, { branch: "feat/x-2", dir: "/w/feat-x-2", suffixed: true })).toBe(
      "derived from your prompt (the naming model didn't answer) · renamed, the original was taken",
    )
    expect(branchProposalNote({ branch: "convoy-20260726-a4f2", source: "fallback" }, { branch: "convoy-20260726-a4f2", dir: "/w/c" })).toBe(
      "generic name (nothing to derive it from)",
    )
  })

  test("branchProposalNote uses fallback when model is missing for source=model", () => {
    expect(branchProposalNote({ branch: "feat/x", source: "model" }, { branch: "feat/x", dir: "/w/feat-x" })).toBe(
      "proposed by the naming model",
    )
  })
})

describe("launch TUI pipeline preview", () => {
  test("shows the resolved model for single-model pipeline steps", () => {
    const lines = plainLines(
      stepTree(
        [
          { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "gpt-5.5 xhigh" },
          { stepName: "design", groupId: "g2", kind: "agent", modelLabel: "claude-opus-4-8" },
        ] satisfies Parameters<typeof stepTree>[0],
        80,
      ),
    )

    expect(lines).toEqual(["○ implementer  · gpt-5.5 xhigh", "○ design  · claude-opus-4-8"])
  })

  test("labels Claude Code aliases and its CLI default", () => {
    expect(launcherStepModelLabel({ runner: "claude-code", model: "opus" })).toBe("claude-code/opus")
    expect(launcherStepModelLabel({ runner: "claude-code", model: "" })).toBe("claude-code/default")
    expect(launcherStepModelLabel({ model: "openai/gpt-5.6", variant: "xhigh" })).toBe("gpt-5.6 xhigh")
  })

  test("launcherStepModelLabel truncates provider prefix from OpenCode models", () => {
    expect(launcherStepModelLabel({ model: "anthropic/claude-sonnet-4" })).toBe("claude-sonnet-4")
    expect(launcherStepModelLabel({ model: "openai/gpt-5.6" })).toBe("gpt-5.6")
  })

  test("launcherStepModelLabel handles model with variant", () => {
    expect(launcherStepModelLabel({ model: "openai/gpt-5.6", variant: "xhigh" })).toBe("gpt-5.6 xhigh")
  })

  test("shows executor to advisor relationships and call caps", () => {
    const lines = plainLines(stepTree([
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "glm-5.2", advisorLabel: "claude-opus-5 advisor ×3" },
    ], 100))
    expect(lines).toEqual(["○ implementer  · glm-5.2 → claude-opus-5 advisor ×3"])
  })

  test("stepTree handles human gates", () => {
    const lines = plainLines(stepTree([
      { stepName: "approve", groupId: "", kind: "human", modelLabel: "", advisorLabel: "" },
    ], 100))
    expect(lines.some((line) => line.includes("manual gate"))).toBe(true)
    expect(lines.some((line) => line.includes("approve"))).toBe(true)
  })

  test("stepTree handles model fan-out (one agent, many models)", () => {
    const lines = plainLines(stepTree([
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "gpt-5", advisorLabel: "" },
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "implementer", groupId: "g1", kind: "agent", modelLabel: "gemini-3", advisorLabel: "" },
    ], 80))
    expect(lines.some((line) => line.includes("3 models"))).toBe(true)
  })

  test("stepTree handles parallel agents (same groupId, different stepName)", () => {
    const lines = plainLines(stepTree([
      { stepName: "audit-a", groupId: "g1", kind: "agent", modelLabel: "gpt-5", advisorLabel: "" },
      { stepName: "audit-b", groupId: "g1", kind: "agent", modelLabel: "claude-4", advisorLabel: "" },
      { stepName: "audit-c", groupId: "g1", kind: "agent", modelLabel: "gemini-3", advisorLabel: "" },
    ], 80))
    expect(lines.some((line) => line.includes("parallel") || line.includes("agents"))).toBe(true)
  })

  test("shows an explicit placeholder when a pipeline has no hooks", () => {
    expect(plainLines(hookLines([], 80))).toEqual(["hooks  · none"])
  })

  test("lists pre and post hooks with non-default post-hook conditions", () => {
    const lines = plainLines(
      hookLines(
        [
          { stage: "pre", label: "lint" },
          { stage: "post", label: "notify-slack", when: "failure" },
          { stage: "post", label: "bun run build" },
        ] satisfies Parameters<typeof hookLines>[0],
        80,
      ),
    )

    expect(lines).toEqual(["hooks", "○ pre   · lint", "○ post  · notify-slack  · on failure", "○ post  · bun run build"])
  })

  test("hookLines handles always condition", () => {
    const lines = plainLines(hookLines([
      { stage: "post", label: "cleanup", when: "always" },
    ], 80))
    expect(lines.some((line) => line.includes("always"))).toBe(true)
  })

  test("hookLines handles hook label with multiple spaces", () => {
    const lines = plainLines(hookLines([
      { stage: "pre", label: "run   linter" },
    ], 80))
    // The hookNodes function replaces consecutive whitespace with single space
    expect(lines.some((line) => line.includes("run   linter") || line.includes("run linter"))).toBe(true)
  })

  test("hookLines handles narrow width", () => {
    const lines = plainLines(hookLines([
      { stage: "pre", label: "very-long-hook-name-that-should-be-truncated" },
    ], 15))
    expect(lines.length).toBeGreaterThan(0)
  })
})

describe("launch TUI pipeline choices", () => {
  test("carries defaultPrompt and suggestedPrompts through from the resolved pipeline", () => {
    const choices = pipelineChoices(undefined, builtInAgents)
    const review = choices.find((choice) => choice.name === "review")
    expect(review?.defaultPrompt).toBe(
      "Review the current branch against its base and report prioritized findings with a verified quality score.",
    )
    expect(review?.suggestedPrompts).toEqual(["Review the open PR for this branch", "Review only the last commit's diff"])
  })

  test("leaves defaultPrompt and suggestedPrompts unset for pipelines without them", () => {
    const choices = pipelineChoices(undefined, builtInAgents)
    const implement = choices.find((choice) => choice.name === "implement")
    expect(implement?.defaultPrompt).toBeUndefined()
    expect(implement?.suggestedPrompts).toBeUndefined()
  })

  test("configured pipelines carry their defaultPrompt and suggestedPrompts", () => {
    const config = parseConvoyConfig(
      [
        "pipelines:",
        "  triage:",
        "    description: Triage incoming reports",
        "    defaultPrompt: Triage the incoming reports.",
        "    suggestedPrompts:",
        "      - Triage today's reports",
        "    steps:",
        "      - implementer",
      ].join("\n"),
      ".convoy/config.yaml",
      "/tmp/non-existent-convoy-target",
    )
    const choices = pipelineChoices(config, builtInAgents)
    const triage = choices.find((choice) => choice.name === "triage")
    expect(triage?.source).toBe("configured")
    expect(triage?.defaultPrompt).toBe("Triage the incoming reports.")
    expect(triage?.suggestedPrompts).toEqual(["Triage today's reports"])
  })
})

describe("launch TUI prompt prefill and clean/dirty tracking", () => {
  test("openPrompt prefills an empty field with the pipeline's defaultPrompt", () => {
    const prefilled = prefillPromptField(emptyPromptField(), "Review the branch.")
    expect(prefilled).toMatchObject({ prompt: "Review the branch.", fromDefault: true, lastDefault: "Review the branch." })
  })

  test("openPrompt keeps an already-typed prompt instead of overwriting it", () => {
    const typed = { ...emptyPromptField(), prompt: "my prompt", fromDefault: false }
    expect(prefillPromptField(typed, "Review the branch.")).toBe(typed)
  })

  test("openPrompt leaves a clean empty field alone when the pipeline has no default", () => {
    expect(prefillPromptField(emptyPromptField(), undefined)).toEqual(emptyPromptField())
  })

  test("openPrompt preserves a whitespace-only user edit instead of prefilling over it", () => {
    const blank = { ...emptyPromptField(), prompt: "   " }
    expect(prefillPromptField(blank, "Review the branch.")).toBe(blank)
  })

  test("moveSelection swaps a clean default for the new pipeline's default", () => {
    const clean = { ...emptyPromptField(), prompt: "old default", fromDefault: true, lastDefault: "old default" }
    const swapped = promptAfterPipelineSwitch(clean, "new default")
    expect(swapped).toMatchObject({ prompt: "new default", fromDefault: true, lastDefault: "new default" })
  })

  test("moveSelection clears a clean default when the new pipeline has none", () => {
    const clean = { ...emptyPromptField(), prompt: "old default", fromDefault: true, lastDefault: "old default" }
    const swapped = promptAfterPipelineSwitch(clean, undefined)
    expect(swapped).toMatchObject({ prompt: "", fromDefault: false })
  })

  test("moveSelection preserves user-typed text across pipeline switches", () => {
    const dirty = { ...emptyPromptField(), prompt: "my typed prompt", fromDefault: false }
    const swapped = promptAfterPipelineSwitch(dirty, "new default")
    expect(swapped.prompt).toBe("my typed prompt")
    expect(swapped.fromDefault).toBe(false)
  })

  test("moveSelection preserves a whitespace-only user edit across pipeline switches", () => {
    const dirty = { ...emptyPromptField(), prompt: "   ", fromDefault: false }
    expect(promptAfterPipelineSwitch(dirty, "new default")).toBe(dirty)
  })

  test("moveSelection treats a default that was edited afterwards as user text", () => {
    // fromDefault is still true but the text no longer matches the applied
    // default: the field was edited after prefill, so the text must survive.
    const edited = { prompt: "default plus my note", fromDefault: true, lastDefault: "default", suggestionIndex: 0, hasCycledSuggestions: false }
    const swapped = promptAfterPipelineSwitch(edited, "new default")
    expect(swapped).toMatchObject({ prompt: "default plus my note", fromDefault: false, lastDefault: undefined })
  })

  test("typing marks the field dirty so it is no longer swapped or cycleable", () => {
    const clean = { prompt: "default", fromDefault: true, lastDefault: "default", suggestionIndex: 0, hasCycledSuggestions: true }
    const dirty = markPromptEdited(clean)
    expect(dirty).toMatchObject({ prompt: "default", fromDefault: false, lastDefault: undefined, suggestionIndex: 0, hasCycledSuggestions: false })
  })

  test("submitting a padded default keeps its clean provenance after trimming", () => {
    const clean = { prompt: "  default  ", fromDefault: true, lastDefault: "  default  ", suggestionIndex: 0, hasCycledSuggestions: false }
    const trimmed = trimPromptField(clean)
    expect(trimmed).toMatchObject({ prompt: "default", fromDefault: true, lastDefault: "default" })
    expect(promptAfterPipelineSwitch(trimmed, "new default").prompt).toBe("new default")
  })
})

describe("launch TUI Tab suggestions", () => {
  const suggestions = ["suggestion one", "suggestion two"]

  test("Tab inserts the first suggestion when the prompt is clean", () => {
    const clean = emptyPromptField()
    const next = nextPromptSuggestion(clean, suggestions)
    expect(next?.prompt).toBe("suggestion one")
    expect(next).toMatchObject({ fromDefault: true, lastDefault: "suggestion one", suggestionIndex: 0, hasCycledSuggestions: true })
  })

  test("Tab cycles through suggestions on repeated press", () => {
    let state = emptyPromptField()
    state = nextPromptSuggestion(state, suggestions)!
    expect(state.prompt).toBe("suggestion one")
    state = nextPromptSuggestion(state, suggestions)!
    expect(state.prompt).toBe("suggestion two")
    state = nextPromptSuggestion(state, suggestions)!
    expect(state.prompt).toBe("suggestion one")
  })

  test("Tab does nothing when the pipeline has no suggestions", () => {
    expect(nextPromptSuggestion(emptyPromptField(), undefined)).toBeUndefined()
    expect(nextPromptSuggestion(emptyPromptField(), [])).toBeUndefined()
  })

  test("Tab does nothing when the prompt is dirty (user-typed)", () => {
    const dirty = { ...emptyPromptField(), prompt: "typed", fromDefault: false }
    expect(nextPromptSuggestion(dirty, suggestions)).toBeUndefined()
  })

  test("Tab does not overwrite a whitespace-only user edit", () => {
    const dirty = { ...emptyPromptField(), prompt: "   ", fromDefault: false }
    expect(nextPromptSuggestion(dirty, suggestions)).toBeUndefined()
  })

  test("Tab replaces a held default with the first suggestion", () => {
    const holdingDefault = { prompt: "the default", fromDefault: true, lastDefault: "the default", suggestionIndex: 0, hasCycledSuggestions: false }
    const next = nextPromptSuggestion(holdingDefault, suggestions)!
    expect(next.prompt).toBe("suggestion one")
    expect(next).toMatchObject({ suggestionIndex: 0, hasCycledSuggestions: true })
  })

  test("an inserted suggestion stays swappable on the next pipeline switch", () => {
    const inserted = nextPromptSuggestion(emptyPromptField(), suggestions)!
    expect(inserted.fromDefault).toBe(true)
    const swapped = promptAfterPipelineSwitch(inserted, "new default")
    expect(swapped.prompt).toBe("new default")
  })
})

describe("launch TUI goal mode", () => {
  test("defaultGoalTarget is 90", () => {
    expect(defaultGoalTarget).toBe(90)
  })

  test("adjustGoalTarget increases by delta", () => {
    expect(adjustGoalTarget(90, 5)).toBe(95)
    expect(adjustGoalTarget(85, 5)).toBe(90)
    expect(adjustGoalTarget(50, 10)).toBe(60)
  })

  test("adjustGoalTarget decreases by delta", () => {
    expect(adjustGoalTarget(90, -5)).toBe(85)
    expect(adjustGoalTarget(95, -10)).toBe(85)
  })

  test("adjustGoalTarget clamps to 100 at the top", () => {
    expect(adjustGoalTarget(98, 5)).toBe(100)
    expect(adjustGoalTarget(100, 5)).toBe(100)
  })

  test("adjustGoalTarget clamps to 1 at the bottom and never returns 0", () => {
    expect(adjustGoalTarget(3, -5)).toBe(1)
    expect(adjustGoalTarget(1, -5)).toBe(1)
    expect(adjustGoalTarget(1, -100)).toBe(1)
  })

  test("adjustGoalTarget with 0 delta returns the current value", () => {
    expect(adjustGoalTarget(90, 0)).toBe(90)
    expect(adjustGoalTarget(1, 0)).toBe(1)
    expect(adjustGoalTarget(100, 0)).toBe(100)
  })

  test("consensusStep detects scored built-in pipelines", () => {
    // Scored: pipelines that end in a quality-score-report step
    for (const name of ["ship", "review", "review-lite", "goal-fix"]) {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      expect(consensusStep(pipeline)).toBeDefined()
    }
  })

  test("consensusStep rejects non-scored built-in pipelines", () => {
    for (const name of ["implement", "implement-lite", "fixer", "review-cc", "hunter"]) {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      expect(consensusStep(pipeline)).toBeUndefined()
    }
  })

  test("only ship is goal-eligible: review scores but cannot be fixed, implement can be fixed but is not scored", () => {
    // Goal mode needs both halves; the launcher's `scored` flag is the AND of them.
    const eligible = (name: string) => {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      return Boolean(consensusStep(pipeline)) && hasWritableStep(pipeline)
    }

    expect(eligible("ship")).toBe(true)
    expect(eligible("review")).toBe(false)
    expect(eligible("review-lite")).toBe(false)
    expect(eligible("implement")).toBe(false)
  })
})
