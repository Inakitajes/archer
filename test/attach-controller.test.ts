import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { claimAttachRole } from "../src/attach"
import { createControlClient } from "../src/control-client"
import { ControlProgress } from "../src/control-progress"
import { ControlPendingQueue, startControlServer, type ControlServer } from "../src/control-server"
import type { GoalLoopView } from "../src/progress"
import { noopProgress, type ProgressUI } from "../src/progress"

const dirs: string[] = []

afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-attach-controller-"))
  dirs.push(dir)
  return dir
}

const pipeline = { name: "implement", steps: [] }
const phases = [{ name: "implement", description: "" }]

async function freshControl(dir: string): Promise<ControlServer> {
  const pending = new ControlPendingQueue()
  const server = await startControlServer({ pending })
  await writeFile(join(dir, "control.json"), JSON.stringify({ url: server.url, token: server.token, pid: process.pid }), { mode: 0o600 })
  return server
}

describe("attach controller role", () => {
  test("a free slot claims controller and a second client is the observer", async () => {
    const dir = await scratch()
    const server = await freshControl(dir)
    try {
      const first = createControlClient({ url: server.url, token: server.token })
      const second = createControlClient({ url: server.url, token: server.token })
      expect(await first.claimController()).toBe("controller")
      expect(await second.claimController()).toBe("observer")
      expect(server.hasController()).toBe(true)
    } finally {
      server.close()
    }
  })

  test("bye frees the slot for the next menu attach", async () => {
    const dir = await scratch()
    const server = await freshControl(dir)
    try {
      const first = createControlClient({ url: server.url, token: server.token })
      const second = createControlClient({ url: server.url, token: server.token })
      expect(await first.claimController()).toBe("controller")
      await first.bye()
      expect(server.hasController()).toBe(false)
      expect(await second.claimController()).toBe("controller")
    } finally {
      server.close()
    }
  })

  test("retries a transient claim failure once before falling back to observer", async () => {
    let calls = 0
    const flaky = {
      claimController: async () => {
        calls += 1
        if (calls === 1) throw new Error("coordinator briefly unreachable")
        return "controller" as const
      },
    }
    expect(await claimAttachRole(flaky as never)).toBe("controller")
    expect(calls).toBe(2)
  })

  test("two claim failures fall back to observer", async () => {
    let calls = 0
    const dead = {
      claimController: async () => {
        calls += 1
        throw new Error("timeout")
      },
    }
    expect(await claimAttachRole(dead as never)).toBe("observer")
    expect(calls).toBe(2)
  })
})

describe("ControlProgress wiring", () => {
  test("start() writes control.json and the ready path", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const readyPath = join(dir, "ready")
    const progress = new ControlProgress({ server, readyPath })
    progress.start("20260101-000000-ab12", "/repo", dir)
    // The persist is async; wait for control.json to appear.
    let control: { url: string; token: string } | undefined
    for (let attempt = 0; attempt < 40 && !control; attempt++) {
      await Bun.sleep(10)
      try {
        control = JSON.parse(await readFile(join(dir, "control.json"), "utf8"))
      } catch {
        // not written yet
      }
    }
    expect(control?.url).toBe(server.url)
    expect(control?.token).toBe(server.token)
    const ready = JSON.parse(await readFile(readyPath, "utf8"))
    expect(ready).toMatchObject({ runID: "20260101-000000-ab12", controlUrl: server.url })
    server.close()
  })

  test("resetPipeline pushes a reset the client can see", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    progress.start("20260101-000000-ab12", "/repo", dir)
    progress.resetPipeline(phases, { runID: "20260101-000000-cd34", targetDir: "/repo", runDir: dir, pipeline })
    try {
      const snapshot = server.pending.snapshot()
      expect(snapshot.reset?.runID).toBe("20260101-000000-cd34")
      expect(snapshot.reset?.pipelineName).toBe("implement")
    } finally {
      server.close()
    }
  })

  test("the goal-loop view rides the reset so the client's header keeps the trajectory", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    progress.start("20260101-000000-ab12", "/repo", dir)
    try {
      // The loop updates its view before each iteration's run, so the reset
      // the iteration pushes always carries the freshest trajectory.
      progress.setGoalLoop({ target: 90, iteration: 2, maxRuns: 4, plateau: 2, scores: [60, 71] })
      progress.resetPipeline(phases, { runID: "20260101-000000-cd34", targetDir: "/repo", runDir: dir, pipeline })
      expect(server.pending.snapshot().reset?.goalLoop).toEqual({
        target: 90,
        iteration: 2,
        maxRuns: 4,
        plateau: 2,
        scores: [60, 71],
      })
    } finally {
      server.close()
    }
  })

  test("the finish hold carries the coordinator's outcome, not just a flag", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    try {
      const client = createControlClient({ url: server.url, token: server.token })
      await client.claimController()
      const goalLoop: GoalLoopView = { target: 90, iteration: 3, maxRuns: 4, plateau: 2, scores: [60, 71, 84], outcome: { reason: "goal", reached: true, restored: false } }
      const held = progress.runFinished({ status: "completed", runDir: dir, goalLoop })
      await Bun.sleep(20)
      expect(server.pending.snapshot().finish).toEqual({ status: "completed", goalLoop })
      await client.finishDismiss()
      await held
    } finally {
      server.close()
    }
  })

  test("runFinished holds only while a controller is connected", async () => {
    const dir = await scratch()
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    try {
      // No controller: returns immediately (--no-tui behavior).
      await progress.runFinished({ status: "completed", runDir: dir })
      // A controller connected: holds until /finish-dismiss.
      const client = createControlClient({ url: server.url, token: server.token })
      await client.claimController()
      const held = progress.runFinished({ status: "completed", runDir: dir })
      await Bun.sleep(30)
      // Still held (not resolved).
      expect(server.pending.snapshot().finish?.status).toBe("completed")
      await client.finishDismiss()
      await held
    } finally {
      server.close()
    }
  })

  test("adapter rejects nothing without a controller: the hold resolves on the controller reply", async () => {
    const server = await startControlServer()
    const progress = new ControlProgress({ server })
    try {
      const asked = progress.askPermission({ id: "p1", permission: "bash", patterns: ["bash"] })
      let released = false
      void asked.then(() => (released = true))
      await Bun.sleep(30)
      // Still pending — never auto-rejected.
      expect(released).toBe(false)
      expect(server.pending.snapshot().permission?.requestId).toBe("p1")
      const client = createControlClient({ url: server.url, token: server.token })
      await client.claimController()
      await client.permission("p1", "once")
      expect(await asked).toBe("once")
    } finally {
      server.close()
    }
  })
})
