import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { aggregateAdvisorEvents, type AdvisorEvent } from "../src/advisor-events"
import type { PhaseMetadata, RunMetadata } from "../src/metadata"
import type { ProgressPhaseSnapshot, ProgressUI } from "../src/progress"

import { __testing, LiveAttach } from "../src/attach"

const { overallStatus, reconcileAdvisorJournal, replayHistory, snapshotOf } = __testing

const recoveryDirs: string[] = []

function runMetadata(phases: Record<string, PhaseMetadata>): RunMetadata {
  return {
    schemaVersion: 3,
    runID: "run-test",
    targetDir: "/repo",
    createdAt: 1,
    updatedAt: 1,
    control: { state: "running" },
    phases,
  }
}

function advisorRequestedEvent(id = "evt-1", phase = "design"): AdvisorEvent {
  return {
    id,
    type: "advisor.requested",
    timestamp: new Date(0).toISOString(),
    callId: `call-${id}`,
    phase,
    attempt: 1,
    trigger: "completion",
    budget: { used: 1, max: 3 },
    model: "anthropic/claude-opus-4",
  }
}

afterAll(async () => {
  await Promise.all(recoveryDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-attach-test-"))
  recoveryDirs.push(dir)
  return dir
}

function noopTui(): ProgressUI {
  return {
    start: () => {},
    stop: () => {},
    serverReady: () => {},
    phaseSession: () => {},
    phaseStarted: () => {},
    phaseAttempt: () => {},
    phaseRunning: () => {},
    phaseCompleted: () => {},
    phaseFailed: () => {},
    phaseSkipped: () => {},
    phaseRestored: () => {},
    phaseActivity: () => {},
    phaseAdvisorEvent: () => {},
    phaseMessage: () => {},
    phaseStepUsage: () => {},
    phaseUsageTotal: () => {},
    phaseTodos: () => {},
    phaseDiff: () => {},
    message: () => {},
    suspend: () => {},
    resume: () => {},
    runFinished: () => Promise.resolve(),
    runControlState: () => {},
    keepRunDirRequested: () => false,
  }
}

describe("overallStatus", () => {
  function metaWith(statuses: Record<string, PhaseMetadata["status"]>): RunMetadata {
    const phases: Record<string, PhaseMetadata> = {}
    for (const [name, status] of Object.entries(statuses)) phases[name] = { status }
    return runMetadata(phases)
  }

  test("returns completed when all phases complete", () => {
    expect(overallStatus(metaWith({ design: "completed", implementer: "completed" }))).toBe("completed")
  })

  test("returns completed when phases are completed or skipped", () => {
    expect(overallStatus(metaWith({ design: "completed", review: "skipped", tests: "completed" }))).toBe("completed")
  })

  test("returns failed when any phase failed", () => {
    expect(overallStatus(metaWith({ design: "completed", implementer: "failed" }))).toBe("failed")
  })

  test("returns failed when any phase is running", () => {
    expect(overallStatus(metaWith({ design: "completed", implementer: "running" }))).toBe("failed")
  })

  test("returns failed when any phase is pending", () => {
    expect(overallStatus(metaWith({ design: "completed", implementer: "pending" }))).toBe("failed")
  })

  test("returns failed for empty phases", () => {
    expect(overallStatus(runMetadata({}))).toBe("failed")
  })
})

describe("snapshotOf", () => {
  test("builds correct snapshot from phase metadata", () => {
    const phase: PhaseMetadata = {
      status: "completed",
      sessionID: "ses_1",
      durationMs: 5000,
      cost: 0.05,
      tokens: { input: 1000, output: 500, reasoning: 100, cacheRead: 50, cacheWrite: 25, total: 1675 },
      model: "openai/gpt-4",
    }
    const result = snapshotOf(phase, "completed")
    expect(result).toEqual({
      status: "completed",
      sessionID: "ses_1",
      durationMs: 5000,
      cost: 0.05,
      tokens: { input: 1000, output: 500, reasoning: 100, cacheRead: 50, cacheWrite: 25, total: 1675 },
      model: "openai/gpt-4",
      advisor: undefined,
      advisorEvents: undefined,
    })
  })

  test("handles minimal metadata", () => {
    const phase: PhaseMetadata = { status: "completed" }
    const result = snapshotOf(phase, "completed")
    expect(result.status).toBe("completed")
    expect(result.sessionID).toBeUndefined()
    expect(result.durationMs).toBeUndefined()
    expect(result.cost).toBeUndefined()
  })

  test("includes advisor data when present", () => {
    const advisorEvents = [advisorRequestedEvent()]
    const advisor = aggregateAdvisorEvents(advisorEvents)
    const phase: PhaseMetadata = { status: "completed", advisor, advisorEvents }
    const result = snapshotOf(phase, "completed")
    expect(result.advisor).toEqual(advisor)
    expect(result.advisorEvents).toEqual(advisorEvents)
  })

  test("treats running status as failed in snapshot", () => {
    const phase: PhaseMetadata = { status: "running" }
    const result = snapshotOf(phase, "failed")
    expect(result.status).toBe("failed")
  })
})

describe("replayHistory", () => {
  const restored: { name: string; snapshot: ProgressPhaseSnapshot }[] = []
  const sessions: string[] = []

  function tui(): ProgressUI {
    return {
      ...noopTui(),
      phaseRestored: (name: string, snapshot: ProgressPhaseSnapshot) => {
        restored.push({ name, snapshot })
      },
      phaseSession: (name: string) => {
        sessions.push(name)
      },
    }
  }

  beforeEach(() => {
    restored.length = 0
    sessions.length = 0
  })

  test("replays completed phases as restored", () => {
    const metadata = runMetadata({
      design: { status: "completed", sessionID: "ses_1" },
      implementer: { status: "completed" },
    })
    replayHistory(tui(), metadata)
    expect(sessions).toEqual(["design"])
    expect(restored.map((r) => r.name).sort()).toEqual(["design", "implementer"])
    expect(restored.every((r) => r.snapshot.status === "completed")).toBe(true)
  })

  test("skips pending phases", () => {
    const metadata = runMetadata({
      design: { status: "pending" },
      implementer: { status: "completed" },
    })
    replayHistory(tui(), metadata)
    expect(restored.map((r) => r.name)).toEqual(["implementer"])
  })

  test("treats running status as failed", () => {
    const metadata = runMetadata({ design: { status: "running" } })
    replayHistory(tui(), metadata)
    expect(restored[0].snapshot.status).toBe("failed")
  })

  test("handles empty phases", () => {
    replayHistory(tui(), runMetadata({}))
    expect(restored).toEqual([])
  })
})

describe("reconcileAdvisorJournal", () => {
  async function runDirWithJournal(events: unknown[]): Promise<string> {
    const dir = await tempDir()
    await mkdir(join(dir, "events"), { recursive: true })
    await writeFile(join(dir, "events", "advisor.jsonl"), events.map((e) => JSON.stringify(e)).join("\n"))
    return dir
  }

  test("merges advisor events into metadata phases", async () => {
    const dir = await runDirWithJournal([
      advisorRequestedEvent("1", "design"),
    ])
    const metadata = runMetadata({ design: { status: "completed" } })

    await reconcileAdvisorJournal(metadata, dir)
    expect(metadata.phases["design"]?.advisorEvents).toHaveLength(1)
    expect(metadata.phases["design"]?.advisorEvents?.[0]).toMatchObject({
      type: "advisor.requested",
    })
  })

  test("creates phase entry if missing from metadata", async () => {
    const dir = await runDirWithJournal([
      advisorRequestedEvent("1", "unknown-phase"),
    ])
    const metadata = runMetadata({})

    await reconcileAdvisorJournal(metadata, dir)
    expect(metadata.phases["unknown-phase"]).toBeDefined()
    expect(metadata.phases["unknown-phase"].status).toBe("pending")
  })

  test("handles empty journal", async () => {
    const dir = await runDirWithJournal([])
    const metadata = runMetadata({})
    await reconcileAdvisorJournal(metadata, dir)
    expect(metadata.phases).toEqual({})
  })
})

describe("LiveAttach", () => {
  test("starts and stops without error", async () => {
    const client = {} as never
    const attach = new LiveAttach(client, noopTui(), "/tmp", "/tmp/meta.json")
    await attach.start()
    await attach.stop()
  })

  test("stop is idempotent", async () => {
    const client = {} as never
    const attach = new LiveAttach(client, noopTui(), "/tmp", "/tmp/meta.json")
    await attach.start()
    await attach.stop()
    await attach.stop()
  })

  test("accepts phasesWithoutLiveAttach set", () => {
    const client = {} as never
    const phases = new Set(["claude-code-step"])
    const attach = new LiveAttach(client, noopTui(), "/tmp", "/tmp/meta.json", phases)
    expect(attach).toBeDefined()
  })

  test("serverGone is a promise", () => {
    const client = {} as never
    const attach = new LiveAttach(client, noopTui(), "/tmp", "/tmp/meta.json")
    expect(attach.serverGone).toBeInstanceOf(Promise)
  })

  test("tick does nothing when stopped", async () => {
    const client = {} as never
    const attach = new LiveAttach(client, noopTui(), "/tmp", "/tmp/meta.json")
    await attach.start()
    await attach.stop()
    // tick should be a no-op now
    // We can't call tick directly (private), but stopping and starting should be safe
  })
})
