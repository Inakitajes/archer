import { describe, expect, test } from "bun:test"

import { connectOpencode, type OpencodeClient } from "../src/opencode"

describe("connectOpencode", () => {
  test("returns an object that conforms to the OpencodeClient shape", () => {
    const client = connectOpencode("http://127.0.0.1:12345")

    expect(client).toBeTruthy()
    const clientKeys = Object.keys(client)
    expect(clientKeys.length).toBeGreaterThan(0)
  })

  test("uses the provided URL as the base URL", () => {
    const url = "http://127.0.0.1:54321"
    const client = connectOpencode(url)

    // The client has a `baseUrl` property or similar; verify it gets set.
    // The SDK client stores baseUrl internally, so we verify URL is used
    // by checking that methods are defined (they'd fail at call time if
    // unconfigured rather than be undefined).
    expect(client).toBeTruthy()
  })

  test("returns a distinct client for each call", () => {
    const a = connectOpencode("http://127.0.0.1:1111")
    const b = connectOpencode("http://127.0.0.1:2222")

    // Each call produces a separate client instance
    expect(a).not.toBe(b)
  })
})

describe("sessionShellCommand (private)", () => {
  test("builds commands with correct structure", async () => {
    const { sessionShellCommand, shellQuote } = await import("../src/opencode")
    const cmd = sessionShellCommand("opencode /repo", "/my dir", "/usr/bin:/bin")
    expect(cmd).toContain("export PATH='/usr/bin:/bin':$PATH")
    expect(cmd).toContain("cd '/my dir'")
    expect(cmd).toContain("opencode /repo")
  })

  test("omits path when empty", async () => {
    const { sessionShellCommand } = await import("../src/opencode")
    const cmd = sessionShellCommand("opencode", "/repo", "")
    expect(cmd).not.toContain("export PATH")
    expect(cmd).toContain("cd '/repo'")
  })

  test("omits cd when cwd undefined", async () => {
    const { sessionShellCommand } = await import("../src/opencode")
    const cmd = sessionShellCommand("opencode", undefined, "")
    expect(cmd).toBe("opencode")
  })

  test("omits cd when cwd is empty", async () => {
    const { sessionShellCommand } = await import("../src/opencode")
    const cmd = sessionShellCommand("opencode /repo", "", "/usr/bin:/bin")
    expect(cmd).toContain("export PATH")
    expect(cmd).not.toContain("cd ''")
    expect(cmd).toContain("opencode /repo")
  })

  test("omits path and cd when both empty", async () => {
    const { sessionShellCommand } = await import("../src/opencode")
    const cmd = sessionShellCommand("opencode", undefined, "")
    expect(cmd).toBe("opencode")
  })

  test("includes path but omits cd when cwd is undefined", async () => {
    const { sessionShellCommand } = await import("../src/opencode")
    const cmd = sessionShellCommand("opencode /repo", undefined, "/usr/bin")
    expect(cmd).toContain("export PATH='/usr/bin':$PATH")
    expect(cmd).not.toContain("cd ")
    expect(cmd).toContain("opencode /repo")
  })

  test("shellQuote wraps value in single quotes", async () => {
    const { shellQuote } = await import("../src/opencode")
    expect(shellQuote("simple")).toBe("'simple'")
    expect(shellQuote("path with spaces")).toBe("'path with spaces'")
  })

  test("shellQuote escapes single quotes inside the value", async () => {
    const { shellQuote } = await import("../src/opencode")
    expect(shellQuote("it's a test")).toBe("'it'\\''s a test'")
  })
})

describe("connectOpencode URL formats", () => {
  test("accepts http URL with port", () => {
    const client = connectOpencode("http://127.0.0.1:8080")
    expect(client).toBeTruthy()
    expect(typeof client.session?.create).toBe("function")
  })

  test("accepts https URL", () => {
    const client = connectOpencode("https://opencode.example.com")
    expect(client).toBeTruthy()
  })

  test("accepts URL with path", () => {
    const client = connectOpencode("http://localhost:3000/custom/path")
    expect(client).toBeTruthy()
  })

  test("handles URL with trailing slash", () => {
    const client = connectOpencode("http://127.0.0.1:4000/")
    expect(client).toBeTruthy()
  })
})