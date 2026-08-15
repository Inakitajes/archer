import { describe, expect, test } from "bun:test"

import {
  canonicalInput,
  defaultLoopGuard,
  LoopGuard,
  LoopGuardError,
  observationFromSessionEvent,
  resolveLoopGuard,
  softAgentSteps,
} from "../src/loop-guard"

const tight = resolveLoopGuard({ identicalCalls: 3, sameToolFailures: 3, maxSteps: 5, maxPhaseCost: 2 })

describe("resolveLoopGuard", () => {
  test("fills in the built-in defaults", () => {
    expect(resolveLoopGuard()).toEqual(defaultLoopGuard)
    expect(resolveLoopGuard({})).toEqual(defaultLoopGuard)
  })

  test("lets a config override individual keys", () => {
    expect(resolveLoopGuard({ identicalCalls: 8, maxSteps: 40 })).toMatchObject({
      enabled: true,
      identicalCalls: 8,
      sameToolFailures: 6,
      maxSteps: 40,
      maxPhaseCost: 20,
    })
  })

  test("maxPhaseCost: false turns the cost fuse off even though the default is on", () => {
    expect(resolveLoopGuard({ maxPhaseCost: false }).maxPhaseCost).toBeUndefined()
  })

  test("a resolved config cannot be fed back into resolveLoopGuard", () => {
    // SC-1/SC-10: re-resolving a resolved config re-arms the $20 default over a
    // user's `maxPhaseCost: false`. The resolved marker makes that a compile
    // error, so the double-resolution bug cannot silently come back.
    // @ts-expect-error — LoopGuardConfig is not assignable to LoopGuardSettings
    resolveLoopGuard(resolveLoopGuard({ maxPhaseCost: false }))
  })

  test("soft agent steps land a few turns before the hard abort", () => {
    expect(softAgentSteps(80)).toBe(75)
    expect(softAgentSteps(5)).toBe(1)
    expect(softAgentSteps(1)).toBe(1)
  })
})

describe("LoopGuard identical calls", () => {
  test("trips when the same tool+args repeat across turns", () => {
    const guard = new LoopGuard(tight)
    const call = { kind: "call" as const, name: "read", input: { filePath: "src/a.ts" } }

    expect(guard.observe(call)).toBeUndefined()
    expect(guard.observe(call)).toBeUndefined()
    const trip = guard.observe(call)
    expect(trip).toMatchObject({ reason: "identical-calls", count: 3, tool: "read" })
    expect(trip?.message).toContain("src/a.ts")
    expect(trip?.message).toContain("aborted")
  })

  test("treats key order and surrounding whitespace as the same call", () => {
    const guard = new LoopGuard(tight)
    expect(guard.observe({ kind: "call", name: "bash", input: { command: " bun test ", timeout: 30 } })).toBeUndefined()
    expect(guard.observe({ kind: "call", name: "bash", input: { timeout: 30, command: "bun test" } })).toBeUndefined()
    expect(guard.observe({ kind: "call", name: "bash", input: { command: "bun test", timeout: 30 } })?.reason).toBe("identical-calls")
  })

  test("a different argument resets the streak", () => {
    const guard = new LoopGuard(tight)
    const read = (filePath: string) => ({ kind: "call" as const, name: "read", input: { filePath } })
    expect(guard.observe(read("a.ts"))).toBeUndefined()
    expect(guard.observe(read("a.ts"))).toBeUndefined()
    expect(guard.observe(read("b.ts"))).toBeUndefined()
    expect(guard.observe(read("a.ts"))).toBeUndefined()
    expect(guard.observe(read("a.ts"))).toBeUndefined()
    expect(guard.observe(read("a.ts"))?.reason).toBe("identical-calls")
  })
})

describe("LoopGuard same-tool failures", () => {
  test("trips when the same tool keeps failing even if the args drift", () => {
    const guard = new LoopGuard(tight)
    expect(guard.observe({ kind: "result", name: "edit", failed: true })).toBeUndefined()
    expect(guard.observe({ kind: "result", name: "edit", failed: true })).toBeUndefined()
    expect(guard.observe({ kind: "result", name: "edit", failed: true })?.reason).toBe("same-tool-failures")
  })

  test("a success or a different tool resets the failure streak", () => {
    const guard = new LoopGuard(tight)
    expect(guard.observe({ kind: "result", name: "bash", failed: true })).toBeUndefined()
    expect(guard.observe({ kind: "result", name: "bash", failed: true })).toBeUndefined()
    expect(guard.observe({ kind: "result", name: "bash", failed: false })).toBeUndefined()
    expect(guard.observe({ kind: "result", name: "bash", failed: true })).toBeUndefined()
    expect(guard.observe({ kind: "result", name: "read", failed: true })).toBeUndefined()
    expect(guard.observe({ kind: "result", name: "bash", failed: true })).toBeUndefined()
  })
})

describe("LoopGuard ceilings", () => {
  test("trips on the configured step count", () => {
    const guard = new LoopGuard(tight)
    expect(guard.observe({ kind: "step" })).toBeUndefined()
    expect(guard.observe({ kind: "step" })).toBeUndefined()
    expect(guard.observe({ kind: "step" })).toBeUndefined()
    expect(guard.observe({ kind: "step" })).toBeUndefined()
    expect(guard.observe({ kind: "step" })).toMatchObject({ reason: "max-steps", count: 5 })
  })

  test("trips when cumulative cost reaches the cap", () => {
    const guard = new LoopGuard(tight)
    expect(guard.observe({ kind: "cost", messageID: "msg_1", cost: 1.99 })).toBeUndefined()
    expect(guard.observe({ kind: "cost", messageID: "msg_1", cost: 2 })).toMatchObject({ reason: "max-cost" })
  })

  test("accumulates cost across watcher scopes so a follow-up turn trips the shared cap", () => {
    // Turn 1 runs through one watcher; the advisor follow-up runs through a NEW
    // watcher whose observations restart near zero. The guard must hold the
    // running total or the turn-1 spend is invisible to the fuse.
    const guard = new LoopGuard(resolveLoopGuard({ maxPhaseCost: 20 }))
    expect(guard.observe({ kind: "cost", messageID: "msg_1", cost: 10 })).toBeUndefined()
    expect(guard.observe({ kind: "cost", messageID: "msg_2", cost: 5 })).toBeUndefined()
    // Follow-up watcher: its own message ids, costs restarting near zero.
    expect(guard.observe({ kind: "cost", messageID: "msg_3", cost: 4 })).toBeUndefined()
    const trip = guard.observe({ kind: "cost", messageID: "msg_3", cost: 7 })
    expect(trip).toMatchObject({ reason: "max-cost", count: 22 })
  })

  test("a disabled cost cap never trips on cost", () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxPhaseCost: false }))
    expect(guard.observe({ kind: "cost", messageID: "msg_1", cost: 400 })).toBeUndefined()
  })

  test("enabled: false ignores every observation", () => {
    const guard = new LoopGuard(resolveLoopGuard({ enabled: false, identicalCalls: 1, maxSteps: 1, maxPhaseCost: 0.01 }))
    const call = { kind: "call" as const, name: "read", input: { filePath: "a.ts" } }
    expect(guard.observe(call)).toBeUndefined()
    expect(guard.observe(call)).toBeUndefined()
    expect(guard.observe({ kind: "step" })).toBeUndefined()
    expect(guard.observe({ kind: "cost", messageID: "msg_1", cost: 99 })).toBeUndefined()
  })
})

describe("observationFromSessionEvent", () => {
  test("maps the OpenCode tool/step events the watcher already sees", () => {
    expect(observationFromSessionEvent("session.next.tool.called", { tool: "read", input: { filePath: "a.ts" } })).toEqual({
      kind: "call",
      name: "read",
      input: { filePath: "a.ts" },
    })
    expect(observationFromSessionEvent("session.next.tool.failed", { name: "bash" })).toEqual({
      kind: "result",
      name: "bash",
      failed: true,
    })
    expect(observationFromSessionEvent("session.next.tool.success", { tool: "edit" })).toEqual({
      kind: "result",
      name: "edit",
      failed: false,
    })
    expect(observationFromSessionEvent("session.next.step.started", {})).toEqual({ kind: "step" })
    expect(observationFromSessionEvent("session.next.reasoning.delta", { delta: "hmm" })).toBeUndefined()
  })

  test("maps assistant message updates to per-message cost observations", () => {
    const info = (id: string, cost: number, role = "assistant") => ({ role, id, cost, tokens: { input: 1, output: 1 } })
    expect(observationFromSessionEvent("message.updated", { sessionID: "ses_1", info: info("msg_1", 0.42) })).toEqual({
      kind: "cost",
      messageID: "msg_1",
      cost: 0.42,
    })
    // User messages and non-message updates never feed the cost fuse.
    expect(observationFromSessionEvent("message.updated", { sessionID: "ses_1", info: info("msg_2", 0.5, "user") })).toBeUndefined()
    expect(observationFromSessionEvent("message.updated", { sessionID: "ses_1", info: { role: "assistant" } })).toBeUndefined()
    expect(observationFromSessionEvent("message.updated", { sessionID: "ses_1" })).toBeUndefined()
  })
})

describe("LoopGuardError", () => {
  test("carries the trip and a readable message", () => {
    const trip = { reason: "identical-calls" as const, message: "stopped", count: 4, tool: "read" }
    const error = new LoopGuardError(trip)
    expect(error.name).toBe("LoopGuardError")
    expect(error.message).toBe("stopped")
    expect(error.trip).toEqual(trip)
  })
})

describe("canonicalInput", () => {
  test("is stable across key order", () => {
    expect(canonicalInput({ b: 1, a: " x " })).toBe(canonicalInput({ a: "x", b: 1 }))
  })
})
