import { describe, expect, test, mock } from "bun:test"
import type { Provider } from "@opencode-ai/sdk/v2"

import { toModelChoices, parseModelsDev } from "../src/model-catalog"

describe("toModelChoices", () => {
  const providers: Provider[] = [
    {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          name: "Claude Sonnet 4.5",
          providerID: "anthropic",
          status: "active",
          limit: { context: 200_000 },
          capabilities: {},
          variants: { thinking: {} },
        },
        "claude-haiku-4-5": {
          id: "claude-haiku-4-5",
          name: "Claude Haiku 4.5",
          providerID: "anthropic",
          status: "beta",
          limit: { context: 100_000 },
          capabilities: {},
          variants: {},
        },
      },
    } as Provider,
    {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-5": {
          id: "gpt-5",
          name: "GPT-5",
          providerID: "openai",
          status: "active",
          capabilities: {},
          variants: {},
        },
      },
    } as Provider,
  ]

  test("returns only connected providers' models", () => {
    const choices = toModelChoices(providers, ["anthropic"])
    expect(choices.map((c) => c.value)).toEqual(
      expect.arrayContaining(["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5#thinking", "anthropic/claude-haiku-4-5"]),
    )
    expect(choices.map((c) => c.value)).not.toContain("openai/gpt-5")
  })

  test("expands variants into separate choices", () => {
    const choices = toModelChoices(providers, ["anthropic"])
    const variants = choices.filter((c) => c.value.includes("#"))
    expect(variants).toHaveLength(1)
    expect(variants[0]!.value).toBe("anthropic/claude-sonnet-4-5#thinking")
    expect(variants[0]!.label).toContain("(thinking)")
  })

  test("attaches contextK and status for non-active models", () => {
    const choices = toModelChoices(providers, ["anthropic"])
    const haiku = choices.find((c) => c.value === "anthropic/claude-haiku-4-5")!
    expect(haiku.status).toBe("beta")
    expect(haiku.contextK).toBe(100)
  })

  test("does not duplicate values", () => {
    const duplicated = toModelChoices([providers[0]!, providers[0]!], ["anthropic"])
    const values = duplicated.map((c) => c.value)
    expect(new Set(values).size).toBe(values.length)
  })

  test("returns empty array when no providers are connected", () => {
    const choices = toModelChoices(providers, [])
    expect(choices).toEqual([])
  })

  test("returns empty array when providers is empty", () => {
    const choices = toModelChoices([], ["anthropic"])
    expect(choices).toEqual([])
  })

  test("handles provider with no models", () => {
    const noModelsProvider = [{ id: "empty", name: "Empty", models: {} }] as Provider[]
    const choices = toModelChoices(noModelsProvider, ["empty"])
    expect(choices).toEqual([])
  })

  test("handles provider with null/empty variants object", () => {
    const provider = {
      id: "test",
      name: "Test",
      models: {
        "model-1": {
          id: "model-1",
          name: "Model 1",
          providerID: "test",
          status: "active",
          capabilities: {},
        },
      },
    } as Provider
    const choices = toModelChoices([provider], ["test"])
    expect(choices).toHaveLength(1)
    expect(choices[0]!.value).toBe("test/model-1")
  })

  test("deduplicates when same value appears across providers", () => {
    const multi = [
      { id: "p1", name: "P1", models: { m: { id: "m", name: "M", providerID: "p1", status: "active", capabilities: {} } } },
      { id: "p2", name: "P2", models: { m: { id: "m", name: "M", providerID: "p2", status: "active", capabilities: {} } } },
    ] as Provider[]
    const choices = toModelChoices(multi, ["p1", "p2"])
    expect(choices).toHaveLength(2)
    expect(choices.map((c) => c.value)).toEqual(["p1/m", "p2/m"])
  })

  test("status is undefined when status is active", () => {
    const provider = {
      id: "test",
      name: "Test",
      models: {
        m: { id: "m", name: "M", providerID: "test", status: "active", capabilities: {} },
      },
    } as Provider
    const choices = toModelChoices([provider], ["test"])
    expect(choices[0]!.status).toBeUndefined()
  })

  test("contextK is undefined when limit.context is missing", () => {
    const provider = {
      id: "test",
      name: "Test",
      models: {
        m: { id: "m", name: "M", providerID: "test", status: "active", capabilities: {} },
      },
    } as Provider
    const choices = toModelChoices([provider], ["test"])
    expect(choices[0]!.contextK).toBeUndefined()
  })
})

describe("parseModelsDev", () => {
  const fixture = {
    anthropic: {
      models: {
        "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", limit: { context: 200_000 } },
        "claude-opus-5": { name: "Claude Opus 5" },
      },
    },
    openai: {
      models: {
        "gpt-5": { name: "GPT-5" },
      },
    },
  }

  test("parses a models.dev fixture into sorted choices", () => {
    const choices = parseModelsDev(fixture as unknown as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>)
    expect(choices).toHaveLength(3)
    expect(choices[0]!.value).toBe("anthropic/claude-opus-5")
    expect(choices[1]!.value).toBe("anthropic/claude-sonnet-4-5")
    expect(choices[2]!.value).toBe("openai/gpt-5")
  })

  test("attaches contextK when available", () => {
    const choices = parseModelsDev(fixture as unknown as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>)
    const sonnet = choices.find((c) => c.value === "anthropic/claude-sonnet-4-5")!
    expect(sonnet.contextK).toBe(200)
  })

  test("handles a provider with no models", () => {
    const choices = parseModelsDev({ empty: {} })
    expect(choices).toEqual([])
  })

  test("handles an empty object", () => {
    const choices = parseModelsDev({})
    expect(choices).toEqual([])
  })

  test("handles provider with null models", () => {
    const data = { provider: { models: null } } as unknown as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>
    const choices = parseModelsDev(data)
    expect(choices).toEqual([])
  })

  test("handles model with null name (falls back to modelID)", () => {
    const data = { test: { models: { "model-1": { name: null, limit: { context: 100_000 } } } } } as unknown as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>
    const choices = parseModelsDev(data)
    expect(choices).toHaveLength(1)
    expect(choices[0]!.value).toBe("test/model-1")
    expect(choices[0]!.label).toBe("model-1")
  })

  test("handles model with undefined name (falls back to modelID)", () => {
    const data = { test: { models: { "model-1": {} } } } as unknown as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>
    const choices = parseModelsDev(data)
    expect(choices).toHaveLength(1)
    expect(choices[0]!.label).toBe("model-1")
  })

  test("sorts choices alphabetically by value", () => {
    const unsorted = {
      zed: { models: { "z-model": { name: "Z Model" } } },
      alpha: { models: { "a-model": { name: "A Model" } } },
    } as unknown as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>
    const choices = parseModelsDev(unsorted)
    expect(choices[0]!.value).toBe("alpha/a-model")
    expect(choices[1]!.value).toBe("zed/z-model")
  })

  test("handles model with zero limit context (should not set contextK)", () => {
    const data = { test: { models: { "model-1": { name: "M", limit: { context: 0 } } } } } as unknown as Record<string, { models?: Record<string, { name?: string; limit?: { context?: number } }> }>
    const choices = parseModelsDev(data)
    expect(choices[0]!.contextK).toBeUndefined()
  })
})