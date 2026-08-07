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

// HN-001: concurrent append() calls must be serialized so the JSONL audit
// journal is never corrupted. The buggy implementation captures `writes` before
// updating it (`const write = writes.then(...); writes = write.catch(...)`), so
// two racing appends both chain on the same promise and interleave their
// appendFile calls, corrupting the journal. This asserts the invariant that
// N concurrent appends produce exactly N complete, parseable lines.
test("concurrent appends never interleave or drop JSONL lines (HN-001)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-race-"))
  dirs.push(dir)
  await mkdir(join(dir, "events"), { mode: 0o700 })
  const journal = await createAdvisorEventJournal({ dir, runID: "20260101-race-test" })

  const count = 50
  await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const event: AdvisorEvent = {
        id: `evt-${i}`,
        type: "advisor.requested",
        timestamp: new Date(i).toISOString(),
        callId: `call-${i}`,
        phase: "build",
        attempt: 1,
        trigger: "first-write",
        budget: { used: i, max: 3 },
        model: "anthropic/opus",
      }
      return journal.append(event)
    }),
  )

  const events = await readAdvisorEvents(dir)
  // Every event must survive: a race that interleaves or truncates lines would
  // silently drop events here (readAdvisorEvents skips corrupt lines).
  expect(events).toHaveLength(count)
  const ids = events.map((event) => event.id).sort()
  expect(ids).toEqual(Array.from({ length: count }, (_, i) => `evt-${i}`).sort())
})

// HN-001: concurrent append() calls must be serialized so the JSONL audit
// journal is never corrupted. The buggy implementation captures `writes` before
// updating it (`const write = writes.then(...); writes = write.catch(...)`), so
// two racing appends both chain on the same promise and interleave their
// appendFile calls, corrupting the journal. This asserts the invariant that
// N concurrent appends produce exactly N complete, parseable lines.
//
// Two test variants: batched (all fired at once via Promise.all) and
// interleaved (each waits for the previous but the promise chain is shared).
test("concurrent appends never interleave or drop JSONL lines (HN-001, batched)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-race-"))
  dirs.push(dir)
  await mkdir(join(dir, "events"), { mode: 0o700 })
  const journal = await createAdvisorEventJournal({ dir, runID: "20260101-race-test" })

  const count = 100
  await Promise.all(
    Array.from({ length: count }, (_, i) => {
      const event: AdvisorEvent = {
        id: `evt-${i}`,
        type: "advisor.requested",
        timestamp: new Date(i).toISOString(),
        callId: `call-${i}`,
        phase: "build",
        attempt: 1,
        trigger: "first-write",
        budget: { used: i, max: 3 },
        model: "anthropic/opus",
      }
      // Do NOT await inside the loop - fire all at once into the shared chain.
      return journal.append(event)
    }),
  )

  const events = await readAdvisorEvents(dir)
  expect(events).toHaveLength(count)
  const ids = events.map((event) => event.id).sort()
  expect(ids).toEqual(Array.from({ length: count }, (_, i) => `evt-${i}`).sort())
})

// HN-001 interleaved variant: each append starts while the previous one is
// still in-flight (awaiting its write), stressing the shared `writes` chain.
test("concurrent appends never interleave or drop JSONL lines (HN-001, interleaved)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-race-2"))
  dirs.push(dir)
  await mkdir(join(dir, "events"), { mode: 0o700 })
  const journal = await createAdvisorEventJournal({ dir, runID: "20260101-race-2" })

  const count = 100
  const promises = []
  for (let i = 0; i < count; i++) {
    const event: AdvisorEvent = {
      id: `evt-${i}`,
      type: "advisor.requested",
      timestamp: new Date(i).toISOString(),
      callId: `call-${i}`,
      phase: "build",
      attempt: 1,
      trigger: "first-write",
      budget: { used: i, max: 3 },
      model: "anthropic/opus",
    }
    // Call append but don't await; collect the promise
    promises.push(journal.append(event))
  }
  await Promise.all(promises)

  const events = await readAdvisorEvents(dir)
  expect(events).toHaveLength(count)
  const ids = events.map((event) => event.id).sort()
  expect(ids).toEqual(Array.from({ length: count }, (_, i) => `evt-${i}`).sort())
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
