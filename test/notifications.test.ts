import { describe, expect, test } from "bun:test"

import { Notifier, resolveTerminalBundleId, type NotifierProcess } from "../src/notifications"
import type { NotificationEvent } from "../src/run-status"

const ghostty = { TERM_PROGRAM: "ghostty" }

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { key: "step-start:0", category: "steps", title: "convoy · feat/notify", body: "step 1/7 · plan — started", ...overrides }
}

/** Records every argv and lets the test decide each exit code. */
function recorder(exitCodes: number[] = []) {
  const commands: string[][] = []
  const spawn = (command: string[]): NotifierProcess => {
    commands.push(command)
    const code = exitCodes[commands.length - 1] ?? 0
    return { exited: Promise.resolve(code) }
  }
  return { commands, spawn }
}

/** The delivery is fire-and-forget; give its microtasks a turn before asserting. */
const flush = () => Bun.sleep(1)

describe("Notifier delivery", () => {
  test("attributes the banner to the host terminal so it carries that app's icon", async () => {
    const { commands, spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty })

    expect(notifier.notify(event())).toBe(true)
    await flush()

    expect(commands).toEqual([
      [
        "osascript",
        "-e",
        'tell application id "com.mitchellh.ghostty"',
        "-e",
        'display notification "step 1/7 · plan — started" with title "convoy · feat/notify"',
        "-e",
        "end tell",
      ],
    ])
  })

  test("falls back to a bare banner when the attributed one fails", async () => {
    const { commands, spawn } = recorder([1, 0])
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty })

    notifier.notify(event())
    await flush()

    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(["osascript", "-e", 'display notification "step 1/7 · plan — started" with title "convoy · feat/notify"'])
  })

  test("goes straight to a bare banner when the terminal is unknown", async () => {
    const { commands, spawn } = recorder()
    new Notifier({ platform: "darwin", spawn, env: {} }).notify(event())
    await flush()

    expect(commands).toHaveLength(1)
    expect(commands[0]![2]).toStartWith("display notification ")
  })

  test("a sound name is only added when configured", async () => {
    const { commands, spawn } = recorder()
    new Notifier({ platform: "darwin", spawn, env: {}, settings: { sound: "Ping" } }).notify(event())
    await flush()

    expect(commands[0]![2]).toBe('display notification "step 1/7 · plan — started" with title "convoy · feat/notify" sound name "Ping"')
  })

  test("quotes and backslashes in a body are escaped, never interpolated raw", async () => {
    const { commands, spawn } = recorder()
    const hostile = 'rm -rf "dist" && echo \\ pwned'
    new Notifier({ platform: "darwin", spawn, env: {} }).notify(event({ body: hostile }))
    await flush()

    const script = commands[0]![2]!
    expect(script).toContain('\\"dist\\"')
    expect(script).toContain("echo \\\\ pwned")
    // Argv array, never a shell string: the payload is one argument.
    expect(commands[0]![0]).toBe("osascript")
    expect(commands[0]).toHaveLength(3)
  })
})

describe("Notifier gating", () => {
  test("does nothing off macOS", async () => {
    const { commands, spawn } = recorder()
    const notifier = new Notifier({ platform: "linux", spawn, env: ghostty })

    expect(notifier.available).toBe(false)
    expect(notifier.notify(event())).toBe(false)
    await flush()
    expect(commands).toEqual([])
  })

  test("the master switch suppresses every category", async () => {
    const { commands, spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, settings: { enabled: false } })

    expect(notifier.available).toBe(false)
    expect(notifier.notify(event({ category: "failures" }))).toBe(false)
    await flush()
    expect(commands).toEqual([])
  })

  test("each category has its own switch", () => {
    const { spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, settings: { steps: false } })

    expect(notifier.notify(event({ category: "steps" }))).toBe(false)
    expect(notifier.notify(event({ key: "fail:0", category: "failures" }))).toBe(true)
  })

  test("stop() ends delivery for the rest of the run", () => {
    const { spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty })

    notifier.stop()
    expect(notifier.notify(event())).toBe(false)
  })
})

describe("Notifier throttling", () => {
  test("repeats of one key collapse inside the window, and fire again after it", () => {
    const { spawn } = recorder()
    let clock = 1_000
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, now: () => clock })

    expect(notifier.notify(event())).toBe(true)
    clock += 1_000
    expect(notifier.notify(event())).toBe(false)
    clock += 2_500
    expect(notifier.notify(event())).toBe(true)
  })

  test("waiting has a longer window than steps, so a live prompt does not re-fire", () => {
    const { spawn } = recorder()
    let clock = 1_000
    const wait = event({ key: "wait:permission:req-1", category: "waiting" })
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, now: () => clock })

    expect(notifier.notify(wait)).toBe(true)
    clock += 5_000
    expect(notifier.notify(wait)).toBe(false)
    clock += 6_000
    expect(notifier.notify(wait)).toBe(true)
  })

  test("different keys never throttle each other", () => {
    const { spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, now: () => 1_000 })

    expect(notifier.notify(event({ key: "step-start:0" }))).toBe(true)
    expect(notifier.notify(event({ key: "step-start:1" }))).toBe(true)
  })
})

describe("resolveTerminalBundleId", () => {
  test("maps the common terminals", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "ghostty" })).toBe("com.mitchellh.ghostty")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "iTerm.app" })).toBe("com.googlecode.iterm2")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "Apple_Terminal" })).toBe("com.apple.Terminal")
  })

  test("recognises Ghostty by TERM when TERM_PROGRAM is missing", () => {
    expect(resolveTerminalBundleId({ TERM: "xterm-ghostty" })).toBe("com.mitchellh.ghostty")
    expect(resolveTerminalBundleId({ GHOSTTY_RESOURCES_DIR: "/opt/ghostty" })).toBe("com.mitchellh.ghostty")
  })

  test("an explicit override beats detection", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "ghostty", CONVOY_NOTIFY_APP_ID: "com.example.Term" })).toBe("com.example.Term")
  })

  test("an unknown terminal resolves to nothing so the bare banner is used", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "something-else" })).toBeUndefined()
    expect(resolveTerminalBundleId({})).toBeUndefined()
  })
})
