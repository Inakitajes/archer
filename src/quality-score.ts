/**
 * The machine-readable quality-score contract shared by the quality-scorer and
 * quality-score-report agents, and parsed by the runner.
 *
 * The scorer agents emit a fenced `quality-score` JSON block at the end of
 * their report. This module validates that block, computes the canonical
 * weighted total from the dimensions and weights in code, and derives the
 * verdict. The goal loop (--goal) reads this from reports/score-report.md to
 * decide whether to keep iterating, so the score is a control signal computed
 * here — never an agent-supplied number taken on faith.
 */

import { log } from "./log"

export const qualityDimensions = ["prd", "tests", "security", "maintainability", "operational", "scope"] as const

export type QualityDimension = (typeof qualityDimensions)[number]

export type QualityDimensionScores = Record<QualityDimension, number>

export type QualityScoreVerdict = "ready" | "ready-with-caveats" | "not-ready" | "failing"

export type QualityScore = {
  /** Weighted total, 0–100. */
  score: number
  /** Per-dimension scores, 0–100 each. */
  dimensions: QualityDimensionScores
  /** Derived from `score`: ready (≥90) · ready-with-caveats (75–89) · not-ready (60–74) · failing (<60). */
  verdict: QualityScoreVerdict
  /** Findings that must be resolved before merge, each prefixed by its finding id and tagged with its absolute severity. */
  mustFix: string[]
  /** Concrete actions that would raise the score, one per weak dimension; the goal-fix loop acts on these. */
  gaps?: Partial<Record<QualityDimension, string>>
  confidence?: "high" | "medium" | "low"
}

/** The rubric v1 weights; a project rubric (.convoy/quality-rubric.md) may override them, but the parser must know the defaults. */
export const qualityDimensionWeights: Record<QualityDimension, number> = {
  prd: 0.3,
  tests: 0.2,
  security: 0.15,
  maintainability: 0.15,
  operational: 0.1,
  scope: 0.1,
}

/** Weighted sum of the per-dimension scores, rounded to the nearest integer. */
export function weightedQualityScore(dimensions: QualityDimensionScores, weights: Record<QualityDimension, number> = qualityDimensionWeights): number {
  const total = qualityDimensions.reduce((sum, dimension) => sum + (clampScore(dimensions[dimension]) / 100) * weights[dimension], 0)
  return Math.round(total * 100)
}

export function qualityVerdict(score: number): QualityScoreVerdict {
  if (score >= 90) return "ready"
  if (score >= 75) return "ready-with-caveats"
  if (score >= 60) return "not-ready"
  return "failing"
}

/** The pipeline's authoritative scorer step, when it has one: the step running the quality-score-report agent. */
export function consensusStep(
  pipeline: { steps: readonly { type: string; agentName?: string; reportPath?: string }[] },
): { type: string; agentName?: string; reportPath: string } | undefined {
  const step = pipeline.steps.find((candidate) => candidate.type === "agent" && candidate.agentName === "quality-score-report")
  return step && step.reportPath ? { ...step, reportPath: step.reportPath } : undefined
}

/**
 * Extracts and validates the `quality-score` JSON block from a scorer report.
 *
 * Strict contract: the report must end with exactly one `quality-score` fenced
 * block (no `json` alias, no bare-object fallback), that block must be the last
 * thing in the report, and it must contain valid, in-range data. A report that
 * fails any of that yields undefined so the caller can treat the scorer as
 * having failed the contract — it is safer to reject an ambiguous or accidental
 * object than to take it as a control signal.
 */
export function parseQualityScoreReport(markdown: string): QualityScore | undefined {
  const block = extractQualityScoreBlock(markdown)
  if (!block) return undefined

  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined

  const dimensions = parseDimensions(parsed.dimensions)
  if (!dimensions) return undefined

  // The score is always recomputed in code from the dimensions and the rubric
  // weights. An agent-declared score is at most informative: a report whose
  // declared score contradicts its own dimensions must not drive the loop.
  const score = weightedQualityScore(dimensions)
  const declaredScore = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : undefined
  if (declaredScore !== undefined && Math.abs(declaredScore - score) > 1) {
    log.warn(
      `quality score: declared score ${declaredScore} disagrees with the dimensions (weighted total ${score}); using the computed score`,
    )
  }

  const mustFix = Array.isArray(parsed.mustFix) ? parsed.mustFix.filter((item): item is string => typeof item === "string") : []

  // The verdict is a pure function of the score: trusting an agent-supplied
  // verdict that contradicts its own numbers would let an inconsistent report
  // pass as consistent, and the goal loop reads this.
  const verdict = qualityVerdict(score)

  const gaps = parseGaps(parsed.gaps)
  const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low" ? parsed.confidence : undefined

  return { score, dimensions, verdict, mustFix, ...(gaps ? { gaps } : {}), ...(confidence ? { confidence } : {}) }
}

/**
 * Finds the report's authoritative quality-score block: the last
 * `quality-score` fence, which must also end the report (only whitespace may
 * follow its closing fence). Blocks earlier in the report are examples, not
 * results, and trailing content after the final block makes the report
 * malformed rather than selecting a different candidate.
 */
function extractQualityScoreBlock(markdown: string): string | undefined {
  const fence = /```quality-score\s*\n([\s\S]*?)```/gi
  let match: RegExpExecArray | null
  let last: RegExpExecArray | null = null
  while ((match = fence.exec(markdown)) !== null) last = match
  if (!last) return undefined
  if (markdown.slice(last.index + last[0].length).trim() !== "") return undefined
  return last[1].trim()
}

function parseDimensions(value: unknown): QualityDimensionScores | undefined {
  if (!isRecord(value)) return undefined
  const dimensions = {} as QualityDimensionScores
  for (const dimension of qualityDimensions) {
    const raw = value[dimension]
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
    // Dimensions are contract-bounded: an out-of-range value is a malformed
    // report, not a value to clamp into shape.
    if (raw < 0 || raw > 100) return undefined
    dimensions[dimension] = Math.round(raw)
  }
  return dimensions
}

function parseGaps(value: unknown): Partial<Record<QualityDimension, string>> | undefined {
  if (!isRecord(value)) return undefined
  const gaps: Partial<Record<QualityDimension, string>> = {}
  for (const dimension of qualityDimensions) {
    const raw = value[dimension]
    if (typeof raw === "string" && raw.trim() !== "") gaps[dimension] = raw
  }
  return Object.keys(gaps).length > 0 ? gaps : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value))
}
