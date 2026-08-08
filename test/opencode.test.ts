import { describe, expect, test, mock, spyOn, beforeEach, afterEach, beforeAll, afterAll } from "bun:test"

import {
  shellQuote,
  sessionShellCommand,
  iterateSessionShellCommand,
  openSessionCommand,
  openOpencodeSessionWindow,
  openInteractiveOpencodeWindow,
  openStoredSessionWindow,
  openIterateOpencodeWindow,
  connectOpencode,
  startOpencode,
} from "../src/opencode"

import type { OpencodeHandle } from "../src/opencode"

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
      process.env.PATH = originalPath
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

describe("iterateSessionShellCommand", () => {
  test("builds a command with the prompt", () => {
    const cmd = iterateSessionShellCommand(
      { targetDir: "/repo", prompt: "Add login" },
      "/usr/bin:/bin",
    )
    expect(cmd).toContain("opencode")
    expect(cmd).toContain("/repo")
    expect(cmd).toContain("--prompt")
    expect(cmd).toContain("'Add login'")
  })

  test("escapes special characters in the prompt", () => {
    const cmd = iterateSessionShellCommand(
      { targetDir: "/repo", prompt: "it's fine" },
      "/usr/bin",
    )
    expect(cmd).toContain("'it'\\''s fine'")
  })

  test("includes cwd and PATH setup", () => {
    const cmd = iterateSessionShellCommand(
      { targetDir: "/my project", prompt: "hello" },
      "/usr/local/bin:/usr/bin",
    )
    expect(cmd).toContain("export PATH=")
    expect(cmd).toContain("cd '/my project'")
    expect(cmd).toMatch(/opencode.*--prompt/)
  })
})

describe("openSessionCommand", () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")?.value
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    process.env.CONVOY_TERMINAL = originalTerminal
  })

  afterAll(() => {
    if (originalPlatform !== undefined) {
      Object.defineProperty(process, "platform", { value: originalPlatform })
    }
    Bun.which = originalWhich
  })

  test("opens in Terminal.app when CONVOY_TERMINAL=terminal", async () => {
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    Object.defineProperty(process, "platform", { value: "linux" })

    try {
      await expect(openSessionCommand("echo hello")).rejects.toThrow("macOS only")
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform })
    }
  })

  test("includes cwd in the shell command when provided", async () => {
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(1),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from("command not found"))
          controller.close()
        },
      }),
    }))

    try {
      await expect(openSessionCommand("false")).rejects.toThrow("command not found")
    } finally {
      mockSpawn.mockRestore()
    }
  })
})

describe("openOpencodeSessionWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    process.env.CONVOY_TERMINAL = originalTerminal
    Bun.which = originalWhich
  })

  test("returns 'terminal' backend after opening", async () => {
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(1),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(Buffer.from("Ghostty not found"))
          controller.close()
        },
      }),
    }))

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
})

describe("openInteractiveOpencodeWindow", () => {
  const originalTerminal = process.env.CONVOY_TERMINAL
  const originalWhich = Bun.which

  beforeEach(() => {
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    process.env.CONVOY_TERMINAL = originalTerminal
    Bun.which = originalWhich
  })

  test("uses --continue flag instead of --session", async () => {
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    process.env.CONVOY_TERMINAL = originalTerminal
    Bun.which = originalWhich
  })

  test("does not include attach or url", async () => {
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    process.env.CONVOY_TERMINAL = "terminal"
  })

  afterEach(() => {
    process.env.CONVOY_TERMINAL = originalTerminal
    Bun.which = originalWhich
  })

  test("passes --prompt with the given prompt", async () => {
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
    const mockSpawn = spyOn(Bun, "spawn").mockImplementation((_cmd: string[]) => ({
      exited: Promise.resolve(0),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
    }))

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
  test("returns an OpencodeHandle with client, url, and close when started", async () => {
    const handle: OpencodeHandle = await startOpencode({} as any)
    expect(handle).toBeTruthy()
    expect(handle.client).toBeTruthy()
    expect(typeof handle.url).toBe("string")
    expect(handle.url.length).toBeGreaterThan(0)
    expect(typeof handle.close).toBe("function")
    handle.close()
  })
})