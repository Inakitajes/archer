import { describe, expect, test } from "bun:test"

import { parseQualityRubricWeights, parseQualityScoreReport, qualityDimensions, qualityDimensionWeights, qualityVerdict, weightedQualityScore, type QualityDimension, type QualityDimensionScores } from "../src/quality-score"

const dimensions: QualityDimensionScores = { prd: 92, tests: 70, security: 95, maintainability: 88, operational: 90, scope: 85 }

describe("weighted quality score", () => {
  test("computes the rubric v1 weighted total", () => {
    // 92*0.3 + 70*0.2 + 95*0.15 + 88*0.15 + 90*0.1 + 85*0.1 = 87.05 → 87
    expect(weightedQualityScore(dimensions)).toBe(87)
  })

  test("floors and caps out-of-range dimensions", () => {
    expect(weightedQualityScore({ ...dimensions, prd: 120 })).toBe(weightedQualityScore({ ...dimensions, prd: 100 }))
    expect(weightedQualityScore({ ...dimensions, tests: -40 })).toBe(weightedQualityScore({ ...dimensions, tests: 0 }))
  })

  test("is weighted toward prd and tests", () => {
    const weakPrd = weightedQualityScore({ ...dimensions, prd: 40 })
    const weakTests = weightedQualityScore({ ...dimensions, tests: 40 })
    const weakScope = weightedQualityScore({ ...dimensions, scope: 40 })
    expect(weakPrd).toBeLessThan(weakTests)
    expect(weakTests).toBeLessThan(weakScope)
  })

  test("honors a custom rubric's weights", () => {
    // A project rubric (.convoy/quality-rubric.md) overrides the v1 weights;
    // the canonical computation must follow the weights it is given, not
    // hardcode the defaults. 92*0.5 + 70*0.5 = 81.
    const customWeights: Record<QualityDimension, number> = { prd: 0.5, tests: 0.5, security: 0, maintainability: 0, operational: 0, scope: 0 }
    expect(weightedQualityScore(dimensions, customWeights)).toBe(81)
  })
})

describe("verdict thresholds", () => {
  test("maps scores to the four verdict bands", () => {
    expect(qualityVerdict(90)).toBe("ready")
    expect(qualityVerdict(99)).toBe("ready")
    expect(qualityVerdict(89)).toBe("ready-with-caveats")
    expect(qualityVerdict(75)).toBe("ready-with-caveats")
    expect(qualityVerdict(74)).toBe("not-ready")
    expect(qualityVerdict(60)).toBe("not-ready")
    expect(qualityVerdict(59)).toBe("failing")
    expect(qualityVerdict(0)).toBe("failing")
  })
})

describe("parseQualityScoreReport", () => {
  test("parses the fenced quality-score block", () => {
    const report = `# Quality Score Report

## Score
prd 92, tests 70, security 95, maintainability 88, operational 90, scope 85

\`\`\`quality-score
{
  "score": 87,
  "dimensions": {
    "prd": 92,
    "tests": 70,
    "security": 95,
    "maintainability": 88,
    "operational": 90,
    "scope": 85
  },
  "verdict": "ready-with-caveats",
  "mustFix": ["SC-3: no test protects the cancellation path (major)"],
  "gaps": {
    "tests": "Add a regression test that fails when cancellation is removed"
  },
  "confidence": "high"
}
\`\`\`
`
    const parsed = parseQualityScoreReport(report)

    expect(parsed?.score).toBe(87)
    expect(parsed?.dimensions).toEqual(dimensions)
    expect(parsed?.verdict).toBe("ready-with-caveats")
    expect(parsed?.mustFix).toEqual(["SC-3: no test protects the cancellation path (major)"])
    expect(parsed?.gaps?.tests).toContain("cancellation")
    expect(parsed?.confidence).toBe("high")
  })

  test("rejects a json-fenced block and a bare object", () => {
    const jsonFenced = `x\n\`\`\`json\n${JSON.stringify({ score: 91, dimensions, verdict: "ready", mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(jsonFenced)).toBeUndefined()

    const bare = `Preamble ${JSON.stringify({ score: 80, dimensions, verdict: "ready-with-caveats", mustFix: [] })} trailing`
    expect(parseQualityScoreReport(bare)).toBeUndefined()
  })

  test("uses the final quality-score block, not an earlier example", () => {
    const report = [
      "The scorer pasted the contract example earlier in the report;",
      "the authoritative block is the last one.",
      `\`\`\`quality-score\n${JSON.stringify({ score: 87, dimensions, mustFix: [] })}\n\`\`\`\n`,
      "Final consensus:",
      // The final block wins — and the score is the canonical weighted total of
      // its own dimensions (prd 100 → 89), not the number it declares.
      `\`\`\`quality-score\n${JSON.stringify({ score: 89, dimensions: { ...dimensions, prd: 100 }, mustFix: [] })}\n\`\`\`\n`,
    ].join("\n")
    expect(parseQualityScoreReport(report)?.score).toBe(89)
  })

  test("skips an invalid earlier block and uses the final valid one", () => {
    const report = [
      "```quality-score\n{ this is not json }\n```",
      `\`\`\`quality-score\n${JSON.stringify({ score: 87, dimensions, mustFix: [] })}\n\`\`\`\n`,
    ].join("\n")
    expect(parseQualityScoreReport(report)?.score).toBe(87)
  })

  test("parses a report where the final block is followed by text", () => {
    const report = `\`\`\`quality-score\n${JSON.stringify({ score: 80, dimensions, mustFix: [] })}\n\`\`\`\n\n(aside: the run is done)`
    expect(parseQualityScoreReport(report)?.score).toBe(87)
  })

  test("never treats a bare object with braces inside strings as a score block", () => {
    const bare = `Preamble ${JSON.stringify({ score: 80, dimensions, gaps: { tests: "use {x} and }y }" }, mustFix: [] })} trailing`
    // A bare-object fallback that counts braces naively mis-slices on braces
    // inside string values; the strict contract accepts only the fenced block.
    expect(parseQualityScoreReport(bare)).toBeUndefined()
  })

  test("parses a block whose JSON strings contain triple-backticks", () => {
    // A gap description that references a ```fenced``` code block must not close
    // the fence early: the parser finds the LAST ``` (the real closing fence)
    // instead of the first one inside the JSON string.
    const report = `\`\`\`quality-score\n${JSON.stringify({ score: 87, dimensions, gaps: { tests: "use a \`\`\`fenced\`\`\` block" }, mustFix: [] })}\n\`\`\`\n`
    const parsed = parseQualityScoreReport(report)
    expect(parsed).toBeDefined()
    expect(parsed?.score).toBe(87)
    expect(parsed?.gaps?.tests).toBe("use a ```fenced``` block")
  })

  test("derives the score from dimensions when omitted", () => {
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions, verdict: "ready-with-caveats", mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report)?.score).toBe(87)
  })

  test("derives the verdict from the score when omitted or wrong", () => {
    // The verdict derives from the canonical score computed from the
    // dimensions, never from a declared score or verdict an agent supplies.
    const high: QualityDimensionScores = { prd: 95, tests: 92, security: 96, maintainability: 93, operational: 95, scope: 94 }
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions: high, mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report)?.verdict).toBe("ready")

    const wrong = `\`\`\`quality-score\n${JSON.stringify({ score: 55, dimensions, verdict: "ready", mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(wrong)?.verdict).toBe("ready-with-caveats")
  })

  test("enforces the 80 floor for minor-only findings", () => {
    // The rubric promises: "a change whose only findings are minor cannot
    // score below 80." When every mustFix entry is tagged (minor), the score
    // is floored at 80 even if the dimensions weigh below that. Here the
    // dimensions are all 50 (weighted total 50), but the floor lifts it to 80.
    const lowDims: QualityDimensionScores = { prd: 50, tests: 50, security: 50, maintainability: 50, operational: 50, scope: 50 }
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions: lowDims, mustFix: ["SC-1: typo in comment (minor)", "SC-2: unused import (minor)"] })}\n\`\`\`\n`
    const parsed = parseQualityScoreReport(report)
    expect(parsed?.score).toBe(80)
    expect(parsed?.verdict).toBe("ready-with-caveats")
  })

  test("does not apply the 80 floor when any finding is non-minor", () => {
    // A single major finding means the floor does not apply; the score stays
    // at the weighted total even if it's below 80.
    const lowDims: QualityDimensionScores = { prd: 50, tests: 50, security: 50, maintainability: 50, operational: 50, scope: 50 }
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions: lowDims, mustFix: ["SC-1: typo (minor)", "SC-2: real bug (major)"] })}\n\`\`\`\n`
    const parsed = parseQualityScoreReport(report)
    expect(parsed?.score).toBe(50)
  })

  test("does not apply the 80 floor when there are no findings", () => {
    // The floor is about capping minor deductions, not inflating a clean
    // score; no findings means the weighted total stands as-is.
    const lowDims: QualityDimensionScores = { prd: 50, tests: 50, security: 50, maintainability: 50, operational: 50, scope: 50 }
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions: lowDims, mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report)?.score).toBe(50)
  })

  test("does not apply the 80 floor when a finding lacks a severity tag", () => {
    // A finding without a parseable (minor) tag is treated as non-minor so
    // a malformed report cannot exploit the floor.
    const lowDims: QualityDimensionScores = { prd: 50, tests: 50, security: 50, maintainability: 50, operational: 50, scope: 50 }
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions: lowDims, mustFix: ["SC-1: something without a tag"] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report)?.score).toBe(50)
  })

  test("never trusts a declared score that contradicts the dimensions", () => {
    // The canonical-score rule: the weighted total is computed in code from the
    // dimensions and weights; an agent's declared score is at most informative.
    const weak: QualityDimensionScores = { prd: 20, tests: 20, security: 20, maintainability: 20, operational: 10, scope: 10 }
    const report = `\`\`\`quality-score\n${JSON.stringify({ score: 100, dimensions: weak, mustFix: [] })}\n\`\`\`\n`
    const parsed = parseQualityScoreReport(report)
    expect(parsed?.score).not.toBe(100)
    if (parsed) expect(parsed.score).toBe(weightedQualityScore(weak))
  })

  test("derives the canonical score from the dimensions when the declared score is out of band", () => {
    const report = `\`\`\`quality-score\n${JSON.stringify({ score: 140.4, dimensions, verdict: "ready", mustFix: [] })}\n\`\`\`\n`
    // The declared score is not authoritative: the weighted total is recomputed
    // from the dimensions, which weigh to 87.
    expect(parseQualityScoreReport(report)?.score).toBe(87)
  })

  test("rejects dimensions outside 0–100", () => {
    const outOfRange = `\`\`\`quality-score\n${JSON.stringify({ score: 87, dimensions: { ...dimensions, prd: 120 }, mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(outOfRange)).toBeUndefined()
  })

  test("is undefined for reports without a parseable block", () => {
    expect(parseQualityScoreReport("# Quality Score Report\n\nno block here")).toBeUndefined()
    expect(parseQualityScoreReport("```quality-score\nnot json\n```")).toBeUndefined()
    expect(parseQualityScoreReport(`\`\`\`quality-score\n${JSON.stringify({ score: 90, dimensions: { prd: 90 }, mustFix: [] })}\n\`\`\`\n`)).toBeUndefined()
    expect(parseQualityScoreReport(`\`\`\`quality-score\n${JSON.stringify({ score: 90, dimensions: { ...dimensions, prd: "high" }, mustFix: [] })}\n\`\`\`\n`)).toBeUndefined()
    expect(parseQualityScoreReport("")).toBeUndefined()
  })

  test("keeps every dimension in the contract", () => {
    expect(qualityDimensions).toEqual(["prd", "tests", "security", "maintainability", "operational", "scope"])
  })

  test("honors project rubric weights passed to the canonical parser", () => {
    // A project rubric (.convoy/quality-rubric.md) overrides the v1 weights; the
    // canonical recompute must use the weights it is given, not hardcode the
    // defaults. With prd/tests each 50%, 92*0.5 + 70*0.5 = 81.
    const customWeights: Record<QualityDimension, number> = { prd: 0.5, tests: 0.5, security: 0, maintainability: 0, operational: 0, scope: 0 }
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions, mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report, customWeights)?.score).toBe(81)
  })

  test("falls back to the v1 weights when none are passed", () => {
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions, mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report)?.score).toBe(weightedQualityScore(dimensions))
  })
})

describe("parseQualityRubricWeights", () => {
  // A rubric file is the prose the scorer agents read. Its weight table is a
  // markdown table with a `| `dimension` | <n>% |` row per dimension; the parser
  // extracts and normalizes those weights so the canonical score matches the
  // rubric the scorers used rather than the hardcoded v1 defaults.
  const rubricTable = [
    "# Quality rubric (project override)",
    "",
    "| Dimension | Weight | What it measures |",
    "|---|---|---|",
    "| `prd` | 50% | The PRD is implemented. |",
    "| `tests` | 50% | Behavioral coverage. |",
    "| `security` | 0% | Security (de-prioritized for this project). |",
    "| `maintainability` | 0% | Maintainability. |",
    "| `operational` | 0% | Operational. |",
    "| `scope` | 0% | Scope. |",
  ].join("\n")

  test("parses a rubric weight table into normalized weights", () => {
    const weights = parseQualityRubricWeights(rubricTable)
    expect(weights).toBeDefined()
    if (!weights) return
    // 50/50/0/0/0/0 sums to 100, normalized to 0.5/0.5/0/0/0/0.
    expect(weights.prd).toBeCloseTo(0.5)
    expect(weights.tests).toBeCloseTo(0.5)
    expect(weights.security).toBe(0)
  })

  test("normalizes weights that do not sum to 100", () => {
    // 30/30/10/10/10/10 = 90; the parser normalizes proportionally so the
    // weighted total stays coherent rather than contradicting the dimensions.
    const weights = parseQualityRubricWeights(
      rubricTable
        .replace("| `prd` | 50% |", "| `prd` | 30% |")
        .replace("| `tests` | 50% |", "| `tests` | 30% |")
        .replace("| `security` | 0% |", "| `security` | 10% |")
        .replace("| `maintainability` | 0% |", "| `maintainability` | 10% |")
        .replace("| `operational` | 0% |", "| `operational` | 10% |")
        .replace("| `scope` | 0% |", "| `scope` | 10% |"),
    )
    expect(weights).toBeDefined()
    if (!weights) return
    const total = qualityDimensions.reduce((sum, d) => sum + weights[d], 0)
    expect(total).toBeCloseTo(1)
  })

  test("returns undefined when a dimension is missing", () => {
    const incomplete = rubricTable.replace("| `scope` | 0% | Scope. |", "")
    expect(parseQualityRubricWeights(incomplete)).toBeUndefined()
  })

  test("returns undefined when a weight is negative", () => {
    // A negative weight is malformed; the parser rejects it. (0% is legitimate —
    // a project may de-prioritize a dimension — so only negatives are rejected.)
    const bad = rubricTable.replace("| `prd` | 50% |", "| `prd` | -10% |")
    expect(parseQualityRubricWeights(bad)).toBeUndefined()
  })

  test("returns undefined when every weight is zero (normalization would divide by zero)", () => {
    const allZero = rubricTable
      .replace("| `prd` | 50% |", "| `prd` | 0% |")
      .replace("| `tests` | 50% |", "| `tests` | 0% |")
    expect(parseQualityRubricWeights(allZero)).toBeUndefined()
  })

  test("the default v1 weights are a complete, normalized set", () => {
    // Guard: the built-in fallback must always parse to a 1.0 sum so a missing
    // rubric never produces a contradictory score.
    const total = qualityDimensions.reduce((sum, d) => sum + qualityDimensionWeights[d], 0)
    expect(total).toBeCloseTo(1)
  })
})
