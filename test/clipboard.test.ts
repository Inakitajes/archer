import { describe, expect, test } from "bun:test"

import { copyReportToClipboard, nativeClipboardCommand, writeClipboardOSC52 } from "../src/clipboard"

describe("report clipboard", () => {
  test("uses the native clipboard locally for large reports", async () => {
    const calls: string[][] = []
    const result = await copyReportToClipboard("x".repeat(64 * 1024), () => false, {
      platform: "darwin",
      env: {},
      which: () => "/usr/bin/pbcopy",
      runNative: async (command) => {
        calls.push(command)
        return true
      },
    })
    expect(result).toBe("copied-native")
    expect(calls).toEqual([["pbcopy"]])
  })

  test("uses OSC52 remotely and reports its large-payload transport limit", async () => {
    expect(await copyReportToClipboard("remote", () => true, { env: { SSH_CONNECTION: "host" } })).toBe("copied-osc52")
    expect(await copyReportToClipboard("x".repeat(2 * 1024), () => false, { env: { MOSH_CONNECTION: "host" } })).toBe("transport-failed")
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
})
