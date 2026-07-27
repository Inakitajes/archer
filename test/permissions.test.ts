import { describe, expect, test } from "bun:test"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import { startPermissionGate, type AdvisorCheckpoint } from "../src/permissions"
import { noopProgress, type AutoAcceptMode, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "../src/progress"

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
