import { dirname } from "node:path"

import { aggregateAdvisorEvents, readAdvisorEvents } from "./advisor-events"
import { readRunMetadata, type PhaseMetadata, type RunMetadata } from "./metadata"
import { watchSession, type SessionWatcher } from "./runner"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"
import type { ProgressPhaseSnapshot, ProgressUI } from "./progress"

const pollMs = 1_000

/** Mirrors a live run's activity into the dashboard without driving the run. */
export class LiveAttach {
  readonly serverGone: Promise<void>
  private resolveServerGone!: () => void
  private readonly watchers = new Map<string, SessionWatcher>()
  private readonly started = new Set<string>()
  private readonly sessions = new Set<string>()
  private readonly finalized = new Set<string>()
  private poll?: ReturnType<typeof setInterval>
  private stopped = false

  constructor(
    private readonly client: OpencodeClient,
    private readonly tui: ProgressUI,
    private readonly targetDir: string,
    private readonly metaPath: string,
    private readonly phasesWithoutLiveAttach: ReadonlySet<string> = new Set(),
  ) {
    this.serverGone = new Promise((resolve) => {
      this.resolveServerGone = resolve
    })
  }

  async start() {
    await this.tick()
    this.poll = setInterval(() => void this.tick(), pollMs)
    this.poll.unref?.()
  }

  private async tick() {
    if (this.stopped) return
    const metadata = await readRunMetadata(this.metaPath)
    if (!metadata) return

    await reconcileAdvisorJournal(metadata, dirname(this.metaPath))

    for (const [name, phase] of Object.entries(metadata.phases)) {
      if (phase.sessionID && !this.sessions.has(name)) {
        this.tui.phaseSession(name, phase.sessionID)
        this.sessions.add(name)
      }
      if (phase.status === "running") {
        if (!this.started.has(name)) {
          this.started.add(name)
          this.tui.phaseStarted(name)
          if (phase.model) this.tui.phaseAttempt(name, { attempt: 1, model: phase.model })
        }
        for (const event of phase.advisorEvents ?? []) this.tui.phaseAdvisorEvent(name, event)
        if (!this.phasesWithoutLiveAttach.has(name)) this.watch(name, phase.sessionID)
      } else if (phase.status !== "pending" && !this.finalized.has(name)) {
        this.finalized.add(name)
        this.tui.phaseRestored(name, snapshotOf(phase, phase.status))
        this.drop(name)
      }
    }

    if (!metadata.server && !this.stopped) this.resolveServerGone()
  }

  private watch(name: string, sessionID: string | undefined) {
    if (!sessionID || this.watchers.has(name)) return
    const watcher = watchSession(this.client, {
      directory: this.targetDir,
      phaseName: name,
      sessionID,
      progress: this.tui,
      signal: new AbortController().signal,
    })
    this.watchers.set(name, watcher)
    watcher.result.then(
      () => this.drop(name),
      () => this.drop(name),
    )
  }

  private drop(name: string) {
    const watcher = this.watchers.get(name)
    if (!watcher) return
    this.watchers.delete(name)
    void watcher.stop().catch(() => {})
  }

  async stop() {
    if (this.stopped) return
    this.stopped = true
    if (this.poll) clearInterval(this.poll)
    await Promise.all([...this.watchers.values()].map((watcher) => watcher.stop().catch(() => {})))
    this.watchers.clear()
  }
}

/** Merge the authoritative append-only journal over metadata's convenience projection. */
export async function reconcileAdvisorJournal(metadata: RunMetadata, runDir: string) {
  const advisorEvents = await readAdvisorEvents(runDir)
  for (const name of new Set(advisorEvents.map((event) => event.phase))) {
    const events = advisorEvents.filter((event) => event.phase === name)
    const phase = (metadata.phases[name] ??= { status: "pending" })
    phase.advisorEvents = events
    phase.advisor = aggregateAdvisorEvents(events)
  }
}

/** Restore persisted phase state into a progress UI. */
export function replayHistory(tui: ProgressUI, metadata: RunMetadata) {
  for (const [name, phase] of Object.entries(metadata.phases)) {
    if (phase.sessionID) tui.phaseSession(name, phase.sessionID)
    if (phase.status === "pending") continue
    const status = phase.status === "running" ? "failed" : phase.status
    tui.phaseRestored(name, snapshotOf(phase, status))
  }
}

function snapshotOf(phase: PhaseMetadata, status: ProgressPhaseSnapshot["status"]): ProgressPhaseSnapshot {
  return {
    status,
    sessionID: phase.sessionID,
    durationMs: phase.durationMs,
    cost: phase.cost,
    tokens: phase.tokens,
    model: phase.model,
    advisor: phase.advisor,
    advisorEvents: phase.advisorEvents,
  }
}

/** Completed only when every recorded phase completed or was skipped. */
export function overallStatus(metadata: RunMetadata): "completed" | "failed" {
  const statuses = Object.values(metadata.phases).map((phase) => phase.status)
  const allDone = statuses.length > 0 && statuses.every((status) => status === "completed" || status === "skipped")
  return allDone ? "completed" : "failed"
}

/**
 * Waits until the run recorded at `metaPath` has a live OpenCode server entry,
 * then returns its URL. The coordinator writes `metadata.server` when the
 * server is ready — before that (a fresh iteration booting, a run just
 * spawned) the entry is absent. `abort` races the wait: when it resolves the
 * caller is leaving (detach) or the coordinator died, and undefined comes
 * back so nobody starts an attach against a server that will never exist.
 */
export async function waitForServerUrl(metaPath: string, abort: Promise<unknown>, pollMs = 250): Promise<string | undefined> {
  for (;;) {
    const metadata = await readRunMetadata(metaPath).catch(() => undefined)
    if (metadata?.server?.url) return metadata.server.url
    const winner = await Promise.race([
      Bun.sleep(pollMs).then(() => "poll" as const),
      Promise.resolve(abort).then(() => "abort" as const),
    ])
    if (winner === "abort") return undefined
  }
}
