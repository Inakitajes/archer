import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { refreshCodexIfNeeded } from "../src/limits-auth"
import { parseCodexUsage, parseOpenRouterCredits, parseOpenRouterKey, openRouterKeyFrom, startLimitsPoller } from "../src/limits"

describe("parseCodexUsage", () => {
  test("parses a valid rate-limit payload", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 45, reset_at: 1_700_000_000 },
        secondary_window: { used_percent: 20, reset_at: 1_700_000_000 },
      },
    })
    expect(result).toEqual({
      sessionPct: 45,
      sessionResetsAt: 1_700_000_000_000,
      weeklyPct: 20,
    })
  })

  test("handles reset_at already in milliseconds", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 30, reset_at: 1_700_000_000_000 },
      },
    })
    expect(result?.sessionResetsAt).toBe(1_700_000_000_000)
  })

  test("handles reset_at <= 0", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 50, reset_at: 0 },
      },
    })
    expect(result?.sessionResetsAt).toBeUndefined()
  })

  test("returns undefined when used_percent is missing", () => {
    expect(parseCodexUsage({})).toBeUndefined()
    expect(parseCodexUsage({ rate_limit: {} })).toBeUndefined()
  })

  test("returns undefined when used_percent is not a number", () => {
    expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "foo" } } })).toBeUndefined()
  })

  test("handles missing secondary_window", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 10, reset_at: 1_700_000_000 },
      },
    })
    expect(result?.weeklyPct).toBeUndefined()
  })

  test("handles undefined secondary_window explicitly", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 15, reset_at: 1_700_000_000 },
        secondary_window: undefined,
      },
    })
    expect(result).toBeDefined()
    expect(result!.sessionPct).toBe(15)
    expect(result!.weeklyPct).toBeUndefined()
  })

  test("handles non-numeric used_percent in secondary_window", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 25, reset_at: 1_700_000_000 },
        secondary_window: { used_percent: "abc", reset_at: 1_800_000_000 },
      },
    })
    expect(result).toBeDefined()
    expect(result!.sessionPct).toBe(25)
    expect(result!.weeklyPct).toBeUndefined()
  })

  test("handles missing rate_limit entirely", () => {
    const result = parseCodexUsage({ not_rate_limit: {} })
    expect(result).toBeUndefined()
  })

  test("handles non-object data input", () => {
    expect(parseCodexUsage(null)).toBeUndefined()
    expect(parseCodexUsage(undefined)).toBeUndefined()
    expect(parseCodexUsage("string")).toBeUndefined()
  })

  test("handles reset_at as negative number", () => {
    const result = parseCodexUsage({
      rate_limit: {
        primary_window: { used_percent: 5, reset_at: -1 },
      },
    })
    expect(result?.sessionResetsAt).toBeUndefined()
  })
})

describe("refreshCodexIfNeeded", () => {
  const expiredToken = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`

  function mockFetch(implementation: () => Promise<Response>): typeof fetch {
    return Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }) as typeof fetch
  }

  test("refreshes and persists a matching token rotation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-limits-"))
    const authPath = join(dir, "auth.json")
    const auth = {
      tokens: {
        access_token: expiredToken,
        refresh_token: "old-refresh",
        id_token: "old-id",
        account_id: "account-1",
      },
    }
    await writeFile(authPath, JSON.stringify(auth))

    try {
      const fetcher = mockFetch(async () => Response.json({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        id_token: "fresh-id",
      }))

      expect(await refreshCodexIfNeeded(auth, authPath, fetcher)).toEqual({ token: "fresh-access" })
      expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
        tokens: {
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          id_token: "fresh-id",
          account_id: "account-1",
        },
        last_refresh: expect.any(String),
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("keeps the current token when refresh is unavailable", async () => {
    const auth = { tokens: { access_token: expiredToken, refresh_token: "refresh" } }
    const unavailable = mockFetch(async () => { throw new Error("offline") })
    const serverError = mockFetch(async () => new Response(null, { status: 500 }))

    expect(await refreshCodexIfNeeded(auth, "unused", unavailable)).toEqual({ token: expiredToken })
    expect(await refreshCodexIfNeeded(auth, "unused", serverError)).toEqual({ token: expiredToken })
  })

  test("keeps tokens whose expiry cannot be decoded", async () => {
    const auth = { tokens: { access_token: "not-a-jwt", refresh_token: "refresh" } }
    let requested = false
    const fetcher = mockFetch(async () => {
      requested = true
      return new Response(null, { status: 500 })
    })

    expect(await refreshCodexIfNeeded(auth, "unused", fetcher)).toEqual({ token: "not-a-jwt" })
    expect(requested).toBe(false)
  })

  test("surfaces rejected refresh credentials", async () => {
    const auth = { tokens: { access_token: expiredToken, refresh_token: "refresh" } }
    const fetcher = mockFetch(async () => new Response(null, { status: 401 }))

    expect(await refreshCodexIfNeeded(auth, "unused", fetcher)).toEqual({
      token: expiredToken,
      authError: "codex login",
    })
  })
})

describe("parseOpenRouterCredits", () => {
  test("parses a valid credits response", () => {
    const result = parseOpenRouterCredits({
      data: { total_credits: 100, total_usage: 25.5 },
    })
    expect(result).toEqual({ kind: "remaining", amount: 74.5 })
  })

  test("returns undefined when the payload has no data", () => {
    expect(parseOpenRouterCredits({})).toBeUndefined()
  })

  test("returns undefined when total_credits is not a number", () => {
    expect(parseOpenRouterCredits({ data: { total_credits: "abc", total_usage: 10 } })).toBeUndefined()
  })

  test("returns undefined when total_usage is not a number", () => {
    expect(parseOpenRouterCredits({ data: { total_credits: 100, total_usage: "xyz" } })).toBeUndefined()
  })

  test("returns undefined when both are not numbers", () => {
    expect(parseOpenRouterCredits({ data: { total_credits: "abc", total_usage: "def" } })).toBeUndefined()
  })

  test("returns undefined when data is null", () => {
    expect(parseOpenRouterCredits({ data: null })).toBeUndefined()
  })

  test("handles non-object input", () => {
    expect(parseOpenRouterCredits(null)).toBeUndefined()
    expect(parseOpenRouterCredits(undefined)).toBeUndefined()
    expect(parseOpenRouterCredits("string")).toBeUndefined()
  })

  test("handles zero credits and zero usage", () => {
    const result = parseOpenRouterCredits({
      data: { total_credits: 0, total_usage: 0 },
    })
    expect(result).toEqual({ kind: "remaining", amount: 0 })
  })

  test("handles floating point precision", () => {
    const result = parseOpenRouterCredits({
      data: { total_credits: 0.1, total_usage: 0.05 },
    })
    expect(result).toEqual({ kind: "remaining", amount: 0.05 })
  })
})

describe("parseOpenRouterKey", () => {
  test("parses a key with limit_remaining", () => {
    const result = parseOpenRouterKey({
      data: { limit_remaining: 500 },
    })
    expect(result).toEqual({ kind: "remaining", amount: 500 })
  })

  test("falls back to usage_monthly when limit_remaining is missing", () => {
    const result = parseOpenRouterKey({
      data: { usage_monthly: 42.5 },
    })
    expect(result).toEqual({ kind: "monthly", amount: 42.5 })
  })

  test("falls back to usage when usage_monthly is also missing", () => {
    const result = parseOpenRouterKey({
      data: { usage: 99 },
    })
    expect(result).toEqual({ kind: "monthly", amount: 99 })
  })

  test("returns undefined when no usable data exists", () => {
    expect(parseOpenRouterKey({ data: {} })).toBeUndefined()
    expect(parseOpenRouterKey({})).toBeUndefined()
  })

  test("returns undefined when data is null", () => {
    expect(parseOpenRouterKey({ data: null })).toBeUndefined()
  })

  test("handles non-object input", () => {
    expect(parseOpenRouterKey(null)).toBeUndefined()
    expect(parseOpenRouterKey(undefined)).toBeUndefined()
  })

  test("prefers limit_remaining over usage_monthly", () => {
    const result = parseOpenRouterKey({
      data: { limit_remaining: 100, usage_monthly: 50, usage: 25 },
    })
    expect(result).toEqual({ kind: "remaining", amount: 100 })
  })

  test("prefers usage_monthly over usage", () => {
    const result = parseOpenRouterKey({
      data: { usage_monthly: 60, usage: 30 },
    })
    expect(result).toEqual({ kind: "monthly", amount: 60 })
  })

  test("returns undefined when usage_monthly and usage are not numbers", () => {
    expect(parseOpenRouterKey({ data: { usage_monthly: "abc", usage: "def" } })).toBeUndefined()
  })

  test("handles usage_monthly=0", () => {
    const result = parseOpenRouterKey({
      data: { usage_monthly: 0, usage: 10 },
    })
    expect(result).toEqual({ kind: "monthly", amount: 0 })
  })

  test("handles usage=0 fallback", () => {
    const result = parseOpenRouterKey({
      data: { usage: 0 },
    })
    expect(result).toEqual({ kind: "monthly", amount: 0 })
  })
})

describe("openRouterKeyFrom", () => {
  test("returns OPENROUTER_API_KEY from env", () => {
    expect(openRouterKeyFrom({ OPENROUTER_API_KEY: "sk-abc" }, {})).toBe("sk-abc")
  })

  test("falls back to opencode auth when env is unset", () => {
    const key = openRouterKeyFrom({}, { openrouter: { type: "api", key: "sk-opencode" } })
    expect(key).toBe("sk-opencode")
  })

  test("env always wins over opencode auth", () => {
    const key = openRouterKeyFrom(
      { OPENROUTER_API_KEY: "sk-env" },
      { openrouter: { type: "api", key: "sk-opencode" } },
    )
    expect(key).toBe("sk-env")
  })

  test("returns undefined when no key is available", () => {
    expect(openRouterKeyFrom({}, {})).toBeUndefined()
  })

  test("returns undefined for non-api opencode auth", () => {
    expect(openRouterKeyFrom({}, { openrouter: { type: "oauth" } })).toBeUndefined()
  })

  test("returns undefined when opencode auth has missing openrouter entry", () => {
    expect(openRouterKeyFrom({}, { someOtherKey: "value" })).toBeUndefined()
  })

  test("returns undefined when opencode auth openrouter entry is null", () => {
    expect(openRouterKeyFrom({}, { openrouter: null })).toBeUndefined()
  })

  test("returns undefined when opencode auth openrouter entry is a non-object", () => {
    expect(openRouterKeyFrom({}, { openrouter: "string" })).toBeUndefined()
  })

  test("returns undefined when opencode auth openrouter key is empty string", () => {
    expect(openRouterKeyFrom({}, { openrouter: { type: "api", key: "" } })).toBeUndefined()
  })

  test("returns undefined when opencode auth is non-object", () => {
    expect(openRouterKeyFrom({}, null)).toBeUndefined()
    expect(openRouterKeyFrom({}, undefined)).toBeUndefined()
    expect(openRouterKeyFrom({}, "string")).toBeUndefined()
  })

  test("returns undefined when env OPENROUTER_API_KEY is empty string", () => {
    expect(openRouterKeyFrom({ OPENROUTER_API_KEY: "" }, {})).toBeUndefined()
  })
})

describe("startLimitsPoller", () => {
  test("calls onUpdate and returns a stop function", () => {
    const snapshots: unknown[] = []
    const stop = startLimitsPoller((snap) => { snapshots.push(snap) }, 1_000_000)
    try {
      expect(typeof stop).toBe("function")
    } finally {
      stop()
    }
  })

  test("stop function clears the interval", () => {
    let callCount = 0
    const stop = startLimitsPoller(() => { callCount++ }, 1_000_000)
    stop()
  })
})

describe("startLimitsPoller with mocked fetch", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("does not crash when fetch throws", () => {
    globalThis.fetch = Object.assign(
      () => { throw new Error("network error") },
      { preconnect: originalFetch.preconnect },
    ) as typeof fetch

    const snapshots: unknown[] = []
    const stop = startLimitsPoller((snap) => { snapshots.push(snap) }, 10_000)
    try {
      expect(typeof stop).toBe("function")
    } finally {
      stop()
    }
  })
})

describe("openRouterKeySources", () => {
  test("returns a result with the expected shape", async () => {
    const { openRouterKeySources } = await import("../src/limits")
    const result = await openRouterKeySources()
    expect(result).toHaveProperty("keychain")
    expect(result).toHaveProperty("env")
    expect(result).toHaveProperty("opencode")
    expect(typeof result.keychain).toBe("boolean")
    expect(typeof result.env).toBe("boolean")
    expect(typeof result.opencode).toBe("boolean")
  })

  test("detects env var when set", async () => {
    const original = process.env.OPENROUTER_API_KEY
    process.env.OPENROUTER_API_KEY = "sk-test"
    const { openRouterKeySources } = await import("../src/limits")
    try {
      const result = await openRouterKeySources()
      expect(result.env).toBe(true)
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = original
    }
  })

  test("detects env var absent", async () => {
    const original = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    const { openRouterKeySources } = await import("../src/limits")
    try {
      const result = await openRouterKeySources()
      expect(result.env).toBe(false)
    } finally {
      if (original === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = original
    }
  })
})
