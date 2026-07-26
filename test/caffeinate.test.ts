import { expect, test } from "bun:test"

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

test("Caffeinate starts with the Convoy pid and releases its assertion", async () => {
  const commands: string[][] = []
  const states: KeepAwakeState[] = []
  const child = fakeProcess()
  const caffeinate = new Caffeinate({
    platform: "darwin",
    pid: 4242,
    spawn(command) {
      commands.push(command)
      return child.process
    },
  })
  caffeinate.bind({ ...noopProgress, keepAwakeState: (state) => states.push(state) })

  await caffeinate.toggle()
  expect(commands).toEqual([["caffeinate", "-d", "-i", "-w", "4242"]])
  expect(caffeinate.snapshot()).toEqual({ status: "on" })

  await caffeinate.stop()
  expect(caffeinate.snapshot()).toEqual({ status: "off" })
  expect(states).toEqual([{ status: "off" }, { status: "on" }, { status: "off" }])
})

test("Caffeinate is unavailable off macOS without spawning a process", async () => {
  let spawns = 0
  const caffeinate = new Caffeinate({
    platform: "linux",
    spawn() {
      spawns++
      throw new Error("must not spawn")
    },
  })

  await caffeinate.toggle()
  expect(spawns).toBe(0)
  expect(caffeinate.snapshot()).toEqual({ status: "unavailable", detail: "Keep-awake is available on macOS only" })
})

test("Caffeinate reports an unexpected child exit and can be started again", async () => {
  const first = fakeProcess()
  const second = fakeProcess()
  const children = [first.process, second.process]
  const caffeinate = new Caffeinate({ platform: "darwin", spawn: () => children.shift()! })

  await caffeinate.toggle()
  first.exit(1)
  await first.process.exited
  await Promise.resolve()
  expect(caffeinate.snapshot()).toEqual({ status: "off", detail: "Caffeinate stopped unexpectedly (status 1)" })

  await caffeinate.toggle()
  expect(caffeinate.snapshot()).toEqual({ status: "on" })
  await caffeinate.stop()
})
