import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"

import { advisorFallbackText, advisorFeedbackToolName, advisorToolName } from "./advisor"
import type { AdvisorFeedbackOutcome } from "./advisor-events"
import type { AdvisorRuntime } from "./advisor-runtime"
import { log } from "./log"
import { opencodeConfigDir } from "./workspace"

/**
 * Lets the executor consult its advisor on demand, which is what makes the
 * escalation happen on difficulty rather than on a fixed phase.
 *
 * The custom tool runs inside the OpenCode server process, so it cannot call
 * into Convoy directly. It posts to this loopback endpoint instead, keeping all
 * of the policy — which advising model, what budget is left, how usage is
 * tallied — in Convoy where it is testable, and leaving the tool file a shim
 * thin enough to be version-stable.
 *
 * The tool receives `context.sessionID`, so the phase is identified exactly
 * rather than correlated by timing.
 */

export const advisorUrlEnv = "CONVOY_ADVISOR_URL"
export const advisorTokenEnv = "CONVOY_ADVISOR_TOKEN"

export type AdvisorBridge = {
  url: string
  token: string
  close(): void
}

export type StartAdvisorBridgeOptions = {
  /**
   * Resolved per request, not captured. The bridge must be listening before the
   * OpenCode server spawns — the SDK hands it Convoy's environment at spawn
   * time, so the URL and token have to already be there — while the runtime
   * needs that server's client. Deferring the lookup breaks the cycle.
   */
  advisors: () => AdvisorRuntime | undefined
  /** Injected in tests. */
  hostname?: string
}

export async function startAdvisorBridge(options: StartAdvisorBridgeOptions): Promise<AdvisorBridge> {
  const token = crypto.randomUUID()
  const hostname = options.hostname ?? "127.0.0.1"
  const port = await freePort(hostname)

  const server = Bun.serve({
    hostname,
    port,
    // No timeout ceiling here: a consultation over a long transcript can take
    // a while, and the executor is blocked on the tool call meanwhile.
    idleTimeout: 0,
    fetch: async (request) => requestUrlPath(request) === "/feedback"
      ? handleFeedback(request, options.advisors, token)
      : handleAdvise(request, options.advisors, token),
  })

  const url = `http://${hostname}:${server.port}/advise`
  log.info(`[advisor] on-demand bridge listening at ${url}`)
  return { url, token, close: () => server.stop(true) }
}

export async function handleAdvise(request: Request, advisors: (() => AdvisorRuntime | undefined) | AdvisorRuntime, token: string): Promise<Response> {
  const runtime = typeof advisors === "function" ? advisors() : advisors
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 })

  let body: { sessionID?: unknown; question?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return new Response("invalid json", { status: 400 })
  }

  const sessionID = typeof body.sessionID === "string" ? body.sessionID : ""
  if (!sessionID) return new Response("sessionID required", { status: 400 })

  const handle = runtime?.handleFor(sessionID)
  // Not an error: an agent can carry the tool because *another* step using it is
  // advised. Answering plainly beats failing the tool call.
  if (!handle) {
    return advice(advisorFallbackText({ kind: "error", code: "unavailable", message: "no advisor configured for this phase" }))
  }

  const question = typeof body.question === "string" && body.question.trim() ? body.question.trim() : undefined
  const result = await handle.consult("on-demand", question)
  if (result.ok) await handle.delivered?.(result.callId, "tool")
  return advice(result.text)
}

export async function handleFeedback(request: Request, advisors: (() => AdvisorRuntime | undefined) | AdvisorRuntime, token: string): Promise<Response> {
  const runtime = typeof advisors === "function" ? advisors() : advisors
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 })
  if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 })
  let body: { sessionID?: unknown; callId?: unknown; outcome?: unknown; note?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return new Response("invalid json", { status: 400 })
  }
  const sessionID = typeof body.sessionID === "string" ? body.sessionID : ""
  if (!sessionID) return new Response("sessionID required", { status: 400 })
  const outcomes: AdvisorFeedbackOutcome[] = ["adopted", "partially-adopted", "rejected"]
  if (!outcomes.includes(body.outcome as AdvisorFeedbackOutcome)) return new Response("invalid outcome", { status: 400 })
  const handle = runtime?.handleFor(sessionID)
  if (!handle) return Response.json({ recorded: false, message: "No advisor consultation belongs to this session." })
  const callId = typeof body.callId === "string" && body.callId ? body.callId : undefined
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2_000) : undefined
  const recorded = await handle.feedback(callId, body.outcome as AdvisorFeedbackOutcome, note)
  return Response.json({ recorded, message: recorded ? "Advisor feedback recorded." : "No matching completed advisor call." })
}

function requestUrlPath(request: Request): string {
  try {
    return new URL(request.url).pathname
  } catch {
    return "/advise"
  }
}

function advice(text: string): Response {
  return Response.json({ advice: text })
}

async function freePort(hostname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, hostname, () => {
      const address = probe.address()
      if (!address || typeof address === "string") {
        probe.close()
        reject(new Error("couldn't find a free port for the advisor bridge"))
        return
      }
      const port = address.port
      probe.close(() => resolve(port))
    })
  })
}

/**
 * The custom tool OpenCode loads from Convoy's config directory.
 *
 * Deliberately importless. OpenCode installs `@opencode-ai/plugin` into every
 * config directory it loads, and the documented form imports its `tool()`
 * helper — but a plain object export works just as well (verified against
 * 1.18.5) and keeps the tool functional when that background install fails, on
 * a machine with no network for instance.
 *
 * `args: {}` mirrors the reference pattern: there is nothing to pass, because
 * the advisor reads the transcript rather than a briefing.
 */
const advisorToolSource = `// Generated by Convoy. Do not edit: it is rewritten on every run.
export default {
  description: [
    "Get guidance from a stronger reviewing model that has read your entire transcript.",
    "Takes no parameters. The advisor has no tools and never touches the repository;",
    "it returns a short plan, a correction, or a stop signal.",
    "",
    "Call it before substantive work (before writing, before committing to an",
    "interpretation), when you believe the task is complete, and when you are stuck.",
    "Orienting yourself first - locating and reading files - is not substantive work.",
  ].join("\\n"),
  args: {},
  async execute(_args, context) {
    const url = process.env.${advisorUrlEnv}
    const token = process.env.${advisorTokenEnv}
    if (!url || !token) return "No advice available: this session has no advisor configured. Continue on your own judgement."
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ sessionID: context?.sessionID }),
        signal: context?.abort,
      })
      if (!response.ok) return "No advice available (advisor bridge returned " + response.status + "). Continue on your own judgement."
      const body = await response.json()
      return typeof body?.advice === "string" && body.advice ? body.advice : "No advice available. Continue on your own judgement."
    } catch (error) {
      return "No advice available (" + (error instanceof Error ? error.message : String(error)) + "). Continue on your own judgement."
    }
  },
}
`

const advisorFeedbackToolSource = `// Generated by Convoy. Do not edit: it is rewritten on every run.
import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Record whether you adopted the latest advisor guidance. outcome must be adopted, partially-adopted, or rejected; note is optional and brief.",
  args: {
    outcome: tool.schema.enum(["adopted", "partially-adopted", "rejected"]),
    note: tool.schema.string().optional(),
    callId: tool.schema.string().optional(),
  },
  async execute(args, context) {
    const base = process.env.${advisorUrlEnv}
    const token = process.env.${advisorTokenEnv}
    if (!base || !token) return "Advisor feedback unavailable for this session."
    try {
      const url = new URL(base)
      url.pathname = "/feedback"
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + token },
        body: JSON.stringify({ sessionID: context?.sessionID, outcome: args?.outcome, note: args?.note, callId: args?.callId }),
        signal: context?.abort,
      })
      if (!response.ok) return "Advisor feedback was not recorded (bridge returned " + response.status + ")."
      const body = await response.json()
      return typeof body?.message === "string" ? body.message : "Advisor feedback recorded."
    } catch (error) {
      return "Advisor feedback was not recorded (" + (error instanceof Error ? error.message : String(error)) + ")."
    }
  },
})
`

/**
 * Materializes the tool into Convoy's OpenCode config directory, rewriting it
 * each run so an upgraded Convoy never runs against a stale shim.
 */
export async function installAdvisorTool(dir = opencodeConfigDir()): Promise<string> {
  const toolsDir = join(dir, "tools")
  await mkdir(toolsDir, { recursive: true, mode: 0o700 })
  // OpenCode names a custom tool after its file, so this is the same constant
  // the agent config and the advisor's own tool blocklist are built from.
  const path = join(toolsDir, `${advisorToolName}.ts`)
  // Rewrite only on change: OpenCode watches these directories, and a touched
  // file on every run would churn its tool registry for nothing.
  const existing = await readFile(path, "utf8").catch(() => undefined)
  if (existing !== advisorToolSource) await writeFile(path, advisorToolSource, { mode: 0o600 })
  const feedbackPath = join(toolsDir, `${advisorFeedbackToolName}.ts`)
  const existingFeedback = await readFile(feedbackPath, "utf8").catch(() => undefined)
  if (existingFeedback !== advisorFeedbackToolSource) await writeFile(feedbackPath, advisorFeedbackToolSource, { mode: 0o600 })
  return path
}

/** Exposed for the test that asserts the shim stays syntactically valid. */
export const advisorToolFileSource = advisorToolSource
export const advisorFeedbackToolFileSource = advisorFeedbackToolSource
