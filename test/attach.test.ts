import { afterAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { overallStatus, reconcileAdvisorJournal, replayHistory } from "../src/attach-runtime"
import { noopProgress } from "../src/progress"

import type { AdvisorEvent } from "../src/advisor-events"
import type { PhaseMetadata, RunMetadata } from "../src/metadata"
import type { ProgressPhaseSnapshot, ProgressUI } from "../src/progress"

const dirs: string[] = []
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

function metadata(phases: Record<string, PhaseMetadata>): RunMetadata {
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

test("overall status requires every recorded phase to finish cleanly", () => {
  expect(overallStatus(metadata({ design: { status: "completed" }, review: { status: "skipped" } }))).toBe("completed")
  expect(overallStatus(metadata({ design: { status: "completed" }, review: { status: "failed" } }))).toBe("failed")
  expect(overallStatus(metadata({}))).toBe("failed")
})

test("history replay restores sessions and maps interrupted phases to failed", () => {
  const sessions: Array<[string, string]> = []
  const restored: Array<[string, ProgressPhaseSnapshot]> = []
  const progress: ProgressUI = {
    ...noopProgress,
    phaseSession: (name, sessionID) => sessions.push([name, sessionID]),
    phaseRestored: (name, snapshot) => restored.push([name, snapshot]),
  }

  replayHistory(progress, metadata({
    design: { status: "completed", sessionID: "ses-design", cost: 0.1 },
    build: { status: "running", sessionID: "ses-build" },
    review: { status: "pending" },
  }))

  expect(sessions).toEqual([["design", "ses-design"], ["build", "ses-build"]])
  expect(restored).toEqual([
    ["design", expect.objectContaining({ status: "completed", sessionID: "ses-design", cost: 0.1 })],
    ["build", expect.objectContaining({ status: "failed", sessionID: "ses-build" })],
  ])
})

test("advisor journal reconciliation restores events missing from metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-attach-runtime-"))
  dirs.push(dir)
  await mkdir(join(dir, "events"))
  const event: AdvisorEvent = {
    id: "evt-1",
    type: "advisor.requested",
    timestamp: new Date(0).toISOString(),
    callId: "call-1",
    phase: "design",
    attempt: 1,
    trigger: "completion",
    budget: { used: 1, max: 2 },
    model: "anthropic/opus",
  }
  await writeFile(join(dir, "events", "advisor.jsonl"), `${JSON.stringify(event)}\n`)
  const run = metadata({})

  await reconcileAdvisorJournal(run, dir)

  expect(run.phases.design).toMatchObject({
    status: "pending",
    advisorEvents: [event],
    advisor: { attempted: 1 },
  })
})
