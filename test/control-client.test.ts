import { afterAll, describe, expect, test } from "bun:test"

import { createControlClient } from "../src/control-client"
import { ControlPendingQueue, startControlServer, type ControlServer } from "../src/control-server"
import type { PermissionPromptInfo } from "../src/progress"

const permissionInfo: PermissionPromptInfo = {
  id: "perm-1",
  permission: "bash",
  patterns: ["bash"],
  command: "ls -la",
  sessionID: "sess-1",
}

const servers: ControlServer[] = []
afterAll(async () => {
  for (const server of servers) server.close()
})

async function server(): Promise<ControlServer> {
  const s = await startControlServer()
  servers.push(s)
  return s
}

describe("control client", () => {
  test("sends the Bearer token on every request", async () => {
    const s = await server()
    // The server returns 401 for anything but the exact token, so a client
    // that stops sending it fails immediately instead of missing a handler.
    const client = createControlClient({ url: s.url, token: s.token })
    expect(await client.claimController()).toBe("controller")
    await client.pause()
    await client.abort()
    await client.keepAwake()
    await expect(client.pending()).resolves.toEqual({})
  })

  test("maps a 409 controller claim to the observer fallback", async () => {
    const s = await server()
    const first = createControlClient({ url: s.url, token: s.token })
    const second = createControlClient({ url: s.url, token: s.token })

    expect(await first.claimController()).toBe("controller")
    expect(await second.claimController()).toBe("observer")

    // Releasing the slot lets the fallback take control on its next claim.
    await first.bye()
    expect(await second.claimController()).toBe("controller")
  })

  test("resolves a pending permission gate through the POST endpoint", async () => {
    const s = await server()
    const client = createControlClient({ url: s.url, token: s.token })
    expect(await client.claimController()).toBe("controller")
    const wait = s.pending.holdPermission({ ...permissionInfo })
    await client.permission("perm-1", "always")
    expect(await wait).toBe("always")
  })

  test("resolves a pending human gate through the POST endpoint", async () => {
    const s = await server()
    const client = createControlClient({ url: s.url, token: s.token })
    expect(await client.claimController()).toBe("controller")
    const wait = s.pending.holdHuman({ stepName: "review", iterations: 0, kind: "failure", canRetry: true })
    const id = (await client.pending()).human?.requestId
    expect(id).toBeTruthy()
    await client.human(id!, "retry")
    expect(await wait).toBe("retry")
  })

  test("dismisses the finish hold through the POST endpoint", async () => {
    const s = await server()
    const client = createControlClient({ url: s.url, token: s.token })
    expect(await client.claimController()).toBe("controller")
    const wait = s.pending.holdFinish({ status: "completed" })
    await client.finishDismiss()
    await expect(wait).resolves.toBeUndefined()
  })

  test("empty auto-accept cycles and an explicit mode sets", async () => {
    const s = await server()
    const client = createControlClient({ url: s.url, token: s.token })
    expect(await client.claimController()).toBe("controller")
    // No shared object configured: the server still answers and reports mode.
    await client.autoAccept()
    await client.autoAccept("off")
    const client2 = createControlClient({ url: s.url, token: "wrong" })
    await expect(client2.autoAccept()).rejects.toThrow(/control request failed: 401/)
  })
})
