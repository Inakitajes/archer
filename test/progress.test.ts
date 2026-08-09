import { describe, expect, test } from "bun:test"

import { createProgressUI, noopProgress } from "../src/progress"
import type { AdvisorEvent } from "../src/advisor-events"

describe("noopProgress", () => {
  test("accepts every lifecycle event as a no-op", () => {
    const advisorEvent: AdvisorEvent = {
      id: "evt-1",
      type: "advisor.requested",
      timestamp: new Date(0).toISOString(),
      callId: "call-1",
      phase: "build",
      attempt: 1,
      trigger: "completion",
      budget: { used: 1, max: 3 },
      model: "anthropic/claude-opus-4",
    }
    const operations = [
      () => noopProgress.start("run-1", "/target", "/run"),
      () => noopProgress.serverReady("http://127.0.0.1:4096"),
      () => noopProgress.phaseStarted("build", "starting"),
      () => noopProgress.phaseRunning("build", "running"),
      () => noopProgress.phaseAttempt("build", { attempt: 1, model: "openai/gpt-5" }),
      () => noopProgress.phaseSession("build", "ses_1"),
      () => noopProgress.phaseActivity("build", "reading", "tool", true),
      () => noopProgress.phaseMessage("build", { channel: "response", text: "done", partID: "part-1" }),
      () => noopProgress.phaseStepUsage("build", { stepID: "step-1", cost: 0.01 }),
      () => noopProgress.phaseUsageTotal("build", { sessionID: "ses_1", cost: 0.01 }),
      () => noopProgress.phaseAdvisorEvent("build", advisorEvent),
      () => noopProgress.phaseTodos("build", [{ content: "write tests", status: "completed" }]),
      () => noopProgress.phaseDiff("build", { files: 1, additions: 2, deletions: 1 }),
      () => noopProgress.phaseCompleted("build", "done"),
      () => noopProgress.phaseSkipped("build"),
      () => noopProgress.phaseFailed("build", "failed"),
      () => noopProgress.phaseRestored("build", { status: "completed", sessionID: "ses_1", durationMs: 1_000, cost: 0.01 }),
      () => noopProgress.message("hello"),
      () => noopProgress.suspend(),
      () => noopProgress.resume(),
      () => noopProgress.stop(),
    ]

    for (const operation of operations) expect(operation()).toBeUndefined()
  })

  test("optional methods are absent", () => {
    expect(noopProgress.askPermission).toBeUndefined()
    expect(noopProgress.askHumanReview).toBeUndefined()
    expect(noopProgress.isInteractiveTakeover).toBeUndefined()
    expect(noopProgress.runFinished).toBeUndefined()
    expect(noopProgress.keepRunDirRequested).toBeUndefined()
    expect(noopProgress.runControlState).toBeUndefined()
    expect(noopProgress.keepAwakeState).toBeUndefined()
    expect(noopProgress.runStatus).toBeUndefined()
  })

})

describe("createProgressUI", () => {
  async function withTty(value: boolean, fn: () => Promise<void>) {
    const original = process.stdout.isTTY
    Object.defineProperty(process.stdout, "isTTY", { value, configurable: true })
    try {
      await fn()
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true })
    }
  }

  test("returns noopProgress when not enabled", async () => {
    const result = await createProgressUI([], false)
    expect(result).toBe(noopProgress)
  })

  test("returns noopProgress when not a TTY", async () => {
    await withTty(false, async () => {
      const result = await createProgressUI([{ name: "test", description: "" }], true)
      expect(result).toBe(noopProgress)
    })
  })

  test("accepts autoAccept parameter without errors", async () => {
    const result = await createProgressUI([], false, undefined, { mode: "smart" })
    expect(result).toBe(noopProgress)
  })

  test("accepts controls parameter without errors", async () => {
    const controls = {
      onPauseToggle: () => {},
      onKeepAwakeToggle: () => {},
    }
    const result = await createProgressUI([], false, undefined, undefined, controls)
    expect(result).toBe(noopProgress)
  })

  test("accepts onAbort callback without errors", async () => {
    let aborted = false
    const result = await createProgressUI([], false, () => { aborted = true })
    expect(result).toBe(noopProgress)
    expect(aborted).toBe(false)
  })
})
