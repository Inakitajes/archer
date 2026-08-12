import { describe, expect, test } from "bun:test"

import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { buildRunPlan } from "../src/run-plan"
import { goalBriefFor, runGoalLoop } from "../src/goal-loop"
import type { RunOptions, RunPlan } from "../src/types"
import type { RunResult } from "../src/runner"
import type { QualityScore } from "../src/quality-score"

const dimensions: QualityScore["dimensions"] = { prd: 92, tests: 70, security: 95, maintainability: 88, operational: 90, scope: 85 }

const initialPipeline = resolvePipeline({ name: "implement-scored", spec: builtInPipelines["implement-scored"]!, agents: builtInAgents })
const goalFixPipeline = resolvePipeline({ name: "goal-fix", spec: builtInPipelines["goal-fix"]!, agents: builtInAgents })

function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "build it",
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    tui: false,
    notify: false,
    notifications: {},
    humanReview: false,
    baseRef: "main",
    targetDir: "/repo",
    worktree: true,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "openai/gpt-5.6-sol",
    pipeline: initialPipeline,
    goalFixPipeline,
    agents: [...builtInAgents],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    ...overrides,
  }
}

function scoreAt(value: number): QualityScore {
  return { score: value, dimensions, verdict: "ready-with-caveats", mustFix: [], gaps: { tests: "cover the cancellation path" } }
}

function resultAt(value: number): RunResult {
  return { runID: "r", dir: "/run", qualityScore: scoreAt(value), scoreReportText: "# score" }
}

async function fakeRunQueue(scores: (number | undefined)[]): Promise<{ calls: RunOptions[]; fakeRun: (options: RunOptions) => Promise<RunResult> }> {
  const calls: RunOptions[] = []
  const queue = [...scores]
  const fakeRun = async (options: RunOptions): Promise<RunResult> => {
    calls.push(options)
    const next = queue.shift()
    return next === undefined ? { runID: "r", dir: "/run" } : resultAt(next)
  }
  return { calls, fakeRun }
}

describe("goalBriefFor", () => {
  test("composes the score, dimensions, gaps, and must-fix into a work order", () => {
    const brief = goalBriefFor({ runID: "r", dir: "/run", qualityScore: scoreAt(71), scoreReportText: "# x" })

    expect(brief).toContain("71/100")
    expect(brief).toContain("prd: 92")
    expect(brief).toContain("Gaps to close")
    expect(brief).toContain("tests: cover the cancellation path")
    expect(brief).toContain("Fix exactly the gaps and must-fix items above, nothing more")
  })

  test("degrades gracefully when no score was recorded", () => {
    const brief = goalBriefFor({ runID: "r", dir: "/run" })
    expect(brief).toContain("No previous score was recorded")
  })
})

describe("runGoalLoop", () => {
  test("stops after the initial run when the goal is already met", async () => {
    const { calls, fakeRun } = await fakeRunQueue([95])
    const outcome = await runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, { run: fakeRun })

    expect(calls).toHaveLength(1)
    expect(outcome.reached).toBe(true)
    expect(outcome.reason).toBe("goal")
    expect(outcome.scores).toEqual([95])
  })

  test("stops immediately when the run produced no score", async () => {
    const { calls, fakeRun } = await fakeRunQueue([undefined])
    const outcome = await runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, { run: fakeRun })

    expect(calls).toHaveLength(1)
    expect(outcome.reason).toBe("no-score")
    expect(outcome.reached).toBe(false)
  })

  test("keeps fixing until the score reaches the goal", async () => {
    const { calls, fakeRun } = await fakeRunQueue([71, 84, 93])
    const outcome = await runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, { run: fakeRun })

    expect(calls).toHaveLength(3)
    expect(outcome.scores).toEqual([71, 84, 93])
    expect(outcome.reached).toBe(true)
    expect(outcome.reason).toBe("goal")
  })

  test("stops at the plateau when a fix iteration improves by less than the plateau", async () => {
    const { calls, fakeRun } = await fakeRunQueue([71, 74])
    const outcome = await runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 5, plateau: 5 }, { run: fakeRun })

    expect(calls).toHaveLength(2)
    expect(outcome.scores).toEqual([71, 74])
    expect(outcome.reason).toBe("plateau")
    expect(outcome.reached).toBe(false)
  })

  test("stops at the iteration cap when scores keep improving but never reach the goal", async () => {
    const { calls, fakeRun } = await fakeRunQueue([71, 74, 77, 80])
    const outcome = await runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, { run: fakeRun })

    expect(calls).toHaveLength(4) // initial + 3 fix iterations
    expect(outcome.scores).toEqual([71, 74, 77, 80])
    expect(outcome.reason).toBe("max-iterations")
    expect(outcome.reached).toBe(false)
  })

  test("fix iterations run the goal-fix pipeline in the same tree with the brief only on the goal-fixer", async () => {
    const { calls, fakeRun } = await fakeRunQueue([71, 88, 95])
    const options = makeOptions({ worktree: true, resumeRunID: "earlier", goal: 90, goalMaxIterations: 9, goalPlateau: 9 })
    await runGoalLoop(options, buildRunPlan(options), { goal: 90, maxIterations: 3, plateau: 3 }, { run: fakeRun })

    const fixCall = calls[1]!
    expect(fixCall.pipeline.name).toBe("goal-fix")
    expect(fixCall.worktree).toBe(false)
    expect(fixCall.resumeRunID).toBe("")
    expect(fixCall.goal).toBeUndefined()
    expect(fixCall.goalFixPipeline).toBeUndefined()
    expect(fixCall.onlySteps).toEqual([])
    expect(fixCall.skipSteps).toEqual([])
    expect(fixCall.targetDir).toBe("/repo")
    // The finish screen shows the trajectory building up: the scores that ran so far.
    expect(fixCall.goalTrajectory).toEqual([71])
    expect(calls[2]?.goalTrajectory).toEqual([71, 88])

    const steps = fixCall.pipeline.steps
    const fixer = steps.find((step) => step.type === "agent" && step.agentName === "goal-fixer")
    const scorers = steps.filter((step) => step.type === "agent" && step.agentName?.startsWith("quality-scorer"))
    const consensus = steps.find((step) => step.type === "agent" && step.agentName === "quality-score-report")

    expect(fixer?.type === "agent" && fixer.goalBrief).toContain("71/100")
    for (const scorer of scorers) {
      expect(scorer.type === "agent" && scorer.goalBrief).toBeUndefined()
    }
    expect(consensus?.type === "agent" && consensus.goalBrief).toBeUndefined()

    // The brief must survive the frozen plan the runner actually executes.
    const plannedFixer = (fixCall.plan?.pipeline.steps ?? []).find((step) => step.type === "agent" && step.agentName === "goal-fixer")
    expect(plannedFixer?.type === "agent" && plannedFixer.goalBrief).toContain("71/100")
  })

  test("propagates a failing run", async () => {
    const failingRun = async () => {
      throw new Error("boom")
    }
    await expect(
      runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, { run: failingRun }),
    ).rejects.toThrow("boom")
  })
})

describe("goal-fix pipeline shape", () => {
  test("is fix → scorer fan-out → consensus, with the fixer keeping bash", () => {
    const steps = goalFixPipeline.steps
    expect(steps.map((step) => step.name)).toEqual([
      "fix",
      "score__openai-gpt-5-6-sol-xhigh",
      "score__anthropic-claude-opus-5",
      "score-report",
    ])

    const fixer = steps[0]
    expect(fixer?.type === "agent" && fixer.agentName === "goal-fixer")
    expect(fixer?.type === "agent" && fixer.readOnly).toBeUndefined()

    const consensus = steps[3]
    expect(consensus?.type === "agent" && consensus.agentName === "quality-score-report")
    expect(consensus?.type === "agent" && consensus.verify).toBe(true)
  })
})
