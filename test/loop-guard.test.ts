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
    expect(guard.observe({ kind: "cost", cost: 1.99 })).toBeUndefined()
    expect(guard.observe({ kind: "cost", cost: 2 })).toMatchObject({ reason: "max-cost" })
  })

  test("a disabled cost cap never trips on cost", () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxPhaseCost: false }))
    expect(guard.observe({ kind: "cost", cost: 400 })).toBeUndefined()
  })

  test("enabled: false ignores every observation", () => {
    const guard = new LoopGuard(resolveLoopGuard({ enabled: false, identicalCalls: 1, maxSteps: 1, maxPhaseCost: 0.01 }))
    const call = { kind: "call" as const, name: "read", input: { filePath: "a.ts" } }
    expect(guard.observe(call)).toBeUndefined()
    expect(guard.observe(call)).toBeUndefined()
    expect(guard.observe({ kind: "step" })).toBeUndefined()
    expect(guard.observe({ kind: "cost", cost: 99 })).toBeUndefined()
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
