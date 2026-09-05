/**
 * Display-layer reconstruction of a goal cycle's phases for dashboards.
 *
 * Durable state already encodes everything the pipeline panel needs: the
 * frozen `pipeline.goalPlan` fragments (resolved, routed) plus the
 * deterministic `goal-<stage>-<n>-<name>` qualification rule the scheduler
 * executes under. This module re-derives each invocation's phases from that
 * state — logical step names, model/variant labels, advisors, read-only
 * badges — and groups them per invocation so the tree shows iteration
 * boundaries instead of flat, truncated physical ids. Execution-side
 * grouping, batching, resume, and report identities are untouched: the
 * reconstruction is invertible synthesis over the documented invariant, not
 * new persisted state.
 */

import { goalInvocationId, qualifyInvocation, type GoalInvocationId } from "./goal-scheduler"
import type { GoalRunState } from "./metadata"
import { progressPhases } from "./runner"
import type { ProgressPhase } from "./progress"
import type { Pipeline } from "./types"

export type GoalPhaseReconstructionOptions = {
  /**
   * Whether the run is live (its OpenCode server or control channel answers).
   * Gates the in-flight seed: a live run lists the invocation its durable goal
   * record reports as current even when none of its phases has been recorded
   * yet, so dashboards opened between stage boundaries receive those phases'
   * events and the progress counter reflects the real phase total. Settled and
   * historical runs list only invocations with recorded phases — no phantom
   * pending rows for rounds that never ran.
   */
  live?: boolean
  /** The durable goal record; its stage/iteration name the in-flight invocation. */
  goal?: GoalRunState
}

/**
 * Enumerates the invocation sequence the scheduler executes: measurement
 * zero, then — while below target — one improvement fragment followed by one
 * fresh measurement fragment, up to the policy's improvement-round cap.
 */
export function goalInvocationSequence(plan: NonNullable<Pipeline["goalPlan"]>): GoalInvocationId[] {
  const sequence: GoalInvocationId[] = [{ stage: "measure", iteration: 0 }]
  for (let round = 1; round <= plan.maxIterations; round++) {
    sequence.push({ stage: "improve", iteration: round }, { stage: "measure", iteration: round })
  }
  return sequence
}

/**
 * The goal invocation phases a dashboard should display, in execution order:
 * only invocations with at least one recorded phase, plus the in-flight
 * invocation on a live run. Returns an empty list for pipelines without a
 * goal plan (and for legacy shapes, which keep their bare-extras row).
 */
export function goalProgressPhases(
  pipeline: Pipeline,
  recorded: ReadonlySet<string>,
  options: GoalPhaseReconstructionOptions = {},
): ProgressPhase[] {
  const plan = pipeline.goalPlan
  if (!plan) return []
  const goal = options.goal
  const inFlight =
    options.live && goal && !goal.outcome && goal.stage !== "complete"
      ? { stage: goal.stage, iteration: goal.iteration }
      : undefined
  const rows: ProgressPhase[] = []
  for (const invocation of goalInvocationSequence(plan)) {
    const steps = qualifyInvocation(invocation.stage, invocation.iteration, plan[invocation.stage].steps)
    const hasRecorded = steps.some((step) => recorded.has(step.name))
    const isLive =
      inFlight !== undefined && inFlight.stage === invocation.stage && inFlight.iteration === invocation.iteration
    if (!hasRecorded && !isLive) continue
    // Reuse progressPhases' exact step→row mapping, then re-group: the
    // qualified steps keep the fragment's positional groupId (`measure-g1`),
    // which every measurement round shares — the display id is the qualified
    // invocation id, so two rounds can never merge into one tree group.
    const groupId = goalInvocationId(invocation.stage, invocation.iteration)
    rows.push(...progressPhases({ ...pipeline, steps }).map((phase) => ({ ...phase, groupId })))
  }
  return rows
}
