import { describe, expect, test, mock } from "bun:test"

/**
 * Each test imports model-catalog with a unique query parameter to force
 * fresh module evaluation (avoiding the module-level `cached` variable).
 */

function successSdkHandle() {
  return Promise.resolve({
    client: {
      provider: {
        list: () =>
          Promise.resolve({
            error: undefined,
            data: {
              all: [
                {
                  id: "anthropic",
                  models: {
                    "claude-sonnet-4-5": {
                      id: "claude-sonnet-4-5",
                      name: "Claude Sonnet 4.5",
                      providerID: "anthropic",
                      status: "active",
                      limit: { context: 200_000 },
                      capabilities: {},
                      variants: {},
                    },
                  },
                },
              ],
              connected: ["anthropic"],
            },
          }),
      },
    },
    close: () => {},
    url: "http://localhost:0",
  })
}

function emptySdkHandle() {
  return Promise.resolve({
    client: {
      provider: {
        list: () =>
          Promise.resolve({
            error: undefined,
            data: { all: [], connected: [] },
          }),
      },
    },
    close: () => {},
    url: "http://localhost:0",
  })
}

function errorSdkHandle() {
  return Promise.resolve({
    client: {
      provider: {
        list: () =>
          Promise.resolve({
            error: new Error("provider list error"),
            data: undefined,
          }),
      },
    },
    close: () => {},
    url: "http://localhost:0",
  })
}

let counter = 0
const freshMod = () => import(`../src/model-catalog?list-test-${counter++}`)

describe("listModels SDK failure → fallback to models.dev", () => {
  test("falls back to models.dev when SDK rejects", async () => {
    mock.module("../src/opencode", () => ({
      startOpencode: () => Promise.reject(new Error("SDK unavailable")),
    }))

    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            fallback: {
              models: {
                "model-1": { name: "Fallback Model" },
              },
            },
          }),
      })
    }) as unknown as typeof fetch

    const { listModels } = await freshMod()
    const choices = await listModels("/test")
    expect(fetchCalled).toBe(true)
    expect(choices).toHaveLength(1)
    expect(choices[0]!.value).toBe("fallback/model-1")
  })

  test("SDK returns empty list → falls back to models.dev", async () => {
    mock.module("../src/opencode", () => ({
      startOpencode: () => emptySdkHandle(),
    }))

    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            test: {
              models: {
                "m1": { name: "Model 1" },
              },
            },
          }),
      })
    }) as unknown as typeof fetch

    const { listModels } = await freshMod()
    const choices = await listModels("/test")
    expect(fetchCalled).toBe(true)
    expect(choices).toHaveLength(1)
    expect(choices[0]!.value).toBe("test/m1")
  })

  test("SDK result has error → falls back to models.dev", async () => {
    mock.module("../src/opencode", () => ({
      startOpencode: () => errorSdkHandle(),
    }))

    let fetchCalled = false
    globalThis.fetch = mock(() => {
      fetchCalled = true
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve({
            test: {
              models: {
                "m1": { name: "Fallback Model" },
              },
            },
          }),
      })
    }) as unknown as typeof fetch

    const { listModels } = await freshMod()
    const choices = await listModels("/test")
    expect(fetchCalled).toBe(true)
    expect(choices).toHaveLength(1)
    expect(choices[0]!.value).toBe("test/m1")
  })
})

describe("listModels both sources fail", () => {
  test("both SDK and models.dev reject → returns empty array", async () => {
    mock.module("../src/opencode", () => ({
      startOpencode: () => Promise.reject(new Error("SDK error")),
    }))

    globalThis.fetch = mock(() =>
      Promise.reject(new Error("network failure")),
    ) as unknown as typeof fetch

    const { listModels } = await freshMod()
    const choices = await listModels("/test")
    expect(choices).toEqual([])
  })

  test("SDK fails and models.dev returns non-ok → returns empty array", async () => {
    mock.module("../src/opencode", () => ({
      startOpencode: () => Promise.reject(new Error("SDK error")),
    }))

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        status: 500,
      }),
    ) as unknown as typeof fetch

    const { listModels } = await freshMod()
    const choices = await listModels("/test")
    expect(choices).toEqual([])
  })

  test("SDK fails and models.dev returns empty → returns empty array", async () => {
    mock.module("../src/opencode", () => ({
      startOpencode: () => Promise.reject(new Error("SDK error")),
    }))

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    ) as unknown as typeof fetch

    const { listModels } = await freshMod()
    const choices = await listModels("/test")
    expect(choices).toEqual([])
  })
})

describe("listModels caching", () => {
  test("returns cached value on second call", async () => {
    let sdkCallCount = 0

    mock.module("../src/opencode", () => ({
      startOpencode: () => {
        sdkCallCount++
        return successSdkHandle()
      },
    }))

    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    ) as unknown as typeof fetch

    const { listModels } = await freshMod()

    const first = await listModels("/test")
    expect(first.length).toBeGreaterThan(0)
    expect(sdkCallCount).toBe(1)

    const second = await listModels("/test")
    expect(second).toBe(first)
    expect(sdkCallCount).toBe(1)
  })
})