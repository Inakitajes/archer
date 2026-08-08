import { describe, expect, test } from "bun:test"

import { Notifier, resolveTerminalBundleId, defaultNotificationSettings } from "../src/notifications"
import type { NotifierSpawn, NotifierProcess } from "../src/notifications"

// A fake spawn that records what it would run and never actually starts a process.
function fakeSpawn(exitCode: number = 0): { spawn: NotifierSpawn; commands: string[][] } {
  const commands: string[][] = []
  const spawn: NotifierSpawn = (command) => {
    commands.push(command)
    return {
      exited: Promise.resolve(exitCode),
      kill() {},
      unref() {},
    }
  }
  return { spawn, commands }
}

describe("defaultNotificationSettings", () => {
  test("has all notifications enabled by default", () => {
    expect(defaultNotificationSettings.enabled).toBe(true)
    expect(defaultNotificationSettings.steps).toBe(true)
    expect(defaultNotificationSettings.waiting).toBe(true)
    expect(defaultNotificationSettings.failures).toBe(true)
    expect(defaultNotificationSettings.finish).toBe(true)
    expect(defaultNotificationSettings.terminalTitle).toBe(true)
    expect(defaultNotificationSettings.sound).toBe("")
  })
})

describe("resolveTerminalBundleId", () => {
  test("returns CONVOY_NOTIFY_APP_ID override when set", () => {
    expect(resolveTerminalBundleId({ CONVOY_NOTIFY_APP_ID: "com.example.app" })).toBe("com.example.app")
  })

  test("returns the bundle ID for a known terminal program", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "Apple_Terminal" })).toBe("com.apple.Terminal")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "iTerm.app" })).toBe("com.googlecode.iterm2")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "ghostty" })).toBe("com.mitchellh.ghostty")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "vscode" })).toBe("com.microsoft.VSCode")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "WarpTerminal" })).toBe("dev.warp.Warp-Stable")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "Hyper" })).toBe("co.zeit.hyper")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "WezTerm" })).toBe("com.github.wez.wezterm")
  })

  test("detects Ghostty from TERM when TERM_PROGRAM is unset", () => {
    expect(resolveTerminalBundleId({ TERM: "xterm-ghostty" })).toBe("com.mitchellh.ghostty")
    expect(resolveTerminalBundleId({ GHOSTTY_RESOURCES_DIR: "/some/path" })).toBe("com.mitchellh.ghostty")
  })

  test("returns undefined when the terminal is unknown", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "Alacritty" })).toBeUndefined()
    expect(resolveTerminalBundleId({})).toBeUndefined()
  })

  test("trims whitespace from env values", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "  Apple_Terminal  " })).toBe("com.apple.Terminal")
  })
})

describe("Notifier", () => {
  test("available returns false on non-darwin platforms", () => {
    const notifier = new Notifier({ platform: "linux" })
    expect(notifier.available).toBe(false)
  })

  test("available returns false when notifications are disabled", () => {
    const notifier = new Notifier({ platform: "darwin", settings: { enabled: false } })
    expect(notifier.available).toBe(false)
  })

  test("available returns true on darwin with notifications enabled", () => {
    const notifier = new Notifier({ platform: "darwin" })
    expect(notifier.available).toBe(true)
  })

  test("notify returns false when stopped", () => {
    const notifier = new Notifier({ platform: "darwin", settings: { enabled: true } })
    notifier.stop()
    expect(notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })).toBe(false)
  })

  test("notify returns false when not available", () => {
    const notifier = new Notifier({ platform: "linux" })
    expect(notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })).toBe(false)
  })

  test("notify returns false when the category is disabled", () => {
    const notifier = new Notifier({ platform: "darwin", settings: { steps: false } })
    expect(notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })).toBe(false)
  })

  test("notify returns true for a first-time event", () => {
    const { spawn } = fakeSpawn(0)
    const notifier = new Notifier({ platform: "darwin", spawn })
    expect(notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })).toBe(true)
  })

  test("notify throttles duplicate events within the window", () => {
    let now = 1000
    const { spawn } = fakeSpawn(0)
    const notifier = new Notifier({ platform: "darwin", spawn, now: () => now })
    expect(notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })).toBe(true)
    // 1 second later — still inside the 3s throttle window
    now = 2000
    expect(notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })).toBe(false)
  })

  test("notify lets a throttled event through after the window expires", () => {
    let now = 1000
    const { spawn } = fakeSpawn(0)
    const notifier = new Notifier({ platform: "darwin", spawn, now: () => now })
    notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })
    now = 5000 // 4 seconds later — past the 3s window
    expect(notifier.notify({ key: "test", category: "steps", title: "T", body: "B" })).toBe(true)
  })

  test("spawns osascript for delivery on darwin", async () => {
    const { spawn, commands } = fakeSpawn(0)
    const notifier = new Notifier({ platform: "darwin", spawn, settings: { sound: "Ping" } })
    notifier.notify({ key: "test", category: "finish", title: "Done", body: "Run finished" })
    // Give the async deliver a moment to spawn
    await new Promise((r) => setTimeout(r, 50))
    expect(commands.length).toBeGreaterThan(0)
    const osascript = commands.find((cmd) => cmd[0] === "osascript")
    expect(osascript).toBeDefined()
    expect(osascript!.join(" ")).toContain("display notification")
    expect(osascript!.join(" ")).toContain("sound name")
  })

  test("spawns osascript with attributed notification when a bundle ID is known", async () => {
    const { spawn, commands } = fakeSpawn(0)
    const notifier = new Notifier({
      platform: "darwin",
      spawn,
      env: { TERM_PROGRAM: "Apple_Terminal" },
    })
    notifier.notify({ key: "test", category: "finish", title: "Done", body: "Run finished" })
    await new Promise((r) => setTimeout(r, 50))
    const osascriptCalls = commands.filter((cmd) => cmd[0] === "osascript")
    expect(osascriptCalls.length).toBeGreaterThan(0)
    // The first call should be attributed (tell application id ...)
    expect(osascriptCalls[0]!.join(" ")).toContain("tell application id")
  })

  test("stop kills all children and drains them", async () => {
    const exitResolvers: Array<() => void> = []
    const spawn: NotifierSpawn = (command) => ({
      exited: new Promise<number>((resolve) => {
        exitResolvers.push(() => resolve(0))
      }),
      kill() {},
      unref() {},
    })
    const notifier = new Notifier({ platform: "darwin", spawn })
    notifier.notify({ key: "t", category: "finish", title: "T", body: "B" })
    await new Promise((r) => setTimeout(r, 10))
    await notifier.stop()
    // After stop, notify should return false
    expect(notifier.notify({ key: "t2", category: "finish", title: "T", body: "B" })).toBe(false)
  })

  test("notify with a custom now() respects throttling per key", () => {
    let now = 1000
    const { spawn } = fakeSpawn(0)
    const notifier = new Notifier({ platform: "darwin", spawn, now: () => now })
    // Different keys should not throttle each other
    expect(notifier.notify({ key: "a", category: "steps", title: "T", body: "B" })).toBe(true)
    expect(notifier.notify({ key: "b", category: "steps", title: "T", body: "B" })).toBe(true)
  })

  test("stop drains a slow child notification", async () => {
    const pendingExit = new Promise<number>(() => {}) // never resolves
    const slowSpawn: NotifierSpawn = () => ({
      exited: pendingExit,
      kill() {},
      unref() {},
    })
    const notifier = new Notifier({ platform: "darwin", spawn: slowSpawn })
    notifier.notify({ key: "slow", category: "finish", title: "T", body: "B" })
    // Give time for the notification to be tracked
    await new Promise((r) => setTimeout(r, 50))
    // Stop should kill the child and drain it (the slow promise times out after stopDrainMs)
    await notifier.stop()
    // After stop, notifications should be suppressed
    expect(notifier.notify({ key: "after", category: "finish", title: "T", body: "B" })).toBe(false)
  })

  test("stop drains a child that exits quickly", async () => {
    let resolveExit!: (code: number) => void
    const exitPromise = new Promise<number>((resolve) => { resolveExit = resolve })
    const quickSpawn: NotifierSpawn = () => ({
      exited: exitPromise,
      kill() {},
      unref() {},
    })
    const notifier = new Notifier({ platform: "darwin", spawn: quickSpawn })
    notifier.notify({ key: "quick", category: "finish", title: "T", body: "B" })
    await new Promise((r) => setTimeout(r, 50))
    // Resolve the child exit
    resolveExit!(0)
    await notifier.stop()
    expect(notifier.notify({ key: "after2", category: "finish", title: "T", body: "B" })).toBe(false)
  })
})