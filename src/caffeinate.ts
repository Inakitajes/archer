import type { KeepAwakeState, ProgressUI } from "./progress"

export type CaffeinateProcess = {
  exited: Promise<number>
  kill(): void
}

export type CaffeinateSpawn = (command: string[]) => CaffeinateProcess

export type CaffeinateOptions = {
  platform?: NodeJS.Platform
  pid?: number
  spawn?: CaffeinateSpawn
}

/**
 * Owns Convoy's optional macOS sleep assertion. It is deliberately scoped to
 * this process: run metadata must never make a later run keep a different
 * machine awake.
 */
export class Caffeinate {
  private readonly platform: NodeJS.Platform
  private readonly pid: number
  private readonly spawn: CaffeinateSpawn
  private state: KeepAwakeState
  private child?: CaffeinateProcess
  private progress?: ProgressUI
  private tail: Promise<unknown> = Promise.resolve()

  constructor(options: CaffeinateOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.pid = options.pid ?? process.pid
    this.spawn = options.spawn ?? ((command) => Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" }))
    this.state = this.platform === "darwin" ? { status: "off" } : { status: "unavailable", detail: "Keep-awake is available on macOS only" }
  }

  bind(progress: ProgressUI) {
    this.progress = progress
    this.publish()
  }

  snapshot(): KeepAwakeState {
    return this.state
  }

  toggle(): Promise<void> {
    return this.serial(() => (this.state.status === "on" ? this.stopNow() : this.startNow()))
  }

  stop(): Promise<void> {
    return this.serial(() => this.stopNow())
  }

  private serial(job: () => Promise<void> | void): Promise<void> {
    const run = this.tail.then(job, job)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private startNow() {
    if (this.state.status === "unavailable" || this.child) return
    let child: CaffeinateProcess
    try {
      // -d prevents display sleep, -i prevents idle system sleep, and -w makes
      // caffeinate exit automatically if Convoy itself disappears unexpectedly.
      child = this.spawn(["caffeinate", "-d", "-i", "-w", String(this.pid)])
    } catch (error) {
      this.transition({ status: "off", detail: `Couldn't start caffeinate: ${formatError(error)}` })
      return
    }

    this.child = child
    this.transition({ status: "on" })
    void child.exited.then(
      (code) => this.exited(child, code),
      (error) => this.exited(child, undefined, error),
    )
  }

  private async stopNow() {
    if (this.state.status === "unavailable") return
    const child = this.child
    this.child = undefined
    if (child) {
      try {
        child.kill()
      } catch {
        // The process may already have exited between clearing the reference and
        // sending SIGTERM. Its exit handler is intentionally now a no-op.
      }
      await child.exited.catch(() => undefined)
    }
    this.transition({ status: "off" })
  }

  private exited(child: CaffeinateProcess, code?: number, error?: unknown) {
    if (this.child !== child) return
    this.child = undefined
    const suffix = error ? formatError(error) : `status ${code ?? "unknown"}`
    this.transition({ status: "off", detail: `Caffeinate stopped unexpectedly (${suffix})` })
  }

  private transition(state: KeepAwakeState) {
    this.state = state
    this.publish()
  }

  private publish() {
    this.progress?.keepAwakeState?.(this.state)
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
