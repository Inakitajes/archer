import { describe, expect, test } from "bun:test"

import { isStepRunnerId, normalizeStepRunnerModel, stepRunnerFor, stepRunnerModel } from "../src/step-runners"

describe("stepRunnerFor", () => {
  test("returns opencode definition by default", () => {
    const runner = stepRunnerFor()
    expect(runner.id).toBe("opencode")
    expect(runner.displayName).toBe("OpenCode")
  })

  test("returns opencode definition", () => {
    const runner = stepRunnerFor("opencode")
    expect(runner.id).toBe("opencode")
    expect(runner.displayName).toBe("OpenCode")
    expect(runner.capabilities.advisor).toBe(true)
    expect(runner.capabilities.liveAttach).toBe(true)
    expect(runner.capabilities.writeSteps).toBe(true)
    expect(runner.capabilities.modelFanout).toBe(true)
  })

  test("returns claude-code definition", () => {
    const runner = stepRunnerFor("claude-code")
    expect(runner.id).toBe("claude-code")
    expect(runner.displayName).toBe("Claude Code")
    expect(runner.capabilities.advisor).toBe(false)
    expect(runner.capabilities.liveAttach).toBe(false)
    expect(runner.capabilities.writeSteps).toBe(false)
    expect(runner.capabilities.modelFanout).toBe(false)
  })

  test("modelLabel formats correctly for opencode", () => {
    const runner = stepRunnerFor("opencode")
    expect(runner.modelLabel("gpt-4", "turbo")).toBe("gpt-4#turbo")
    expect(runner.modelLabel("gpt-4")).toBe("gpt-4")
  })

  test("modelLabel formats correctly for claude-code", () => {
    const runner = stepRunnerFor("claude-code")
    expect(runner.modelLabel("opus")).toBe("claude-code/opus")
    expect(runner.modelLabel("")).toBe("claude-code/default")
  })
})

describe("isStepRunnerId", () => {
  test("returns true for valid IDs", () => {
    expect(isStepRunnerId("opencode")).toBe(true)
    expect(isStepRunnerId("claude-code")).toBe(true)
  })

  test("returns false for invalid IDs", () => {
    expect(isStepRunnerId("unknown")).toBe(false)
    expect(isStepRunnerId("")).toBe(false)
    expect(isStepRunnerId(undefined)).toBe(false)
  })
})

describe("normalizeStepRunnerModel", () => {
  test("accepts any model for opencode", () => {
    expect(normalizeStepRunnerModel("opencode", "openai/gpt-4")).toBe("openai/gpt-4")
    expect(normalizeStepRunnerModel("opencode", "  anthropic/claude-opus-4  ")).toBe("anthropic/claude-opus-4")
  })

  test("accepts claude-code aliases", () => {
    expect(normalizeStepRunnerModel("claude-code", "opus")).toBe("opus")
    expect(normalizeStepRunnerModel("claude-code", "sonnet")).toBe("sonnet")
    expect(normalizeStepRunnerModel("claude-code", "haiku")).toBe("haiku")
  })

  test("strips anthropic/ prefix for claude-code", () => {
    expect(normalizeStepRunnerModel("claude-code", "anthropic/claude-opus-4")).toBe("claude-opus-4")
  })

  test("accepts valid claude-* model IDs", () => {
    expect(normalizeStepRunnerModel("claude-code", "claude-opus-4")).toBe("claude-opus-4")
    expect(normalizeStepRunnerModel("claude-code", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5")
  })

  test("throws for invalid models on claude-code", () => {
    expect(() => normalizeStepRunnerModel("claude-code", "gpt-4")).toThrow()
    expect(() => normalizeStepRunnerModel("claude-code", "random")).toThrow()
    expect(() => normalizeStepRunnerModel("claude-code", "")).toThrow()
  })
})

describe("stepRunnerModel", () => {
  test("returns model info for opencode without global override", () => {
    const result = stepRunnerModel("opencode", "openai/gpt-4", "turbo")
    expect(result.providerID).toBe("openai")
    expect(result.modelID).toBe("gpt-4")
    expect(result.variant).toBe("turbo")
    expect(result.label).toContain("gpt-4")
  })

  test("returns model info for claude-code", () => {
    const result = stepRunnerModel("claude-code", "opus")
    expect(result.providerID).toBe("claude-code")
    expect(result.modelID).toBe("opus")
    expect(result.label).toBe("claude-code/opus")
  })

  test("returns default model for claude-code when model is empty", () => {
    const result = stepRunnerModel("claude-code", "")
    expect(result.modelID).toBe("default")
  })

  test("applies global override for opencode when present", () => {
    const result = stepRunnerModel("opencode", "openai/gpt-4", undefined, "anthropic/claude-opus-4")
    expect(result.providerID).toBe("anthropic")
    expect(result.modelID).toBe("claude-opus-4")
  })

  test("global override is ignored for claude-code", () => {
    const result = stepRunnerModel("claude-code", "opus", undefined, "anthropic/claude-opus-4")
    expect(result.providerID).toBe("claude-code")
    expect(result.modelID).toBe("opus")
  })

  test("handles undefined runner ID (defaults to opencode)", () => {
    const result = stepRunnerModel(undefined, "openai/gpt-4")
    expect(result.providerID).toBe("openai")
    expect(result.modelID).toBe("gpt-4")
  })
})