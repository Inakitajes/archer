import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { CONTROLLER_ID_HEADER, type ControlRole, type PendingSnapshot } from "./control-server"
import { runsRoot } from "./workspace"
import type { AutoAcceptMode, HumanReviewAction, PermissionReply, RunControlState } from "./progress"

export type ControlFile = { url: string; token: string; pid: number }

/**
 * Reads `~/.convoy/runs/<id>/control.json` — the only place the control token
 * lives. Loopback-only: this file decides where the bearer token gets sent, so
 * a tampered entry must never redirect the client (and its token) off-host.
 */
export async function readControlFile(runID: string, root = runsRoot()): Promise<ControlFile | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(root, runID, "control.json"), "utf8")) as Partial<ControlFile>
    if (parsed && typeof parsed.url === "string" && parsed.url.startsWith("http://127.0.0.1:") && typeof parsed.token === "string") {
      return parsed as ControlFile
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * The attach-side fetch client for the run control server. Every request
 * carries the Bearer token from `~/.convoy/runs/<id>/control.json` (slice 2+),
 * so the token never travels in metadata or the process argv. Once this client
 * holds the controller slot, every request also echoes its per-claim
 * controller id: that header is the heartbeat that keeps the slot alive and
 * the credential that lets only this client release it with /bye.
 */

export type ControlClientOptions = {
  url: string
  token: string
  /** Injectable fetch for tests without a live server. */
  fetchImpl?: typeof fetch
}

export type ControlClient = {
  /** Claims the controller slot; resolves "controller" or falls back to "observer" on 409. */
  claimController(): Promise<ControlRole>
  /** Releases the controller slot on detach/background; refuses (409) unless this client holds it. */
  bye(): Promise<void>
  pending(): Promise<PendingSnapshot>
  status(): Promise<ControlClientStatus>
  pause(): Promise<void>
  resume(): Promise<void>
  abort(): Promise<void>
  keepAwake(): Promise<void>
  setInteractive(phase: string, armed: boolean): Promise<void>
  finishDismiss(): Promise<void>
  /** Empty body cycles the shared AutoAccept; a mode sets it directly. */
  autoAccept(mode?: AutoAcceptMode): Promise<void>
  permission(requestId: string, reply: PermissionReply): Promise<void>
  human(action: HumanReviewAction): Promise<void>
}

export type ControlClientStatus = {
  ok: boolean
  runID?: string
  controlState?: RunControlState
  keepAwake?: "on" | "off" | "unavailable"
  autoAccept?: AutoAcceptMode
  controller: boolean
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  const fetchImpl = options.fetchImpl ?? fetch
  // Set when this client wins the controller slot; observers never have it.
  let controllerId: string | undefined

  const jsonHeaders = () => ({
    "content-type": "application/json",
    authorization: `Bearer ${options.token}`,
    ...(controllerId ? { [CONTROLLER_ID_HEADER]: controllerId } : {}),
  })

  const post = (path: string, body?: unknown): Promise<Response> => {
    return fetchImpl(`${options.url}${path}`, {
      method: "POST",
      headers: jsonHeaders(),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  const get = (path: string): Promise<Response> => {
    return fetchImpl(`${options.url}${path}`, { method: "GET", headers: jsonHeaders() })
  }

  const ok = (response: Response) => {
    if (!response.ok) throw new Error(`control request failed: ${response.status}`)
    return response
  }

  return {
    async claimController() {
      const response = await post("/hello", { role: "controller" })
      if (response.status === 409) return "observer"
      const body = (await ok(response).json()) as { role: ControlRole; controllerId?: string }
      if (body.role === "controller" && typeof body.controllerId === "string") controllerId = body.controllerId
      return body.role
    },
    async bye() {
      await ok(await post("/bye", controllerId ? { controllerId } : {}))
    },
    async pending() {
      const response = await get("/pending")
      ok(response)
      return (await response.json()) as PendingSnapshot
    },
    async status() {
      const response = await get("/status")
      ok(response)
      return (await response.json()) as ControlClientStatus
    },
    async pause() {
      ok(await post("/pause"))
    },
    async resume() {
      ok(await post("/resume"))
    },
    async abort() {
      ok(await post("/abort"))
    },
    async keepAwake() {
      ok(await post("/keep-awake"))
    },
    async setInteractive(phase: string, armed: boolean) {
      ok(await post("/interactive", { phase, armed }))
    },
    async finishDismiss() {
      ok(await post("/finish-dismiss"))
    },
    async autoAccept(mode?: AutoAcceptMode) {
      ok(await post("/auto-accept", mode === undefined ? {} : { mode }))
    },
    async permission(requestId: string, reply: PermissionReply) {
      ok(await post("/permission", { id: requestId, reply }))
    },
    async human(action: HumanReviewAction) {
      ok(await post("/human", { action }))
    },
  }
}
