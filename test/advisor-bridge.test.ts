import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { advisorToolFileSource, handleAdvise, installAdvisorTool, startAdvisorBridge } from "../src/advisor-bridge"
import type { AdvisorPhaseHandle, AdvisorRuntime } from "../src/advisor-runtime"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-bridge-"))
  dirs.push(dir)
  return dir
}

const token = "test-token"

type StubHandle = AdvisorPhaseHandle & { consulted: { reason: string; question?: string }[] }

function stubRuntime(sessions: Record<string, string>): { runtime: AdvisorRuntime; handles: Map<string, StubHandle> } {
  const handles = new Map<string, StubHandle>()
  for (const [sessionID, advice] of Object.entries(sessions)) {
    const consulted: { reason: string; question?: string }[] = []
    handles.set(sessionID, {
      consulted,
      calls: 0,
      usage: [],
      consult: async (reason, question) => {
        consulted.push({ reason, ...(question ? { question } : {}) })
        return { text: advice, ok: true }
      },
      end: () => {},
    } as StubHandle)
  }
  return {
    runtime: {
      begin: () => undefined,
      handleFor: (sessionID) => handles.get(sessionID),
      checkpoint: async () => ({ action: "defer" }),
    },
    handles,
  }
}

const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
  new Request("http://127.0.0.1/advise", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

describe("advisor bridge endpoint", () => {
  test("consults the phase that owns the session and returns its advice", async () => {
    const { runtime, handles } = stubRuntime({ ses_1: "Read src/retry.ts first." })
    const response = await handleAdvise(post({ sessionID: "ses_1" }), runtime, token)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ advice: "Read src/retry.ts first." })
    expect(handles.get("ses_1")?.consulted).toEqual([{ reason: "on-demand" }])
  })

  test("forwards an optional question", async () => {
    const { runtime, handles } = stubRuntime({ ses_1: "Take the mutex first." })
    await handleAdvise(post({ sessionID: "ses_1", question: "which lock ordering?" }), runtime, token)

    expect(handles.get("ses_1")?.consulted).toEqual([{ reason: "on-demand", question: "which lock ordering?" }])
  })

  test("rejects a wrong or missing token", async () => {
    const { runtime } = stubRuntime({ ses_1: "advice" })

    expect((await handleAdvise(post({ sessionID: "ses_1" }, { authorization: "Bearer wrong" }), runtime, token)).status).toBe(401)
    expect((await handleAdvise(post({ sessionID: "ses_1" }, {}), runtime, token)).status).toBe(401)
  })

  test("rejects non-POST and malformed bodies", async () => {
    const { runtime } = stubRuntime({ ses_1: "advice" })
    const get = new Request("http://127.0.0.1/advise", { method: "GET", headers: { authorization: `Bearer ${token}` } })

    expect((await handleAdvise(get, runtime, token)).status).toBe(405)
    const bad = new Request("http://127.0.0.1/advise", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "not json" })
    expect((await handleAdvise(bad, runtime, token)).status).toBe(400)
    expect((await handleAdvise(post({}), runtime, token)).status).toBe(400)
  })

  test("answers an unknown session with degradation guidance rather than an error", async () => {
    const { runtime } = stubRuntime({})
    const response = await handleAdvise(post({ sessionID: "ses_unowned" }), runtime, token)

    // An agent can carry the tool because another step using it is advised;
    // failing the tool call there would be a worse experience than saying so.
    expect(response.status).toBe(200)
    expect((await response.json()).advice).toContain("Continue on your own judgement")
  })

  test("degrades the same way before the runtime exists", async () => {
    const response = await handleAdvise(post({ sessionID: "ses_1" }), () => undefined, token)

    expect(response.status).toBe(200)
    expect((await response.json()).advice).toContain("Continue on your own judgement")
  })
})

describe("advisor bridge server", () => {
  test("serves a live loopback endpoint that resolves the runtime per request", async () => {
    let runtime: AdvisorRuntime | undefined
    const bridge = await startAdvisorBridge({ advisors: () => runtime })
    try {
      // Before the runtime is wired up, the endpoint still answers.
      const early = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ sessionID: "ses_1" }),
      })
      expect((await early.json()).advice).toContain("Continue on your own judgement")

      runtime = stubRuntime({ ses_1: "Now there is advice." }).runtime
      const later = await fetch(bridge.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${bridge.token}` },
        body: JSON.stringify({ sessionID: "ses_1" }),
      })
      expect((await later.json()).advice).toBe("Now there is advice.")
    } finally {
      bridge.close()
    }
  })

  test("mints a distinct token per bridge", async () => {
    const first = await startAdvisorBridge({ advisors: () => undefined })
    const second = await startAdvisorBridge({ advisors: () => undefined })
    try {
      expect(first.token).not.toBe(second.token)
      expect(first.url).not.toBe(second.url)
    } finally {
      first.close()
      second.close()
    }
  })
})

describe("advisor tool file", () => {
  test("is written with restrictive permissions and no imports, so it survives a failed dep install", async () => {
    const dir = await scratch()
    const path = await installAdvisorTool(dir)

    const source = await readFile(path, "utf8")
    expect(path).toBe(join(dir, "tools", "advisor.ts"))
    expect(source).not.toContain("import ")
    expect(source).toContain("args: {}")
    expect(source).toContain("context?.sessionID")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  test("is valid JavaScript that returns the bridge's advice", async () => {
    const dir = await scratch()
    // Rewritten as .mjs so it can be imported directly; the source is identical.
    const modulePath = join(dir, "advisor.mjs")
    await writeFile(modulePath, advisorToolFileSource)
    const tool = (await import(modulePath)).default

    expect(tool.args).toEqual({})
    expect(tool.description).toContain("Takes no parameters")

    // No bridge configured: says so instead of throwing.
    delete process.env.CONVOY_ADVISOR_URL
    delete process.env.CONVOY_ADVISOR_TOKEN
    expect(await tool.execute({}, { sessionID: "ses_1" })).toContain("no advisor configured")

    // Against a real bridge, it returns the advice verbatim.
    const bridge = await startAdvisorBridge({ advisors: () => stubRuntime({ ses_1: "Read the migration first." }).runtime })
    try {
      process.env.CONVOY_ADVISOR_URL = bridge.url
      process.env.CONVOY_ADVISOR_TOKEN = bridge.token
      expect(await tool.execute({}, { sessionID: "ses_1" })).toBe("Read the migration first.")

      // A rejected token degrades rather than throwing into the agent loop.
      process.env.CONVOY_ADVISOR_TOKEN = "wrong"
      expect(await tool.execute({}, { sessionID: "ses_1" })).toContain("advisor bridge returned 401")
    } finally {
      bridge.close()
      delete process.env.CONVOY_ADVISOR_URL
      delete process.env.CONVOY_ADVISOR_TOKEN
    }
  })

  test("rewrites only when the content changed, so OpenCode's watcher isn't churned", async () => {
    const dir = await scratch()
    const path = await installAdvisorTool(dir)
    const first = (await stat(path)).mtimeMs

    await new Promise((resolve) => setTimeout(resolve, 20))
    await installAdvisorTool(dir)
    expect((await stat(path)).mtimeMs).toBe(first)

    await writeFile(path, "// stale shim from an older Convoy\n")
    await installAdvisorTool(dir)
    expect(await readFile(path, "utf8")).toBe(advisorToolFileSource)
  })
})
