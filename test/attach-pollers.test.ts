import { describe, expect, test } from "bun:test"

import { startPendingPoller, startResetFollower, type AttachSession } from "../src/attach"
import type { ControlClient } from "../src/control-client"
import type { ControlReset, PendingSnapshot } from "../src/control-server"
import type { PermissionPromptInfo, PermissionReply, ProgressUI, RunOutcome } from "../src/progress"
import type { GoalLoopView } from "../src/progress"

/**
 * The control pollers drive the attach session's gates and view-following.
 * They are exercised here against fake clients and a fake dashboard, the same
 * seam style as test/runner-hosted.test.ts fakes startOpencode. The fakes are
 * stateful like the real server: a resolved gate disappears from /pending.
 */

const view = { runDir: "/runs/20260101-000000-ab12", metaPath: "/runs/20260101-000000-ab12/metadata.json" }

function tuiSpy() {
  const asked: PermissionPromptInfo[] = []
  const outcomes: RunOutcome[] = []
  const tui = {
    askPermission: (info: PermissionPromptInfo) => {
      asked.push(info)
      return Promise.resolve("once" as PermissionReply)
    },
    runFinished: (outcome: RunOutcome) => {
      outcomes.push(outcome)
      return Promise.resolve()
    },
  } as Partial<ProgressUI> as ProgressUI
  return { tui, asked, outcomes }
}

function sessionSpy(tui: ProgressUI) {
  const state = {
    resets: [] as ControlReset[],
    gone: false,
    finishDismissed: false,
    session: {
      tui,
      view: () => view,
      applyReset: (reset: ControlReset) => void state.resets.push(reset),
      coordinatorGone: () => {
        state.gone = true
      },
      onFinishDismissed: () => {
        state.finishDismissed = true
      },
    } as AttachSession,
  }
  return state
}

function clientSpy(snapshots: PendingSnapshot[], opts: { failAt?: number[]; failAll?: boolean } = {}) {
  const calls: { permission?: [string, PermissionReply]; finishDismiss?: number } = {}
  let polls = 0
  let permissionResolved = false
  let finishDismissed = false
  const client = {
    pending: async (): Promise<PendingSnapshot> => {
      const index = polls++
      if (opts.failAll || opts.failAt?.includes(index)) throw new Error("coordinator gone")
      const snapshot = { ...(snapshots[Math.min(index, snapshots.length - 1)] ?? {}) }
      // Resolved gates leave the snapshot, like the real control server.
      if (permissionResolved) delete snapshot.permission
      if (finishDismissed) delete snapshot.finish
      return snapshot
    },
    permission: async (id: string, reply: PermissionReply) => {
      permissionResolved = true
      calls.permission = [id, reply]
    },
    human: async (_action: string) => {},
    finishDismiss: async () => {
      finishDismissed = true
      calls.finishDismiss = (calls.finishDismiss ?? 0) + 1
    },
  } as unknown as ControlClient
  return { client, calls }
}

const fast = 10

describe("controller pending poller", () => {
  test("answers a parked permission through the dashboard and posts the reply", async () => {
    const tui = tuiSpy()
    const spy = sessionSpy(tui.tui)
    const { client, calls } = clientSpy([{ permission: { requestId: "perm-1", permission: "bash", patterns: ["bash"], command: "ls -la" } }])
    const poller = startPendingPoller(client, spy.session, fast)
    try {
      await Bun.sleep(80)
      expect(tui.asked).toHaveLength(1)
      expect(tui.asked[0]?.id).toBe("perm-1")
      expect(tui.asked[0]?.command).toBe("ls -la")
      expect(calls.permission).toEqual(["perm-1", "once"])
    } finally {
      poller.stop()
    }
  })

  test("renders the finish gate's real outcome and dismisses it", async () => {
    const tui = tuiSpy()
    const spy = sessionSpy(tui.tui)
    const goalLoop: GoalLoopView = { target: 90, iteration: 3, maxRuns: 4, plateau: 2, scores: [60, 71, 84], outcome: { reason: "goal", reached: true, restored: false } }
    const { client, calls } = clientSpy([{ finish: { status: "completed", goalLoop } }])
    const poller = startPendingPoller(client, spy.session, fast)
    try {
      await Bun.sleep(80)
      expect(tui.outcomes).toEqual([{ status: "completed", runDir: view.runDir, goalLoop }])
      expect(calls.finishDismiss).toBe(1)
      expect(spy.finishDismissed).toBe(true)
    } finally {
      poller.stop()
    }
  })

  test("consecutive failures end the session; a single miss does not", async () => {
    const tui = tuiSpy()
    // One failed poll between successful ones: the poller keeps going.
    const oneMiss = sessionSpy(tui.tui)
    const poller = startPendingPoller(clientSpy([{}], { failAt: [1] }).client, oneMiss.session, fast)
    await Bun.sleep(100)
    expect(oneMiss.gone).toBe(false)
    poller.stop()

    // Sustained failure: the coordinator is declared gone.
    const dead = sessionSpy(tui.tui)
    const poller2 = startPendingPoller(clientSpy([{}], { failAll: true }).client, dead.session, fast)
    try {
      await Bun.sleep(150)
      expect(dead.gone).toBe(true)
    } finally {
      poller2.stop()
    }
  })
})

describe("observer reset follower", () => {
  test("follows a goal-loop reset but never answers gates", async () => {
    const tui = tuiSpy()
    const spy = sessionSpy(tui.tui)
    const reset: ControlReset = {
      runID: "20260101-000001-cd34",
      targetDir: "/repo",
      runDir: "/runs/20260101-000001-cd34",
      pipelineName: "goal-fix",
      phases: [{ name: "goal-fixer", description: "" }],
      pipeline: { name: "goal-fix", steps: [] },
    }
    // A parked permission shares the snapshot with the reset: the observer
    // must forward the reset and leave the gate strictly alone.
    const { client } = clientSpy([{ reset }, { reset, permission: { requestId: "perm-1", permission: "bash", patterns: ["bash"] } }])
    const poller = startResetFollower(client, spy.session, fast)
    try {
      await Bun.sleep(100)
      expect(spy.resets.length).toBeGreaterThan(0)
      expect(spy.resets.every((seen) => seen === reset)).toBe(true)
      expect(tui.asked).toHaveLength(0)
    } finally {
      poller.stop()
    }
  })

  test("declares the coordinator gone after sustained failures", async () => {
    const tui = tuiSpy()
    const spy = sessionSpy(tui.tui)
    const { client } = clientSpy([{}], { failAll: true })
    const poller = startResetFollower(client, spy.session, fast)
    try {
      await Bun.sleep(150)
      expect(spy.gone).toBe(true)
    } finally {
      poller.stop()
    }
  })
})
