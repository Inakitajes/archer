import { describe, expect, test } from "bun:test"

import {
  Notifier,
  defaultNotificationSettings,
  resolveTerminalBundleId,
  type NotifierProcess,
  type NotifierSpawn,
} from "../src/notifications"
import type { NotificationEvent } from "../src/run-status"

const ghostty = { TERM_PROGRAM: "ghostty" }

function event(overrides: Partial<NotificationEvent> = {}): NotificationEvent {
  return { key: "step-start:0", category: "steps", title: "convoy · feat/notify", body: "step 1/7 · plan — started", ...overrides }
}

/** Records exact argv and exposes a deterministic barrier for asynchronous fallback delivery. */
function recorder(exitCodes: number[] = []) {
  const commands: string[][] = []
  const waiters: Array<{ count: number; resolve: () => void }> = []
  const spawn: NotifierSpawn = (command) => {
    commands.push(command)
    const code = exitCodes[commands.length - 1] ?? 0
    for (let index = waiters.length - 1; index >= 0; index--) {
      const waiter = waiters[index]!
      if (commands.length < waiter.count) continue
      waiters.splice(index, 1)
      waiter.resolve()
    }
    return { exited: Promise.resolve(code) }
  }
  const waitForCommands = async (count: number) => {
    if (commands.length < count) await new Promise<void>((resolve) => waiters.push({ count, resolve }))
    // The command is recorded synchronously inside spawn. Let the promise
    // returned by `exited` and Notifier's tracking/fallback continuations drain
    // too, without a wall-clock sleep.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  }
  return { commands, spawn, waitForCommands }
}

describe("Notifier delivery", () => {
  test("attributes the banner to the host terminal with exact argv", async () => {
    const { commands, spawn, waitForCommands } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty })

    expect(notifier.notify(event())).toBe(true)
    await waitForCommands(1)

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
    const { commands, spawn, waitForCommands } = recorder([1, 0])
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty })

    notifier.notify(event())
    await waitForCommands(2)

    expect(commands).toHaveLength(2)
    expect(commands[1]).toEqual(["osascript", "-e", 'display notification "step 1/7 · plan — started" with title "convoy · feat/notify"'])
  })

  test("goes straight to a bare banner when the terminal is unknown", async () => {
    const { commands, spawn, waitForCommands } = recorder()
    new Notifier({ platform: "darwin", spawn, env: {} }).notify(event())
    await waitForCommands(1)

    expect(commands).toEqual([
      ["osascript", "-e", 'display notification "step 1/7 · plan — started" with title "convoy · feat/notify"'],
    ])
  })

  test("adds a sound name only when configured", async () => {
    const { commands, spawn, waitForCommands } = recorder()
    new Notifier({ platform: "darwin", spawn, env: {}, settings: { sound: "Ping" } }).notify(event())
    await waitForCommands(1)

    expect(commands[0]).toEqual([
      "osascript",
      "-e",
      'display notification "step 1/7 · plan — started" with title "convoy · feat/notify" sound name "Ping"',
    ])
  })

  test("escapes hostile quotes and backslashes inside one argv element", async () => {
    const { commands, spawn, waitForCommands } = recorder()
    const hostile = 'rm -rf "dist" && echo \\ pwned'
    new Notifier({ platform: "darwin", spawn, env: {} }).notify(event({ body: hostile }))
    await waitForCommands(1)

    expect(commands[0]).toEqual([
      "osascript",
      "-e",
      'display notification "rm -rf \\"dist\\" && echo \\\\ pwned" with title "convoy · feat/notify"',
    ])
  })
})

describe("Notifier gating", () => {
  test("does nothing off macOS", () => {
    const { commands, spawn } = recorder()
    const notifier = new Notifier({ platform: "linux", spawn, env: ghostty })

    expect(notifier.available).toBe(false)
    expect(notifier.notify(event())).toBe(false)
    expect(commands).toEqual([])
  })

  test("the master switch suppresses every category", () => {
    const { commands, spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, settings: { enabled: false } })

    expect(notifier.available).toBe(false)
    expect(notifier.notify(event({ category: "failures" }))).toBe(false)
    expect(commands).toEqual([])
  })

  test("each category has its own switch", () => {
    const { spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, settings: { steps: false } })

    expect(notifier.notify(event({ category: "steps" }))).toBe(false)
    expect(notifier.notify(event({ key: "fail:0", category: "failures" }))).toBe(true)
  })

  test("stop ends delivery for the rest of the run", async () => {
    const { spawn } = recorder()
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty })

    await notifier.stop()
    expect(notifier.notify(event())).toBe(false)
  })

  test("stop kills and drains an unsettled notification child", async () => {
    let resolveExit!: (code: number) => void
    let kills = 0
    const child: NotifierProcess = {
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve
      }),
      kill() {
        kills++
        resolveExit(1)
      },
    }
    const spawn: NotifierSpawn = () => child
    const notifier = new Notifier({ platform: "darwin", spawn, env: {} })

    notifier.notify(event())
    await notifier.stop()

    expect(kills).toBe(1)
    expect(await child.exited).toBe(1)
  })
})

describe("Notifier throttling", () => {
  test("repeats of one key collapse inside the window and fire after it", () => {
    const { spawn } = recorder()
    let clock = 1_000
    const notifier = new Notifier({ platform: "darwin", spawn, env: ghostty, now: () => clock })

    expect(notifier.notify(event())).toBe(true)
    clock += 1_000
    expect(notifier.notify(event())).toBe(false)
    clock += 2_500
    expect(notifier.notify(event())).toBe(true)
  })

  test("waiting has a longer window than steps", () => {
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

describe("notification settings and terminal detection", () => {
  test("defaults enable every category without a sound", () => {
    expect(defaultNotificationSettings).toEqual({
      enabled: true,
      steps: true,
      waiting: true,
      failures: true,
      finish: true,
      terminalTitle: true,
      sound: "",
    })
  })

  test("maps common terminals and trims their names", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "ghostty" })).toBe("com.mitchellh.ghostty")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "iTerm.app" })).toBe("com.googlecode.iterm2")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "  Apple_Terminal  " })).toBe("com.apple.Terminal")
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "WezTerm" })).toBe("com.github.wez.wezterm")
  })

  test("recognizes Ghostty without TERM_PROGRAM", () => {
    expect(resolveTerminalBundleId({ TERM: "xterm-ghostty" })).toBe("com.mitchellh.ghostty")
    expect(resolveTerminalBundleId({ GHOSTTY_RESOURCES_DIR: "/opt/ghostty" })).toBe("com.mitchellh.ghostty")
  })

  test("an explicit override beats detection", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "ghostty", CONVOY_NOTIFY_APP_ID: "com.example.Term" })).toBe("com.example.Term")
  })

  test("an unknown terminal resolves to nothing", () => {
    expect(resolveTerminalBundleId({ TERM_PROGRAM: "something-else" })).toBeUndefined()
    expect(resolveTerminalBundleId({})).toBeUndefined()
  })
})
