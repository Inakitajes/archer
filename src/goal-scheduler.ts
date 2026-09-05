/**
 * The embedded goal scheduler: measure iteration zero, then bounded
 * improve/measure rounds, all through one shared run context.
 *
 * The scheduler owns only orchestration and policy. Execution goes through the
 * same `executePhaseGroups` machinery the pipeline prefix uses — identical
 * phase attempts, commits, permissions, advisors, failure gates, read-only
 * baselines, and usage accounting — with one workspace, one metadata store,
 * one OpenCode server, and one lifecycle for the whole cycle. There are no
 * child runs: each invocation's phases are registered under
 * invocation-qualified physical IDs (`goal-measure-1-score-report`) with
 * iteration-qualified report paths (`reports/goal/iteration-1/measure/...`).
 */

import { mkdir, rename, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { RepoSnapshot } from "./git"
import { log } from "./log"
import type { GoalLoopView } from "./progress"
import type { GoalRunState } from "./metadata"
import type { QualityScore } from "./quality-score"
import type { AgentStep, ResolvedGoalPlan, Step } from "./types"
import { captureBestEffort, emitSummaryLogs, flushDeferredLogs, goalBriefFor, logGoalIteration, restoreBestEffort, type BestState, type DeferredLog, type GoalLoopOutcome } from "./goal-policy"

/** One executed fragment invocation: a stage, its round number, and its qualified steps. */
export type GoalInvocation = {
  stage: "improve" | "measure"
  /** 0 for the opening measurement; 1..n afterwards. */
  iteration: number
  /** Cloned steps with invocation-qualified physical names and report paths. */
  steps: AgentStep[]
}

export type GoalCycleOutcome = GoalLoopOutcome

export type GoalCycleDeps = {
  /** Executes one invocation's qualified steps through the shared phase machinery. */
  executeGroups: (invocation: GoalInvocation) => Promise<void>
  /** Parses the authoritative score from a completed measurement invocation. */
  parseScore: (invocation: GoalInvocation) => Promise<QualityScore | undefined>
  /** Atomically promotes a validated measurement's consensus report to the run's conventional final-report path. */
  promoteScore: (invocation: GoalInvocation) => Promise<void>
  /** Captures the repository's clean state; undefined when the tree is dirty. */
  captureSnapshot: (cwd: string) => Promise<RepoSnapshot | undefined>
  /** Restores the repository to a previously captured state (destructive: reset --hard + clean -fd). */
  restoreSnapshot: (snapshot: RepoSnapshot, cwd: string) => Promise<void>
  /** Reports whether the working tree at `cwd` is clean (no uncommitted or untracked changes). */
  isCleanRepo: (cwd: string) => Promise<boolean>
  /** Returns the current HEAD commit SHA, or undefined when git fails. */
  currentHead: (cwd: string) => Promise<string | undefined>
  /** Live dashboard updates: called before and after every stage. */
  onView?: (view: GoalLoopView) => void
  /**
   * Persists the durable goal record. Called after every stage boundary —
   * phase completion, score validation/promotion, stage transitions,
   * best-state capture, and final settlement — so a crash leaves an
   * unambiguous resumable next action. Errors are logged and swallowed: a
   * checkpoint must never abort the cycle it is recording.
   */
  checkpoint?: (state: GoalRunState) => Promise<void>
}

export type GoalCycleInput = {
  targetDir: string
  /** Distinguishes a user abort (never restores) from any other failure (restores best, guarded). */
  isAbort: (error: unknown) => boolean
  /**
   * The durable goal record from a previous process. Resume continues from the
   * record's pending stage instead of restarting the cycle: completed
   * measurements reload as complete `QualityScore` objects (so the next brief
   * is rebuilt from the last canonical score), and the pending improve/measure
   * group re-runs through phase recovery, which skips already-completed phases.
   */
  resume?: GoalRunState
}

export type GoalInvocationId = {
  stage: "improve" | "measure"
  /** 0 for the opening measurement; 1..n afterwards. */
  iteration: number
}

/** The qualified phase identity one physical phase name encodes. */
export type QualifiedGoalPhase = GoalInvocationId & {
  /** The fragment step's logical (pre-qualification) name. */
  stepName: string
}

/** The deterministic display group id shared by one invocation's phases (`goal-measure-0`). */
export function goalInvocationId(stage: "improve" | "measure", iteration: number): string {
  return `goal-${stage}-${iteration}`
}

/**
 * Inverse of `qualifyInvocation`'s naming rule: `goal-<stage>-<n>-<name>` →
 * its invocation identity and logical step name. Returns undefined for
 * anything else — prefix phases, hooks, legacy names — so callers can treat
 * parseability as "this phase belongs to a goal invocation". The qualify and
 * parse pair must move together; round-trip tests over the built-in
 * fragments pin that.
 */
export function parseGoalPhaseName(name: string): QualifiedGoalPhase | undefined {
  const match = /^goal-(improve|measure)-(\d+)-(.+)$/.exec(name)
  return match
    ? { stage: match[1] as "improve" | "measure", iteration: Number(match[2]), stepName: match[3] }
    : undefined
}

/** Parses a display group id produced by `goalInvocationId`. */
export function parseGoalInvocationId(id: string): GoalInvocationId | undefined {
  const match = /^goal-(improve|measure)-(\d+)$/.exec(id)
  return match ? { stage: match[1] as "improve" | "measure", iteration: Number(match[2]) } : undefined
}

/**
 * Qualifies one fragment invocation's steps. Physical phase IDs are
 * deterministic (`goal-<stage>-<n>-<name>`) so two measurements can never
 * collide in phase state, sessions, diffs, logs, or report paths; report
 * selectors inside the fragment are rewritten to the qualified paths so each
 * invocation reads only its own round's reports. `prd.md` and non-report
 * inputs pass through untouched.
 */
export function qualifyInvocation(stage: "improve" | "measure", iteration: number, steps: readonly AgentStep[], brief?: { recipient: string; text: string }): AgentStep[] {
  const reportMap = new Map(steps.map((step) => [`reports/${step.name}.md`, `reports/goal/iteration-${iteration}/${stage}/${step.name}.md`]))
  return steps.map((step) => ({
    ...structuredClone(step),
    name: `goal-${stage}-${iteration}-${step.name}`,
    reportPath: reportMap.get(`reports/${step.name}.md`)!,
    inputFiles: step.inputFiles.map((file) => reportMap.get(file) ?? file),
    ...(brief && step.name === brief.recipient ? { goalBrief: brief.text } : {}),
  }))
}

/**
 * Runs the complete goal cycle: measurement zero, then while below target one
 * improvement fragment followed by one fresh measurement fragment, stopping at
 * the target, a plateau, the iteration cap, a fragment failure, or a missing
 * authoritative score. After each validated measurement the consensus report
 * is promoted to the run's conventional final-report location. When the cycle
 * stops below the target on a lower-scoring round, the best measured state is
 * restored — only when the cleanliness and head-identity guards prove that
 * doing so cannot discard concurrent work, and never on a user abort.
 *
 * Every stage boundary persists the durable goal record (`checkpoint`), so a
 * crashed coordinator can resume from the exact pending group. A resumed run
 * reloads its completed measurements from that record and continues rather
 * than re-measuring finished rounds.
 */
export async function runGoalCycle(
  goal: ResolvedGoalPlan,
  input: GoalCycleInput,
  deps: GoalCycleDeps,
): Promise<GoalCycleOutcome> {
  const deferredLogs: DeferredLog[] = []
  // Every completed authoritative measurement, oldest first. A resumed run
  // reloads the record's measurements as complete objects — the prior canonical
  // brief is rebuilt from the last one, so no score narration is lost.
  const scores: QualityScore[] = []
  let best: BestState | undefined
  // Track the HEAD the cycle's own phases leave behind, so the restore can
  // refuse when someone else committed on the branch during the cycle.
  let lastHead = await deps.currentHead(input.targetDir)
  let restored = false

  const maxMeasurements = 1 + goal.maxIterations
  const numericScores = () => scores.map((entry) => entry.score)
  const viewFor = (outcome?: GoalLoopView["outcome"]): GoalLoopView => ({
    target: goal.target,
    iteration: scores.length + 1,
    maxRuns: maxMeasurements,
    plateau: goal.plateau,
    scores: numericScores(),
    ...(outcome ? { outcome } : {}),
  })
  const outcomeView = (outcome: GoalCycleOutcome): GoalLoopView["outcome"] => ({
    reason: outcome.reason,
    reached: outcome.reached,
    restored: outcome.restored,
  })
  const publish = (outcome?: GoalCycleOutcome) => deps.onView?.(viewFor(outcome ? outcomeView(outcome) : undefined))

  const measure = async (iteration: number): Promise<QualityScore | undefined> => {
    const invocation: GoalInvocation = { stage: "measure", iteration, steps: qualifyInvocation("measure", iteration, goal.measure.steps) }
    publish()
    await deps.executeGroups(invocation)
    lastHead = await deps.currentHead(input.targetDir)
    const score = await deps.parseScore(invocation)
    if (score) {
      // Promotion happens only after the score validated, so an invalid or
      // interrupted attempt cannot replace the last measured score.
      await deps.promoteScore(invocation)
    }
    return score
  }

  /** Persists the durable goal record; a failed checkpoint never aborts the cycle it records. */
  const checkpoint = async (state: GoalRunState): Promise<void> => {
    try {
      await deps.checkpoint?.(state)
    } catch (error) {
      log.warn(`goal cycle: could not persist goal checkpoint: ${String(error)}`)
    }
  }
  /** The durable record for the current cycle position, with the given overrides. */
  const stateFor = (partial: Partial<GoalRunState> = {}): GoalRunState => ({
    target: goal.target,
    maxIterations: goal.maxIterations,
    plateau: goal.plateau,
    iteration,
    stage,
    scores: [...scores],
    ...(best ? { bestScore: best.score } : {}),
    ...partial,
  })

  const finish = async (outcome: GoalCycleOutcome, state?: GoalRunState): Promise<GoalCycleOutcome> => {
    if (state) await checkpoint(state)
    publish(outcome)
    emitSummaryLogs(outcome, deferredLogs)
    return outcome
  }

  let iteration: number
  let stage: GoalRunState["stage"]
  let score: QualityScore | undefined

  const resume = input.resume
  if (resume) {
    // Reload every completed authoritative measurement from the durable record.
    scores.push(...resume.scores)
    if (resume.bestScore !== undefined) best = { score: resume.bestScore }
    iteration = resume.iteration
    stage = resume.stage
    // A settled cycle needs no re-execution: the record already carries the
    // outcome, trajectory, best score, and restore result.
    if (resume.outcome && resume.outcome !== "failed") {
      return finish({
        scores: numericScores(),
        reached: resume.outcome === "goal",
        reason: resume.outcome === "goal" ? "goal" : resume.outcome === "plateau" ? "plateau" : resume.outcome === "no-score" ? "no-score" : "max-iterations",
        ...(resume.bestScore !== undefined ? { bestScore: resume.bestScore } : {}),
        restored: resume.restored ?? false,
      })
    }
    if (resume.outcome === "failed") {
      // A failed cycle retries on resume: recompute the pending stage from the
      // record so phase recovery can re-attempt the failed fragment.
      stage = scores.length > 0 ? "improve" : "measure"
      iteration = scores.length > 0 ? scores.length : 0
    }
    // The last completed measurement drives the next improvement's brief.
    score = scores[scores.length - 1]
  } else {
    iteration = 0
    stage = "measure"
  }

  try {
    // Each stop reason is set explicitly at the decision point that produces
    // it; the iteration cap is the default so an exhaust cycle always lands on
    // a real reason instead of a sentinel that is never actually returned.
    let reason: GoalCycleOutcome["reason"] = "max-iterations"
    let improveRound = iteration

    // A pending measurement: the opening measurement (iteration zero) for a
    // fresh cycle, or the round after a completed improvement on resume. Its
    // already-completed phases are skipped by phase recovery.
    if (stage === "measure") {
      score = await measure(iteration)
      if (!score) {
        return finish({ scores: numericScores(), reached: false, reason: "no-score", restored: false }, stateFor({ stage: "complete", outcome: "no-score" }))
      }
      scores.push(score)
      if (best === undefined || score.score > best.score) {
        best = { score: score.score, snapshot: await captureBestEffort(input.targetDir, deps.captureSnapshot, deferredLogs) }
      }
      logGoalIteration(iteration, score.score, goal.target, goal.plateau, undefined, deferredLogs)
      publish()
      if (score.score >= goal.target) {
        return finish({ scores: numericScores(), reached: true, reason: "goal", bestScore: best.score, restored: false }, stateFor({ stage: "complete", outcome: "goal" }))
      }
      improveRound = iteration + 1
      // The opening measurement is complete; the next action is improve round 1.
      await checkpoint(stateFor({ stage: "improve", iteration: improveRound }))
    }

    for (; improveRound <= goal.maxIterations; improveRound++) {
      const round = improveRound
      const brief = goalBriefFor(score!)
      const improve: GoalInvocation = { stage: "improve", iteration: round, steps: qualifyInvocation("improve", round, goal.improve.steps, { recipient: goal.briefRecipient, text: brief }) }
      deps.onView?.(viewFor())
      await deps.executeGroups(improve)
      lastHead = await deps.currentHead(input.targetDir)
      // The improvement is complete; the next action is its measurement.
      await checkpoint(stateFor({ stage: "measure", iteration: round }))

      score = (await measure(round)) ?? undefined
      if (!score) {
        reason = "no-score"
        iteration = round
        break
      }
      scores.push(score)
      iteration = round
      if (best === undefined || score.score > best.score) {
        best = { score: score.score, snapshot: await captureBestEffort(input.targetDir, deps.captureSnapshot, deferredLogs) }
      }
      const improvement = score.score - scores[scores.length - 2]!.score
      logGoalIteration(round, score.score, goal.target, goal.plateau, improvement, deferredLogs)
      publish()

      if (score.score >= goal.target) {
        reason = "goal"
        break
      }
      if (improvement < goal.plateau) {
        reason = "plateau"
        break
      }
      // The round improved enough; persist readiness for the next improve round.
      await checkpoint(stateFor({ stage: "improve", iteration: round + 1 }))
    }

    // The branch must end on the best measured state, not the iteration that
    // happened to trigger the stop. Restore whenever the cycle stopped below
    // the goal and the final measured state is not the best one: after a
    // no-score round (whose mutation was never measured) and after a plateau
    // on a lower score. A plateau or cap that ends on the best score is
    // already there, so no restore is needed.
    const finalScore = scores[scores.length - 1]?.score
    let restoreRefusedReason: string | undefined
    if (reason !== "goal" && best && (reason === "no-score" || finalScore === undefined || finalScore < best.score)) {
      restored = await restoreBestEffort(best, input.targetDir, deps.restoreSnapshot, deps.isCleanRepo, lastHead, deps.currentHead, deferredLogs)
      if (!restored) restoreRefusedReason = "restore of the best measured state did not occur (missing snapshot, concurrent commits, dirty tree, or failure)"
    }

    const outcome: GoalCycleOutcome = { scores: numericScores(), reached: reason === "goal", reason, bestScore: best?.score, restored }
    return finish(
      outcome,
      stateFor({
        stage: "complete",
        outcome: reason === "goal" ? "goal" : reason === "plateau" ? "plateau" : reason === "no-score" ? "no-score" : "max-iterations",
        ...(restored ? { restored: true } : {}),
        ...(restoreRefusedReason ? { restoreRefusedReason } : {}),
      }),
    )
  } catch (error) {
    // A user abort is a deliberate stop, not a failure: never restore after
    // one. Any other fragment failure ends the cycle — restore the best
    // measured state if the guards allow it, then surface the error so the
    // runner's failure path (failure hooks, failed finish screen) proceeds.
    if (best && !input.isAbort(error)) {
      await restoreBestEffort(best, input.targetDir, deps.restoreSnapshot, deps.isCleanRepo, lastHead, deps.currentHead, deferredLogs)
    }
    await checkpoint(stateFor({ stage: "complete", outcome: "failed" }))
    throw error
  } finally {
    flushDeferredLogs(deferredLogs)
  }
}

/**
 * Atomically promotes one measurement's authoritative consensus report to
 * `reports/score-report.md`, the run's conventional final-report location, so
 * finish tooling and run history keep reading the same path. Only called after
 * the score validated, so an invalid attempt never replaces the last
 * authoritative report.
 */
export async function promoteScoreReport(workspaceDir: string, invocation: GoalInvocation): Promise<void> {
  const consensus = invocation.steps.find((step) => step.deliverableContract?.kind === "quality-score-report")
  if (!consensus) return
  const source = join(workspaceDir, consensus.reportPath)
  let text: string
  try {
    text = await readFile(source, "utf8")
  } catch (error) {
    log.warn(`goal cycle: could not read the consensus report for promotion: ${String(error)}`)
    return
  }
  const finalPath = join(workspaceDir, "reports", "score-report.md")
  await mkdir(dirname(finalPath), { recursive: true })
  const tempPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tempPath, text)
  await rename(tempPath, finalPath)
}

/** Type helper keeping the scheduler's step list honest with the executor's. */
export type GoalCycleSteps = readonly Step[]
