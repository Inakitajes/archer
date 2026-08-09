import { describe, expect, test } from "bun:test"

import {
  activity,
  awaitActionOrAbort,
  completionFollowUp,
  createConcurrencyLimiter,
  defaultMaxConcurrentAgents,
  describeMessageChunk,
  describeSessionStatus,
  describeToolCall,
  diffSummaryFromEvent,
  formatCharCount,
  formatCost,
  formatModelFromEvent,
  gateAllowedActions,
  isIgnorableRejection,
  isUserAbortError,
  keepCompletedPhase,
  newActivityState,
  noChangesReply,
  payloadID,
  payloadType,
  pickString,
  planBatches,
  pulse,
  rawString,
  recoveryReport,
  rememberMessagePartChannel,
  sleep,
  stepUsageFromEvent,
  todosFromEvent,
  usageFromRecord,
  UserAbortError,
} from "../src/runner"
import { payloadProperties } from "../src/event-hub"

// ---------------------------------------------------------------------------
// UserAbortError & isUserAbortError & isIgnorableRejection
// ---------------------------------------------------------------------------

describe("UserAbortError", () => {
  test("creates an error with default message", () => {
    const err = new UserAbortError()
    expect(err.message).toBe("aborted by user")
    expect(err.name).toBe("UserAbortError")
  })

  test("creates an error with custom message", () => {
    const err = new UserAbortError("custom")
    expect(err.message).toBe("custom")
  })
})

describe("isUserAbortError", () => {
  test("returns true for UserAbortError instances", () => {
    expect(isUserAbortError(new UserAbortError())).toBe(true)
  })

  test("returns true for errors with name UserAbortError", () => {
    const err = new Error("msg")
    err.name = "UserAbortError"
    expect(isUserAbortError(err)).toBe(true)
  })

  test("returns false for regular errors", () => {
    expect(isUserAbortError(new Error("test"))).toBe(false)
    expect(isUserAbortError("string")).toBe(false)
    expect(isUserAbortError(null)).toBe(false)
  })
})

describe("isIgnorableRejection", () => {
  test("returns true for UserAbortError", () => {
    expect(isIgnorableRejection(new UserAbortError())).toBe(true)
  })

  test("returns true for AbortError", () => {
    const err = new Error("The operation was aborted")
    err.name = "AbortError"
    expect(isIgnorableRejection(err)).toBe(true)
  })

  test("returns true for errors with 'aborted' in message", () => {
    expect(isIgnorableRejection(new Error("session aborted"))).toBe(true)
    expect(isIgnorableRejection(new Error("Aborted by user"))).toBe(true)
  })

  test("returns false for other errors", () => {
    expect(isIgnorableRejection(new Error("network error"))).toBe(false)
    expect(isIgnorableRejection("string")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// planBatches
// ---------------------------------------------------------------------------

describe("planBatches", () => {
  test("groups sequential steps with same groupId", () => {
    const steps = [
      { type: "agent" as const, name: "a1", stepName: "a1", groupId: "g1", agentName: "a1", description: "", model: "gpt-4", inputFiles: [], inputDiff: false, reportPath: "a1.md" },
      { type: "agent" as const, name: "a2", stepName: "a2", groupId: "g1", agentName: "a2", description: "", model: "gpt-4", inputFiles: [], inputDiff: false, reportPath: "a2.md" },
      { type: "agent" as const, name: "b1", stepName: "b1", groupId: undefined, agentName: "b1", description: "", model: "gpt-4", inputFiles: [], inputDiff: false, reportPath: "b1.md" },
    ]
    const batches = planBatches(steps)
    expect(batches.length).toBe(2)
    expect(batches[0]!.length).toBe(2)
    expect(batches[1]!.length).toBe(1)
  })

  test("puts human steps in their own batch", () => {
    const steps = [
      { type: "human" as const, name: "gate", stepName: "gate", description: "", inputFiles: [], inputDiff: false, reportPath: "gate.md" },
      { type: "agent" as const, name: "impl", stepName: "impl", groupId: "g1", agentName: "impl", description: "", model: "gpt-4", inputFiles: [], inputDiff: false, reportPath: "impl.md" },
    ]
    const batches = planBatches(steps)
    expect(batches.length).toBe(2)
    expect(batches[0]!.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// defaultMaxConcurrentAgents & createConcurrencyLimiter
// ---------------------------------------------------------------------------

describe("defaultMaxConcurrentAgents", () => {
  test("is 30", () => {
    expect(defaultMaxConcurrentAgents).toBe(30)
  })
})

describe("createConcurrencyLimiter", () => {
  test("queues waiters when limit is reached", async () => {
    const limiter = createConcurrencyLimiter(2)
    let running = 0
    let maxRunning = 0
    const track = async () => {
      await limiter(async () => {
        running++
        maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 10))
        running--
      })
    }
    await Promise.all([track(), track(), track(), track()])
    expect(maxRunning).toBeLessThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// keepCompletedPhase & completionFollowUp
// ---------------------------------------------------------------------------

describe("keepCompletedPhase", () => {
  test("returns the first result with a warning", () => {
    const result = { type: "success" as const, assistantText: "done", cost: 0.1 }
    expect(keepCompletedPhase("design", result, "model unavailable")).toBe(result)
  })
})

describe("completionFollowUp", () => {
  test("returns read-only protocol for read-only steps", () => {
    const advice = completionFollowUp({ readOnly: true } as AgentStep, "Check the report")
    expect(advice).toContain("COMPLETE corrected report")
    expect(advice).toContain(noChangesReply)
  })

  test("returns writable protocol for writable steps", () => {
    const advice = completionFollowUp({ readOnly: false } as AgentStep, "Fix the bug")
    expect(advice).toContain("do it now")
    expect(advice).not.toContain(noChangesReply)
  })
})

// ---------------------------------------------------------------------------
// recoveryReport
// ---------------------------------------------------------------------------

describe("recoveryReport", () => {
  test("returns a recovery report string", () => {
    const report = recoveryReport("implement")
    expect(report).toContain("Recovered uncommitted changes")
    expect(report).toContain("Phase \"implement\"")
  })
})

// ---------------------------------------------------------------------------
// gateAllowedActions
// ---------------------------------------------------------------------------

describe("gateAllowedActions", () => {
  test("interactive gates allow continue, iterate, abort", () => {
    expect(gateAllowedActions("interactive", true)).toEqual(["continue", "iterate", "abort"])
    expect(gateAllowedActions("interactive", false)).toEqual(["continue", "iterate", "abort"])
  })

  test("failure gates include retry when canRetry is true", () => {
    expect(gateAllowedActions("failure", true)).toEqual(["retry", "iterate", "abort"])
  })

  test("failure gates omit retry when canRetry is false", () => {
    expect(gateAllowedActions("failure", false)).toEqual(["iterate", "abort"])
  })
})

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe("sleep", () => {
  test("resolves after the specified time", async () => {
    const start = Date.now()
    await sleep(5)
    expect(Date.now() - start).toBeGreaterThanOrEqual(4)
  })

  test("resolves immediately when signal is already aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const start = Date.now()
    await sleep(1000, controller.signal)
    expect(Date.now() - start).toBeLessThan(100)
  })
})

// ---------------------------------------------------------------------------
// payloadType
// ---------------------------------------------------------------------------

describe("payloadType", () => {
  test("extracts type from payload", () => {
    expect(payloadType({ type: "message" })).toBe("message")
  })

  test("strips .1 suffix from sync types", () => {
    expect(payloadType({ type: "sync", name: "tool.use.1" })).toBe("tool.use")
  })

  test("returns name when there is no type", () => {
    expect(payloadType({ name: "event" })).toBe("event")
  })

  test("returns empty string for non-object", () => {
    expect(payloadType(null)).toBe("")
    expect(payloadType("string")).toBe("")
  })
})

// ---------------------------------------------------------------------------
// newActivityState
// ---------------------------------------------------------------------------

describe("newActivityState", () => {
  test("returns a fresh state with zeros", () => {
    const state = newActivityState()
    expect(state.reasoningChars).toBe(0)
    expect(state.textChars).toBe(0)
    expect(state.textTail).toBe("")
    expect(state.reasoningPart).toBe(0)
    expect(state.textPart).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// activity & pulse
// ---------------------------------------------------------------------------

describe("activity", () => {
  test("creates an activity signal", () => {
    const signal = activity("info", "working", { stepID: "s1", cost: 0.1 })
    expect(signal).toEqual({ type: "activity", kind: "info", message: "working", stepUsage: { stepID: "s1", cost: 0.1 } })
  })
})

describe("pulse", () => {
  test("creates a pulse signal", () => {
    const signal = pulse("info", "beating")
    expect(signal).toEqual({ type: "activity", kind: "info", message: "beating", pulse: true })
  })
})

// ---------------------------------------------------------------------------
// describeSessionStatus
// ---------------------------------------------------------------------------

describe("describeSessionStatus", () => {
  test("returns pulse for busy status", () => {
    const signal = describeSessionStatus({ type: "busy" })
    expect(signal).toMatchObject({ type: "activity", kind: "info", message: "provider busy" })
  })

  test("returns pulse for idle status", () => {
    const signal = describeSessionStatus({ type: "idle" })
    expect(signal).toMatchObject({ type: "activity", kind: "info", message: "provider idle" })
  })

  test("returns activity for retry status", () => {
    const signal = describeSessionStatus({ type: "retry", attempt: 2, message: "rate limited" })
    expect(signal).toMatchObject({ type: "activity", kind: "retry", message: expect.stringContaining("rate limited") as any })
  })

  test("returns undefined for unknown status", () => {
    expect(describeSessionStatus({ type: "unknown" })).toBeUndefined()
    expect(describeSessionStatus(null)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// describeMessageChunk
// ---------------------------------------------------------------------------

describe("describeMessageChunk", () => {
  test("handles message.part.delta with text", () => {
    const msg = describeMessageChunk(
      { type: "message.part.delta", properties: { delta: "hello", field: "text", partID: "part_1" } },
      newActivityState(),
    )
    expect(msg).toBeDefined()
    expect(msg).toMatchObject({ channel: "response", text: "hello" } as any)
  })

  test("returns undefined for non-text field", () => {
    expect(describeMessageChunk({ type: "message.part.delta", properties: { delta: "hello", field: "arguments" } })).toBeUndefined()
  })

  test("handles session.next.reasoning.delta", () => {
    const state = newActivityState()
    state.reasoningPart = 1
    const msg = describeMessageChunk({ type: "session.next.reasoning.delta", properties: { delta: "I think..." } }, state)
    expect(msg).toBeDefined()
    expect(msg).toMatchObject({ channel: "reasoning", text: "I think..." } as any)
  })

  test("handles session.next.text.delta", () => {
    const msg = describeMessageChunk({ type: "session.next.text.delta", properties: { delta: "Hello" } }, newActivityState())
    expect(msg).toBeDefined()
    expect(msg).toMatchObject({ channel: "response", text: "Hello" } as any)
  })

  test("handles session.next.tool.called", () => {
    const msg = describeMessageChunk({ type: "session.next.tool.called", properties: { tool: "Read", input: { file_path: "/test.js" } } })
    expect(msg).toBeDefined()
    expect(msg).toMatchObject({ channel: "tool" } as any)
  })

  test("handles session.next.shell.started", () => {
    const msg = describeMessageChunk({ type: "session.next.shell.started", properties: { command: "npm test" } })
    expect(msg).toBeDefined()
    expect(msg).toMatchObject({ channel: "bash", text: "npm test" } as any)
  })

  test("returns undefined for unknown type", () => {
    expect(describeMessageChunk({ type: "unknown" })).toBeUndefined()
  })

  test("returns undefined for non-object payload", () => {
    expect(describeMessageChunk(null)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// rememberMessagePartChannel
// ---------------------------------------------------------------------------

describe("rememberMessagePartChannel", () => {
  test("remembers reasoning channel", () => {
    const state = newActivityState()
    const part = { id: "p1", type: "reasoning" }
    rememberMessagePartChannel({ part }, state)
    expect(state.messagePartChannels.get("p1")).toBe("reasoning")
  })

  test("remembers text channel", () => {
    const state = newActivityState()
    const part = { id: "p2", type: "text" }
    rememberMessagePartChannel({ part }, state)
    expect(state.messagePartChannels.get("p2")).toBe("response")
  })

  test("does nothing when state is undefined", () => {
    expect(() => rememberMessagePartChannel({ part: { id: "p1", type: "reasoning" } }, undefined)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// rawString
// ---------------------------------------------------------------------------

describe("rawString", () => {
  test("returns the string for string values", () => {
    expect(rawString("hello")).toBe("hello")
  })

  test("returns empty string for non-string values", () => {
    expect(rawString(42)).toBe("")
    expect(rawString(null)).toBe("")
    expect(rawString(undefined)).toBe("")
  })
})

// ---------------------------------------------------------------------------
// todosFromEvent & diffSummaryFromEvent
// ---------------------------------------------------------------------------

describe("todosFromEvent", () => {
  test("parses valid todos", () => {
    const todos = todosFromEvent([{ content: "Fix bug", status: "pending" }, { content: "Add tests" }])
    expect(todos).toEqual([{ content: "Fix bug", status: "pending" }, { content: "Add tests", status: "pending" }])
  })

  test("returns empty array for non-array", () => {
    expect(todosFromEvent(null)).toEqual([])
  })

  test("skips invalid items", () => {
    expect(todosFromEvent([{ content: "Valid" }, null, { status: "done" }])).toEqual([{ content: "Valid", status: "pending" }])
  })
})

describe("diffSummaryFromEvent", () => {
  test("parses valid diff data", () => {
    const diff = diffSummaryFromEvent([{ additions: 10, deletions: 5 }, { additions: 3, deletions: 1 }])
    expect(diff).toEqual({ files: 2, additions: 13, deletions: 6 })
  })

  test("returns zeros for non-array", () => {
    expect(diffSummaryFromEvent(null)).toEqual({ files: 0, additions: 0, deletions: 0 })
  })

  test("skips invalid items", () => {
    expect(diffSummaryFromEvent([{ additions: 5 }, null])).toEqual({ files: 2, additions: 5, deletions: 0 })
  })
})

// ---------------------------------------------------------------------------
// formatCharCount & formatModelFromEvent & formatCost
// ---------------------------------------------------------------------------

describe("formatCharCount", () => {
  test("formats small numbers directly", () => {
    expect(formatCharCount(0)).toBe("0")
    expect(formatCharCount(999)).toBe("999")
  })

  test("formats large numbers with k", () => {
    expect(formatCharCount(1000)).toBe("1.0k")
    expect(formatCharCount(12345)).toBe("12.3k")
  })
})

describe("formatModelFromEvent", () => {
  test("formats model from event data", () => {
    expect(formatModelFromEvent({ providerID: "openai", id: "gpt-4", variant: "turbo" })).toBe("openai/gpt-4#turbo")
    expect(formatModelFromEvent({ providerID: "anthropic", id: "claude-opus-4" })).toBe("anthropic/claude-opus-4")
  })

  test("returns default string for null", () => {
    expect(formatModelFromEvent(null)).toBe("selected model")
  })
})

describe("formatCost", () => {
  test("formats cost without tokens", () => {
    expect(formatCost({ cost: 0.05 })).toBe(", $0.0500")
  })

  test("formats cost with tokens", () => {
    const result = formatCost({ cost: 0.05, tokens: { input: 100, output: 50, reasoning: 10 } })
    expect(result).toContain("$0.0500")
    expect(result).toContain("100")
    expect(result).toContain("50")
  })

  test("returns empty string when no cost and no tokens", () => {
    expect(formatCost({})).toBe("")
  })
})

// ---------------------------------------------------------------------------
// describeToolCall & pickString & payloadID & usageFromRecord & stepUsageFromEvent
// ---------------------------------------------------------------------------

describe("describeToolCall", () => {
  test("formats tool call with arguments", () => {
    expect(describeToolCall({ tool: "Read", input: { filePath: "/test.js" } })).toBe("Read: /test.js")
    expect(describeToolCall({ tool: "Grep", input: { pattern: "TODO" } })).toBe("Grep: TODO")
  })
})

describe("pickString", () => {
  test("picks first matching string key", () => {
    expect(pickString({ command: "npm test" }, ["command"])).toBe("npm test")
    expect(pickString({}, ["key"])).toBe("")
  })
})

describe("payloadID", () => {
  test("extracts ID from payload", () => {
    expect(payloadID({ id: "ses_123" })).toBe("ses_123")
    expect(payloadID({})).toBeUndefined()
  })
})

describe("usageFromRecord", () => {
  test("returns usage when cost is present", () => {
    const usage = usageFromRecord({ cost: 0.05 })
    expect(usage).toEqual({ cost: 0.05, tokens: undefined })
  })

  test("returns usage when tokens are present", () => {
    const usage = usageFromRecord({ tokens: { input: 100, output: 50 } })
    expect(usage?.tokens?.input).toBe(100)
    expect(usage?.tokens?.output).toBe(50)
  })

  test("returns undefined for empty record", () => {
    expect(usageFromRecord({})).toBeUndefined()
  })

  test("uses cost from properties when present", () => {
    const usage = stepUsageFromEvent({ id: "s1" }, { cost: 0.05, tokens: { input: 100 } }, "gpt-4")
    expect(usage?.stepID).toBe("s1")
    expect(usage?.cost).toBe(0.05)
  })
})

// ---------------------------------------------------------------------------
// awaitActionOrAbort
// ---------------------------------------------------------------------------

describe("awaitActionOrAbort", () => {
  test("resolves with the action result", async () => {
    const result = await awaitActionOrAbort(Promise.resolve("done"))
    expect(result).toBe("done")
  })

  test("rejects when the action rejects", async () => {
    await expect(awaitActionOrAbort(Promise.reject(new Error("fail")))).rejects.toThrow("fail")
  })
})