import { describe, expect, test } from "bun:test"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import type { AdvisorResult, AdvisorUsage } from "../src/advisor"
import { createAdvisorRuntime, firstWriteMessage, totalAdvisorUsage } from "../src/advisor-runtime"
import type { AgentStep } from "../src/types"

const usage = (cost: number): AdvisorUsage => ({
  cost,
  tokens: { input: 8_000, output: 600, reasoning: 200, cacheRead: 4_000, cacheWrite: 100 },
  model: "anthropic/convoy-advisor-claude-opus-5",
})

const step = (extra: Partial<AgentStep> = {}): AgentStep => ({
  type: "agent",
  name: "build",
  stepName: "build",
  groupId: "g1",
  agentName: "implementer",
  description: "Implement",
  model: "openai/gpt-5.6-sol",
  inputFiles: ["prd.md"],
  inputDiff: false,
  reportPath: "reports/build.md",
  advisor: "anthropic/claude-opus-5",
  resolvedAdvisor: {
    configured: "anthropic/claude-opus-5",
    logical: "anthropic/claude-opus-5",
    gateway: "configured",
    providerID: "anthropic",
    modelID: "claude-opus-5",
    target: "anthropic/claude-opus-5",
  },
  ...extra,
})

const client = {} as OpencodeClient

type StubOptions = { results?: AdvisorResult[]; onCall?: (input: { reason: string; model: { modelID: string } }) => void }

function runtime(opts: StubOptions = {}) {
  const calls: { reason: string; modelID: string; sessionID: string }[] = []
  const results = [...(opts.results ?? [])]
  return {
    calls,
    runtime: createAdvisorRuntime({
      client,
      directory: "/repo",
      consult: async (input) => {
        calls.push({ reason: input.reason, modelID: input.model.modelID, sessionID: input.sessionID })
        opts.onCall?.(input as never)
        return results.shift() ?? { kind: "advice", text: "Read src/retry.ts first.", usage: usage(0.02) }
      },
    }),
  }
}

describe("advisor phase registration", () => {
  test("registers only steps that have a resolved advisor", () => {
    const { runtime: advisors } = runtime()

    expect(advisors.begin("ses_1", step())).toBeDefined()
    expect(advisors.begin("ses_2", step({ advisor: undefined, resolvedAdvisor: undefined }))).toBeUndefined()
    expect(advisors.handleFor("ses_2")).toBeUndefined()
  })

  test("consults through the capped alias, not the raw advising model", async () => {
    const { runtime: advisors, calls } = runtime()
    const handle = advisors.begin("ses_1", step())!

    await handle.consult("on-demand")
    expect(calls[0]).toEqual({ reason: "on-demand", modelID: "convoy-advisor-claude-opus-5", sessionID: "ses_1" })
  })

  test("end() unregisters, so a finished phase's session stops resolving", () => {
    const { runtime: advisors } = runtime()
    const handle = advisors.begin("ses_1", step())!

    expect(advisors.handleFor("ses_1")).toBeDefined()
    handle.end()
    expect(advisors.handleFor("ses_1")).toBeUndefined()
  })
})

describe("advisor budget", () => {
  test("stops consulting once the step's cap is reached", async () => {
    const { runtime: advisors, calls } = runtime()
    const handle = advisors.begin("ses_1", step({ advisorMaxCalls: 2 }))!

    expect((await handle.consult("on-demand")).ok).toBe(true)
    expect((await handle.consult("on-demand")).ok).toBe(true)
    const third = await handle.consult("on-demand")

    expect(third.ok).toBe(false)
    expect(third.text).toContain("advisor budget")
    expect(calls).toHaveLength(2)
  })

  test("counts failed consultations too, so a broken advisor is not retried on every edit", async () => {
    const { runtime: advisors, calls } = runtime({
      results: [
        { kind: "error", code: "unavailable", message: "provider down" },
        { kind: "error", code: "unavailable", message: "provider down" },
      ],
    })
    const handle = advisors.begin("ses_1", step({ advisorMaxCalls: 2 }))!

    await handle.consult("on-demand")
    await handle.consult("on-demand")
    expect((await handle.consult("on-demand")).text).toContain("advisor budget")
    expect(calls).toHaveLength(2)
  })

  test("defaults to three consultations per attempt", async () => {
    const { runtime: advisors, calls } = runtime()
    const handle = advisors.begin("ses_1", step())!

    for (let i = 0; i < 4; i++) await handle.consult("on-demand")
    expect(calls).toHaveLength(3)
  })

  test("accumulates usage from successful consultations only", async () => {
    const { runtime: advisors } = runtime({
      results: [
        { kind: "advice", text: "a", usage: usage(0.02) },
        { kind: "error", code: "unavailable", message: "down" },
      ],
    })
    const handle = advisors.begin("ses_1", step())!

    await handle.consult("on-demand")
    await handle.consult("on-demand")

    expect(handle.usage).toHaveLength(1)
    expect(handle.calls).toBe(2)
  })
})

describe("first-write checkpoint", () => {
  test("holds the first edit and returns the advice as the rejection message", async () => {
    const { runtime: advisors, calls } = runtime()
    advisors.begin("ses_1", step())

    const decision = await advisors.checkpoint({ sessionID: "ses_1", permission: "edit", summary: "edit src/a.ts" })

    expect(decision.action).toBe("advise")
    if (decision.action !== "advise") return
    expect(decision.message).toContain("Read src/retry.ts first.")
    // Without this the model reads a bare denial as "editing is forbidden".
    expect(decision.message).toContain("You may proceed")
    expect(calls[0]?.reason).toBe("first-write")
  })

  test("allows every later edit without consulting again, so no human prompt appears", async () => {
    const { runtime: advisors, calls } = runtime()
    advisors.begin("ses_1", step())

    await advisors.checkpoint({ sessionID: "ses_1", permission: "edit", summary: "edit src/a.ts" })
    const second = await advisors.checkpoint({ sessionID: "ses_1", permission: "edit", summary: "edit src/b.ts" })
    const third = await advisors.checkpoint({ sessionID: "ses_1", permission: "edit", summary: "edit src/c.ts" })

    expect(second.action).toBe("allow")
    expect(third.action).toBe("allow")
    expect(calls).toHaveLength(1)
  })

  test("allows rather than spending a turn when the consultation fails", async () => {
    const { runtime: advisors } = runtime({ results: [{ kind: "error", code: "unavailable", message: "provider down" }] })
    advisors.begin("ses_1", step())

    expect((await advisors.checkpoint({ sessionID: "ses_1", permission: "edit", summary: "edit src/a.ts" })).action).toBe("allow")
  })

  test("defers for a session it does not own", async () => {
    const { runtime: advisors } = runtime()

    expect((await advisors.checkpoint({ sessionID: "ses_unknown", permission: "edit", summary: "edit src/a.ts" })).action).toBe("defer")
  })

  test("allows an already-consulted phase after a budget of one", async () => {
    const { runtime: advisors } = runtime()
    const handle = advisors.begin("ses_1", step({ advisorMaxCalls: 1 }))!
    await handle.consult("on-demand")

    // The on-demand call already used the budget; the checkpoint must not stall the write.
    expect((await advisors.checkpoint({ sessionID: "ses_1", permission: "edit", summary: "edit src/a.ts" })).action).toBe("allow")
  })
})

describe("firstWriteMessage", () => {
  test("explains the hold as well as carrying the advice", () => {
    const message = firstWriteMessage("Use the existing retry helper.")

    expect(message).toContain("Use the existing retry helper.")
    expect(message).toContain("repeat the edit and it will go through")
  })
})

describe("totalAdvisorUsage", () => {
  test("sums cost and folds cache and reasoning into the right side of the split", () => {
    expect(totalAdvisorUsage([usage(0.02), usage(0.03)])).toEqual({
      calls: 2,
      cost: 0.05,
      // input + cacheRead + cacheWrite, doubled
      inputTokens: 24_200,
      // output + reasoning, doubled
      outputTokens: 1_600,
      model: "anthropic/convoy-advisor-claude-opus-5",
    })
  })

  test("reports zeroes with no model for an attempt that never consulted", () => {
    expect(totalAdvisorUsage([])).toEqual({ calls: 0, cost: 0, inputTokens: 0, outputTokens: 0 })
  })
})
