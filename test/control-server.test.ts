import { describe, expect, test } from "bun:test"

import { createControlClient } from "../src/control-client"
import { ControlPendingQueue, startControlServer, type ControlServer } from "../src/control-server"
import type { AutoAccept, PermissionPromptInfo } from "../src/progress"

const permissionInfo: PermissionPromptInfo = {
  id: "perm-1",
  permission: "bash",
  patterns: ["bash"],
  command: "ls -la",
  sessionID: "sess-1",
}

async function post(srv: ControlServer, path: string, body?: unknown) {
  const headers = { "content-type": "application/json", authorization: `Bearer ${srv.token}` }
  return fetch(`${srv.url}${path}`, {
    method: "POST",
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

describe("control server", () => {
  test("rejects missing and wrong auth on every route", async () => {
    const server = await startControlServer()
    try {
      expect((await fetch(`${server.url}/pending`)).status).toBe(401)
      expect((await fetch(`${server.url}/pending`, { headers: { authorization: "Bearer wrong" } })).status).toBe(401)
      expect((await fetch(`${server.url}/abort`, { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401)
    } finally {
      server.close()
    }
  })

  test("allows one controller and refuses a second with 409 while observers pass", async () => {
    const server = await startControlServer()
    try {
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(409)
      expect((await post(server, "/hello", { role: "observer" })).status).toBe(200)
      // A malformed role is a protocol error, not a slot claim.
      expect((await post(server, "/hello", { role: "manager" })).status).toBe(400)
    } finally {
      server.close()
    }
  })

  test("bye frees the controller slot, but only for the claimant", async () => {
    const server = await startControlServer()
    try {
      const hello = await post(server, "/hello", { role: "controller" })
      const { controllerId } = (await hello.json()) as { controllerId: string }
      // A caller without the claim id (an observer sharing the token) must not
      // be able to evict the live controller.
      expect((await post(server, "/bye")).status).toBe(409)
      expect((await post(server, "/bye", { controllerId: "not-the-id" })).status).toBe(409)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(409)
      expect((await post(server, "/bye", { controllerId })).status).toBe(200)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
    } finally {
      server.close()
    }
  })

  test("a controller that goes silent loses the slot after the heartbeat window", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 120 })
    try {
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
      expect(server.hasController()).toBe(true)
      // No request carries the controller id: the claim expires, so the next
      // attach takes control instead of being locked out as an observer.
      await Bun.sleep(250)
      expect(server.hasController()).toBe(false)
      expect((await post(server, "/hello", { role: "controller" })).status).toBe(200)
    } finally {
      server.close()
    }
  })

  test("observer traffic does not keep a dead controller's slot alive", async () => {
    const server = await startControlServer({ controllerTimeoutMs: 120 })
    try {
      const client = createControlClient({ url: server.url, token: server.token })
      expect(await client.claimController()).toBe("controller")
      // An observer polls (no controller id header) while the controller is
      // gone; the slot must still expire on schedule.
      const observer = createControlClient({ url: server.url, token: server.token })
      expect(await observer.claimController()).toBe("observer")
      for (let i = 0; i < 6; i++) {
        await observer.pending()
        await Bun.sleep(50)
      }
      expect(server.hasController()).toBe(false)
    } finally {
      server.close()
    }
  })

  test("pause, resume, abort, and keep-awake fire their handlers", async () => {
    const calls: string[] = []
    const server = await startControlServer({
      handlers: {
        onPause: () => void calls.push("pause"),
        onResume: () => void calls.push("resume"),
        onAbort: () => void calls.push("abort"),
        onKeepAwakeToggle: () => void calls.push("keep-awake"),
      },
    })
    try {
      await post(server, "/pause")
      await post(server, "/resume")
      await post(server, "/abort")
      await post(server, "/keep-awake")
      expect(calls).toEqual(["pause", "resume", "abort", "keep-awake"])
    } finally {
      server.close()
    }
  })

  test("interactive and finish-dismiss fire their handlers", async () => {
    const calls: string[] = []
    const server = await startControlServer({
      handlers: {
        onFinishDismiss: () => void calls.push("finish-dismiss"),
      },
    })
    try {
      // [i] lives on the server's armed set, readable by the gate adapter.
      await post(server, "/interactive", { phase: "design", armed: true })
      await post(server, "/interactive", { phase: "design", armed: false })
      expect(server.isInteractiveArmed("design")).toBe(false)
      await post(server, "/interactive", { phase: "tests", armed: true })
      expect(server.isInteractiveArmed("tests")).toBe(true)
      await post(server, "/finish-dismiss")
      expect(calls).toEqual(["finish-dismiss"])
      expect((await post(server, "/interactive", { phase: 1 })).status).toBe(400)
    } finally {
      server.close()
    }
  })

  test("auto-accept cycles the shared object and honors an explicit mode", async () => {
    const shared: AutoAccept = { mode: "off" }
    const server = await startControlServer({ handlers: { autoAccept: shared } })
    try {
      const first = await post(server, "/auto-accept")
      expect((await first.json())).toMatchObject({ mode: "all" })
      expect(shared.mode).toBe("all")

      expect((await (await post(server, "/auto-accept")).json())).toMatchObject({ mode: "smart" })
      expect((await (await post(server, "/auto-accept", { mode: "off" })).json())).toMatchObject({ mode: "off" })
      expect(shared.mode).toBe("off")
    } finally {
      server.close()
    }
  })

  test("a pending permission shows in GET /pending and resolves on POST /permission", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending })
    try {
      expect(pending.snapshot()).toEqual({})

      const wait = pending.holdPermission({ ...permissionInfo })
      expect(pending.snapshot()).toMatchObject({
        permission: { requestId: "perm-1", permission: "bash", patterns: ["bash"], command: "ls -la" },
      })

      expect((await post(server, "/permission", { id: "nope", reply: "once" })).status).toBe(404)
      expect((await post(server, "/permission", { id: "perm-1" })).status).toBe(400)

      expect((await post(server, "/permission", { id: "perm-1", reply: "once" })).status).toBe(200)
      expect(await wait).toBe("once")
      expect(pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("concurrent permission asks queue instead of overwriting each other", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending })
    try {
      // Parallel phases can ask concurrently; dropping a waiter would hang the
      // coordinator on a promise nobody can resolve anymore.
      const first = pending.holdPermission({ ...permissionInfo })
      const second = pending.holdPermission({ ...permissionInfo, id: "perm-2" })

      // The snapshot surfaces the head; the tail waits its turn.
      expect(pending.snapshot().permission?.requestId).toBe("perm-1")

      // Resolving out of order (by id) must not orphan the other waiter.
      expect((await post(server, "/permission", { id: "perm-2", reply: "reject" })).status).toBe(200)
      expect(await second).toBe("reject")
      expect(pending.snapshot().permission?.requestId).toBe("perm-1")
      expect((await post(server, "/permission", { id: "perm-1", reply: "once" })).status).toBe(200)
      expect(await first).toBe("once")
      expect(pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("pending is empty when idle", async () => {
    const server = await startControlServer()
    try {
      const response = await fetch(`${server.url}/pending`, { headers: { authorization: `Bearer ${server.token}` } })
      expect(await response.json()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("the finish hold surfaces its outcome for the client's finish screen", async () => {
    const pending = new ControlPendingQueue()
    const server = await startControlServer({ pending })
    try {
      // The outcome travels with the hold so an attached dashboard renders
      // the real verdict (status, error, goal loop) instead of guessing.
      const wait = pending.holdFinish({
        status: "failed",
        error: "phase tests failed",
        goalLoop: { target: 90, iteration: 3, maxRuns: 5, plateau: 2, scores: [60, 71, 84], outcome: { reason: "max-iterations", reached: false, restored: false } },
      })
      expect(pending.snapshot().finish).toEqual({
        status: "failed",
        error: "phase tests failed",
        goalLoop: { target: 90, iteration: 3, maxRuns: 5, plateau: 2, scores: [60, 71, 84], outcome: { reason: "max-iterations", reached: false, restored: false } },
      })
      expect(pending.resolveFinish()).toBe(true)
      await wait
      expect(pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })

  test("round-trips through the client with Bearer auth", async () => {
    const server = await startControlServer()
    const client = createControlClient({ url: server.url, token: server.token })
    try {
      expect(await client.claimController()).toBe("controller")
      expect(await client.pending()).toEqual({})

      // A second controller is refused and falls back to observer.
      const second = createControlClient({ url: server.url, token: server.token })
      expect(await second.claimController()).toBe("observer")

      // A gate held by the coordinator resolves through the client.
      const wait = server.pending.holdPermission({ ...permissionInfo })
      expect((await client.pending()).permission?.requestId).toBe("perm-1")
      await client.permission("perm-1", "reject")
      expect(await wait).toBe("reject")
      expect(server.pending.snapshot()).toEqual({})
    } finally {
      server.close()
    }
  })
})
