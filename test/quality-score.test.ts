import { describe, expect, test } from "bun:test"

import { parseQualityScoreReport, qualityVerdict, qualityDimensions, weightedQualityScore, type QualityDimension, type QualityDimensionScores } from "../src/quality-score"

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
      `\`\`\`quality-score\n${JSON.stringify({ score: 92, dimensions: { ...dimensions, prd: 95 }, mustFix: [] })}\n\`\`\`\n`,
    ].join("\n")
    expect(parseQualityScoreReport(report)?.score).toBe(92)
  })

  test("skips an invalid earlier block and uses the final valid one", () => {
    const report = [
      "```quality-score\n{ this is not json }\n```",
      `\`\`\`quality-score\n${JSON.stringify({ score: 84, dimensions, mustFix: [] })}\n\`\`\`\n`,
    ].join("\n")
    expect(parseQualityScoreReport(report)?.score).toBe(84)
  })

  test("rejects a report where the final block is not at the end", () => {
    const report = `\`\`\`quality-score\n${JSON.stringify({ score: 80, dimensions, mustFix: [] })}\n\`\`\`\n\n(aside: the run is done)`
    expect(parseQualityScoreReport(report)).toBeUndefined()
  })

  test("never treats a bare object with braces inside strings as a score block", () => {
    const bare = `Preamble ${JSON.stringify({ score: 80, dimensions, gaps: { tests: "use {x} and }y }" }, mustFix: [] })} trailing`
    // A bare-object fallback that counts braces naively mis-slices on braces
    // inside string values; the strict contract accepts only the fenced block.
    expect(parseQualityScoreReport(bare)).toBeUndefined()
  })

  test("derives the score from dimensions when omitted", () => {
    const report = `\`\`\`quality-score\n${JSON.stringify({ dimensions, verdict: "ready-with-caveats", mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report)?.score).toBe(87)
  })

  test("derives the verdict from the score when omitted or wrong", () => {
    const report = `\`\`\`quality-score\n${JSON.stringify({ score: 96, dimensions, mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(report)?.verdict).toBe("ready")

    const wrong = `\`\`\`quality-score\n${JSON.stringify({ score: 55, dimensions, verdict: "ready", mustFix: [] })}\n\`\`\`\n`
    expect(parseQualityScoreReport(wrong)?.verdict).toBe("failing")
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
})
