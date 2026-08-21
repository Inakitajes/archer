import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import { runGoalLoop, type GoalLoopDeps } from "../src/goal-loop"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { buildRunPlan } from "../src/run-plan"
import { log } from "../src/log"
import { noopProgress, type AutoAccept, type GoalLoopView, type ProgressUI, type RunOutcome } from "../src/progress"
import { UserAbortError, type RunResult } from "../src/runner"
import type { RepoSnapshot } from "../src/git"
import type { RunOptions } from "../src/types"
import type { QualityScore } from "../src/quality-score"

// Slice 4: runGoalLoop never creates a TUI of its own. A loop's dashboard (or
// control adapter) is always injected as options.progress, exactly as the
// coordinator spawns it. These tests watch that borrowed progress's lifecycle:
// one object across the whole loop, exactly one hold at the end, the abort
// handler cleared on exit (SC-6), and never a stop from the loop itself.
const order: string[] = []
let capturedAutoAccept: AutoAccept | undefined

type HostedDashboard = {
  progress: ProgressUI
  views: GoalLoopView[]
  finishCalls: RunOutcome[]
  /** Resolves the dashboard's finish hold once it is waiting on it. */
  dismiss: () => void
}

const dashboards: HostedDashboard[] = []

function hostedProgress(autoAccept: AutoAccept): ProgressUI {
  const views: GoalLoopView[] = []
  const finishCalls: RunOutcome[] = []
  const dismissers: (() => void)[] = []
  order.push("create")
  capturedAutoAccept = { ...autoAccept }
  const progress: ProgressUI = {
    ...noopProgress,
    autoAccept,
    setGoalLoop: (view) => void views.push(view),
    setAbortHandler: (handler) => void order.push(handler ? "abort-handler" : "clear-abort-handler"),
    stop: () => void order.push("stop"),
    runFinished: (outcome) => {
      finishCalls.push(outcome)
      order.push("hold")
      return new Promise<void>((resolve) => dismissers.push(resolve))
    },
  }
  dashboards.push({ progress, views, finishCalls, dismiss: () => dismissers.shift()?.() })
  return progress
}

const dimensions: QualityScore["dimensions"] = { prd: 92, tests: 70, security: 95, maintainability: 88, operational: 90, scope: 85 }

function scoreAt(value: number): QualityScore {
  return { score: value, dimensions, verdict: "ready-with-caveats", mustFix: [], gaps: {} }
}

const initialPipeline = resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })
const goalFixPipeline = resolvePipeline({ name: "goal-fix", spec: builtInPipelines["goal-fix"]!, agents: builtInAgents })

function makeOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "build it",
    prdHistory: true,
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

/** Deps whose run() queue returns the given scores; failOnCall throws instead. */
function makeDeps(scores: number[], failOnCall?: { call: number; error: Error }): GoalLoopDeps {
  const queue = [...scores]
  let call = 0
  const snapshot: RepoSnapshot = { head: "sha-1" }
  return {
    run: async (): Promise<RunResult> => {
      call++
      if (failOnCall && call === failOnCall.call) throw failOnCall.error
      const score = queue.shift()
      return { runID: `run-${call}`, dir: `/runs/run-${call}`, ...(score === undefined ? {} : { qualityScore: scoreAt(score) }) }
    },
    captureSnapshot: async () => snapshot,
    restoreSnapshot: async () => {},
    isCleanRepo: async () => true,
    currentHead: async () => "sha-1",
    runHooks: (async () => {}) as GoalLoopDeps["runHooks"],
    cleanupWorkspace: async () => {},
  }
}

describe("runGoalLoop with a hosted control adapter", () => {
  beforeEach(() => {
    order.length = 0
    capturedAutoAccept = undefined
    dashboards.length = 0
  })

  afterEach(() => log.mute(false))

  test("borrows one progress for the whole loop and holds once, never stopping it", async () => {
    const autoAccept: AutoAccept = { mode: "off" }
    const options = makeOptions({ progress: hostedProgress(autoAccept) })
    const promise = runGoalLoop(options, buildRunPlan(options), { goal: 90, maxIterations: 3, plateau: 3 }, makeDeps([71, 84, 92]))
    const dashboard = dashboards[0]!
    const deadline = Date.now() + 1_000
    while (dashboard.finishCalls.length === 0 && Date.now() < deadline) await Bun.sleep(1)

    // The adapter borrowed the shared auto-accept reference (the permission
    // gate and the control /auto-accept route share it).
    expect(capturedAutoAccept).toEqual({ mode: "off" })
    expect(order.filter((event) => event === "stop")).toHaveLength(0)
    dashboard.dismiss()

    const outcome = await promise
    expect(outcome.reached).toBe(true)
    expect(outcome.scores).toEqual([71, 84, 92])

    // One host object for both runs, one hold, abort handler cleared on exit,
    // and the loop never stops a borrowed dashboard (the coordinator owns its
    // shutdown).
    expect(order).toEqual(["create", "abort-handler", "hold", "clear-abort-handler"])
    expect(dashboards[0]!.finishCalls[0]?.goalLoop?.scores).toEqual([71, 84, 92])
  })

  test("an aborted loop never holds but still clears the abort handler on the borrowed progress", async () => {
    const options = makeOptions({ progress: hostedProgress({ mode: "off" }) })
    await expect(
      runGoalLoop(options, buildRunPlan(options), { goal: 90, maxIterations: 3, plateau: 3 }, makeDeps([71], { call: 2, error: new UserAbortError("Ctrl+C received") })),
    ).rejects.toThrow("Ctrl+C")

    // No finish screen for an abort; the abort handler is cleared so a stray
    // Ctrl+C after the loop exits cannot fire against a dead shutdown.
    expect(dashboards[0]!.finishCalls).toHaveLength(0)
    expect(order).toEqual(["create", "clear-abort-handler"])
    expect(dashboards[0]!.views.length).toBeGreaterThan(0)
  })
})
