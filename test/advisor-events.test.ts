import { appendFile, mkdir, mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, expect, test } from "bun:test"

import { aggregateAdvisorEvents, auditText, createAdvisorEventJournal, readAdvisorEvents, type AdvisorEvent } from "../src/advisor-events"

const dirs: string[] = []
afterAll(async () => Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }))))

test("advisor journal appends private JSONL and tolerates a partial tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-events-"))
  dirs.push(dir)
  await mkdir(join(dir, "events"), { mode: 0o700 })
  const journal = await createAdvisorEventJournal({ dir, runID: "20260101-000000-test" })
  const event: AdvisorEvent = {
    id: "evt-1",
    type: "advisor.requested",
    timestamp: new Date(0).toISOString(),
    callId: "call-1",
    phase: "build",
    attempt: 1,
    trigger: "first-write",
    budget: { used: 1, max: 3 },
    model: "anthropic/opus",
  }
  await journal.append(event)
  await appendFile(journal.path, '{"type":"advisor.requested"')
  expect(await readAdvisorEvents(dir)).toEqual([event])
  expect((await stat(journal.path)).mode & 0o777).toBe(0o600)
})

test("audit policies retain full text only with explicit opt-in", () => {
  expect(auditText("secret advice", "summary", "advice")).toMatchObject({ adviceChars: 13 })
  expect(auditText("secret advice", "summary", "advice")).toHaveProperty("adviceHash")
  expect(auditText("secret advice", "redacted", "advice")).toEqual({ adviceChars: 13 })
  expect(auditText("secret advice", "full", "advice")).toEqual({ advice: "secret advice", adviceChars: 13 })
})

test("aggregates lifecycle events without treating delivery or feedback as new calls", () => {
  const base = {
    timestamp: new Date(0).toISOString(),
    callId: "call-1",
    phase: "build",
    attempt: 2,
    trigger: "completion" as const,
    budget: { used: 1, max: 3 },
  }
  const events: AdvisorEvent[] = [
    { ...base, id: "1", type: "advisor.requested", model: "anthropic/opus" },
    {
      ...base,
      id: "2",
      type: "advisor.completed",
      model: "anthropic/opus",
      latencyMs: 12,
      adviceChars: 7,
      usage: { model: "anthropic/opus", cost: 0.04, tokens: { input: 10, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 } },
    },
    { ...base, id: "3", type: "advisor.delivered", delivery: "follow-up" },
    { ...base, id: "4", type: "advisor.feedback", outcome: "partially-adopted" },
    { ...base, id: "5", callId: "call-2", type: "advisor.budget_exhausted" },
    { ...base, id: "6", callId: "call-3", type: "advisor.failed", model: "anthropic/opus", latencyMs: 8, error: { code: "unavailable" } },
  ]

  expect(aggregateAdvisorEvents(events)).toEqual({
    attempted: 1,
    succeeded: 1,
    failed: 1,
    exhausted: 1,
    delivered: 1,
    byTrigger: { completion: 1 },
    cost: 0.04,
    tokens: { input: 10, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 },
    feedback: { "partially-adopted": 1 },
    callIds: ["call-1"],
    lastAt: base.timestamp,
  })
})
