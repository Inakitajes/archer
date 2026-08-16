import { describe, expect, test } from "bun:test"

import {
  canonicalInput,
  defaultLoopGuard,
  LoopGuard,
  LoopGuardError,
  observationFromSessionEvent,
  resolveLoopGuard,
  softAgentSteps,
  type LoopGuardObservation,
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

describe("LoopGuard callID tool correlation (SDK contract)", () => {
  // QSR-1/QSR-2: session.next.tool.success/failed carry callID but no tool or
  // name. The guard must remember each call's tool from the called event and
  // resolve result identity through callID, or distinct tools' failures
  // collapse into one synthetic "tool" and false-trip the same-tool fuse.
  // These three event types always map to an observation, so the helpers assert
  // non-undefined to keep `observe`'s `LoopGuardObservation` parameter happy.
  const called = (tool: string, callID: string, input: Record<string, unknown> = {}): LoopGuardObservation =>
    observationFromSessionEvent("session.next.tool.called", { tool, input, callID }) as LoopGuardObservation
  const failed = (callID: string): LoopGuardObservation =>
    observationFromSessionEvent("session.next.tool.failed", { callID }) as LoopGuardObservation
  const success = (callID: string): LoopGuardObservation =>
    observationFromSessionEvent("session.next.tool.success", { callID }) as LoopGuardObservation

  test("does not trip when distinct tools fail (callID keeps their identities apart)", () => {
    const guard = new LoopGuard(tight)
    guard.observe(called("read", "c1"))
    guard.observe(called("edit", "c2"))
    expect(guard.observe(failed("c1"))).toBeUndefined()
    expect(guard.observe(failed("c2"))).toBeUndefined()
    // Alternating failures of two different tools never accumulate a streak.
    guard.observe(called("read", "c3"))
    guard.observe(called("edit", "c4"))
    expect(guard.observe(failed("c3"))).toBeUndefined()
    expect(guard.observe(failed("c4"))).toBeUndefined()
  })

  test("trips when the same tool fails repeatedly, resolved through callID", () => {
    const guard = new LoopGuard(tight)
    guard.observe(called("bash", "c1"))
    expect(guard.observe(failed("c1"))).toBeUndefined()
    guard.observe(called("bash", "c2"))
    expect(guard.observe(failed("c2"))).toBeUndefined()
    guard.observe(called("bash", "c3"))
    expect(guard.observe(failed("c3"))).toMatchObject({ reason: "same-tool-failures", count: 3, tool: "bash" })
  })

  test("ignores a failure whose callID was never seen — no synthetic tool merge", () => {
    // Before the fix, a nameless failure collapsed to "tool"; two unrelated
    // failures would then share the streak and false-trip. Now each
    // unidentified failure is ignored on its own.
    const guard = new LoopGuard(tight)
    expect(guard.observe(failed("unknown_1"))).toBeUndefined()
    expect(guard.observe(failed("unknown_2"))).toBeUndefined()
    expect(guard.observe(failed("unknown_3"))).toBeUndefined()
    // A later identified failure starts its own streak from zero.
    guard.observe(called("edit", "c1"))
    expect(guard.observe(failed("c1"))).toBeUndefined()
  })

  test("a success resolved through callID resets the failure streak", () => {
    const guard = new LoopGuard(tight)
    guard.observe(called("bash", "c1"))
    guard.observe(failed("c1"))
    guard.observe(called("bash", "c2"))
    guard.observe(failed("c2"))
    guard.observe(called("bash", "c3"))
    guard.observe(success("c3")) // success resets the streak
    guard.observe(called("bash", "c4"))
    expect(guard.observe(failed("c4"))).toBeUndefined() // streak restarted at 1
  })

  test("a nameless failure after an identified one does not inherit its streak", () => {
    // An identified "bash" failure must not be followed by an unidentified
    // failure adding onto bash's count.
    const guard = new LoopGuard(tight)
    guard.observe(called("bash", "c1"))
    guard.observe(failed("c1"))
    guard.observe(called("bash", "c2"))
    guard.observe(failed("c2"))
    // Unidentified failure: ignored, does NOT make it 3.
    expect(guard.observe(failed("missing_callID"))).toBeUndefined()
    guard.observe(called("bash", "c3"))
    expect(guard.observe(failed("c3"))).toMatchObject({ reason: "same-tool-failures", count: 3, tool: "bash" })
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
    // SDK contract (v2): the called event carries tool+callID+input; the
    // success/failed events carry callID only — no tool or name. Pinning the
    // callID on the call is what lets the guard correlate results back.
    expect(observationFromSessionEvent("session.next.tool.called", { tool: "read", input: { filePath: "a.ts" }, callID: "call_1" })).toEqual({
      kind: "call",
      name: "read",
      input: { filePath: "a.ts" },
      callID: "call_1",
    })
    expect(observationFromSessionEvent("session.next.tool.failed", { callID: "call_2" })).toEqual({
      kind: "result",
      failed: true,
      callID: "call_2",
    })
    expect(observationFromSessionEvent("session.next.tool.success", { callID: "call_3" })).toEqual({
      kind: "result",
      failed: false,
      callID: "call_3",
    })
    expect(observationFromSessionEvent("session.next.step.started", {})).toEqual({ kind: "step" })
    expect(observationFromSessionEvent("session.next.reasoning.delta", { delta: "hmm" })).toBeUndefined()
  })

  test("a called event without a callID still maps to a call observation", () => {
    // Malformed called event: no callID to pin. The call still feeds the
    // identical-calls detector; results just won't be able to correlate.
    expect(observationFromSessionEvent("session.next.tool.called", { tool: "read", input: {} })).toEqual({
      kind: "call",
      name: "read",
      input: {},
    })
  })

  test("a result event with no callID yields a result observation with no identity", () => {
    // No callID means the guard can't correlate and must ignore it rather than
    // merge it into a synthetic "tool".
    expect(observationFromSessionEvent("session.next.tool.failed", {})).toEqual({ kind: "result", failed: true })
    expect(observationFromSessionEvent("session.next.tool.success", {})).toEqual({ kind: "result", failed: false })
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
