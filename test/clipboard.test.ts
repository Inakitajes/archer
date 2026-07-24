import { describe, expect, test } from "bun:test"

import { copyReportToClipboard, nativeClipboardCommand, writeClipboardOSC52 } from "../src/clipboard"

describe("report clipboard", () => {
  test("uses the native clipboard locally for 2 KiB and 64 KiB reports", async () => {
    const calls: string[][] = []
    for (const size of [2 * 1024, 64 * 1024]) {
      const result = await copyReportToClipboard("x".repeat(size), () => false, {
        platform: "darwin",
        env: {},
        which: () => "/usr/bin/pbcopy",
        runNative: async (command) => {
          calls.push(command)
          return true
        },
      })
      expect(result).toBe("copied-native")
    }
    expect(calls).toEqual([["pbcopy"], ["pbcopy"]])
  })

  test("uses OSC52 remotely and reports its large-payload transport limit", async () => {
    expect(await copyReportToClipboard("remote", () => true, { env: { SSH_CONNECTION: "host" } })).toBe("copied-osc52")
    expect(await copyReportToClipboard("x".repeat(2 * 1024), () => false, { env: { MOSH_CONNECTION: "host" } })).toBe("transport-failed")
  })

  test("falls back to OSC52 after a local native-copy failure but never invokes native copy remotely", async () => {
    let nativeCalls = 0
    expect(
      await copyReportToClipboard("local", () => true, {
        platform: "darwin",
        env: {},
        which: () => "/usr/bin/pbcopy",
        runNative: async () => {
          nativeCalls++
          return false
        },
      }),
    ).toBe("copied-osc52")
    expect(nativeCalls).toBe(1)

    expect(
      await copyReportToClipboard("remote", () => true, {
        platform: "darwin",
        env: { SSH_TTY: "/dev/pts/1" },
        which: () => "/usr/bin/pbcopy",
        runNative: async () => {
          nativeCalls++
          return true
        },
      }),
    ).toBe("copied-osc52")
    expect(nativeCalls).toBe(1)
  })

  test("distinguishes unsupported OSC52 and selects platform commands", async () => {
    expect(await copyReportToClipboard("small", () => false, { platform: "linux", env: {}, which: () => null })).toBe("unsupported")
    expect(nativeClipboardCommand("linux", (command) => command === "xclip" ? "/bin/xclip" : null)).toEqual(["xclip", "-selection", "clipboard"])
    expect(nativeClipboardCommand("win32", (command) => command === "clip.exe" ? "clip.exe" : null)).toEqual(["clip.exe"])
  })

  test("writes a large OSC52 payload without a fixed buffer", () => {
    const writes: string[] = []
    expect(writeClipboardOSC52("x".repeat(64 * 1024), { isTTY: true, write: (value) => { writes.push(String(value)); return true } })).toBeTrue()
    expect(writes[0]?.startsWith("\u001b]52;c;")).toBeTrue()
    expect(writes[0]?.endsWith("\u0007")).toBeTrue()
  })

  test("treats OSC52 backpressure as accepted, a throwing stream as failed, and non-TTY as unsupported", async () => {
    // write() === false signals backpressure: the payload was accepted and still
    // flushes, so the copy must report success instead of a false failure.
    expect(writeClipboardOSC52("x".repeat(64 * 1024), { isTTY: true, write: () => false })).toBeTrue()
    expect(writeClipboardOSC52("report", { isTTY: false, write: () => true })).toBeFalse()
    await expect(
      copyReportToClipboard("report", (text) => writeClipboardOSC52(text, { isTTY: true, write: () => { throw new Error("EPIPE") } }), { env: { SSH_CONNECTION: "host" } }),
    ).resolves.toBe("transport-failed")
  })
})
