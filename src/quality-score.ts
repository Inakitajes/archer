/**
 * The machine-readable quality-score contract shared by the quality-scorer and
 * quality-score-report agents, and parsed by the runner.
 *
 * The scorer agents emit a fenced `quality-score` JSON block at the end of
 * their report. This module validates that block, computes the canonical
 * weighted total from the dimensions and weights in code, and derives the
 * verdict. The embedded goal scheduler reads this from the promoted
 * reports/score-report.md to decide whether to keep iterating, so the score is
 * a control signal computed here — never an agent-supplied number taken on
 * faith.
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { log } from "./log"
import type { DeliverableContract } from "./types"

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
  /** Concrete actions that would raise the score, one per weak dimension; the goal cycle's improve fragment acts on these. */
  gaps?: Partial<Record<QualityDimension, string>>
  confidence?: "high" | "medium" | "low"
}

/**
 * Appends the canonical machine-readable score fence to a scorer's narrative.
 * Score and verdict are derived here, never accepted from an agent's payload.
 */
export function renderQualityScoreReport(
  markdown: string,
  fields: Pick<QualityScore, "dimensions" | "mustFix" | "gaps" | "confidence">,
  weights: Record<QualityDimension, number> = qualityDimensionWeights,
): string {
  const weighted = weightedQualityScore(fields.dimensions, weights)
  const score = allFindingsMinor(fields.mustFix) ? Math.max(80, weighted) : weighted
  const report: QualityScore = {
    score,
    dimensions: fields.dimensions,
    verdict: qualityVerdict(score),
    mustFix: fields.mustFix,
    ...(fields.gaps && Object.keys(fields.gaps).length > 0 ? { gaps: fields.gaps } : {}),
    ...(fields.confidence ? { confidence: fields.confidence } : {}),
  }
  return `${markdown.trimEnd()}\n\n\`\`\`quality-score\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`
}

/** Default cap on goal-loop fix iterations after the initial run. */
export const defaultGoalMaxIterations = 3
/** Default goal-loop plateau: stop when a fix iteration improves by fewer points than this. */
export const defaultGoalPlateau = 3

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

/** The path of a project's optional rubric override, relative to the target repo. */
export const qualityRubricPath = ".convoy/quality-rubric.md"

/**
 * Loads and parses a project rubric's dimension weights from
 * `.convoy/quality-rubric.md`, when present. The rubric is the same prose the
 * scorer agents read, so the weights are extracted from its markdown table (a
 * `| \`dimension\` | <n>% |` row per dimension). Returns undefined when there is
 * no rubric, or when the rubric is missing a dimension or has non-positive
 * weights — the canonical computation then falls back to the v1 defaults so a
 * malformed rubric never silently produces a contradictory score.
 */
export async function loadQualityRubricWeights(targetDir: string): Promise<Record<QualityDimension, number> | undefined> {
  let body: string
  try {
    body = await readFile(join(targetDir, qualityRubricPath), "utf8")
  } catch {
    return undefined
  }
  const weights = parseQualityRubricWeights(body)
  if (!weights) {
    log.warn(`quality score: ${qualityRubricPath} is present but its weight table could not be parsed; using the default v1 weights`)
  }
  return weights
}

/** Parses a rubric's weight table into normalized weights summing to 1.0, or undefined when it is incomplete. */
export function parseQualityRubricWeights(body: string): Record<QualityDimension, number> | undefined {
  const weights = {} as Partial<Record<QualityDimension, number>>
  for (const dimension of qualityDimensions) {
    const pattern = new RegExp(`^\\|\\s*\`?${dimension}\`?\\s*\\|\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "im")
    const match = body.match(pattern)
    if (!match) return undefined
    const value = Number(match[1])
    // A dimension may be de-prioritized to 0%, but a negative weight is malformed.
    if (!Number.isFinite(value) || value < 0) return undefined
    weights[dimension] = value
  }
  // Normalize to a 1.0 sum so a rubric whose percentages don't add up to exactly
  // 100 still produces a coherent weighted total rather than a contradictory one.
  // An all-zero rubric is rejected so the normalization never divides by zero.
  const total = qualityDimensions.reduce((sum, dimension) => sum + (weights[dimension] ?? 0), 0)
  if (total <= 0) return undefined
  const normalized = {} as Record<QualityDimension, number>
  for (const dimension of qualityDimensions) normalized[dimension] = (weights[dimension] ?? 0) / total
  return normalized
}

export function qualityVerdict(score: number): QualityScoreVerdict {
  if (score >= 90) return "ready"
  if (score >= 75) return "ready-with-caveats"
  if (score >= 60) return "not-ready"
  return "failing"
}

/**
 * The pipeline's authoritative scorer step, when it has one. The contract is
 * what makes a step authoritative — a goal measure fragment may end in an
 * arbitrarily named step whose `deliverable: quality-score` override produces
 * the machine-readable score — so the quality-score deliverable contract wins,
 * with the `quality-score-report` agent identity kept as the fallback for
 * steps resolved before deliverable contracts were persisted (legacy metadata).
 */
export function consensusStep(
  pipeline: { steps: readonly { type: string; agentName?: string; reportPath?: string; deliverableContract?: DeliverableContract }[] },
): { type: string; agentName?: string; reportPath: string } | undefined {
  const step =
    pipeline.steps.find((candidate) => candidate.type === "agent" && candidate.deliverableContract?.kind === "quality-score-report") ??
    pipeline.steps.find((candidate) => candidate.type === "agent" && candidate.agentName === "quality-score-report")
  return step && step.reportPath ? { ...step, reportPath: step.reportPath } : undefined
}

/**
 * Extracts and validates the `quality-score` JSON block from a scorer report.
 *
 * The authoritative block is the last `quality-score` fenced block (no `json`
 * alias or bare-object fallback) and must contain valid, in-range data. Text
 * after its closing fence is tolerated because an agent's final response may
 * append delivery narration after an otherwise valid machine-readable report.
 */
export function parseQualityScoreReport(
  markdown: string,
  weights: Record<QualityDimension, number> = qualityDimensionWeights,
): QualityScore | undefined {
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

  const mustFix = Array.isArray(parsed.mustFix) ? parsed.mustFix.filter((item): item is string => typeof item === "string") : []

  // The score is always recomputed in code from the dimensions and the rubric
  // weights. An agent-declared score is at most informative: a report whose
  // declared score contradicts its own dimensions must not drive the loop.
  // Enforce the rubric's 80 floor: a change whose only findings are minor
  // cannot score below 80, no matter how many minor deductions accumulate.
  // The scorer tags each finding with its absolute severity in parentheses
  // (e.g. "SC-3: ... (minor)"); when every surviving finding is minor, the
  // score is floored at 80. Findings without a parseable severity tag are
  // treated as non-minor so a malformed report cannot exploit the floor.
  const score = allFindingsMinor(mustFix) ? Math.max(80, weightedQualityScore(dimensions, weights)) : weightedQualityScore(dimensions, weights)
  const declaredScore = typeof parsed.score === "number" && Number.isFinite(parsed.score) ? parsed.score : undefined
  if (declaredScore !== undefined && Math.abs(declaredScore - score) > 1) {
    log.warn(
      `quality score: declared score ${declaredScore} disagrees with the dimensions (weighted total ${score}); using the computed score`,
    )
  }

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
 * `quality-score` fence. Blocks earlier in the report are examples, not
 * results. Text after the final block is ignored but logged as a contract
 * warning so a valid score is still available to the goal loop.
 */
function extractQualityScoreBlock(markdown: string): string | undefined {
  // Find every opening fence with the same contract as before: the tag must be
  // followed by optional whitespace and a newline. The last such fence is the
  // authoritative block (earlier ones may be examples the scorer pasted).
  const openings = [...markdown.matchAll(/```quality-score\s*\n/gi)]
  if (openings.length === 0) return undefined
  const lastOpening = openings[openings.length - 1]
  if (lastOpening.index === undefined) return undefined
  const afterOpening = markdown.slice(lastOpening.index + lastOpening[0].length)
  // The closing fence is the LAST ``` in the remainder, not the first. A
  // non-greedy regex would close early on triple-backticks inside JSON string
  // values (e.g. a gap description that references a ```fenced``` code block),
  // yielding invalid JSON and a silent no-score. The last ``` after the last
  // opening fence is the closer; anything after it is trailing narration.
  const closingIndex = afterOpening.lastIndexOf("```")
  if (closingIndex === -1) return undefined
  const block = afterOpening.slice(0, closingIndex)
  const trailing = afterOpening.slice(closingIndex + 3)
  if (trailing.trim() !== "") {
    log.warn("quality score: found content after the final quality-score block; extracting the score and ignoring trailing text")
  }
  return block.trim()
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

/**
 * Reports whether every surviving finding is tagged `minor`. The scorer
 * tags each mustFix entry with its absolute severity in parentheses (e.g.
 * "SC-3: ... (minor)"). A finding without a parseable severity tag is
 * treated as non-minor so a malformed report cannot exploit the 80 floor.
 * Returns false when there are no findings (the floor is about capping
 * minor deductions, not inflating a clean score).
 */
export function allFindingsMinor(mustFix: string[]): boolean {
  if (mustFix.length === 0) return false
  return mustFix.every((finding) => /\(minor\)\s*$/i.test(finding))
}

function clampScore(value: number): number {
  return Math.min(100, Math.max(0, value))
}
