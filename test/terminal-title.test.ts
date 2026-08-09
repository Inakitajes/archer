import { Writable } from "node:stream"

import { describe, expect, test } from "bun:test"

import { writeTerminalTitle, pushTerminalTitle, popTerminalTitle } from "../src/terminal-title"
import type { TitleOutput } from "../src/terminal-title"

function capturedOutput(isTTY: boolean): { output: TitleOutput; bytes: () => Buffer } {
  const chunks: Buffer[] = []
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  return {
    output: Object.assign(output, { isTTY }) as TitleOutput,
    bytes: () => Buffer.concat(chunks),
  }
}

function brokenOutput(): TitleOutput {
  return {
    isTTY: true,
    write() {
      throw new Error("stream closed")
    },
  } as unknown as TitleOutput
}

describe("writeTerminalTitle", () => {
  test("writes the exact OSC 2 byte sequence to a TTY", () => {
    const capture = capturedOutput(true)

    expect(writeTerminalTitle("convoy test", capture.output)).toBe(true)
    expect(capture.bytes()).toEqual(Buffer.from([
      0x1b, 0x5d, 0x32, 0x3b,
      ...Buffer.from("convoy test"),
      0x07,
    ]))
  })

  test("does not write to a non-TTY output", () => {
    const capture = capturedOutput(false)

    expect(writeTerminalTitle("convoy test", capture.output)).toBe(false)
    expect(capture.bytes()).toHaveLength(0)
  })

  test("returns false when the write throws", () => {
    expect(writeTerminalTitle("test", brokenOutput())).toBe(false)
  })
})

describe("pushTerminalTitle", () => {
  test("writes the exact xterm push-title sequence", () => {
    const capture = capturedOutput(true)

    expect(pushTerminalTitle(capture.output)).toBe(true)
    expect(capture.bytes()).toEqual(Buffer.from([0x1b, 0x5b, 0x32, 0x32, 0x3b, 0x32, 0x74]))
  })

  test("does not write to a non-TTY output", () => {
    const capture = capturedOutput(false)

    expect(pushTerminalTitle(capture.output)).toBe(false)
    expect(capture.bytes()).toHaveLength(0)
  })
})

describe("popTerminalTitle", () => {
  test("writes the exact xterm pop-title sequence", () => {
    const capture = capturedOutput(true)

    expect(popTerminalTitle(capture.output)).toBe(true)
    expect(capture.bytes()).toEqual(Buffer.from([0x1b, 0x5b, 0x32, 0x33, 0x3b, 0x32, 0x74]))
  })

  test("does not write to a non-TTY output", () => {
    const capture = capturedOutput(false)

    expect(popTerminalTitle(capture.output)).toBe(false)
    expect(capture.bytes()).toHaveLength(0)
  })
})
