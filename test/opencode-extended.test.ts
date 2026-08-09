import { afterEach, describe, expect, test } from "bun:test"

import { connectOpencode } from "../src/opencode"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("connectOpencode", () => {
  test("sends SDK requests to the provided base URL", async () => {
    let requestUrl = ""
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        requestUrl = input instanceof Request ? input.url : String(input)
        return Response.json({ data: { all: [], connected: [] } })
      },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    await connectOpencode("http://127.0.0.1:54321/custom").provider.list({ directory: "/repo" })

    expect(requestUrl).toBe("http://127.0.0.1:54321/custom/provider?directory=%2Frepo")
  })
})
