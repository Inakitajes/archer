import { describe, expect, test } from "bun:test"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import { askHumanAction } from "../src/human"
import { startPermissionGate, type AdvisorCheckpoint } from "../src/permissions"
import { noopProgress, type AutoAcceptMode, type HumanReviewAction, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "../src/progress"
import type { TerminalInput, TerminalPrompt } from "../src/terminal-input"

type ReplyCall = { reply: PermissionReply; message?: string }

type GateHarness = {
  client: OpencodeClient
  progress: ProgressUI
  replies: ReplyCall[]
  asked: PermissionPromptInfo[]
}

const askedRequest = {
  id: "perm-1",
  sessionID: "sess-1",
  permission: "bash",
  patterns: ["bash"],
  metadata: { command: "ls -la" },
  always: [],
}

/**
 * Stands up a fake opencode client: one permission.asked event on the stream,
 * a judge whose answer the test fixes, and recorders for permission.reply.
 */
function harness(opts: { judgeAnswer?: string; askReply?: PermissionReply; permission?: string }): GateHarness {
  const replies: ReplyCall[] = []
  const asked: PermissionPromptInfo[] = []
  let delivered = false
  const request = { ...askedRequest, ...(opts.permission ? { permission: opts.permission, patterns: [opts.permission] } : {}) }

  const client = {
    event: {
      subscribe: async () => ({
        stream: (async function* () {
          if (!delivered) {
            delivered = true
            yield { type: "permission.asked", properties: request }
          }
        })(),
      }),
    },
    permission: {
      reply: async ({ reply, message }: { reply: PermissionReply; message?: string }) => {
        replies.push({ reply, ...(message ? { message } : {}) })
        return { data: undefined, error: undefined }
      },
    },
    session: {
      create: async () => ({ data: { id: "judge-session" }, error: undefined }),
      prompt: async () => ({ data: { info: {}, parts: [{ type: "text", text: opts.judgeAnswer ?? "" }] }, error: undefined }),
      delete: async () => ({ data: undefined, error: undefined }),
    },
  } as unknown as OpencodeClient

  const progress: ProgressUI = {
    ...noopProgress,
    askPermission: async (info) => {
      asked.push(info)
      return opts.askReply ?? "reject"
    },
  }

  return { client, progress, replies, asked }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for gate")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function drive(opts: {
  mode: AutoAcceptMode
  judgeAnswer?: string
  askReply?: PermissionReply
  permission?: string
  advisorCheckpoint?: AdvisorCheckpoint
}): Promise<{ replies: ReplyCall[]; asked: PermissionPromptInfo[] }> {
  const h = harness({ judgeAnswer: opts.judgeAnswer, askReply: opts.askReply, permission: opts.permission })
  const gate = startPermissionGate({
    client: h.client,
    progress: h.progress,
    interactive: true,
    directory: "/tmp",
    autoAccept: { mode: opts.mode },
    judgeModel: { providerID: "openai", modelID: "gpt-5.5" },
    ...(opts.advisorCheckpoint ? { advisorCheckpoint: opts.advisorCheckpoint } : {}),
  })
  try {
    await waitFor(() => h.replies.length > 0)
  } finally {
    await gate.stop()
  }
  return { replies: h.replies, asked: h.asked }
}

describe("permission gate auto-accept modes", () => {
  test("mode 'all' allows once without prompting", async () => {
    const { replies, asked } = await drive({ mode: "all" })
    expect(replies).toEqual([{ reply: "once" }])
    expect(asked).toHaveLength(0)
  })

  test("mode 'off' always prompts the user", async () => {
    const { replies, asked } = await drive({ mode: "off", askReply: "always" })
    expect(asked).toHaveLength(1)
    expect(replies).toEqual([{ reply: "always" }])
  })

  test("smart mode auto-allows a safe verdict", async () => {
    const { replies, asked } = await drive({ mode: "smart", judgeAnswer: '{"safe": true, "reason": "lists files"}' })
    expect(replies).toEqual([{ reply: "once" }])
    expect(asked).toHaveLength(0)
  })

  test("smart mode escalates an unsafe verdict to the user with the reason", async () => {
    const { replies, asked } = await drive({
      mode: "smart",
      judgeAnswer: '{"safe": false, "reason": "deletes files"}',
      askReply: "reject",
    })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.judgeReason).toContain("deletes files")
    expect(replies).toEqual([{ reply: "reject", message: "rejected by user" }])
  })

  test("smart mode fails closed and escalates when the judge errors", async () => {
    const { asked } = await drive({ mode: "smart", judgeAnswer: "not json", askReply: "reject" })
    expect(asked).toHaveLength(1)
    expect(asked[0]?.judgeReason).toBeDefined()
  })
})

describe("permission gate advisor checkpoint", () => {
  const checkpoint = (decisions: Awaited<ReturnType<AdvisorCheckpoint>>[]) => {
    const seen: { sessionID: string; permission: string }[] = []
    const queue = [...decisions]
    const fn: AdvisorCheckpoint = async ({ sessionID, permission }) => {
      seen.push({ sessionID, permission })
      return queue.shift() ?? { action: "defer" }
    }
    return { fn, seen }
  }

  test("an 'advise' decision rejects the edit carrying the advice", async () => {
    const { fn, seen } = checkpoint([{ action: "advise", message: "Use the existing retry helper." }])
    const { replies, asked } = await drive({ mode: "off", permission: "edit", advisorCheckpoint: fn })

    expect(replies).toEqual([{ reply: "reject", message: "Use the existing retry helper." }])
    // Held by Convoy, not escalated: the human is never involved.
    expect(asked).toHaveLength(0)
    expect(seen).toEqual([{ sessionID: "sess-1", permission: "edit" }])
  })

  test("an 'allow' decision permits the edit without ever prompting a human", async () => {
    const { fn } = checkpoint([{ action: "allow" }])
    const { replies, asked } = await drive({ mode: "off", permission: "edit", advisorCheckpoint: fn })

    expect(replies).toEqual([{ reply: "once" }])
    expect(asked).toHaveLength(0)
  })

  test("a 'defer' decision falls through to normal handling", async () => {
    const { fn } = checkpoint([{ action: "defer" }])
    const { replies, asked } = await drive({ mode: "off", permission: "edit", askReply: "always", advisorCheckpoint: fn })

    expect(asked).toHaveLength(1)
    expect(replies).toEqual([{ reply: "always" }])
  })

  test("runs ahead of --yolo, so auto-accept cannot skip the structural checkpoint", async () => {
    const { fn, seen } = checkpoint([{ action: "advise", message: "Check the migration order first." }])
    const { replies } = await drive({ mode: "all", permission: "edit", advisorCheckpoint: fn })

    expect(seen).toHaveLength(1)
    expect(replies).toEqual([{ reply: "reject", message: "Check the migration order first." }])
  })

  test("is not consulted for anything but edits, so a git status never spends the checkpoint", async () => {
    const { fn, seen } = checkpoint([{ action: "advise", message: "should never be used" }])
    const { replies } = await drive({ mode: "all", permission: "bash", advisorCheckpoint: fn })

    expect(seen).toHaveLength(0)
    expect(replies).toEqual([{ reply: "once" }])
  })
})

/**
 * A stream the test pushes events into on demand, so a single gate can see
 * requests from several sessions (a failed member plus its live siblings).
 */
function pushableStream() {
  const queue: unknown[] = []
  const waiters: Array<(value: IteratorResult<unknown>) => void> = []
  const push = (event: unknown) => {
    const waiter = waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else queue.push(event)
  }
  const stream = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          return new Promise((resolve) => waiters.push(resolve))
        },
        return: async () => ({ value: undefined, done: true as const }),
      }
    },
  }
  return { stream, push }
}

function permAsked(id: string, sessionID: string, command = "ls -la") {
  return { type: "permission.asked", properties: { id, sessionID, permission: "bash", patterns: ["bash"], metadata: { command }, always: [] } }
}

/** A gate backed by a pushable stream and a recorder keyed by request id. */
function multiHarness() {
  const { stream, push } = pushableStream()
  const replies = new Map<string, PermissionReply>()
  const client = {
    event: { subscribe: async () => ({ stream }) },
    permission: {
      reply: async ({ requestID, reply }: { requestID: string; reply: PermissionReply }) => {
        replies.set(requestID, reply)
        return { data: undefined, error: undefined }
      },
    },
    session: {
      create: async () => ({ data: { id: "judge-session" }, error: undefined }),
      prompt: async () => ({ data: { info: {}, parts: [] }, error: undefined }),
      delete: async () => ({ data: undefined, error: undefined }),
    },
  } as unknown as OpencodeClient
  return { client, replies, push }
}

/** A terminal-input arbiter whose `ask` blocks until the test answers it. */
function controllableTerminalInput() {
  const order: string[] = []
  let current: ((answer: string) => void) | undefined
  let tail: Promise<void> = Promise.resolve()
  const input: TerminalInput = {
    withInput(fn) {
      const run = async () => {
        order.push("start")
        const prompt: TerminalPrompt = { ask: () => new Promise<string>((resolve) => (current = resolve)) }
        try {
          return await fn(prompt)
        } finally {
          order.push("end")
        }
      }
      const result = tail.then(run, run)
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
  const answer = (value: string) => {
    const resolve = current
    current = undefined
    resolve?.(value)
  }
  return { input, order, answer }
}

describe("permission gate session-scoped pause", () => {
  test("a paused session's prompts are left for the interactive owner while live siblings keep being handled", async () => {
    const { client, replies, push } = multiHarness()
    const gate = startPermissionGate({
      client,
      progress: noopProgress,
      interactive: true,
      directory: "/tmp",
      autoAccept: { mode: "all" },
    })

    // The failed member's interactive session is paused; its prompts belong to
    // the OpenCode TUI the user opened with [o].
    gate.pause("sess-A")
    push(permAsked("pA", "sess-A"))
    push(permAsked("pB", "sess-B"))

    // The live sibling is auto-allowed; the paused member is never replied to.
    await waitFor(() => replies.has("pB"))
    expect(replies.get("pB")).toBe("once")
    expect(replies.has("pA")).toBe(false)

    await gate.stop()
  })

  test("resuming a session lets its later prompts be handled again", async () => {
    const { client, replies, push } = multiHarness()
    const gate = startPermissionGate({ client, progress: noopProgress, interactive: true, directory: "/tmp", autoAccept: { mode: "all" } })

    gate.pause("sess-A")
    push(permAsked("pA1", "sess-A"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(replies.has("pA1")).toBe(false)

    gate.resume("sess-A")
    push(permAsked("pA2", "sess-A"))
    await waitFor(() => replies.has("pA2"))
    expect(replies.get("pA2")).toBe("once")

    await gate.stop()
  })

  test("pausing without a session leaves every session for an interactive owner (solo human gate)", async () => {
    const { client, replies, push } = multiHarness()
    const gate = startPermissionGate({ client, progress: noopProgress, interactive: true, directory: "/tmp", autoAccept: { mode: "all" } })

    gate.pause()
    push(permAsked("pA", "sess-A"))
    push(permAsked("pB", "sess-B"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Both dropped while paused — the interactive OpenCode owns the terminal.
    expect(replies.size).toBe(0)

    gate.resume()
    push(permAsked("pC", "sess-C"))
    push(permAsked("pD", "sess-D"))
    await waitFor(() => replies.has("pC") && replies.has("pD"))
    expect(replies.get("pC")).toBe("once")
    expect(replies.get("pD")).toBe("once")

    await gate.stop()
  })

  test("two paused sessions resume independently so neither outlives the other", async () => {
    const { client, replies, push } = multiHarness()
    const gate = startPermissionGate({ client, progress: noopProgress, interactive: true, directory: "/tmp", autoAccept: { mode: "all" } })

    gate.pause("sess-A")
    gate.pause("sess-B")
    push(permAsked("pA", "sess-A"))
    push(permAsked("pB", "sess-B"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(replies.size).toBe(0)

    // Resuming only A must not unlock B's prompts too.
    gate.resume("sess-A")
    push(permAsked("pA2", "sess-A"))
    await waitFor(() => replies.has("pA2"))
    expect(replies.get("pA2")).toBe("once")
    push(permAsked("pB2", "sess-B"))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(replies.has("pB2")).toBe(false)

    gate.resume("sess-B")
    push(permAsked("pB3", "sess-B"))
    await waitFor(() => replies.has("pB3"))
    expect(replies.get("pB3")).toBe("once")

    await gate.stop()
  })
})

describe("permission gate terminal-input arbiter", () => {
  test("the readline fallback routes through the shared arbiter instead of opening its own readline", async () => {
    const { client, replies, push } = multiHarness()
    let withInputCalls = 0
    const input: TerminalInput = {
      async withInput(fn) {
        withInputCalls++
        // Canned "once" answer, no real readline.
        return fn({ ask: async () => "o" })
      },
    }

    const gate = startPermissionGate({
      client,
      progress: noopProgress,
      interactive: true,
      directory: "/tmp",
      autoAccept: { mode: "off" },
      terminalInput: input,
    })
    push(permAsked("p1", "sess-1"))

    await waitFor(() => replies.has("p1"))
    expect(replies.get("p1")).toBe("once")
    expect(withInputCalls).toBe(1)

    await gate.stop()
  })

  test("a failed member's gate and a live sibling's permission prompt serialize on the shared arbiter", async () => {
    const { input, order, answer } = controllableTerminalInput()
    const { client, replies, push } = multiHarness()
    const gate = startPermissionGate({
      client,
      progress: noopProgress,
      interactive: true,
      directory: "/tmp",
      autoAccept: { mode: "off" },
      terminalInput: input,
    })

    // A live sibling in the same parallel batch raises a permission prompt; it
    // takes the shared arbiter first and holds it waiting for input.
    push(permAsked("pSib", "sess-sibling"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(["start"])

    // The failed member's phase gate asks for a decision through the SAME
    // arbiter; it must queue behind the permission prompt, not race for stdin.
    let gateAction: HumanReviewAction | undefined
    const gateDone = askHumanAction({ prompt: "decide > ", allowed: ["continue", "iterate", "abort"], terminalInput: input }).then((action) => {
      gateAction = action
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(["start"])

    // Answering the permission prompt releases the arbiter to the phase gate.
    answer("o")
    await waitFor(() => replies.has("pSib"))
    expect(replies.get("pSib")).toBe("once")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(order).toEqual(["start", "end", "start"])

    answer("c")
    await gateDone
    expect(gateAction).toBe("continue")
    expect(order).toEqual(["start", "end", "start", "end"])

    await gate.stop()
  })
})
