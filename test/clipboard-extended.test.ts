import { describe, expect, test } from "bun:test"
import { nativeClipboardCommand, writeClipboardOSC52, copyReportToClipboard } from "../src/clipboard"

describe("nativeClipboardCommand", () => {
  test("returns pbcopy on darwin when pbcopy exists", () => {
    expect(nativeClipboardCommand("darwin", () => "/usr/bin/pbcopy")).toEqual(["pbcopy"])
  })

  test("returns undefined on darwin when pbcopy is missing", () => {
    expect(nativeClipboardCommand("darwin", () => null)).toBeUndefined()
  })

  test("prefers wl-copy on linux over xclip", () => {
    const which = (cmd: string) => cmd === "wl-copy" ? "/usr/bin/wl-copy" : null
    expect(nativeClipboardCommand("linux", which)).toEqual(["wl-copy"])
  })

  test("falls back to xclip on linux when wl-copy is missing", () => {
    const which = (cmd: string) => cmd === "xclip" ? "/usr/bin/xclip" : null
    expect(nativeClipboardCommand("linux", which)).toEqual(["xclip", "-selection", "clipboard"])
  })

  test("returns undefined on linux when neither wl-copy nor xclip exist", () => {
    expect(nativeClipboardCommand("linux", () => null)).toBeUndefined()
  })

  test("returns clip.exe on win32 when it exists", () => {
    expect(nativeClipboardCommand("win32", () => "C:\\Windows\\System32\\clip.exe")).toEqual(["clip.exe"])
  })

  test("returns undefined on win32 when clip.exe is missing", () => {
    expect(nativeClipboardCommand("win32", () => null)).toBeUndefined()
  })

  test("returns undefined for unknown platforms like android, freebsd, aix", () => {
    for (const platform of ["android", "freebsd", "aix"] as NodeJS.Platform[]) {
      expect(nativeClipboardCommand(platform, () => "/bin/sh")).toBeUndefined()
    }
  })
})

describe("writeClipboardOSC52", () => {
  function stream(overrides: Partial<{ isTTY: boolean; write: (s: string) => boolean }> = {}) {
    return { isTTY: true, write: () => true, ...overrides } as Pick<NodeJS.WriteStream, "write" | "isTTY">
  }

  test("returns false when output is not a TTY", () => {
    expect(writeClipboardOSC52("hello", stream({ isTTY: false }))).toBeFalse()
  })

  test("writes base64-encoded OSC52 sequence to a TTY output", () => {
    const writes: string[] = []
    const result = writeClipboardOSC52("hello", stream({ write: (s) => { writes.push(s); return true } }))
    expect(result).toBeTrue()
    expect(writes[0]).toBe(`\u001b]52;c;${Buffer.from("hello", "utf8").toString("base64")}\u0007`)
  })

  test("encodes non-ASCII and empty text correctly", () => {
    const writes: string[] = []
    const out = stream({ write: (s) => { writes.push(s); return true } })

    writeClipboardOSC52("", out)
    expect(writes[0]).toBe(`\u001b]52;c;${Buffer.from("", "utf8").toString("base64")}\u0007`)

    writeClipboardOSC52("héllo 世界", out)
    expect(writes[1]).toBe(`\u001b]52;c;${Buffer.from("héllo 世界", "utf8").toString("base64")}\u0007`)

    writeClipboardOSC52("\0\n\t", out)
    expect(writes[2]).toBe(`\u001b]52;c;${Buffer.from("\0\n\t", "utf8").toString("base64")}\u0007`)
  })

  test("returns true even when write() signals backpressure (false)", () => {
    expect(writeClipboardOSC52("large payload", stream({ write: () => false }))).toBeTrue()
  })

  test("throws when write() throws, allowing caller to map to transport-failed", () => {
    expect(() => writeClipboardOSC52("fail", stream({ write: () => { throw new Error("EPIPE") } }))).toThrow("EPIPE")
  })
})

describe("copyReportToClipboard edge cases", () => {
  test("returns unsupported when native command fails (catch) and OSC52 also not used", async () => {
    const result = await copyReportToClipboard("data", () => false, {
      platform: "darwin",
      env: {},
      which: () => "/usr/bin/pbcopy",
      runNative: async () => { throw new Error("spawn ENOENT") },
    })
    expect(result).toBe("unsupported")
  })

  test("returns unsupported when native and OSC52 both fail and text fits 750 bytes", async () => {
    const result = await copyReportToClipboard("data", () => false, {
      platform: "darwin",
      env: {},
      which: () => "/usr/bin/pbcopy",
      runNative: async () => false,
    })
    expect(result).toBe("unsupported")
  })

  test("returns unsupported when native missing, OSC52 false, and text fits in 750 bytes", async () => {
    const result = await copyReportToClipboard("small text", () => false, {
      platform: "linux",
      env: {},
      which: () => null,
    })
    expect(result).toBe("unsupported")
  })

  test("returns transport-failed when native missing, OSC52 false, and text exceeds 750 bytes", async () => {
    const result = await copyReportToClipboard("x".repeat(751), () => false, {
      platform: "linux",
      env: {},
      which: () => null,
    })
    expect(result).toBe("transport-failed")
  })

  test("copies via native runNativeClipboard when pbcopy is available on darwin", async () => {
    const result = await copyReportToClipboard("hello world", () => false, {
      platform: "darwin",
      env: {},
      which: () => "/usr/bin/pbcopy",
    })
    expect(result).toBe("copied-native")
  })

  test("copies via OSC52 when env is set remotely and native is missing", async () => {
    const writes: string[] = []
    const result = await copyReportToClipboard("remote-text", (t) => {
      writes.push(t)
      return true
    }, { env: { SSH_TTY: "/dev/pts/0" }, which: () => null })
    expect(result).toBe("copied-osc52")
    expect(writes[0]).toBe("remote-text")
  })

  test("copied-osc52 even from remote when text fits 750 bytes", async () => {
    const result = await copyReportToClipboard("a".repeat(400), () => true, {
      env: { SSH_CONNECTION: "host" },
    })
    expect(result).toBe("copied-osc52")
  })

  test("copies via native on local even when env has SSH vars but OSC52 is chosen after native fails", async () => {
    let nativeCalled = false
    const result = await copyReportToClipboard("local-ssh", () => true, {
      env: { SSH_CONNECTION: "host" },
      platform: "darwin",
      which: () => "/usr/bin/pbcopy",
      runNative: async () => { nativeCalled = true; return false },
    })
    expect(nativeCalled).toBe(false)
    expect(result).toBe("copied-osc52")
  })

  test("native is skipped on remote even if a tool is installed", async () => {
    let nativeCalled = false
    const result = await copyReportToClipboard("data", () => true, {
      env: { SSH_CONNECTION: "host" },
      platform: "darwin",
      which: () => "/usr/bin/pbcopy",
      runNative: async () => { nativeCalled = true; return false },
    })
    expect(nativeCalled).toBe(false)
    expect(result).toBe("copied-osc52")
  })
})