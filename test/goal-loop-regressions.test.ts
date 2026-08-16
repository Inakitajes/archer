import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

import type { AutoAccept, ProgressUI, RunOutcome, RunStatus } from "../src/progress"
import type { RepoSnapshot } from "../src/git"
import type { RunOptions } from "../src/types"
import type { QualityScore } from "../src/quality-score"
import type { GoalLoopDeps } from "../src/goal-loop"
import type { RunResult } from "../src/runner"

// SC-1: The log module is mocked so the test can observe WHEN the trajectory
// and restore warnings are emitted. The mock respects the mute flag — calls
// while the TUI is up are swallowed, mirroring the real behavior — and records
// visible calls in the shared order array so the test can verify they land
// after the dashboard's stop().
const order: string[] = []
let muted = false
let created = 0
let capturedAutoAccept: AutoAccept | undefined
let dismissHold: () => void = () => {}

mock.module("../src/log", () => ({
  log: {
    mute(value: boolean) {
      muted = value
    },
    info(message: string) {
      if (!muted) order.push(`info:${message}`)
    },
    warn(message: string) {
      if (!muted) order.push(`warn:${message}`)
    },
    error(message: string) {
      order.push(`error:${message}`)
    },
    section(message: string) {
      if (!muted) order.push(`section:${message}`)
    },
  },
}))

// The TUI mock pushes lifecycle events to the same order array and unmutes the
// log on stop — exactly what the real TUI does (log.mute(false) in stop()).
mock.module("../src/tui", () => ({
  createTuiProgress: async (_phases: unknown, _onAbort: unknown, autoAccept?: AutoAccept): Promise<ProgressUI> => {
    created++
    order.push("create")
    capturedAutoAccept = autoAccept
    const dismissers: (() => void)[] = []
    const { noopProgress } = await import("../src/progress")
    const progress: ProgressUI = {
      ...noopProgress,
      setGoalLoop: () => {},
      setAbortHandler: (handler) => void order.push(handler ? "abort-handler" : "clear-abort-handler"),
      stop: () => {
        order.push("stop")
        muted = false
      },
      runFinished: () => {
        order.push("hold")
        return new Promise<void>((resolve) => dismissers.push(resolve))
      },
    }
    dismissHold = () => dismissers.shift()?.()
    return progress
  },
}))

// Imported after the mocks so the goal loop picks them up.
const { runGoalLoop } = await import("../src/goal-loop")
const { builtInAgents, builtInPipelines, resolvePipeline } = await import("../src/pipeline")
const { buildRunPlan } = await import("../src/run-plan")
const { noopProgress } = await import("../src/progress")
const { RunShutdown } = await import("../src/runner")
const { log } = await import("../src/log")

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

function makeDeps(scores: number[]): GoalLoopDeps {
  const queue = [...scores]
  let call = 0
  const snapshot: RepoSnapshot = { head: "sha-1" }
  return {
    run: async (): Promise<RunResult> => {
      call++
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

async function withTty(fn: () => Promise<void>): Promise<void> {
  const original = process.stdout.isTTY
  Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true })
  try {
    await fn()
  } finally {
    Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true })
  }
}

// --- Hosted progress helpers (caller-provided, no TUI) ---

function fakeHostedProgress(): { progress: ProgressUI; finishCalls: RunOutcome[]; dismiss: () => void } {
  const finishCalls: RunOutcome[] = []
  const dismissers: (() => void)[] = []
  const progress: ProgressUI = {
    ...noopProgress,
    setGoalLoop: () => {},
    setAbortHandler: () => {},
    runFinished: (outcome: RunOutcome) => {
      finishCalls.push(outcome)
      return new Promise<void>((resolve) => dismissers.push(resolve))
    },
  }
  return { progress, finishCalls, dismiss: () => dismissers.shift()?.() }
}

async function runHosted(
  options: RunOptions,
  config: { goal: number; maxIterations: number; plateau: number },
  deps: GoalLoopDeps,
  fake: ReturnType<typeof fakeHostedProgress>,
) {
  const promise = runGoalLoop(options, buildRunPlan(options), config, deps)
  const deadline = Date.now() + 1_000
  while (fake.finishCalls.length === 0 && Date.now() < deadline) await Bun.sleep(1)
  fake.dismiss()
  return promise
}

// ---------------------------------------------------------------------------
// SC-1: Summary trajectory and restore warnings are emitted after stop()
// ---------------------------------------------------------------------------

describe("SC-1: summary trajectory and restore warnings are emitted after progress.stop()", () => {
  beforeEach(() => {
    order.length = 0
    created = 0
    muted = false
    capturedAutoAccept = undefined
  })

  afterEach(() => log.mute(false))

  test("the trajectory log lands after the dashboard stops, not during the muted TUI window", async () => {
    await withTty(async () => {
      const promise = runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, makeDeps([71, 84, 92]))
      const deadline = Date.now() + 1_000
      while (!order.includes("hold") && Date.now() < deadline) await Bun.sleep(1)
      dismissHold()
      const outcome = await promise
      expect(outcome.reached).toBe(true)
    })

    // The trajectory and "done" log lines appear AFTER stop, not before.
    const stopIndex = order.indexOf("stop")
    expect(stopIndex).toBeGreaterThan(-1)
    const trajectoryIndex = order.findIndex((e) => e.startsWith("info:goal loop trajectory:"))
    expect(trajectoryIndex).toBeGreaterThan(stopIndex)
    const doneIndex = order.findIndex((e) => e.startsWith("info:goal loop: done"))
    expect(doneIndex).toBeGreaterThan(stopIndex)
    // No trajectory log leaked during the muted window (before stop).
    const preStopTrajectory = order.slice(0, stopIndex).find((e) => e.includes("trajectory"))
    expect(preStopTrajectory).toBeUndefined()
  })

  test("restore warnings are deferred until after stop on a plateau below goal", async () => {
    await withTty(async () => {
      const promise = runGoalLoop(makeOptions(), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, makeDeps([71, 86, 70]))
      const deadline = Date.now() + 1_000
      while (!order.includes("hold") && Date.now() < deadline) await Bun.sleep(1)
      dismissHold()
      await promise
    })

    const stopIndex = order.indexOf("stop")
    expect(stopIndex).toBeGreaterThan(-1)
    // The "best effort" warning and trajectory all land after stop.
    const warnIndex = order.findIndex((e) => e.startsWith("warn:goal loop: best effort"))
    expect(warnIndex).toBeGreaterThan(stopIndex)
  })
})

// ---------------------------------------------------------------------------
// SC-2: Abort in the inter-iteration/startup window
// ---------------------------------------------------------------------------

describe("SC-2: abort in the inter-iteration/startup window does not start work or restore", () => {
  test("an abort during previous.release() prevents the next run from starting", async () => {
    let call = 0
    const started: number[] = []
    const snapshot: RepoSnapshot = { head: "sha-1" }
    const deps: GoalLoopDeps = {
      run: async (): Promise<RunResult> => {
        call++
        started.push(call)
        return {
          runID: `run-${call}`,
          dir: `/runs/run-${call}`,
          qualityScore: scoreAt(71),
          release: async () => {
            if (call === 1) {
              // Signal arrives during the first run's release — after the loop's
              // guard but before the second run starts.
              process.emit("SIGTERM", "SIGTERM")
            }
          },
        }
      },
      captureSnapshot: async () => snapshot,
      restoreSnapshot: async () => {},
      isCleanRepo: async () => true,
      currentHead: async () => "sha-1",
      runHooks: (async () => {}) as GoalLoopDeps["runHooks"],
      cleanupWorkspace: async () => {},
    }
    await expect(
      runGoalLoop(makeOptions({ tui: false }), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, deps),
    ).rejects.toThrow("SIGTERM")

    // Only run 1 started; run 2 was prevented by the re-check after release.
    expect(started).toEqual([1])
  })

  test("an abort before the initial run prevents it from starting", async () => {
    const started: number[] = []
    let signaled = false
    const snapshot: RepoSnapshot = { head: "sha-1" }
    const deps: GoalLoopDeps = {
      run: async (): Promise<RunResult> => {
        started.push(started.length + 1)
        return { runID: "run-1", dir: "/runs/run-1", qualityScore: scoreAt(92) }
      },
      captureSnapshot: async () => snapshot,
      restoreSnapshot: async () => {},
      isCleanRepo: async () => true,
      currentHead: async () => "sha-1",
      runHooks: (async () => {}) as GoalLoopDeps["runHooks"],
      cleanupWorkspace: async () => {},
    }
    // Emit the signal when the loop sets its first goal-loop view, before the
    // initial run starts.
    const progress: ProgressUI = {
      ...noopProgress,
      setGoalLoop: () => {
        if (!signaled) {
          signaled = true
          process.emit("SIGTERM", "SIGTERM")
        }
      },
    }
    await expect(
      runGoalLoop(makeOptions({ tui: false, progress }), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, deps),
    ).rejects.toThrow("SIGTERM")

    // The initial run never started.
    expect(started).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// SC-3: The loop publishes a final status through the status tracker
// ---------------------------------------------------------------------------

describe("SC-3: the loop publishes a final status through the status tracker", () => {
  function fakeProgressWithStatus(): { progress: ProgressUI; statuses: RunStatus[]; finishCalls: RunOutcome[]; dismiss: () => void } {
    const statuses: RunStatus[] = []
    const finishCalls: RunOutcome[] = []
    const dismissers: (() => void)[] = []
    const progress: ProgressUI = {
      ...noopProgress,
      runStatus: (status: RunStatus) => void statuses.push(status),
      setGoalLoop: () => {},
      setAbortHandler: () => {},
      runFinished: (outcome: RunOutcome) => {
        finishCalls.push(outcome)
        return new Promise<void>((resolve) => dismissers.push(resolve))
      },
    }
    return {
      progress,
      statuses,
      finishCalls,
      dismiss: () => dismissers.shift()?.(),
    }
  }

  test("on goal met, the tracker publishes a completed final status to runStatus", async () => {
    const fake = fakeProgressWithStatus()
    const snapshot: RepoSnapshot = { head: "sha-1" }
    const deps: GoalLoopDeps = {
      run: async () => ({ runID: "r", dir: "/run", qualityScore: scoreAt(95) }),
      captureSnapshot: async () => snapshot,
      restoreSnapshot: async () => {},
      isCleanRepo: async () => true,
      currentHead: async () => "sha-1",
      runHooks: (async () => {}) as GoalLoopDeps["runHooks"],
      cleanupWorkspace: async () => {},
    }
    const promise = runGoalLoop(
      makeOptions({ tui: false, progress: fake.progress, notify: true, notifications: { terminalTitle: true } }),
      buildRunPlan(makeOptions()),
      { goal: 90, maxIterations: 3, plateau: 3 },
      deps,
    )
    const deadline = Date.now() + 1_000
    while (fake.finishCalls.length === 0 && Date.now() < deadline) await Bun.sleep(1)
    fake.dismiss()
    const outcome = await promise

    expect(outcome.reached).toBe(true)
    // The tracker published a "stopped" status with outcome "completed" via
    // the loop's hold → progress.runFinished → tracker.finished.
    const finalStatus = fake.statuses.at(-1)
    expect(finalStatus).toBeDefined()
    expect(finalStatus!.activity).toBe("stopped")
    expect(finalStatus!.outcome).toBe("completed")
  })

  test("on a failed run, the tracker publishes a failed final status", async () => {
    const fake = fakeProgressWithStatus()
    let call = 0
    const snapshot: RepoSnapshot = { head: "sha-1" }
    const deps: GoalLoopDeps = {
      run: async () => {
        call++
        if (call === 1) return { runID: "r", dir: "/run", qualityScore: scoreAt(71) }
        throw new Error("fix iteration exploded")
      },
      captureSnapshot: async () => snapshot,
      restoreSnapshot: async () => {},
      isCleanRepo: async () => true,
      currentHead: async () => "sha-1",
      runHooks: (async () => {}) as GoalLoopDeps["runHooks"],
      cleanupWorkspace: async () => {},
    }
    const promise = runGoalLoop(makeOptions({ tui: false, progress: fake.progress }), buildRunPlan(makeOptions()), { goal: 90, maxIterations: 3, plateau: 3 }, deps)
    const deadline = Date.now() + 1_000
    while (fake.finishCalls.length === 0 && Date.now() < deadline) await Bun.sleep(1)
    fake.dismiss()
    await expect(promise).rejects.toThrow("fix iteration exploded")

    const finalStatus = fake.statuses.at(-1)
    expect(finalStatus).toBeDefined()
    expect(finalStatus!.activity).toBe("stopped")
    expect(finalStatus!.outcome).toBe("failed")
  })
})

// ---------------------------------------------------------------------------
// SC-6: RunShutdown.dispose() makes request() inert
// ---------------------------------------------------------------------------

describe("SC-6: RunShutdown.dispose() makes request() inert", () => {
  test("a disposed shutdown does not abort or force-exit on request", () => {
    const shutdown = new RunShutdown()
    shutdown.dispose()
    // request() should be a no-op: no abort, no force timer.
    shutdown.request("SIGTERM")
    expect(shutdown.aborted).toBe(false)
  })

  test("a non-disposed shutdown still aborts on request", () => {
    const shutdown = new RunShutdown()
    shutdown.request("SIGTERM")
    expect(shutdown.aborted).toBe(true)
    shutdown.dispose()
  })
})

// ---------------------------------------------------------------------------
// SC-8: resetPipeline preserves the retainMessage feed entry explicitly
// ---------------------------------------------------------------------------

describe("SC-8: the loop passes retainFeedMessage so the runner forwards it to resetPipeline", () => {
  test("fix iterations carry the iteration announcement as retainFeedMessage", async () => {
    const retainedMessages: (string | undefined)[] = []
    let runCount = 0
    const snapshot: RepoSnapshot = { head: "sha-1" }
    const deps: GoalLoopDeps = {
      run: async (options: RunOptions): Promise<RunResult> => {
        runCount++
        retainedMessages.push(options.retainFeedMessage)
        return runCount === 1
          ? { runID: "r1", dir: "/r1", qualityScore: scoreAt(71) }
          : { runID: "r2", dir: "/r2", qualityScore: scoreAt(92) }
      },
      captureSnapshot: async () => snapshot,
      restoreSnapshot: async () => {},
      isCleanRepo: async () => true,
      currentHead: async () => "sha-1",
      runHooks: (async () => {}) as GoalLoopDeps["runHooks"],
      cleanupWorkspace: async () => {},
    }
    const fake = fakeHostedProgress()
    await runHosted(makeOptions({ progress: fake.progress }), { goal: 90, maxIterations: 3, plateau: 3 }, deps, fake)

    // The initial run has no retainFeedMessage; the fix iteration's options
    // carry the iteration announcement.
    expect(retainedMessages[0]).toBeUndefined()
    expect(retainedMessages[1]).toContain("goal loop: iteration 2/4")
    expect(retainedMessages[1]).toContain("last 71/100")
  })
})
