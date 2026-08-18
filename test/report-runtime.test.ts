import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { createReportRuntime } from "../src/report-runtime"
import { isScoringAgent, maxReportMarkdownChars } from "../src/report"
import { qualityDimensionWeights } from "../src/quality-score"
import type { AgentStep, DeliverableContract } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-report-runtime-"))
  dirs.push(dir)
  return dir
}

function phase(extra: Partial<AgentStep> = {}): AgentStep {
  return {
    type: "agent",
    name: "review",
    stepName: "review",
    groupId: "g1",
    agentName: "bug-auditor",
    description: "Review",
    model: "openai/gpt-5.6-terra",
    inputFiles: ["prd.md"],
    inputDiff: false,
    reportPath: "reports/review.md",
    ...extra,
  }
}

const markdown: DeliverableContract = { kind: "markdown-report" }
const dimensions = { prd: 92, tests: 70, security: 95, maintainability: 88, operational: 90, scope: 85 }

describe("report runtime", () => {
  test("writes the owning phase report atomically and retains its candidate", async () => {
    const dir = await workspace()
    const reports = createReportRuntime(dir)
    const handle = reports.begin("ses_1", phase(), markdown, qualityDimensionWeights)

    const result = await handle.write({ markdown: "# Findings\n\nNo blockers." })
    expect("markdown" in result && result.markdown).toContain("# Findings")
    expect(await readFile(join(dir, "reports/review.md"), "utf8")).toBe("# Findings\n\nNo blockers.")
    expect(handle.candidate).toBe("# Findings\n\nNo blockers.")
    expect((await readdir(join(dir, "reports"))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("serializes repeated writes so the last report wins", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin("ses_1", phase(), markdown, qualityDimensionWeights)

    await Promise.all([handle.write({ markdown: "first" }), handle.write({ markdown: "second" })])
    expect(handle.candidate).toBe("second")
    expect(await readFile(join(dir, "reports/review.md"), "utf8")).toBe("second")
  })

  test("forgets sessions once their phase ends", async () => {
    const reports = createReportRuntime(await workspace())
    const handle = reports.begin("ses_1", phase(), markdown, qualityDimensionWeights)
    await handle.write({ markdown: "completed" })
    expect(reports.handleFor("ses_1")).toBeDefined()
    handle.end()
    expect(reports.handleFor("ses_1")).toBeUndefined()
    expect(reports.candidateFor("ses_1")).toBe("completed")
  })

  test("rejects empty markdown and score arguments from ordinary agents", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin("ses_1", phase(), markdown, qualityDimensionWeights)

    expect(await handle.write({ markdown: "" })).toEqual({ error: "markdown must be a non-empty string" })
    expect(await handle.write({ markdown: "report", dimensions })).toEqual({ error: "only quality-scorer and quality-score-report may supply scoring fields" })
    expect(await handle.write({ markdown: "x".repeat(maxReportMarkdownChars + 1) })).toEqual({
      error: `markdown must be at most ${maxReportMarkdownChars} characters`,
    })
  })

  test("renders scorer inputs into the canonical score report and rejects malformed dimensions", async () => {
    const dir = await workspace()
    const handle = createReportRuntime(dir).begin(
      "ses_1",
      phase({ agentName: "quality-score-report", reportPath: "reports/score.md" }),
      { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 },
      qualityDimensionWeights,
    )

    expect(await handle.write({ markdown: "score", dimensions: { ...dimensions, tests: 101 } })).toEqual({ error: "dimensions.tests must be 0–100" })
    const result = await handle.write({ markdown: "# Score", dimensions, mustFix: ["SC-1: nit (minor)"], confidence: "high" })
    expect("markdown" in result && result.markdown).toContain("\"score\": 87")
    expect("markdown" in result && result.markdown).toContain("\"verdict\": \"ready-with-caveats\"")
    expect("markdown" in result && result.markdown).toContain("```quality-score")
  })

  test("never accepts agent-supplied score or verdict", async () => {
    const handle = createReportRuntime(await workspace()).begin(
      "ses_1",
      phase({ agentName: "quality-scorer" }),
      { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 },
      qualityDimensionWeights,
    )
    expect(await handle.write({ markdown: "score", dimensions, score: 100, verdict: "ready" })).toEqual({
      error: "write_report does not accept score or verdict; Convoy derives both from dimensions",
    })
  })
})

describe("isScoringAgent", () => {
  test("recognizes the scorer agents and their read-only/verify variants", () => {
    expect(isScoringAgent("quality-scorer")).toBe(true)
    expect(isScoringAgent("quality-score-report")).toBe(true)
    // The runner appends __ro (read-only) and __verify (verify-only) suffixes to
    // the agent name; a scorer variant must still be allowed to score.
    expect(isScoringAgent("quality-scorer__ro")).toBe(true)
    expect(isScoringAgent("quality-score-report__verify")).toBe(true)
  })

  test("rejects ordinary agents, including their read-only/verify variants", () => {
    expect(isScoringAgent("bug-auditor")).toBe(false)
    expect(isScoringAgent("bug-auditor__ro")).toBe(false)
    expect(isScoringAgent("implementer__verify")).toBe(false)
    // A name that merely contains the scorer prefix is not a scorer.
    expect(isScoringAgent("quality-scorer-clone")).toBe(false)
  })

  test("a read-only scorer variant can still supply scoring fields through the runtime", async () => {
    const handle = createReportRuntime(await workspace()).begin(
      "ses_1",
      phase({ agentName: "quality-scorer__ro" }),
      { kind: "quality-score-report", schemaVersion: 1, retryOnMissingOrInvalid: 1 },
      qualityDimensionWeights,
    )
    const result = await handle.write({ markdown: "# Score", dimensions, mustFix: [], confidence: "medium" })
    expect("error" in result).toBe(false)
    expect("markdown" in result && result.markdown).toContain("```quality-score")
  })
})

describe("report runtime workspace boundary", () => {
  test("rejects a report path that escapes the workspace", () => {
    const reports = createReportRuntime("/tmp/convoy-boundary-root")
    expect(() =>
      reports.begin(
        "ses_1",
        phase({ reportPath: "../escape.md" }),
        markdown,
        qualityDimensionWeights,
      ),
    ).toThrow(/outside workspace/)
    // An absolute path outside the root is rejected the same way.
    expect(() =>
      reports.begin(
        "ses_2",
        phase({ reportPath: "/etc/convoy-report.md" }),
        markdown,
        qualityDimensionWeights,
      ),
    ).toThrow(/outside workspace/)
  })
})
