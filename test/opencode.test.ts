import { describe, expect, test, spyOn, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  shellQuote,
  sessionShellCommand,
  openSessionCommand,
  openOpencodeSessionWindow,
  openInteractiveOpencodeWindow,
  openStoredSessionWindow,
  openIterateOpencodeWindow,
  connectOpencode,
  startOpencode,
} from "../src/opencode"

import type { OpencodeHandle } from "../src/opencode"

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")
const originalTerminal = process.env.CONVOY_TERMINAL
const originalZellij = process.env.ZELLIJ
const originalPath = process.env.PATH
const originalSpawn = Bun.spawn
const originalWhich = Bun.which

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

function setPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value, configurable: true })
}

type SpawnMock = {
  (...args: unknown[]): unknown
  mock: { calls: Array<[string[], ...unknown[]]> }
  mockRestore(): void
}

function mockSpawnResult(exitCode = 0, stderr = ""): SpawnMock {
  const spawn = spyOn(Bun, "spawn")
  spawn.mockImplementation((() => ({
    exited: Promise.resolve(exitCode),
    stderr: new ReadableStream({
      start(controller) {
        if (stderr) controller.enqueue(Buffer.from(stderr))
        controller.close()
      },
    }),
  })) as unknown as typeof Bun.spawn)
  return spawn as unknown as SpawnMock
}

// Fails only the named binary, so a fallback backend can still succeed in the
// same test — mockSpawnResult(1) would fail the fallback too.
function mockSpawnFailing(binary: string): SpawnMock {
  const spawn = spyOn(Bun, "spawn")
  spawn.mockImplementation(((cmd: string[]) => {
    const failed = cmd[0] === binary
    return {
      exited: Promise.resolve(failed ? 1 : 0),
      stderr: new ReadableStream({
        start(controller) {
          if (failed) controller.enqueue(Buffer.from(`${binary}: no active session`))
          controller.close()
        },
      }),
    }
  }) as unknown as typeof Bun.spawn)
  return spawn as unknown as SpawnMock
}

function spawnedBinaries(mockSpawn: SpawnMock): string[] {
  return mockSpawn.mock.calls.map((call) => call[0]![0]!)
}

afterEach(() => {
  if (originalPlatformDescriptor) Object.defineProperty(process, "platform", originalPlatformDescriptor)
  restoreEnv("CONVOY_TERMINAL", originalTerminal)
  restoreEnv("ZELLIJ", originalZellij)
  restoreEnv("PATH", originalPath)
  Bun.spawn = originalSpawn
  Bun.which = originalWhich
})

describe("shellQuote", () => {
  test("wraps a simple string in single quotes", () => {
    expect(shellQuote("hello")).toBe("'hello'")
  })

  test("escapes a single quote inside the string", () => {
    expect(shellQuote("it's fine")).toBe("'it'\\''s fine'")
  })

  test("handles a path with spaces", () => {
    expect(shellQuote("/path/with spaces/file.txt")).toBe("'/path/with spaces/file.txt'")
  })

  test("handles special characters", () => {
    expect(shellQuote("$PATH")).toBe("'$PATH'")
  })

  test("handles empty string", () => {
    expect(shellQuote("")).toBe("''")
  })

  test("handles string with multiple single quotes", () => {
    expect(shellQuote("it's 'really' fine")).toBe("'it'\\''s '\\''really'\\'' fine'")
  })

  test("handles string with only a single quote", () => {
    expect(shellQuote("'")).toBe("''\\'''")
  })

  test("handles unicode characters", () => {
    expect(shellQuote("héllo")).toBe("'héllo'")
  })

  test("handles newline characters", () => {
    expect(shellQuote("line1\nline2")).toBe("'line1\nline2'")
  })

  test("handles string with consecutive single quotes", () => {
    expect(shellQuote("a''b")).toBe("'a'\\'''\\''b'")
  })
})

describe("sessionShellCommand", () => {
  test("does not launch the command when changing directory fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-session-command-"))
    const marker = join(root, "launched")
    const command = sessionShellCommand(`touch ${shellQuote(marker)}`, join(root, "missing"), "/usr/bin:/bin")

    try {
      expect(command).toContain(" && cd ")
      expect(command).toContain(" && touch ")

      const child = Bun.spawn(["sh", "-c", command], { stdout: "ignore", stderr: "ignore" })
      expect(await child.exited).not.toBe(0)
      expect(await Bun.file(marker).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("builds a command with PATH and cwd", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "/usr/bin:/bin")
    expect(cmd).toContain("export PATH='/usr/bin:/bin':$PATH")
    expect(cmd).toContain("cd '/repo'")
    expect(cmd).toContain("opencode /repo")
  })

  test("omits PATH export when path is empty string", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "")
    expect(cmd).not.toContain("export PATH")
    expect(cmd).toContain("cd '/repo'")
    expect(cmd).toContain("opencode /repo")
  })

  test("omits cd when cwd is undefined", () => {
    const cmd = sessionShellCommand("opencode /repo", undefined, "")
    expect(cmd).not.toContain("cd ")
    expect(cmd).toBe("opencode /repo")
  })

  test("joins parts with &&", () => {
    const cmd = sessionShellCommand("opencode", "/repo", "/usr/bin")
    expect(cmd).toMatch(/^.+ && .+ && .+$/)
  })

  test("handles path with special characters in cwd", () => {
    const cmd = sessionShellCommand("opencode /repo", "/my repo", "/usr/bin:/bin")
    expect(cmd).toContain("cd '/my repo'")
  })

  test("handles cwd with single quotes", () => {
    const cmd = sessionShellCommand("opencode", "/it's/repo", "/usr/bin")
    expect(cmd).toContain("cd '/it'\\''s/repo'")
  })

  test("omits both PATH and cwd when both missing", () => {
    const cmd = sessionShellCommand("opencode", undefined, "")
    expect(cmd).toBe("opencode")
  })

  test("uses process.env.PATH by default when path not provided", () => {
    const originalPath = process.env.PATH
    process.env.PATH = "/custom/path"
    try {
      const cmd = sessionShellCommand("opencode")
      expect(cmd).toContain("export PATH='/custom/path':$PATH")
    } finally {
      restoreEnv("PATH", originalPath)
    }
  })

  test("includes cwd but no PATH when path is empty", () => {
    const cmd = sessionShellCommand("opencode /repo", "/repo", "")
    expect(cmd).toBe("cd '/repo' && opencode /repo")
  })

  test("preserves the core command as-is", () => {
    const cmd = sessionShellCommand("echo 'hello world'", "/dir", "")
    expect(cmd).toContain("echo 'hello world'")
    expect(cmd).toContain("cd '/dir'")
  })
})

describe("openSessionCommand", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")?.value
  const originalTerminal = process.env.CONVOY_TERMINAL

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
  })

  test("opens in Terminal.app when CONVOY_TERMINAL=terminal", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("echo hello", "/tmp")
      expect(mockSpawn).toHaveBeenCalledTimes(1)
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args[0]).toBe("osascript")
      expect(args[1]).toBe("-e")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("throws when process.platform is not darwin", async () => {
    setPlatform("linux")
    // A forced window backend never asked for a pane, so the message stays the
    // plain one even when the suite itself runs inside a Zellij session.
    process.env.ZELLIJ = "0"

    try {
      await expect(openSessionCommand("echo hello")).rejects.toThrow("macOS only")
    } finally {
      setPlatform(originalPlatform)
    }
  })

  test("includes cwd in the shell command when provided", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("opencode /repo --prompt hello", "/my repo")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toMatch(/cd '\/my repo'/)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("does not include cd when cwd is undefined", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("opencode /repo")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).not.toMatch(/cd\b/)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("propagates errors from Bun.spawn", async () => {
    const mockSpawn = mockSpawnResult(1, "command not found")

    try {
      await expect(openSessionCommand("false")).rejects.toThrow("command not found")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("opens a Zellij pane on Linux when running inside Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openSessionCommand("opencode attach http://127.0.0.1:1234", "/my repo", "opencode session")

      expect(backend).toBe("zellij")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args.slice(0, 9)).toEqual([
        "zellij",
        "action",
        "new-pane",
        "--name",
        "opencode session",
        "--cwd",
        "/my repo",
        "--",
        "sh",
      ])
      expect(args[9]).toBe("-lc")
      expect(args[10]).toContain("opencode attach http://127.0.0.1:1234")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // A pane that vanished on exit would hide a failed launch, and `zellij
  // action` exits 0 as soon as the pane exists — so the pane must hold.
  test("never passes --close-on-exit, so a failed launch stays on screen", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "zellij"
    const mockSpawn = mockSpawnResult()

    try {
      await openSessionCommand("opencode /repo", "/repo", "opencode session")
      expect(mockSpawn.mock.calls[0]![0]).not.toContain("--close-on-exit")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("can force the Zellij backend", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "zellij"
    delete process.env.ZELLIJ
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo")).resolves.toBe("zellij")
      expect(mockSpawn.mock.calls[0]![0]).toEqual(["zellij", "action", "new-pane", "--", "sh", "-lc", expect.any(String)])
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("propagates errors from a forced Zellij pane", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "zellij"
    const mockSpawn = mockSpawnResult(1, "zellij: no active session")

    try {
      await expect(openSessionCommand("opencode /repo")).rejects.toThrow("no active session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // The documented escape hatch: an explicit choice beats auto-detection, so a
  // user inside Zellij can still ask for a separate macOS window.
  test("an explicit terminal choice wins over an active Zellij session", async () => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "ghostty"
    process.env.ZELLIJ = "0"
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.toBe("ghostty")
      expect(mockSpawn.mock.calls[0]![0]![0]).toBe("open")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // Which window backend takes over depends on whether Ghostty is installed on
  // the machine running the suite; what matters here is that Zellij is skipped
  // and a window still opens, rather than the user losing session opening.
  test("falls back to a macOS window when the zellij binary is missing", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => null) as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)).not.toContain("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("falls back to a macOS window when an auto-detected pane fails to open", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = ((name: string) => (name === "zellij" ? "/usr/bin/zellij" : null)) as typeof Bun.which
    const mockSpawn = mockSpawnFailing("zellij")

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)[0]).toBe("zellij")
      expect(spawnedBinaries(mockSpawn).length).toBeGreaterThan(1)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("propagates a failed pane off macOS, where nothing can take over", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnFailing("zellij")

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).rejects.toThrow("no active session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("ignores an empty ZELLIJ export rather than treating it as a live session", async () => {
    setPlatform("darwin")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = ""
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo", "/repo")).resolves.not.toBe("zellij")
      expect(spawnedBinaries(mockSpawn)).not.toContain("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // "run Convoy inside Zellij" would name the wrong cause for someone who is
  // already inside Zellij and only missing the binary.
  test("names the missing binary off macOS instead of advising Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => null) as typeof Bun.which

    await expect(openSessionCommand("opencode /repo", "/repo")).rejects.toThrow("couldn't find the zellij binary on PATH")
  })

  test("rejects an unknown CONVOY_TERMINAL instead of silently ignoring it", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "kitty"
    process.env.ZELLIJ = "0"

    await expect(openSessionCommand("opencode /repo")).rejects.toThrow("CONVOY_TERMINAL=kitty is not a known backend")
  })

  test("tolerates surrounding whitespace and case in CONVOY_TERMINAL", async () => {
    setPlatform("linux")
    process.env.CONVOY_TERMINAL = "  Zellij  "
    const mockSpawn = mockSpawnResult()

    try {
      await expect(openSessionCommand("opencode /repo")).resolves.toBe("zellij")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openOpencodeSessionWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("returns 'terminal' backend after opening", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "session-abc",
      })
      expect(backend).toBe("terminal")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("shell-quoted osascript contains attach, url, dir, and session", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("http://127.0.0.1:12345")
      expect(scriptArg).toContain("--dir")
      expect(scriptArg).toContain("--session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("uses Ghostty when CONVOY_TERMINAL=ghostty", async () => {
    process.env.CONVOY_TERMINAL = "ghostty"
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      expect(backend).toBe("ghostty")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args[0]).toBe("open")
      expect(args).toContain("-na")
      expect(args).toContain("Ghostty")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("re-throws error when forced ghostty fails", async () => {
    process.env.CONVOY_TERMINAL = "ghostty"
    const mockSpawn = mockSpawnResult(1, "Ghostty not found")

    try {
      await expect(
        openOpencodeSessionWindow({
          url: "http://127.0.0.1:12345",
          targetDir: "/repo",
          sessionID: "sess-1",
        }),
      ).rejects.toThrow()
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // [o] is documented as opening a pane under Zellij, so the entry point — not
  // just openSessionCommand — has to reach that backend and name its pane.
  test("opens a named Zellij pane when running inside Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openOpencodeSessionWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
        sessionID: "sess-1",
      })
      expect(backend).toBe("zellij")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args.slice(0, 5)).toEqual(["zellij", "action", "new-pane", "--name", "opencode session"])
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openInteractiveOpencodeWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("uses --continue flag instead of --session", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openInteractiveOpencodeWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("--continue")
      expect(scriptArg).not.toContain("--session")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("returns 'terminal' backend", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openInteractiveOpencodeWindow({
        url: "http://127.0.0.1:12345",
        targetDir: "/repo",
      })
      expect(backend).toBe("terminal")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openStoredSessionWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("does not include attach or url", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openStoredSessionWindow({
        targetDir: "/repo",
        sessionID: "session-abc",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("--session")
      expect(scriptArg).not.toContain("attach")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("passes the target dir and session ID", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openStoredSessionWindow({
        targetDir: "/repo",
        sessionID: "sess-2",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toMatch(/'\/repo'/)
      expect(scriptArg).toMatch(/'sess-2'/)
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openIterateOpencodeWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    setPlatform("darwin")
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    restoreEnv("CONVOY_TERMINAL", originalTerminal)
    Bun.which = originalWhich
  })

  test("passes --prompt with the given prompt", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openIterateOpencodeWindow({
        targetDir: "/repo",
        prompt: "Fix the bug",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toContain("--prompt")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("includes cwd setup for the target directory", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      await openIterateOpencodeWindow({
        targetDir: "/my repo",
        prompt: "hello",
      })
      const args = mockSpawn.mock.calls[0]![0] as string[]
      const scriptArg = args[args.length - 1]!
      expect(scriptArg).toMatch(/cd '\/my repo'/)
    } finally {
      mockSpawn.mockRestore()
    }
  })

  test("returns 'terminal' backend", async () => {
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openIterateOpencodeWindow({
        targetDir: "/repo",
        prompt: "hello",
      })
      expect(backend).toBe("terminal")
    } finally {
      mockSpawn.mockRestore()
    }
  })

  // [i] is documented alongside [o] as opening a pane under Zellij.
  test("opens a named Zellij pane when running inside Zellij", async () => {
    setPlatform("linux")
    delete process.env.CONVOY_TERMINAL
    process.env.ZELLIJ = "0"
    Bun.which = (() => "/usr/bin/zellij") as typeof Bun.which
    const mockSpawn = mockSpawnResult()

    try {
      const backend = await openIterateOpencodeWindow({ targetDir: "/repo", prompt: "hello" })
      expect(backend).toBe("zellij")
      const args = mockSpawn.mock.calls[0]![0] as string[]
      expect(args.slice(0, 5)).toEqual(["zellij", "action", "new-pane", "--name", "opencode iterate"])
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("connectOpencode", () => {
  test("returns an object that conforms to the OpencodeClient shape", () => {
    const client = connectOpencode("http://127.0.0.1:12345")
    expect(client).toBeTruthy()
    expect(typeof client).toBe("object")
  })

  test("returns a distinct client for each call", () => {
    const a = connectOpencode("http://127.0.0.1:1111")
    const b = connectOpencode("http://127.0.0.1:2222")
    expect(a).not.toBe(b)
  })

  test("handles URL with trailing path", () => {
    const client = connectOpencode("http://127.0.0.1:12345/api/v2")
    expect(client).toBeTruthy()
  })
})

describe("startOpencode", () => {
  test("returns the SDK client and closes the injected server", async () => {
    const client = { session: {} } as unknown as OpencodeHandle["client"]
    let closed = false
    let serverOptions: Record<string, unknown> | undefined
    let clientOptions: Record<string, unknown> | undefined

    const handle: OpencodeHandle = await startOpencode({}, undefined, {
      createServer: async (options) => {
        if (!options) throw new Error("expected server options")
        serverOptions = options as unknown as Record<string, unknown>
        return {
          url: `http://127.0.0.1:${options.port}`,
          close() {
            closed = true
          },
        }
      },
      createClient: (options) => {
        clientOptions = options as unknown as Record<string, unknown>
        return client
      },
    })

    expect(handle.client).toBe(client)
    expect(handle.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(serverOptions).toMatchObject({ hostname: "127.0.0.1", timeout: 30_000, config: {} })
    expect(serverOptions?.port).toBeGreaterThan(0)
    expect(clientOptions?.baseUrl).toBe(handle.url)
    expect(typeof clientOptions?.fetch).toBe("function")

    handle.close()
    expect(closed).toBe(true)
  })
})
