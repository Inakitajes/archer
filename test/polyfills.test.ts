import { describe, expect, test } from "bun:test"

describe("polyfills", () => {
  test("module imports without error", async () => {
    const mod = await import("../src/polyfills")
    expect(mod).toBeDefined()
  })

  test("TextDecoderStream exists after importing polyfills", async () => {
    await import("../src/polyfills")
    expect(typeof globalThis.TextDecoderStream).toBe("function")
  })

  test("TextDecoderStream decodes multi-chunk streams", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("Hel"))
        controller.enqueue(new TextEncoder().encode("lo "))
        controller.enqueue(new TextEncoder().encode("World"))
        controller.close()
      },
    })

    const decoder = new (globalThis.TextDecoderStream as new () => TransformStream<Uint8Array, string>)()
    const reader = stream.pipeThrough(decoder).getReader()
    let result = ""
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      result += value!
    }
    expect(result).toBe("Hello World")
  })

  test("TextDecoderStream exposes encoding, fatal, and ignoreBOM properties", () => {
    const decoder = new (globalThis.TextDecoderStream as new () => TransformStream<Uint8Array, string>)()
    const d = decoder as unknown as { encoding: string; fatal: boolean; ignoreBOM: boolean }
    expect(d.encoding).toBe("utf-8")
    expect(d.fatal).toBe(false)
    expect(d.ignoreBOM).toBe(false)
  })

  test("TextDecoderStream flush outputs remaining data", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]))
        controller.close()
      },
    })

    const decoder = new (globalThis.TextDecoderStream as new () => TransformStream<Uint8Array, string>)()
    const reader = stream.pipeThrough(decoder).getReader()
    const { value } = await reader.read()
    expect(value).toBe("Hello")
  })

  test("TextDecoderStream handles empty chunks", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([]))
        controller.enqueue(new TextEncoder().encode("abc"))
        controller.close()
      },
    })

    const decoder = new (globalThis.TextDecoderStream as new () => TransformStream<Uint8Array, string>)()
    const reader = stream.pipeThrough(decoder).getReader()
    const { value } = await reader.read()
    expect(value).toBe("abc")
  })

  test("TextDecoderStream with UTF-16LE encoding", () => {
    const decoder = new (globalThis.TextDecoderStream as new (label?: string) => TransformStream<Uint8Array, string>)("utf-16le")
    const d = decoder as unknown as { encoding: string }
    expect(d.encoding).toBe("utf-16le")
  })
})