import { describe, expect, test } from "bun:test"

import { parseModelsDev, toModelChoices } from "../src/model-catalog"

describe("toModelChoices", () => {
  const sampleProviders = [
    {
      id: "openai",
      name: "OpenAI",
      source: "api-key",
      env: {},
      options: {},
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          name: "GPT-4o",
          providerID: "openai",
          status: "active",
          capabilities: {},
          limit: { context: 128000 },
          variants: {},
        },
        "gpt-4o-mini": {
          id: "gpt-4o-mini",
          name: "GPT-4o Mini",
          providerID: "openai",
          status: "active",
          capabilities: {},
          limit: { context: 128000 },
          variants: { turbo: {} },
        },
      },
    },
    {
      id: "anthropic",
      name: "Anthropic",
      source: "api-key",
      env: {},
      options: {},
      models: {
        "claude-opus-4": {
          id: "claude-opus-4",
          name: "Claude Opus 4",
          providerID: "anthropic",
          status: "beta",
          capabilities: {},
          limit: { context: 200000 },
          variants: { thinking: {} },
        },
      },
    },
  ] as const

  test("returns choices for connected providers", () => {
    const choices = toModelChoices(sampleProviders as any, ["openai"])
    expect(choices.length).toBeGreaterThan(0)
    expect(choices.every((c) => c.providerID === "openai")).toBe(true)
  })

  test("includes base model and variants", () => {
    const choices = toModelChoices(sampleProviders as any, ["openai"])
    const values = choices.map((c) => c.value)
    expect(values).toContain("openai/gpt-4o")
    expect(values).toContain("openai/gpt-4o-mini")
    expect(values).toContain("openai/gpt-4o-mini#turbo")
  })

  test("includes status for non-active models", () => {
    const choices = toModelChoices(sampleProviders as any, ["anthropic"])
    const claude = choices.find((c) => c.value === "anthropic/claude-opus-4")
    expect(claude?.status).toBe("beta")
  })

  test("includes contextK when limit.context is present", () => {
    const choices = toModelChoices(sampleProviders as any, ["openai"])
    const gpt4o = choices.find((c) => c.value === "openai/gpt-4o")
    expect(gpt4o?.contextK).toBe(128)
  })

  test("deduplicates repeated provider/model entries", () => {
    const choices = toModelChoices([sampleProviders[0], sampleProviders[0]] as any, ["openai"])
    const gpt4os = choices.filter((c) => c.value === "openai/gpt-4o")
    expect(gpt4os.length).toBe(1)
  })

  test("returns empty array when no providers are connected", () => {
    const choices = toModelChoices(sampleProviders as any, [])
    expect(choices).toEqual([])
  })
})

describe("parseModelsDev", () => {
  test("parses a simple models.dev response", () => {
    const data = {
      openai: {
        models: {
          "gpt-4o": { name: "GPT-4o", limit: { context: 128000 } },
        },
      },
    }
    const choices = parseModelsDev(data)
    expect(choices).toEqual([
      { value: "openai/gpt-4o", label: "GPT-4o", providerID: "openai", contextK: 128 },
    ])
  })

  test("sorts choices by value", () => {
    const data = {
      zeta: { models: { "model-b": { name: "B" } } },
      alpha: { models: { "model-a": { name: "A" } } },
    }
    const choices = parseModelsDev(data)
    expect(choices[0]!.value).toBe("alpha/model-a")
    expect(choices[1]!.value).toBe("zeta/model-b")
  })

  test("uses model ID as label when name is missing", () => {
    const data = {
      test: { models: { "some-model": {} as any } },
    }
    const choices = parseModelsDev(data)
    expect(choices[0]!.label).toBe("some-model")
  })

  test("handles empty providers", () => {
    const choices = parseModelsDev({})
    expect(choices).toEqual([])
  })

  test("handles provider with no models", () => {
    const data = { test: { models: undefined } as any }
    const choices = parseModelsDev(data)
    expect(choices).toEqual([])
  })

  test("handles empty model entries", () => {
    const data = { test: { models: {} } }
    const choices = parseModelsDev(data)
    expect(choices).toEqual([])
  })

  test("omits contextK when limit.context is missing", () => {
    const data = {
      test: { models: { "my-model": { name: "My Model" } } },
    }
    const choices = parseModelsDev(data)
    expect(choices[0]!.contextK).toBeUndefined()
  })
})
