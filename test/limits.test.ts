import { describe, expect, test, mock, afterEach } from "bun:test"

import { parseCodexUsage, jwtExpMs, parseOpenRouterCredits, parseOpenRouterKey, openRouterKeyFrom, limitsPollMs, startLimitsPoller } from "../src/limits"

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

describe("jwtExpMs", () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
    return `header.${encoded}.signature`
  }

  test("extracts exp from a valid JWT payload", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = makeJwt({ exp })
    expect(jwtExpMs(token)).toBe(exp * 1000)
  })

  test("returns null when the payload has no exp", () => {
    expect(jwtExpMs(makeJwt({ sub: "user" }))).toBeNull()
  })

  test("returns null for undecodable token", () => {
    expect(jwtExpMs("invalid")).toBeNull()
  })

  test("returns null for a token with no payload part", () => {
    expect(jwtExpMs("header")).toBeNull()
  })

  test("returns null when payload is not valid JSON", () => {
    const token = "header.not-json.signature"
    expect(jwtExpMs(token)).toBeNull()
  })

  test("returns null when exp is not a number", () => {
    expect(jwtExpMs(makeJwt({ exp: "later" }))).toBeNull()
  })

  test("returns null for an empty string", () => {
    expect(jwtExpMs("")).toBeNull()
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

describe("limitsPollMs", () => {
  test("has the expected default value", () => {
    expect(limitsPollMs).toBe(180_000)
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
    globalThis.fetch = mock(() => { throw new Error("network error") })

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
      process.env.OPENROUTER_API_KEY = original
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
      process.env.OPENROUTER_API_KEY = original
    }
  })
})

describe("jwtExpMs with edge cases", () => {
  test("handles token with empty JSON payload", async () => {
    const { jwtExpMs } = await import("../src/limits")
    const token = "header." + Buffer.from("{}").toString("base64url") + ".sig"
    const result = jwtExpMs(token)
    expect(result).toBeNull()
  })
})
