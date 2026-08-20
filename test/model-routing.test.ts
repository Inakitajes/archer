import { describe, expect, test } from "bun:test"

import {
  applyOpenRouterNitro,
  gatewayLabel,
  isModelGateway,
  logicalModel,
  modelGateways,
  resolveModel,
  stripOpenRouterNitro,
} from "../src/model-routing"

describe("model gateway routing", () => {
  test("routes OpenAI and Anthropic through every gateway", () => {
    expect(resolveModel("openai/gpt-5.6-sol#xhigh", "direct").target).toBe("openai/gpt-5.6-sol#xhigh")
    expect(resolveModel("anthropic/claude-opus-4.8", "openrouter").target).toBe("openrouter/anthropic/claude-opus-4.8")
    expect(resolveModel("anthropic/claude-opus-4.8", "vercel")).toEqual({
      configured: "anthropic/claude-opus-4.8",
      logical: "anthropic/claude-opus-4.8",
      gateway: "vercel",
      providerID: "vercel",
      modelID: "anthropic/claude-opus-4.8",
      target: "vercel/anthropic/claude-opus-4.8",
    })
  })

  test("unwraps an existing gateway and does not duplicate prefixes", () => {
    expect(resolveModel("openrouter/anthropic/claude-opus-4.8", "vercel").target).toBe("vercel/anthropic/claude-opus-4.8")
    expect(resolveModel("vercel/openai/gpt-5.6-sol#high", "openrouter").target).toBe("openrouter/openai/gpt-5.6-sol#high")
  })

  test("keeps nested model IDs and variants intact", () => {
    expect(resolveModel("openai/gpt/reasoning/preview#high", "vercel")).toMatchObject({
      logical: "openai/gpt/reasoning/preview#high",
      providerID: "vercel",
      modelID: "openai/gpt/reasoning/preview",
      target: "vercel/openai/gpt/reasoning/preview#high",
    })
    expect(resolveModel("openai/gpt/reasoning/preview#high", "nitro")).toMatchObject({
      logical: "openai/gpt/reasoning/preview#high",
      providerID: "openrouter",
      modelID: "openai/gpt/reasoning/preview:nitro",
      target: "openrouter/openai/gpt/reasoning/preview:nitro#high",
    })
  })

  test("normalizes zai and z-ai while preserving the logical identity", () => {
    expect(logicalModel("openrouter/z-ai/glm-5.2").model).toBe("zai/glm-5.2")
    expect(resolveModel("openrouter/z-ai/glm-5.2", "direct").target).toBe("zai/glm-5.2")
    expect(resolveModel("zai/glm-5.2", "openrouter").target).toBe("openrouter/z-ai/glm-5.2")
    expect(resolveModel("openrouter/z-ai/glm-5.2", "vercel").target).toBe("vercel/zai/glm-5.2")
  })

  test("routes Moonshot Kimi through gateways without an override", () => {
    expect(resolveModel("moonshotai/kimi-k3", "openrouter").target).toBe("openrouter/moonshotai/kimi-k3")
    expect(resolveModel("openrouter/moonshotai/kimi-k3", "vercel").target).toBe("vercel/moonshotai/kimi-k3")
    expect(resolveModel("moonshotai/kimi-k3", "nitro").target).toBe("openrouter/moonshotai/kimi-k3:nitro")
  })

  test("routes xAI Grok through nitro with the dashed alias", () => {
    expect(resolveModel("xai/grok-4.5", "nitro").target).toBe("openrouter/x-ai/grok-4.5:nitro")
    expect(resolveModel("openrouter/x-ai/grok-4.5", "nitro").target).toBe("openrouter/x-ai/grok-4.5:nitro")
  })

  test("configured remains literal", () => {
    expect(resolveModel("openrouter/z-ai/glm-5.2#high", "configured")).toMatchObject({
      logical: "zai/glm-5.2#high",
      providerID: "openrouter",
      modelID: "z-ai/glm-5.2",
      target: "openrouter/z-ai/glm-5.2#high",
    })
    expect(resolveModel("custom/private/model#v2", "configured").target).toBe("custom/private/model#v2")
  })

  test("configured does not add :nitro to a clean OpenRouter ID", () => {
    expect(resolveModel("openrouter/z-ai/glm-5.2", "configured").modelID).toBe("z-ai/glm-5.2")
  })

  test("explicit overrides enable otherwise unsafe custom routes", () => {
    expect(resolveModel("custom/private-model#fast", "vercel", { "custom/private-model": { vercel: "vercel/acme/private-model" } }).target).toBe(
      "vercel/acme/private-model#fast",
    )
    expect(() => resolveModel("custom/private-model", "vercel")).toThrow("modelRouting.overrides")
  })

  test("retains an override-only variant and rejects a conflicting configured variant", () => {
    const overrides = { "custom/private-model": { vercel: "vercel/acme/private-model#fast" } }

    expect(resolveModel("custom/private-model", "vercel", overrides)).toMatchObject({
      logical: "custom/private-model",
      variant: "fast",
      target: "vercel/acme/private-model#fast",
    })
    expect(() => resolveModel("custom/private-model#slow", "vercel", overrides)).toThrow("must not replace variant #slow")
  })

  test("rejects whitespace and terminal controls in model references", () => {
    expect(() => resolveModel("openai/gpt-5.6\nforged", "vercel")).toThrow("without whitespace or control characters")
    expect(() => resolveModel("openai/gpt-5.6#high\u001b[2J", "vercel")).toThrow("without whitespace or control characters")
    expect(() => resolveModel("openai/gpt-5.6:nitro\nforged", "nitro")).toThrow("without whitespace or control characters")
  })
})

describe("OpenRouter nitro gateway", () => {
  test("applies :nitro to every routable model", () => {
    expect(resolveModel("openai/gpt-5.6-terra#xhigh", "nitro").target).toBe("openrouter/openai/gpt-5.6-terra:nitro#xhigh")
    expect(resolveModel("openai/gpt-5.6-terra#xhigh", "nitro").providerID).toBe("openrouter")
    expect(resolveModel("openai/gpt-5.6-terra#xhigh", "nitro").modelID).toBe("openai/gpt-5.6-terra:nitro")
    expect(resolveModel("anthropic/claude-opus-5", "nitro").target).toBe("openrouter/anthropic/claude-opus-5:nitro")
    expect(resolveModel("zai/glm-5.2", "nitro").target).toBe("openrouter/z-ai/glm-5.2:nitro")
    expect(resolveModel("openrouter/z-ai/glm-5.2", "nitro").target).toBe("openrouter/z-ai/glm-5.2:nitro")
  })

  test("unwraps a vercel-configured model and routes it through nitro", () => {
    expect(resolveModel("vercel/openai/gpt-5.6-sol#high", "nitro")).toMatchObject({
      logical: "openai/gpt-5.6-sol#high",
      providerID: "openrouter",
      modelID: "openai/gpt-5.6-sol:nitro",
      variant: "high",
      target: "openrouter/openai/gpt-5.6-sol:nitro#high",
    })
  })

  test("configured with an existing :nitro keeps it", () => {
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro#high", "configured").target).toBe("openrouter/z-ai/glm-5.2:nitro#high")
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro#high", "configured").modelID).toBe("z-ai/glm-5.2:nitro")
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro#high", "configured").logical).toBe("zai/glm-5.2#high")
  })

  test("applying nitro to a pre-suffixed model is idempotent", () => {
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro", "nitro").target).toBe("openrouter/z-ai/glm-5.2:nitro")
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro#xhigh", "nitro")).toMatchObject({
      providerID: "openrouter",
      modelID: "z-ai/glm-5.2:nitro",
      variant: "xhigh",
      target: "openrouter/z-ai/glm-5.2:nitro#xhigh",
    })
  })

  test("openrouter, direct, and vercel strip a pre-existing :nitro", () => {
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro", "openrouter").target).toBe("openrouter/z-ai/glm-5.2")
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro", "direct").target).toBe("zai/glm-5.2")
    expect(resolveModel("openrouter/z-ai/glm-5.2:nitro", "vercel").target).toBe("vercel/zai/glm-5.2")
  })

  test("logical identity never retains :nitro", () => {
    expect(logicalModel("openrouter/z-ai/glm-5.2:nitro").model).toBe("zai/glm-5.2")
    expect(logicalModel("zai/glm-5.2:nitro").model).toBe("zai/glm-5.2")
  })

  test("nitro falls back to the openrouter override and applies the suffix", () => {
    const overrides = { "custom/private-model": { openrouter: "openrouter/acme/private" } }
    expect(resolveModel("custom/private-model", "nitro", overrides).target).toBe("openrouter/acme/private:nitro")
  })

  test("an explicit nitro override is used as-is", () => {
    const suffixed = { "custom/private-model": { nitro: "openrouter/acme/private:nitro" } }
    expect(resolveModel("custom/private-model", "nitro", suffixed).target).toBe("openrouter/acme/private:nitro")
    // An explicit override without :nitro is also literal (overrides never auto-append).
    const plain = { "custom/private-model": { nitro: "openrouter/acme/private" } }
    expect(resolveModel("custom/private-model", "nitro", plain).target).toBe("openrouter/acme/private")
  })

  test("unsafe namespaces still require an override under nitro", () => {
    expect(() => resolveModel("custom/private-model", "nitro")).toThrow("modelRouting.overrides")
  })

  test("markers and helpers match the nitro contract", () => {
    expect(modelGateways).toEqual(["configured", "direct", "openrouter", "nitro", "vercel"])
    expect(gatewayLabel("nitro")).toBe("OpenRouter Nitro")
    expect(isModelGateway("nitro")).toBe(true)
    expect(isModelGateway("openrouter-nitro")).toBe(false)
    expect(applyOpenRouterNitro("openrouter/x:nitro")).toBe("openrouter/x:nitro")
    expect(applyOpenRouterNitro("openrouter/x")).toBe("openrouter/x:nitro")
    expect(stripOpenRouterNitro("openrouter/x:nitro")).toBe("openrouter/x")
    expect(stripOpenRouterNitro("openrouter/x")).toBe("openrouter/x")
  })
})
