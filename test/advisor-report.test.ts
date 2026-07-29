import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { readAdvisorSplit, renderAdvisorSplit } from "../src/advisor-report"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function runDirWith(logs: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-report-"))
  dirs.push(dir)
  await mkdir(join(dir, "logs"), { recursive: true })
  for (const [name, body] of Object.entries(logs)) {
    await writeFile(join(dir, "logs", name), typeof body === "string" ? body : JSON.stringify(body))
  }
  return dir
}

describe("readAdvisorSplit", () => {
  test("separates executor and advisor spend across attempts", async () => {
    const dir = await runDirWith({
      "build.1.json": { cost: 1.2, tokens: { output: 8_000, reasoning: 2_000 }, advisor: { calls: 2, cost: 0.05, outputTokens: 1_200 } },
      "tests.1.json": { cost: 0.4, tokens: { output: 3_000, reasoning: 0 }, advisor: { calls: 1, cost: 0.02, outputTokens: 600 } },
    })

    const split = await readAdvisorSplit(dir)

    expect(split.executor).toEqual({ cost: 1.6, outputTokens: 13_000 })
    expect(split.advisor).toEqual({ calls: 3, cost: 0.07000000000000001, outputTokens: 1_800, inputTokens: 0 })
    // 1800 / 14800
    expect(split.advisorOutputShare).toBeCloseTo(0.1216, 4)
  })

  test("reports zero advisor usage for a run that had none", async () => {
    const dir = await runDirWith({ "build.1.json": { cost: 1, tokens: { output: 500, reasoning: 0 } } })
    const split = await readAdvisorSplit(dir)

    expect(split.advisor).toEqual({ calls: 0, cost: 0, outputTokens: 0, inputTokens: 0 })
    expect(split.advisorOutputShare).toBe(0)
  })

  test("ignores the claude-code stream logs and unparseable files", async () => {
    const dir = await runDirWith({
      "audit.1.claude.jsonl": '{"type":"result"}',
      "audit.1.claude.json": { cost: 99 },
      "broken.1.json": "{ not json",
      "build.1.json": { cost: 1, tokens: { output: 100 } },
    })

    expect((await readAdvisorSplit(dir)).executor.cost).toBe(1)
  })

  test("returns empty rather than throwing when the run has no logs directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-advisor-report-empty-"))
    dirs.push(dir)

    expect(await readAdvisorSplit(dir)).toEqual({ executor: { cost: 0, outputTokens: 0 }, advisor: { cost: 0, outputTokens: 0, inputTokens: 0, calls: 0 } })
  })

  test("uses the event journal for failed calls and per-phase trigger reporting", async () => {
    const dir = await runDirWith({ "build.1.json": { cost: 1, tokens: { output: 4_000 } } })
    await mkdir(join(dir, "events"), { recursive: true })
    const base = { timestamp: new Date(0).toISOString(), phase: "build", attempt: 1, trigger: "on-demand", budget: { used: 1, max: 3 } }
    await writeFile(join(dir, "events", "advisor.jsonl"), [
      JSON.stringify({ ...base, id: "1", callId: "a", type: "advisor.requested", model: "anthropic/opus" }),
      JSON.stringify({ ...base, id: "2", callId: "a", type: "advisor.failed", model: "anthropic/opus", latencyMs: 10, error: { code: "unavailable", message: "down" } }),
    ].join("\n"))

    const split = await readAdvisorSplit(dir)
    expect(split.advisor.calls).toBe(1)
    expect(split.phases?.build).toMatchObject({ attempted: 1, failed: 1, byTrigger: { "on-demand": 1 } })
    expect(renderAdvisorSplit(split)).toContain("| build | 1 | 0 | 1 |")
  })

  test("merges attempt-log events the journal lost without double counting", async () => {
    const base = { timestamp: new Date(0).toISOString(), phase: "build", attempt: 1, trigger: "on-demand", budget: { used: 1, max: 3 } }
    const requested = { ...base, id: "1", callId: "a", type: "advisor.requested", model: "anthropic/opus" }
    const completed = {
      ...base,
      id: "2",
      callId: "a",
      type: "advisor.completed",
      model: "anthropic/opus",
      latencyMs: 10,
      adviceChars: 5,
      usage: { model: "anthropic/opus", cost: 0.05, tokens: { input: 100, output: 20, reasoning: 0, cacheRead: 0, cacheWrite: 0 } },
    }
    // The journal persisted only the request; the completion survived solely in
    // the attempt log's fallback copy. The legacy advisor block must be skipped
    // either way: cost comes from the merged events exactly once.
    const dir = await runDirWith({
      "build.1.json": { cost: 1, tokens: { output: 4_000 }, advisor: { calls: 1, cost: 0.05, outputTokens: 20, inputTokens: 100 }, advisorEvents: [requested, completed] },
    })
    await mkdir(join(dir, "events"), { recursive: true })
    await writeFile(join(dir, "events", "advisor.jsonl"), `${JSON.stringify(requested)}\n`)

    const split = await readAdvisorSplit(dir)
    expect(split.advisor.calls).toBe(1)
    expect(split.advisor.cost).toBe(0.05)
    expect(split.advisor.outputTokens).toBe(20)
    expect(split.phases?.build).toMatchObject({ attempted: 1, succeeded: 1, cost: 0.05 })

    // And when the journal lost everything, the same attempt log alone yields
    // the same totals rather than doubling them across both readers.
    const journalGone = await runDirWith({
      "build.1.json": { cost: 1, tokens: { output: 4_000 }, advisor: { calls: 1, cost: 0.05, outputTokens: 20, inputTokens: 100 }, advisorEvents: [requested, completed] },
    })
    const splitGone = await readAdvisorSplit(journalGone)
    expect(splitGone.advisor.calls).toBe(1)
    expect(splitGone.advisor.cost).toBe(0.05)
    expect(splitGone.advisor.outputTokens).toBe(20)
  })
})

describe("renderAdvisorSplit", () => {
  const healthy = {
    executor: { cost: 1.6, outputTokens: 13_000 },
    advisor: { cost: 0.07, outputTokens: 1_800, inputTokens: 41_000, calls: 3 },
    advisorOutputShare: 0.1216,
  }

  test("reports both sides, including the advisor's input, which is what actually drives its cost", () => {
    const rendered = renderAdvisorSplit(healthy)

    expect(rendered).toContain("Consultations: 3")
    expect(rendered).toContain("$1.6000")
    expect(rendered).toContain("13,000 output tokens")
    expect(rendered).toContain("41,000 input tokens")
    expect(rendered).toContain("Advisor share of output: 12.2%")
  })

  test("stays quiet on a healthy split rather than warning by default", () => {
    const rendered = renderAdvisorSplit(healthy)

    expect(rendered).not.toContain("too small to judge")
    expect(rendered).not.toContain("share of output is high")
    expect(rendered).not.toContain("exceeded executor spend")
  })

  test("declines to judge a run too small to be informative", () => {
    // The numbers from a real one-step e2e run: 95 executor tokens against 206
    // advisor tokens reads as 68% and means nothing about the pattern.
    const rendered = renderAdvisorSplit({
      executor: { cost: 0.0038, outputTokens: 95 },
      advisor: { cost: 0.0953, outputTokens: 206, inputTokens: 41_629, calls: 2 },
      advisorOutputShare: 0.684,
    })

    expect(rendered).toContain("too small to judge")
    expect(rendered).not.toContain("share of output is high")
  })

  test("flags a genuinely inverted split", () => {
    const rendered = renderAdvisorSplit({
      executor: { cost: 1, outputTokens: 6_000 },
      advisor: { cost: 0.5, outputTokens: 9_000, inputTokens: 50_000, calls: 4 },
      advisorOutputShare: 0.6,
    })

    expect(rendered).toContain("share of output is high")
  })

  test("attributes advisor spend above executor spend to the transcript, not the advice", () => {
    const rendered = renderAdvisorSplit({
      executor: { cost: 0.1, outputTokens: 9_000 },
      advisor: { cost: 0.9, outputTokens: 1_000, inputTokens: 300_000, calls: 3 },
      advisorOutputShare: 0.1,
    })

    expect(rendered).toContain("exceeded executor spend")
    expect(rendered).toContain("frequency")
  })

  test("renders nothing for a run with no consultations", () => {
    expect(renderAdvisorSplit({ executor: { cost: 1, outputTokens: 10 }, advisor: { cost: 0, outputTokens: 0, inputTokens: 0, calls: 0 } })).toBeUndefined()
  })
})
