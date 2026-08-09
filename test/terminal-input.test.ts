import { describe, expect, test } from "bun:test"

import { createTerminalInput, TerminalInterrupt } from "../src/terminal-input"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("TerminalInterrupt", () => {
  test("is an Error with the correct name", () => {
    const err = new TerminalInterrupt()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe("TerminalInterrupt")
    expect(err.message).toBe("terminal interrupt")
  })

  test("can be caught with instanceof", () => {
    const err = new TerminalInterrupt()
    expect(err instanceof Error).toBe(true)
    expect(err instanceof TerminalInterrupt).toBe(true)
  })
})

describe("createTerminalInput", () => {
  test("hands the block a prompt handle", async () => {
    const input = createTerminalInput()
    const prompt = await input.withInput(async (ask) => ask)
    expect(typeof prompt.ask).toBe("function")
  })

  test("serializes concurrent blocks so two prompts never run at once", async () => {
    const input = createTerminalInput()
    const order: string[] = []
    let active = 0
    let peak = 0
    const a = deferred<void>()
    const b = deferred<void>()

    const doneA = input.withInput(async () => {
      active++
      peak = Math.max(peak, active)
      order.push("a:start")
      await a.promise
      order.push("a:end")
      active--
      return "a-result"
    })
    const doneB = input.withInput(async () => {
      active++
      peak = Math.max(peak, active)
      order.push("b:start")
      await b.promise
      order.push("b:end")
      active--
      return "b-result"
    })

    // A is first in the queue: it starts and holds the arbiter at once.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(["a:start"])
    expect(peak).toBe(1)

    // B is queued behind A; it must not start while A holds the arbiter.
    a.resolve()
    expect(await doneA).toBe("a-result")
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(order).toEqual(["a:start", "a:end", "b:start"])
    expect(peak).toBe(1)

    b.resolve()
    expect(await doneB).toBe("b-result")
    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"])
  })

  test("runs blocks in submission order even when an earlier one fails", async () => {
    const input = createTerminalInput()
    const order: string[] = []

    const doneA = input.withInput(async () => {
      order.push("a")
      throw new Error("boom")
    })
    const doneB = input.withInput(async () => {
      order.push("b")
      return "b-result"
    })

    await expect(doneA).rejects.toThrow("boom")
    expect(await doneB).toBe("b-result")
    expect(order).toEqual(["a", "b"])
  })

  test("a rejected block does not wedge a later block waiting on stdin", async () => {
    const input = createTerminalInput()
    const later = input.withInput(async () => "later-result")
    await expect(input.withInput(async () => "first-result")).resolves.toBe("first-result")
    expect(await later).toBe("later-result")
  })

  test("multiple successes in sequence", async () => {
    const input = createTerminalInput()
    const r1 = await input.withInput(async () => "first")
    const r2 = await input.withInput(async () => "second")
    const r3 = await input.withInput(async () => "third")
    expect(r1).toBe("first")
    expect(r2).toBe("second")
    expect(r3).toBe("third")
  })

  test("prompt.ask is a function that returns a promise", () => {
    const input = createTerminalInput()
    const prompt = input.withInput(async (ask) => ask)
    expect(typeof (prompt as unknown as Promise<{ ask: unknown }>).then).toBe("function")
  })
})