import { describe, expect, test } from "bun:test"

import { LoopGuard, resolveLoopGuard, softNudgeSteps } from "../src/loop-guard"

describe("LoopGuard budget gate", () => {
  test("emits one soft nudge at half the configured budget", () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxSteps: 200 }))

    for (let step = 1; step < softNudgeSteps(200); step++) {
      expect(guard.observe({ kind: "step" })).toBeUndefined()
    }

    expect(guard.observe({ kind: "step" })).toMatchObject({ reason: "soft-nudge", count: 100 })
    for (let step = 101; step < 200; step++) {
      expect(guard.observe({ kind: "step" })).toBeUndefined()
    }
    expect(guard.observe({ kind: "step" })).toMatchObject({ reason: "max-steps", count: 200 })
  })

  test("resetSteps zeroes only the renewable step budget", () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxSteps: 200, maxPhaseCost: 20 }))
    for (let step = 0; step < 100; step++) guard.observe({ kind: "step" })
    guard.observe({ kind: "cost", messageID: "msg_1", cost: 10 })

    guard.resetSteps()

    expect(guard.getSteps()).toBe(0)
    expect(guard.getTotalCost()).toBe(10)
  })

  test("a reset allows the hard gate to trigger again", () => {
    const guard = new LoopGuard(resolveLoopGuard({ maxSteps: 200 }))
    for (let step = 0; step < 200; step++) guard.observe({ kind: "step" })
    guard.resetSteps()
    for (let step = 0; step < 199; step++) guard.observe({ kind: "step" })

    expect(guard.observe({ kind: "step" })).toMatchObject({ reason: "max-steps", count: 200 })
  })
})
