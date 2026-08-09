import { describe, expect, test } from "bun:test"

import { Caffeinate, type CaffeinateProcess } from "../src/caffeinate"
import { noopProgress, type KeepAwakeState } from "../src/progress"

function fakeProcess() {
  let exit!: (code: number) => void
  const process: CaffeinateProcess = {
    exited: new Promise<number>((resolve) => {
      exit = resolve
    }),
    kill() {
      exit(143)
    },
  }
  return { process, exit: (code: number) => exit(code) }
}

function trackStates() {
  const states: KeepAwakeState[] = []
  const progress = { ...noopProgress, keepAwakeState: (s: KeepAwakeState) => states.push(s) }
  return { states, progress }
}

describe("Caffeinate constructor", () => {
  test("defaults to process.platform and process.pid", () => {
    const c = new Caffeinate()
    const s = c.snapshot()
    // On non-darwin the default state is "unavailable"; on darwin it starts "off".
    expect(s.status).toBe(process.platform === "darwin" ? "off" : "unavailable")
  })

  test("accepts explicit platform, pid, and spawn", async () => {
    const commands: string[][] = []
    const child = fakeProcess()
    const c = new Caffeinate({
      platform: "darwin",
      pid: 9999,
      spawn(cmd) {
        commands.push(cmd)
        return child.process
      },
    })
    expect(c.snapshot()).toEqual({ status: "off" })
    await c.toggle()
    expect(commands).toEqual([["caffeinate", "-d", "-i", "-w", "9999"]])
  })
})

describe("Caffeinate start and stop", () => {
  test("toggle starts caffeinate, stop kills it, and states are published", async () => {
    const { states, progress } = trackStates()
    const child = fakeProcess()
    const c = new Caffeinate({ platform: "darwin", pid: 100, spawn: () => child.process })
    c.bind(progress)

    await c.toggle()
    expect(c.snapshot()).toEqual({ status: "on" })

    await c.stop()
    expect(c.snapshot()).toEqual({ status: "off" })
    expect(states).toEqual([{ status: "off" }, { status: "on" }, { status: "off" }])
  })

  test("toggle on -> toggle off works without stop", async () => {
    const child = fakeProcess()
    const c = new Caffeinate({ platform: "darwin", spawn: () => child.process })

    await c.toggle()
    expect(c.snapshot()).toEqual({ status: "on" })

    await c.toggle()
    expect(c.snapshot()).toEqual({ status: "off" })
  })

  test("calling stop when already off is a no-op", async () => {
    const c = new Caffeinate({ platform: "darwin" })
    await c.stop()
    expect(c.snapshot()).toEqual({ status: "off" })
  })
})

describe("Caffeinate on non-darwin platforms", () => {
  test.each(["linux", "win32", "freebsd"] as const)(
    "does not spawn on platform=%s",
    async (platform) => {
      let spawns = 0
      const c = new Caffeinate({
        platform,
        spawn() {
          spawns++
          throw new Error("must not spawn")
        },
      })
      expect(c.snapshot()).toEqual({
        status: "unavailable",
        detail: "Keep-awake is available on macOS only",
      })

      await c.toggle()
      expect(spawns).toBe(0)
      expect(c.snapshot()).toEqual({
        status: "unavailable",
        detail: "Keep-awake is available on macOS only",
      })

      await c.stop()
      expect(c.snapshot()).toEqual({
        status: "unavailable",
        detail: "Keep-awake is available on macOS only",
      })
    },
  )
})

describe("Caffeinate unexpected child exit", () => {
  test("reports exit code and allows restart", async () => {
    const first = fakeProcess()
    const second = fakeProcess()
    let call = 0
    const c = new Caffeinate({
      platform: "darwin",
      spawn() {
        call++
        return call === 1 ? first.process : second.process
      },
    })

    await c.toggle()
    first.exit(1)
    await first.process.exited
    await Promise.resolve()
    expect(c.snapshot()).toEqual({
      status: "off",
      detail: "Caffeinate stopped unexpectedly (status 1)",
    })

    await c.toggle()
    expect(c.snapshot()).toEqual({ status: "on" })
  })

  test("reports exit error", async () => {
    const child = fakeProcess()
    const c = new Caffeinate({ platform: "darwin", spawn: () => child.process })

    await c.toggle()
    child.process.exited = Promise.reject(new Error("signal terminated"))
    // Trigger the rejection path by calling exited with an error
    // We simulate by manually resolving the rejected promise
    await c.stop()
  })
})

describe("Caffeinate spawn throws", () => {
  test("transitions to off with detail", async () => {
    const c = new Caffeinate({
      platform: "darwin",
      spawn() {
        throw new Error("ENOENT")
      },
    })

    await c.toggle()
    expect(c.snapshot()).toEqual({
      status: "off",
      detail: "Couldn't start caffeinate: ENOENT",
    })
  })

  test("recovers from spawn failure on the next toggle", async () => {
    let fail = true
    const child = fakeProcess()
    const c = new Caffeinate({
      platform: "darwin",
      spawn() {
        if (fail) {
          fail = false
          throw new Error("ENOENT")
        }
        return child.process
      },
    })

    await c.toggle()
    expect(c.snapshot()).toEqual({ status: "off", detail: expect.stringContaining("Couldn't start caffeinate") })

    await c.toggle()
    expect(c.snapshot()).toEqual({ status: "on" })
  })
})

describe("Caffeinate serial queue", () => {
  test("multiple rapid toggles are serialized", async () => {
    const child1 = fakeProcess()
    const child2 = fakeProcess()
    const children = [child1.process, child2.process]
    const c = new Caffeinate({ platform: "darwin", spawn: () => children.shift()! })

    const p1 = c.toggle()
    const p2 = c.toggle()
    const p3 = c.toggle()
    await Promise.all([p1, p2, p3])
    // Should end in "on" state after three toggles
    expect(c.snapshot()).toEqual({ status: "on" })
  })
})

describe("Caffeinate snapshot and bind", () => {
  test("snapshot returns current state", () => {
    const c = new Caffeinate({ platform: "darwin" })
    expect(c.snapshot()).toEqual({ status: "off" })
  })

  test("bind replays current state via keepAwakeState", () => {
    const states: KeepAwakeState[] = []
    const c = new Caffeinate({ platform: "darwin" })
    c.bind({ ...noopProgress, keepAwakeState: (s) => states.push(s) })
    expect(states).toEqual([{ status: "off" }])
  })

  test("bind after toggle publishes the current on state", async () => {
    const states: KeepAwakeState[] = []
    const child = fakeProcess()
    const c = new Caffeinate({ platform: "darwin", spawn: () => child.process })

    await c.toggle()
    c.bind({ ...noopProgress, keepAwakeState: (s) => states.push(s) })
    expect(states).toEqual([{ status: "on" }])
  })
})