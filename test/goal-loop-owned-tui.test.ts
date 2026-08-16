import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import { runGoalLoop, type GoalLoopDeps } from "../src/goal-loop"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import { buildRunPlan } from "../src/run-plan"
import { log } from "../src/log"
import { noopProgress, type AutoAccept, type GoalLoopView, type ProgressUI, type RunOutcome } from "../src/progress"
import { UserAbortError, type RunResult } from "../src/runner"
import type { RepoSnapshot } from "../src/git"
import type { RunOptions } from "../src/types"
import type { QualityScore } from "../src/quality-score"

// The loop builds the dashboard it OWNS (options.progress unset) through
// createProgressUI, which lazily imports ./tui; replacing that factory here
// lets the tests watch the loop-owned dashboard — created, held, and stopped —
// without booting a real renderer. Like test/runner-hosted.test.ts, the mock
// is registered before anything can import the module.
const order: string[] = []
let created = 0
let capturedAutoAccept: AutoAccept | undefined

type OwnedDashboard = {
  progress: ProgressUI
  views: GoalLoopView[]
  finishCalls: RunOutcome[]
  /** Resolves the dashboard's finish hold once it is waiting on it. */
  dismiss: () => void
}

const dashboards: OwnedDashboard[] = []

mock.module("../src/tui", () => ({
  createTuiProgress: async (_phases: unknown, _onAbort: unknown, autoAccept?: AutoAccept): Promise<ProgressUI> => {
    created++
    order.push("create")
    capturedAutoAccept = autoAccept
    const views: GoalLoopView[] = []
    const finishCalls: RunOutcome[] = []
    const dismissers: (() => void)[] = []
    const progress: ProgressUI = {
      ...noopProgress,
      setGoalLoop: (view) => void views.push(view),
      setAbortHandler: (handler) => void order.push(handler ? "abort-handler" : "clear-abort-handler"),
      stop: () => void order.push("stop"),
      runFinished: (outcome) => {
        finishCalls.push(outcome)
        order.push("hold")
        return new Promise<void>((resolve) => dismissers.push(resolve))
      },
    }
    const dashboard: OwnedDashboard = { progress, views, finishCalls, dismiss: () => dismissers.shift()?.() }
    dashboards.push(dashboard)
    return progress
  },
}))

const dimensions: QualityScore["dimensions"] = { prd: 92, tests: 70, security: 95, maintainability: 88, operational: 90, scope: 85 }

function scoreAt(value: number): QualityScore {
  return { score: value, dimensions, verdict: "ready-with-caveats", mustFix: [], gaps: {} }
}

const initialPipeline = resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })
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
    // The loop only mounts a dashboard of its own when the TUI is enabled.
    tui: true,
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

/** createProgressUI only mounts a TUI on a TTY; force one for the test window. */
async function withTty(fn: () => Promise<void>): Promise<void> {
  const original = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  try {
    await fn()
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true })
  }
}

describe("runGoalLoop with an owned dashboard", () => {
  beforeEach(() => {
    order.length = 0
    created = 0
    capturedAutoAccept = undefined
    dashboards.length = 0
  })

  // createProgressUI mutes the log while the TUI is up; restore it after each
  // test so the rest of the process keeps logging normally.
  afterEach(() => log.mute(false))

  test("builds one dashboard for the whole loop and stops it exactly once, after the hold", async () => {
    const options = makeOptions()
    await withTty(async () => {
      const promise = runGoalLoop(options, buildRunPlan(options), { goal: 90, maxIterations: 3, plateau: 3 }, makeDeps([71, 84, 92]))
      const deadline = Date.now() + 1_000
      while (dashboards.length === 0 && Date.now() < deadline) await Bun.sleep(1)
      const dashboard = dashboards[0]!
      while (dashboard.finishCalls.length === 0 && Date.now() < deadline) await Bun.sleep(1)

      // While the finish hold is up, the dashboard is still live: the loop has
      // neither remounted it for iteration 2 nor stopped it yet.
      expect(created).toBe(1)
      expect(order.filter((event) => event === "stop")).toHaveLength(0)
      dashboard.dismiss()

      const outcome = await promise
      expect(outcome.reached).toBe(true)
      expect(outcome.scores).toEqual([71, 84, 92])
    })

    // One dashboard for both runs, stopped exactly once — after the hold. The
    // shared auto-accept reference was handed to it once, at creation. The
    // abort handler is cleared on loop exit (SC-6) before the dashboard stops.
    expect(created).toBe(1)
    expect(order).toEqual(["create", "abort-handler", "hold", "clear-abort-handler", "stop"])
    expect(capturedAutoAccept).toEqual({ mode: "off" })
    expect(dashboards[0]!.finishCalls[0]?.goalLoop?.scores).toEqual([71, 84, 92])
  })

  test("an aborted loop never holds but still stops its owned dashboard once", async () => {
    const options = makeOptions()
    await withTty(async () => {
      await expect(
        runGoalLoop(options, buildRunPlan(options), { goal: 90, maxIterations: 3, plateau: 3 }, makeDeps([71], { call: 2, error: new UserAbortError("Ctrl+C received") })),
      ).rejects.toThrow("Ctrl+C")
    })

    // No finish screen for an abort, but the dashboard the loop owns must not
    // outlive the loop: exactly one stop, from the loop's finally. The abort
    // handler is cleared on loop exit (SC-6) before the dashboard stops.
    expect(created).toBe(1)
    expect(dashboards[0]!.finishCalls).toHaveLength(0)
    expect(order).toEqual(["create", "clear-abort-handler", "stop"])
  })
})
