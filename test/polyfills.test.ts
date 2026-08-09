import { describe, expect, test } from "bun:test"

describe("polyfills", () => {
  test("installs and exercises the fallback when the native stream is absent", async () => {
    const native = Object.getOwnPropertyDescriptor(globalThis, "TextDecoderStream")
    Reflect.deleteProperty(globalThis, "TextDecoderStream")

    try {
      const fallbackModule = "../src/polyfills?fallback-test"
      await import(fallbackModule)

      const Decoder = globalThis.TextDecoderStream as unknown as new (
        label?: string,
        options?: TextDecoderOptions,
      ) => TransformStream<Uint8Array, string> & {
        encoding: string
        fatal: boolean
        ignoreBOM: boolean
      }
      const decoder = new Decoder("utf-8", { fatal: true, ignoreBOM: true })
      const bytes = new TextEncoder().encode("A€")
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 2))
          controller.enqueue(new Uint8Array())
          controller.enqueue(bytes.slice(2))
          controller.close()
        },
      })

      expect(await new Response(stream.pipeThrough(decoder)).text()).toBe("A€")
      expect(decoder.encoding).toBe("utf-8")
      expect(decoder.fatal).toBe(true)
      expect(decoder.ignoreBOM).toBe(true)
    } finally {
      if (native) Object.defineProperty(globalThis, "TextDecoderStream", native)
      else Reflect.deleteProperty(globalThis, "TextDecoderStream")
    }
  })
})
