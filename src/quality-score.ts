/**
 * The machine-readable quality-score contract shared by the quality-scorer and
 * quality-score-report agents, and parsed by the runner.
 *
 * The scorer agents emit a fenced `quality-score` JSON block at the end of
 * their report. This module validates that block, computes the weighted total
 * when a report omits it, and derives the verdict. The goal loop (--goal) will
 * read this from reports/score-report.md to decide whether to keep iterating.
 */

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
 * Accepts the fenced block (```quality-score or ```json), or a bare JSON object
 * when no fence is present. A report without a parseable block yields undefined
 * so the caller can decide how to treat a scorer that failed the contract.
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

  const score = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? Math.round(clampScore(parsed.score)) : weightedQualityScore(dimensions)

  const mustFix = Array.isArray(parsed.mustFix) ? parsed.mustFix.filter((item): item is string => typeof item === "string") : []

  // The verdict is a pure function of the score: trusting an agent-supplied
  // verdict that contradicts its own numbers would let an inconsistent report
  // pass as consistent, and the goal loop reads this.
  const verdict = qualityVerdict(score)

  const gaps = parseGaps(parsed.gaps)
  const confidence = parsed.confidence === "high" || parsed.confidence === "medium" || parsed.confidence === "low" ? parsed.confidence : undefined

  return { score, dimensions, verdict, mustFix, ...(gaps ? { gaps } : {}), ...(confidence ? { confidence } : {}) }
}

function extractQualityScoreBlock(markdown: string): string | undefined {
  const fenced = /```(?:quality-score|json)\s*\n([\s\S]*?)```/i.exec(markdown)
  if (fenced) return fenced[1].trim()

  const bareStart = markdown.search(/\{\s*"/)
  if (bareStart === -1) return undefined
  // A bare object fallback: find the matching close brace of the first object.
  let depth = 0
  for (let index = bareStart; index < markdown.length; index++) {
    const char = markdown[index]
    if (char === "{") depth++
    else if (char === "}") {
      depth--
      if (depth === 0) return markdown.slice(bareStart, index + 1)
    }
  }
  return undefined
}

function parseDimensions(value: unknown): QualityDimensionScores | undefined {
  if (!isRecord(value)) return undefined
  const dimensions = {} as QualityDimensionScores
  for (const dimension of qualityDimensions) {
    const raw = value[dimension]
    if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined
    dimensions[dimension] = Math.round(clampScore(raw))
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
