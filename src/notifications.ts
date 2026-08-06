import type { NotificationCategory, NotificationEvent } from "./run-status"

export type NotifierProcess = {
  exited: Promise<number>
  kill?(signal?: NodeJS.Signals): void
  unref?(): void
}
export type NotifierSpawn = (command: string[]) => NotifierProcess

/** The `notifications:` block from .convoy/config.yaml, already merged with defaults. */
export type NotificationSettings = {
  enabled: boolean
  steps: boolean
  waiting: boolean
  failures: boolean
  finish: boolean
  terminalTitle: boolean
  /** macOS system sound name (e.g. "Ping"); empty means silent. */
  sound: string
}

export const defaultNotificationSettings: NotificationSettings = {
  enabled: true,
  steps: true,
  waiting: true,
  failures: true,
  finish: true,
  terminalTitle: true,
  sound: "",
}

/**
 * Per-category throttle windows. Step ends are short (they only need to absorb
 * the burst when a wide group finishes at once); waits are long because a
 * permission prompt the user is already looking at must not re-fire.
 */
const throttleMs: Record<NotificationCategory, number> = {
  steps: 3_000,
  failures: 3_000,
  finish: 3_000,
  waiting: 10_000,
}

/** A stalled osascript call is best effort, not permission to hold a run open. */
const deliveryTimeoutMs = 10_000
const deliveryKillGraceMs = 1_000
const stopDrainMs = 250

/**
 * Attributing the notification to the host terminal gives it that app's icon
 * and notification settings, instead of the generic Script Editor banner a bare
 * `display notification` produces.
 */
// Only terminals that actually export TERM_PROGRAM belong here. kitty and
// Alacritty, for instance, do not set it at all, so listing them would look
// like coverage while never matching. Anything missing falls back to the bare
// banner, and CONVOY_NOTIFY_APP_ID covers the rest.
const terminalBundleIds: Record<string, string> = {
  ghostty: "com.mitchellh.ghostty",
  "iTerm.app": "com.googlecode.iterm2",
  Apple_Terminal: "com.apple.Terminal",
  WezTerm: "com.github.wez.wezterm",
  vscode: "com.microsoft.VSCode",
  Hyper: "co.zeit.hyper",
  WarpTerminal: "dev.warp.Warp-Stable",
}

export type NotifierOptions = {
  platform?: NodeJS.Platform
  spawn?: NotifierSpawn
  settings?: Partial<NotificationSettings>
  env?: Record<string, string | undefined>
  now?: () => number
}

/** Escapes a value for interpolation into an AppleScript string literal. */
function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function resolveTerminalBundleId(env: Record<string, string | undefined>): string | undefined {
  const override = env.CONVOY_NOTIFY_APP_ID?.trim()
  if (override) return override
  const program = env.TERM_PROGRAM?.trim()
  if (program && terminalBundleIds[program]) return terminalBundleIds[program]
  // Ghostty does not always export TERM_PROGRAM, but it always sets TERM.
  if (env.TERM === "xterm-ghostty" || env.GHOSTTY_RESOURCES_DIR) return terminalBundleIds.ghostty
  return undefined
}

/**
 * Convoy's optional desktop notifications. Deliberately best effort: a run must
 * never fail, stall, or log noise because macOS declined to show a banner.
 *
 * Scoped to this process like Caffeinate — nothing here is persisted with the
 * run, so a later run can never resurrect another machine's notifications.
 */
export class Notifier {
  private readonly platform: NodeJS.Platform
  private readonly spawn: NotifierSpawn
  private readonly env: Record<string, string | undefined>
  private readonly now: () => number
  private readonly settings: NotificationSettings
  private readonly lastSent = new Map<string, number>()
  private readonly children = new Map<NotifierProcess, Promise<number>>()
  private stopped = false

  constructor(options: NotifierOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? ((command) => Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }))
    this.env = options.env ?? process.env
    this.now = options.now ?? (() => Date.now())
    this.settings = { ...defaultNotificationSettings, ...options.settings }
  }

  get available(): boolean {
    return this.platform === "darwin" && this.settings.enabled
  }

  /** Stops delivery, terminates active children, and drains their exits briefly. */
  async stop() {
    if (this.stopped) return
    this.stopped = true
    const children = [...this.children]
    for (const [child] of children) this.kill(child)
    await Promise.all(children.map(([, exited]) => this.drain(exited)))
  }

  /**
   * Fire and forget. Returns whether the event passed the gates, so tests (and
   * callers that care) can assert suppression without waiting on a subprocess.
   */
  notify(event: NotificationEvent): boolean {
    if (this.stopped || !this.available) return false
    if (!this.settings[event.category]) return false

    const at = this.now()
    const previous = this.lastSent.get(event.key)
    if (previous !== undefined && at - previous < throttleMs[event.category]) return false
    this.lastSent.set(event.key, at)

    void this.deliver(event.title, event.body)
    return true
  }

  /**
   * Attributed banner first, bare banner as a fallback. Both go through
   * osascript with an argv array — never a shell string — so a branch name or a
   * shell command echoed into the body cannot escape into an interpreter.
   */
  private async deliver(title: string, body: string) {
    const sound = this.settings.sound.trim()
    const notification = [
      `display notification ${appleString(body)}`,
      `with title ${appleString(title)}`,
      ...(sound ? [`sound name ${appleString(sound)}`] : []),
    ].join(" ")

    const bundleId = resolveTerminalBundleId(this.env)
    if (bundleId) {
      const attributed = await this.osascript([`tell application id ${appleString(bundleId)}`, notification, "end tell"])
      if (attributed || this.stopped) return
    }
    await this.osascript([notification])
  }

  private async osascript(lines: string[]): Promise<boolean> {
    const args: string[] = []
    for (const line of lines) args.push("-e", line)
    try {
      const child = this.spawn(["osascript", ...args])
      return (await this.track(child)) === 0
    } catch {
      // Notifications are best effort: a missing binary, a denied permission,
      // or a spawn limit must never surface into the run.
      return false
    }
  }

  private track(child: NotifierProcess): Promise<number> {
    child.unref?.()
    let timeout: ReturnType<typeof setTimeout> | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const exited = child.exited.catch(() => -1)
    const tracked = exited.finally(() => {
      if (timeout) clearTimeout(timeout)
      if (forceKill) clearTimeout(forceKill)
      this.children.delete(child)
    })
    this.children.set(child, tracked)
    timeout = setTimeout(() => {
      this.kill(child)
      forceKill = setTimeout(() => this.kill(child, "SIGKILL"), deliveryKillGraceMs)
      forceKill.unref?.()
    }, deliveryTimeoutMs)
    timeout.unref?.()
    return tracked
  }

  private kill(child: NotifierProcess, signal?: NodeJS.Signals) {
    try {
      child.kill?.(signal)
    } catch {
      // The child may have exited between tracking and teardown.
    }
  }

  private async drain(exited: Promise<number>) {
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(resolve, stopDrainMs)
      void exited.then(() => {
        clearTimeout(timeout)
        resolve()
      })
    })
  }
}
