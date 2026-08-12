/**
 * Goal mode: run a scored pipeline, and keep running directed fix iterations
 * until the implementation's quality score reaches the goal — or until the
 * score stops improving, the iteration cap is hit, or a run fails.
 *
 * Each fix iteration runs the `goal-fix` pipeline in the same worktree the
 * initial run created, so the diff accumulates. The previous scoring round's
 * gaps travel as a per-step phase brief on the goal-fixer only: the re-scorer
 * steps never see the previous score, which would anchor them.
 */

import { buildRunPlan } from "./run-plan"
import { log } from "./log"
import { run, type RunResult } from "./runner"
import type { RunOptions, RunPlan } from "./types"

export const defaultGoalMaxIterations = 3
export const defaultGoalPlateau = 3

export type GoalLoopConfig = {
  goal: number
  maxIterations: number
  plateau: number
}

export type GoalLoopOutcome = {
  /** The score trajectory, one entry per run (initial + fix iterations). */
  scores: number[]
  reached: boolean
  reason: "goal" | "plateau" | "max-iterations" | "no-score" | "run-failed"
}

type GoalLoopDeps = {
  run: typeof run
}

export async function runGoalLoop(
  options: RunOptions,
  plan: RunPlan,
  config: GoalLoopConfig,
  deps: GoalLoopDeps = { run },
): Promise<GoalLoopOutcome> {
  const scores: number[] = []
  let outcome: GoalLoopOutcome["reason"] = "run-failed"

  let previous: RunResult
  try {
    previous = await deps.run({ ...options, plan })
  } catch (error) {
    outcome = "run-failed"
    throw error
  }
  let score = previous.qualityScore?.score
  if (score === undefined) {
    log.warn("goal loop: the run produced no machine-readable quality score; nothing to iterate on")
    return { scores, reached: false, reason: "no-score" }
  }
  scores.push(score)
  logIteration(0, score, config, undefined)
  if (score >= config.goal) {
    outcome = "goal"
    return summarize({ scores, reached: true, reason: outcome })
  }

  for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
    const fixOptions = goalFixOptions(options, previous, scores)
    try {
      previous = await deps.run({ ...fixOptions, plan: buildRunPlan(fixOptions) })
    } catch (error) {
      outcome = "run-failed"
      throw error
    }
    score = previous.qualityScore?.score
    if (score === undefined) {
      log.warn(`goal loop: fix iteration ${iteration} produced no score; stopping`)
      outcome = "no-score"
      break
    }
    scores.push(score)
    const improvement = score - scores[scores.length - 2]!
    logIteration(iteration, score, config, improvement)

    if (score >= config.goal) {
      outcome = "goal"
      break
    }
    if (improvement < config.plateau) {
      outcome = "plateau"
      break
    }
  }
  if (outcome === "run-failed") outcome = "max-iterations"

  return summarize({ scores, reached: (scores[scores.length - 1] ?? 0) >= config.goal, reason: outcome })
}

function goalFixOptions(options: RunOptions, previous: RunResult, trajectory: number[]): RunOptions {
  const base = options.goalFixPipeline
  if (!base) throw new Error("goal loop: the goal-fix pipeline is not resolved for this run")
  const brief = goalBriefFor(previous)
  const pipeline = {
    ...base,
    steps: base.steps.map((step) =>
      step.type === "agent" && step.agentName === "goal-fixer" ? { ...step, goalBrief: brief } : step,
    ),
  }
  return {
    ...options,
    pipeline,
    // The finish screen shows the trajectory building across iterations.
    goalTrajectory: [...trajectory],
    // Fix iterations must never re-enter goal mode or filter steps.
    goal: undefined,
    goalMaxIterations: undefined,
    goalPlateau: undefined,
    goalFixPipeline: undefined,
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    // The initial run already isolated the work; fix iterations build on it.
    worktree: false,
    includeDirty: false,
  }
}

/** The work order handed to the goal-fixer: the previous score, the gaps, and the must-fix findings. */
export function goalBriefFor(previous: RunResult): string {
  const score = previous.qualityScore
  if (!score) return "No previous score was recorded. Re-read the PRD and the diff, and make the implementation satisfy the PRD as completely as you can without adding scope."
  const dimensions = qualityDimensionsList(score.dimensions)
  const gaps = Object.entries(score.gaps ?? {}).map(([dimension, gap]) => `- ${dimension}: ${gap}`)
  const mustFix = score.mustFix.map((item) => `- ${item}`)

  return [
    `The previous scoring round scored this implementation ${score.score}/100 (verdict: ${score.verdict}); the goal is higher.`,
    `Per-dimension scores: ${dimensions.join(" · ")}`,
    "",
    gaps.length > 0 ? "Gaps to close (this is your work order):" : "No gaps were recorded; verify the implementation against the PRD and fix anything that plainly fails it.",
    ...(gaps.length > 0 ? gaps : []),
    "",
    mustFix.length > 0 ? "Must-fix findings:" : "No must-fix findings were recorded.",
    ...mustFix,
    "",
    "Fix exactly the gaps and must-fix items above, nothing more. Do not add scope, do not chase speculative improvements, and do not restructure code you are not required to touch.",
  ].join("\n")
}

function qualityDimensionsList(dimensions: Record<string, number>): string[] {
  return Object.entries(dimensions).map(([dimension, value]) => `${dimension}: ${value}`)
}

function logIteration(iteration: number, score: number, config: GoalLoopConfig, improvement: number | undefined) {
  const change = improvement === undefined ? "" : ` (${improvement >= 0 ? "+" : ""}${improvement} vs previous)`
  if (score >= config.goal) log.info(`goal loop: iteration ${iteration} scored ${score}/100 — goal ${config.goal} met${change}`)
  else if (improvement !== undefined && improvement < config.plateau) log.warn(`goal loop: iteration ${iteration} scored ${score}/100${change} — below plateau ${config.plateau}, stopping`)
  else log.info(`goal loop: iteration ${iteration} scored ${score}/100${change}`)
}

function summarize(outcome: GoalLoopOutcome): GoalLoopOutcome {
  const final = outcome.scores[outcome.scores.length - 1]
  const goalText = `goal ${outcome.reason === "goal" ? "met" : "not met"}`
  if (outcome.scores.length > 0) {
    log.info(`goal loop trajectory: ${outcome.scores.join(" → ")}`)
  }
  if (outcome.reached && final !== undefined) {
    log.info(`goal loop: done — ${final}/100, ${goalText}`)
  } else if (final !== undefined) {
    log.warn(`goal loop: best effort ${final}/100 (${goalText}); stopped: ${outcome.reason}`)
  } else {
    log.warn(`goal loop: no score recorded; stopped: ${outcome.reason}`)
  }
  return outcome
}
