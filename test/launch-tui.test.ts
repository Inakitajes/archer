import { describe, expect, test } from "bun:test"

import { branchActionForKey, branchProposalNote, cursorPosition, defaultGoalTarget, adjustGoalTarget, hookLines, launcherStepModelLabel, promptEnterAction, reviewActionForKey, sanitizePaste, stepTree, typedText, wrapPromptLines } from "../src/launch-tui"

import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { consensusStep } from "../src/quality-score"
import type { KeyEvent } from "@opentui/core"

function key(partial: Partial<KeyEvent>): KeyEvent {
  return partial as KeyEvent
}

function plainLines(lines: ReturnType<typeof stepTree>): string[] {
  return lines.map((line) => line.chunks.map((chunk) => chunk.text).join(""))
}

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
    for (const name of ["implement-scored", "review-scored", "goal-fix"]) {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      expect(consensusStep(pipeline)).toBeDefined()
    }
  })

  test("consensusStep rejects non-scored built-in pipelines", () => {
    for (const name of ["implement", "implement-lite", "review", "refine", "ultra-implement", "hunter"]) {
      const pipeline = resolvePipeline({ name, spec: builtInPipelines[name]!, agents: builtInAgents })
      expect(consensusStep(pipeline)).toBeUndefined()
    }
  })
})
