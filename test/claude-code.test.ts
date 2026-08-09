import { describe, expect, test } from "bun:test"
import { pathToFileURL } from "node:url"

import {
  attachmentPaths,
  baseAgentName,
  claudeArgs,
  claudeModelLabel,
  claudePrompt,
  claudeReadableDirectories,
  claudeResumeArgs,
  claudeSessionDirectoriesPath,
  claudeTokens,
  deltaOf,
  describeClaudeEvent,
  ensureClaudeAvailable,
  eventType,
  formatCharCount,
  isWithin,
  newClaudeStreamState,
  numberToken,
  pipelineUsesClaudeCode,
  toolDetail,
  toolUseBlocks,
  truncate,
} from "../src/claude-code"
import type { Pipeline } from "../src/types"

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

function samplePipeline(overrides: Partial<Pipeline> = {}): Pipeline {
  return {
    name: "test",
    steps: [
      { type: "agent", name: "audit", stepName: "audit", groupId: "g1", agentName: "audit", description: "Audit", model: "opus", runner: "claude-code", inputFiles: [], inputDiff: false, reportPath: "reports/audit.md", readOnly: true },
    ],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// pipelineUsesClaudeCode
// ---------------------------------------------------------------------------

describe("pipelineUsesClaudeCode", () => {
  test("returns true when pipeline has claude-code steps", () => {
    expect(pipelineUsesClaudeCode(samplePipeline())).toBe(true)
  })

  test("returns false when pipeline has no claude-code steps", () => {
    const pipeline = samplePipeline({ steps: [{ type: "agent", name: "impl", stepName: "impl", groupId: "g1", agentName: "impl", description: "Impl", model: "gpt-4", inputFiles: [], inputDiff: false, reportPath: "reports/impl.md" }] })
    expect(pipelineUsesClaudeCode(pipeline)).toBe(false)
  })

  test("returns false for empty pipeline", () => {
    expect(pipelineUsesClaudeCode({ name: "empty", steps: [] })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ensureClaudeAvailable
// ---------------------------------------------------------------------------

describe("ensureClaudeAvailable", () => {
  test("does nothing when pipeline has no claude-code steps", () => {
    expect(() => ensureClaudeAvailable({ name: "test", steps: [] }, () => null)).not.toThrow()
  })

  test("does nothing when claude binary is found", () => {
    expect(() => ensureClaudeAvailable(samplePipeline(), () => "/usr/local/bin/claude")).not.toThrow()
  })

  test("throws when claude binary is missing", () => {
    expect(() => ensureClaudeAvailable(samplePipeline(), () => null)).toThrow("CLI was not found")
  })
})

// ---------------------------------------------------------------------------
// claudeModelLabel
// ---------------------------------------------------------------------------

describe("claudeModelLabel", () => {
  test("formats with claude-code prefix", () => {
    expect(claudeModelLabel("opus")).toBe("claude-code/opus")
    expect(claudeModelLabel("")).toBe("claude-code/default")
  })
})

// ---------------------------------------------------------------------------
// newClaudeStreamState
// ---------------------------------------------------------------------------

describe("newClaudeStreamState", () => {
  test("returns initial state with zero counts", () => {
    const state = newClaudeStreamState()
    expect(state.reasoningChars).toBe(0)
    expect(state.textChars).toBe(0)
    expect(state.block).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// formatCharCount & truncate
// ---------------------------------------------------------------------------

describe("formatCharCount", () => {
  test("returns raw number below 1000", () => {
    expect(formatCharCount(0)).toBe("0")
    expect(formatCharCount(500)).toBe("500")
    expect(formatCharCount(999)).toBe("999")
  })

  test("returns 1 decimal for values below 10000", () => {
    expect(formatCharCount(1500)).toBe("1.5k")
    expect(formatCharCount(9999)).toBe("10.0k")
  })

  test("returns integer for values 10000+", () => {
    expect(formatCharCount(10_000)).toBe("10k")
    expect(formatCharCount(123_456)).toBe("123k")
  })
})

describe("truncate", () => {
  test("returns the full value when it fits", () => {
    expect(truncate("hello", 10)).toBe("hello")
  })

  test("truncates with ellipsis when too long", () => {
    expect(truncate("hello world foo bar", 10)).toBe("hello w...")
  })

  test("collapses whitespace and trims", () => {
    expect(truncate("  hello   world  ", 20)).toBe("hello world")
  })
})

// ---------------------------------------------------------------------------
// numberToken
// ---------------------------------------------------------------------------

describe("numberToken", () => {
  test("returns the number for finite values", () => {
    expect(numberToken(100)).toBe(100)
    expect(numberToken(0)).toBe(0)
    expect(numberToken(1.5)).toBe(1.5)
  })

  test("returns 0 for non-number or infinite values", () => {
    expect(numberToken("abc")).toBe(0)
    expect(numberToken(undefined)).toBe(0)
    expect(numberToken(Infinity)).toBe(0)
    expect(numberToken(NaN)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// claudeTokens
// ---------------------------------------------------------------------------

describe("claudeTokens", () => {
  test("returns undefined for non-object", () => {
    expect(claudeTokens(null)).toBeUndefined()
    expect(claudeTokens("abc")).toBeUndefined()
  })

  test("parses usage object into ProgressTokens", () => {
    const result = claudeTokens({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 })
    expect(result).toEqual({ input: 100, output: 50, reasoning: 0, cacheRead: 10, cacheWrite: 5, total: 165 })
  })

  test("returns undefined when all tokens are 0", () => {
    expect(claudeTokens({ input_tokens: 0, output_tokens: 0 })).toBeUndefined()
  })

  test("handles partial usage data", () => {
    const result = claudeTokens({ input_tokens: 200 })
    expect(result).toEqual({ input: 200, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 200 })
  })
})

// ---------------------------------------------------------------------------
// describeClaudeEvent - the big one
// ---------------------------------------------------------------------------

describe("describeClaudeEvent", () => {
  test("returns empty array for non-object input", () => {
    expect(describeClaudeEvent(null, newClaudeStreamState())).toEqual([])
    expect(describeClaudeEvent(42, newClaudeStreamState())).toEqual([])
    expect(describeClaudeEvent("hello", newClaudeStreamState())).toEqual([])
  })

  test("handles system init event", () => {
    const signals = describeClaudeEvent({ type: "system", subtype: "init", session_id: "ses_123" }, newClaudeStreamState())
    expect(signals).toEqual([{ type: "session", sessionID: "ses_123" }])
  })

  test("handles text delta event", () => {
    const state = newClaudeStreamState()
    const event = { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }
    describeClaudeEvent(event, state) // content_block_start increments block
    const signals = describeClaudeEvent(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello world" } } },
      state,
    )
    expect(signals.length).toBe(2)
    expect(signals[0]).toMatchObject({ type: "message", message: { text: "Hello world" } })
    expect(signals[1]).toMatchObject({ type: "activity", kind: "write" })
  })

  test("handles thinking delta event", () => {
    const state = newClaudeStreamState()
    const event = { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } } }
    describeClaudeEvent(event, state) // content_block_start increments block
    const signals = describeClaudeEvent(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "I think..." } } },
      state,
    )
    expect(signals.length).toBe(2)
    expect(signals[0]).toMatchObject({ type: "message", message: { text: "I think..." } })
    expect(signals[1]).toMatchObject({ type: "activity", kind: "think" })
  })

  test("ignores unknown delta types", () => {
    const state = newClaudeStreamState()
    const event = { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } }
    describeClaudeEvent(event, state)
    const signals = describeClaudeEvent(
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "unknown_delta", value: "x" } } },
      state,
    )
    expect(signals).toEqual([])
  })

  test("handles assistant message with tool use blocks", () => {
    const signals = describeClaudeEvent({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Read", input: { file_path: "/tmp/test.js" } },
          { type: "tool_use", name: "Grep", input: { pattern: "TODO" } },
        ],
      },
    }, newClaudeStreamState())
    expect(signals.length).toBe(4)
    expect(signals[0]).toMatchObject({ type: "activity", message: "tool: Read /tmp/test.js" })
    expect(signals[2]).toMatchObject({ type: "activity", message: "tool: Grep TODO" })
  })

  test("handles result event with cost and tokens", () => {
    const signals = describeClaudeEvent({
      type: "result",
      subtype: "success",
      result: "Done!",
      total_cost_usd: 0.05,
      usage: { input_tokens: 100, output_tokens: 50 },
      is_error: false,
    }, newClaudeStreamState())
    expect(signals.length).toBe(1)
    expect(signals[0]).toMatchObject({
      type: "result",
      subtype: "success",
      text: "Done!",
      cost: 0.05,
      isError: false,
    })
  })

  test("marks result as error when subtype is not success", () => {
    const signals = describeClaudeEvent({ type: "result", subtype: "error", result: "failed", is_error: true }, newClaudeStreamState())
    expect(signals[0]).toMatchObject({ type: "result", subtype: "error", isError: true })
  })

  test("handles empty assistant message", () => {
    const signals = describeClaudeEvent({ type: "assistant", message: { content: null } }, newClaudeStreamState())
    expect(signals).toEqual([])
  })

  test("returns empty for unknown event types", () => {
    const signals = describeClaudeEvent({ type: "unknown" }, newClaudeStreamState())
    expect(signals).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// toolDetail
// ---------------------------------------------------------------------------

describe("toolDetail", () => {
  test("extracts file_path", () => {
    expect(toolDetail({ file_path: "/src/main.ts" })).toBe("/src/main.ts")
  })

  test("extracts pattern", () => {
    expect(toolDetail({ pattern: "function.*" })).toBe("function.*")
  })

  test("returns truncated JSON for unknown keys", () => {
    const result = toolDetail({ key1: "value1", key2: "value2" })
    expect(result).toContain("value1")
  })

  test("returns empty string for empty object", () => {
    expect(toolDetail({})).toBe("")
  })
})

// ---------------------------------------------------------------------------
// claudePrompt & claudeArgs & claudeReadableDirectories
// ---------------------------------------------------------------------------

describe("claudePrompt", () => {
  test("returns base prompt when there are no attachments", () => {
    expect(claudePrompt("Do the thing", [])).toBe("Do the thing")
  })

  test("appends attachment paths", () => {
    const attachments = [{ url: pathToFileURL("/tmp/test.js").href, mime: "text/javascript" }]
    const result = claudePrompt("Do the thing", attachments)
    expect(result).toContain("Do the thing")
    expect(result).toContain("## Attached files")
    expect(result).toContain("/tmp/test.js")
  })

  test("includes filename when it differs from path", () => {
    const attachments = [{ url: pathToFileURL("/tmp/abc").href, mime: "text/plain", filename: "readme.md" }]
    const result = claudePrompt("Do it", attachments)
    expect(result).toContain("/tmp/abc (readme.md)")
  })
})

describe("claudeReadableDirectories", () => {
  test("includes runDir and external directories", () => {
    const result = claudeReadableDirectories([], "/target", "/run")
    expect(result).toContain("/run")
  })

  test("includes external attachment directories", () => {
    const attachments = [{ url: pathToFileURL("/external").href, mime: "application/x-directory" }]
    const result = claudeReadableDirectories(attachments, "/target", "/run")
    expect(result).toContain("/run")
    expect(result).toContain("/external")
  })

  test("excludes directories within targetDir or runDir", () => {
    const attachments = [{ url: pathToFileURL("/run/subdir").href, mime: "application/x-directory" }]
    const result = claudeReadableDirectories(attachments, "/target", "/run")
    expect(result).toEqual(["/run"]) // only runDir, not /run/subdir
  })
})

describe("claudeArgs", () => {
  test("includes all required flags", () => {
    const args = claudeArgs({
      systemPromptPath: "/tmp/prompt.md",
      runDir: "/tmp/run",
      targetDir: "/target",
      model: "opus",
      attachments: [],
    })
    expect(args).toContain("-p")
    expect(args).toContain("--output-format")
    expect(args).toContain("stream-json")
    expect(args).toContain("--model")
    expect(args).toContain("opus")
    expect(args).toContain("--safe-mode")
  })
})

// ---------------------------------------------------------------------------
// baseAgentName
// ---------------------------------------------------------------------------

describe("baseAgentName", () => {
  test("strips __ro suffix", () => {
    expect(baseAgentName("auditor__ro")).toBe("auditor")
  })

  test("returns unchanged name without suffix", () => {
    expect(baseAgentName("auditor")).toBe("auditor")
  })
})

// ---------------------------------------------------------------------------
// claudeResumeArgs & claudeSessionDirectoriesPath
// ---------------------------------------------------------------------------

describe("claudeResumeArgs", () => {
  test("includes resume and add-dir flags", () => {
    const args = claudeResumeArgs("ses_123", ["/run", "/external"])
    expect(args).toContain("--resume")
    expect(args).toContain("ses_123")
    expect(args).toContain("--add-dir")
    expect(args).toContain("/run")
    expect(args).toContain("/external")
  })
})

describe("claudeSessionDirectoriesPath", () => {
  test("returns path in logs dir", () => {
    const path = claudeSessionDirectoriesPath("/run", "ses_123")
    expect(path).toBe("/run/logs/claude-ses_123-directories.json")
  })

  test("encodes special characters in session ID", () => {
    const path = claudeSessionDirectoriesPath("/run", "ses 123")
    expect(path).toContain("ses%20123")
  })
})

// ---------------------------------------------------------------------------
// isWithin (tested via claudeReadableDirectories)
// ---------------------------------------------------------------------------

describe("isWithin", () => {
  test("returns true for same path", () => {
    expect(isWithin("/run", "/run")).toBe(true)
  })

  test("returns true for subdirectory", () => {
    expect(isWithin("/run/sub", "/run")).toBe(true)
  })

  test("returns false for unrelated path", () => {
    expect(isWithin("/other", "/run")).toBe(false)
  })

  test("returns false for parent path", () => {
    expect(isWithin("/", "/run")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// attachmentPaths
// ---------------------------------------------------------------------------

describe("attachmentPaths", () => {
  test("converts file URLs to paths", () => {
    const result = attachmentPaths([{ url: pathToFileURL("/tmp/test.js").href, mime: "text/javascript" }])
    expect(result[0]?.path).toBe("/tmp/test.js")
    expect(result[0]?.isDirectory).toBe(false)
  })

  test("marks directories by mime type", () => {
    const result = attachmentPaths([{ url: pathToFileURL("/external").href, mime: "application/x-directory" }])
    expect(result[0]?.isDirectory).toBe(true)
  })

  test("includes filename when present", () => {
    const result = attachmentPaths([{ url: pathToFileURL("/tmp/abc").href, mime: "text/plain", filename: "readme.md" }])
    expect(result[0]?.filename).toBe("readme.md")
  })
})

// ---------------------------------------------------------------------------
// eventType & deltaOf
// ---------------------------------------------------------------------------

describe("eventType", () => {
  test("extracts type from event object", () => {
    expect(eventType({ type: "content_block_start" })).toBe("content_block_start")
  })

  test("returns empty string for non-object", () => {
    expect(eventType(null)).toBe("")
    expect(eventType(42)).toBe("")
  })
})

describe("deltaOf", () => {
  test("extracts delta from event", () => {
    expect(deltaOf({ delta: { type: "text_delta", text: "hello" } })).toEqual({ type: "text_delta", text: "hello" })
  })

  test("returns undefined for non-object event", () => {
    expect(deltaOf(null)).toBeUndefined()
  })

  test("returns undefined when delta is missing", () => {
    expect(deltaOf({})).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// toolUseBlocks
// ---------------------------------------------------------------------------

describe("toolUseBlocks", () => {
  test("parses tool use blocks from assistant message", () => {
    const blocks = toolUseBlocks({
      content: [
        { type: "tool_use", name: "Read", input: { file_path: "/test.js" } },
        { type: "tool_use", name: "Grep", input: { pattern: "TODO" } },
      ],
    })
    expect(blocks).toEqual([
      { name: "Read", detail: "/test.js" },
      { name: "Grep", detail: "TODO" },
    ])
  })

  test("returns empty array for non-object message", () => {
    expect(toolUseBlocks(null)).toEqual([])
  })

  test("returns empty array when content is not an array", () => {
    expect(toolUseBlocks({ content: "not-array" })).toEqual([])
  })

  test("skips non-tool_use blocks", () => {
    const blocks = toolUseBlocks({ content: [{ type: "text", text: "hello" }] })
    expect(blocks).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ndjsonLines - async generator for NDJSON stream parsing
// ---------------------------------------------------------------------------

describe("ndjsonLines", () => {
  test("yields parsed JSON lines from a stream", async () => {
    const { ndjsonLines } = await import("../src/claude-code")
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"init"}\n{"type":"delta","text":"hello"}\n'))
        controller.close()
      },
    })
    const lines: string[] = []
    for await (const line of ndjsonLines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual(['{"type":"init"}', '{"type":"delta","text":"hello"}'])
  })

  test("handles partial chunks across multiple enqueues", async () => {
    const { ndjsonLines } = await import("../src/claude-code")
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"init"}\n{"type'))
        controller.enqueue(encoder.encode('":"delta"}\n'))
        controller.close()
      },
    })
    const lines: string[] = []
    for await (const line of ndjsonLines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual(['{"type":"init"}', '{"type":"delta"}'])
  })

  test("handles empty stream", async () => {
    const { ndjsonLines } = await import("../src/claude-code")
    const stream = new ReadableStream<Uint8Array>({ start(ctrl) { ctrl.close() } })
    const lines: string[] = []
    for await (const line of ndjsonLines(stream)) {
      lines.push(line)
    }
    expect(lines).toEqual([])
  })
})