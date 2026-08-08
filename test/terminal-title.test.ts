import { describe, expect, test } from "bun:test"
import { Writable } from "node:stream"

import { writeTerminalTitle, pushTerminalTitle, popTerminalTitle } from "../src/terminal-title"
import type { TitleOutput } from "../src/terminal-title"

function mockTTY(): TitleOutput {
  let buf = ""
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buf += chunk.toString()
      callback()
    },
  })
  // We need to type-cast to make it look like a TTY
  return Object.assign(stream, { isTTY: true }) as TitleOutput
}

function mockNonTTY(): TitleOutput {
  let buf = ""
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buf += chunk.toString()
      callback()
    },
  })
  return Object.assign(stream, { isTTY: false }) as TitleOutput
}

function mockBrokenStream(): TitleOutput {
  return {
    isTTY: true,
    write() {
      throw new Error("stream closed")
    },
  } as unknown as TitleOutput
}

describe("writeTerminalTitle", () => {
  test("writes the OSC 2 sequence to a TTY output", () => {
    const output = mockTTY()
    const result = writeTerminalTitle("convoy test", output)
    expect(result).toBe(true)
  })

  test("returns false for a non-TTY output", () => {
    const result = writeTerminalTitle("convoy test", mockNonTTY())
    expect(result).toBe(false)
  })

  test("returns false when the write throws", () => {
    const result = writeTerminalTitle("test", mockBrokenStream())
    expect(result).toBe(false)
  })
})

describe("pushTerminalTitle", () => {
  test("writes the push sequence to a TTY output", () => {
    const output = mockTTY()
    const result = pushTerminalTitle(output)
    expect(result).toBe(true)
  })

  test("returns false for a non-TTY output", () => {
    const result = pushTerminalTitle(mockNonTTY())
    expect(result).toBe(false)
  })
})

describe("popTerminalTitle", () => {
  test("writes the pop sequence to a TTY output", () => {
    const output = mockTTY()
    const result = popTerminalTitle(output)
    expect(result).toBe(true)
  })

  test("returns false for a non-TTY output", () => {
    const result = popTerminalTitle(mockNonTTY())
    expect(result).toBe(false)
  })
})

describe("default argument uses process.stdout", () => {
  test("writeTerminalTitle works without a second argument", () => {
    // process.stdout is a TTY in test; this should not throw
    expect(() => writeTerminalTitle("test")).not.toThrow()
  })

  test("pushTerminalTitle works without a second argument", () => {
    expect(() => pushTerminalTitle()).not.toThrow()
  })

  test("popTerminalTitle works without a second argument", () => {
    expect(() => popTerminalTitle()).not.toThrow()
  })
})