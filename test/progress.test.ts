import { describe, expect, test, mock } from "bun:test"

import {
  noopProgress,
  type AutoAccept,
  type AutoAcceptMode,
  type FinishOutcome,
  type FinishProposal,
  type FinishSeam,
  type HumanReviewAction,
  type HumanReviewPromptInfo,
  type KeepAwakeState,
  type PermissionPromptInfo,
  type PermissionReply,
  type ProgressAttempt,
  type ProgressDiffSummary,
  type ProgressMessage,
  type ProgressMessageChannel,
  type ProgressPhase,
  type ProgressPhaseSnapshot,
  type ProgressTodo,
  type ProgressTokens,
  type ProgressUsage,
  type ProgressStepUsage,
  type ProgressUI,
  type RunActivity,
  type RunControlState,
  type RunIdentity,
  type RunOutcome,
  type RunStatus,
  type ActivityKind,
} from "../src/progress"

describe("noopProgress", () => {
  const requiredMethods = [
    "start",
    "serverReady",
    "phaseStarted",
    "phaseRunning",
    "phaseAttempt",
    "phaseSession",
    "phaseActivity",
    "phaseMessage",
    "phaseStepUsage",
    "phaseUsageTotal",
    "phaseAdvisorEvent",
    "phaseTodos",
    "phaseDiff",
    "phaseCompleted",
    "phaseSkipped",
    "phaseFailed",
    "phaseRestored",
    "message",
    "suspend",
    "resume",
    "stop",
  ] as const

  for (const method of requiredMethods) {
    test(`${method} is a function and returns undefined when called`, () => {
      expect(typeof (noopProgress as any)[method]).toBe("function")
      expect((noopProgress as any)[method]()).toBeUndefined()
    })
  }

  test("optional methods are absent", () => {
    expect(noopProgress.askPermission).toBeUndefined()
    expect(noopProgress.askHumanReview).toBeUndefined()
    expect(noopProgress.isInteractiveTakeover).toBeUndefined()
    expect(noopProgress.runFinished).toBeUndefined()
    expect(noopProgress.keepRunDirRequested).toBeUndefined()
    expect(noopProgress.runControlState).toBeUndefined()
    expect(noopProgress.keepAwakeState).toBeUndefined()
    expect(noopProgress.runStatus).toBeUndefined()
  })

  test("accepts arbitrary arguments without throwing", () => {
    noopProgress.start("any", "args", "here")
    noopProgress.phaseActivity("name", "detail", "tool", true)
    noopProgress.phaseMessage("name", { channel: "reasoning", text: "hello", partID: "p1" })
    noopProgress.phaseRestored("name", { status: "completed", sessionID: "ses_1", durationMs: 1000, cost: 0.01 })
  })
})

describe("createProgressUI", () => {
  async function withTty(value: boolean, fn: () => Promise<void>) {
    const original = process.stdout.isTTY
    Object.defineProperty(process.stdout, "isTTY", { value, configurable: true })
    try {
      await fn()
    } finally {
      Object.defineProperty(process.stdout, "isTTY", { value: original, configurable: true })
    }
  }

  test("returns noopProgress when not enabled", async () => {
    const { createProgressUI } = await import("../src/progress")
    const result = await createProgressUI([], false)
    expect(result).toBe(noopProgress)
  })

  test("returns noopProgress when not a TTY", async () => {
    await withTty(false, async () => {
      const { createProgressUI } = await import("../src/progress")
      const result = await createProgressUI([{ name: "test", description: "" }], true)
      expect(result).toBe(noopProgress)
    })
  })

  test("returns noopProgress when enabled and TTY but TUI import fails", async () => {
    await withTty(true, async () => {
      mock.module("../src/tui", () => ({
        createTuiProgress: mock(() => Promise.reject(new Error("TUI module crashed"))),
      }))
      const { createProgressUI } = await import("../src/progress")
      const result = await createProgressUI([{ name: "test", description: "" }], true)
      expect(result).toBe(noopProgress)
    })
  })

  test("accepts autoAccept parameter without errors", async () => {
    const { createProgressUI } = await import("../src/progress")
    // Even though it returns noopProgress (non-TTY), this verifies the parameter passes through
    const result = await createProgressUI([], false, undefined, { mode: "smart" } as AutoAccept)
    expect(result).toBe(noopProgress)
  })

  test("accepts controls parameter without errors", async () => {
    const { createProgressUI } = await import("../src/progress")
    const controls = {
      onPauseToggle: () => {},
      onKeepAwakeToggle: () => {},
      finish: {} as FinishSeam,
    }
    const result = await createProgressUI([], false, undefined, undefined, controls)
    expect(result).toBe(noopProgress)
  })

  test("accepts onAbort callback without errors", async () => {
    const { createProgressUI } = await import("../src/progress")
    let aborted = false
    const result = await createProgressUI([], false, () => { aborted = true })
    expect(result).toBe(noopProgress)
    expect(aborted).toBe(false) // Callback not called when no TUI
  })
})

describe("type satisfaction (compile-time checks)", () => {
  test("ProgressPhase satisfies its shape", () => {
    const full: ProgressPhase = {
      name: "test",
      description: "a test phase",
      groupId: "g1",
      stepName: "test-step",
      plannedModel: "gpt-4",
      plannedVariant: "variant-a",
      runner: "opencode",
      readOnly: true,
      plannedAdvisor: "advisor-1",
      advisorMaxCalls: 5,
    }
    expect(full.name).toBe("test")
    expect(full.description).toBe("a test phase")
    expect(full.groupId).toBe("g1")
    expect(full.runner).toBe("opencode")
    expect(full.readOnly).toBe(true)
  })

  test("ProgressPhase without optional fields", () => {
    const minimal: ProgressPhase = { name: "minimal", description: "" }
    expect(minimal.name).toBe("minimal")
  })

  test("ProgressPhase with runner field variants", () => {
    const opencode: ProgressPhase = { name: "o", description: "", runner: "opencode" }
    const claudeCode: ProgressPhase = { name: "c", description: "", runner: "claude-code" }
    expect(opencode.runner).toBe("opencode")
    expect(claudeCode.runner).toBe("claude-code")
  })

  test("ProgressPhase with readOnly and plannedAdvisor", () => {
    const restricted: ProgressPhase = { name: "audit", description: "", readOnly: true, plannedAdvisor: "judge" }
    expect(restricted.readOnly).toBe(true)
    expect(restricted.plannedAdvisor).toBe("judge")
  })

  test("ProgressTokens sum matches total", () => {
    const tokens: ProgressTokens = { input: 10, output: 5, reasoning: 2, cacheRead: 3, cacheWrite: 1, total: 21 }
    expect(tokens.input + tokens.output + tokens.reasoning + tokens.cacheRead + tokens.cacheWrite).toBe(tokens.total)
  })

  test("ProgressTokens zero values", () => {
    const tokens: ProgressTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    expect(tokens.total).toBe(0)
  })

  test("ProgressMessage union discrimination", () => {
    const msg: ProgressMessage = { channel: "reasoning", text: "thinking", partID: "part-1" }
    expect(msg.channel).toBe("reasoning")
    expect(msg.text).toBe("thinking")
    expect(msg.partID).toBe("part-1")
  })

  test("ProgressMessage without partID", () => {
    const msg: ProgressMessage = { channel: "response", text: "hello" }
    expect(msg.partID).toBeUndefined()
  })

  test("ProgressPhaseSnapshot status variants", () => {
    const completed: ProgressPhaseSnapshot = { status: "completed", sessionID: "ses_1", durationMs: 500, cost: 0.05 }
    const skipped: ProgressPhaseSnapshot = { status: "skipped" }
    const failed: ProgressPhaseSnapshot = { status: "failed" }
    expect(completed.status).toBe("completed")
    expect(skipped.status).toBe("skipped")
    expect(failed.status).toBe("failed")
  })

  test("ProgressPhaseSnapshot with all optional fields", () => {
    const full: ProgressPhaseSnapshot = {
      status: "completed",
      sessionID: "ses_1",
      durationMs: 1000,
      cost: 0.1,
      tokens: { input: 100, output: 50, reasoning: 10, cacheRead: 20, cacheWrite: 5, total: 185 },
      model: "gpt-4",
    }
    expect(full.model).toBe("gpt-4")
    expect(full.tokens!.total).toBe(185)
  })

  test("ActivityKind string union", () => {
    const kinds: ActivityKind[] = ["tool", "bash", "think", "write", "step", "retry", "permission", "todo", "diff", "error", "info", "system"]
    for (const kind of kinds) {
      expect(typeof kind).toBe("string")
    }
  })

  test("PermissionReply variants", () => {
    const replies: PermissionReply[] = ["once", "always", "reject"]
    for (const r of replies) {
      expect(["once", "always", "reject"]).toContain(r)
    }
  })

  test("AutoAcceptMode variants", () => {
    const modes: AutoAcceptMode[] = ["off", "all", "smart"]
    const aa: AutoAccept = { mode: "off" }
    expect(modes).toContain(aa.mode)
  })

  test("AutoAccept all modes", () => {
    const off: AutoAccept = { mode: "off" }
    const all: AutoAccept = { mode: "all" }
    const smart: AutoAccept = { mode: "smart" }
    expect(off.mode).toBe("off")
    expect(all.mode).toBe("all")
    expect(smart.mode).toBe("smart")
  })

  test("RunActivity variants", () => {
    const activities: RunActivity[] = ["working", "waiting", "paused", "stopped"]
    for (const a of activities) {
      expect(["working", "waiting", "paused", "stopped"]).toContain(a)
    }
  })

  test("RunControlState variants", () => {
    const states: RunControlState[] = ["running", "pausing", "paused"]
    for (const s of states) {
      expect(["running", "pausing", "paused"]).toContain(s)
    }
  })

  test("HumanReviewAction variants", () => {
    const actions: HumanReviewAction[] = ["continue", "iterate", "abort", "retry"]
    for (const a of actions) {
      expect(["continue", "iterate", "abort", "retry"]).toContain(a)
    }
  })

  test("RunOutcome structure", () => {
    const completed: RunOutcome = { status: "completed", runDir: "/tmp/run" }
    const failed: RunOutcome = { status: "failed", error: "something broke", runDir: "/tmp/run" }
    expect(completed.status).toBe("completed")
    expect(failed.status).toBe("failed")
    expect(failed.error).toBe("something broke")
  })

  test("RunOutcome with only status", () => {
    const outcome: RunOutcome = { status: "completed", runDir: "/tmp/run" }
    expect(outcome.error).toBeUndefined()
  })

  test("KeepAwakeState", () => {
    const on: KeepAwakeState = { status: "on", detail: "caffeinate running" }
    const off: KeepAwakeState = { status: "off" }
    const na: KeepAwakeState = { status: "unavailable" }
    expect(on.status).toBe("on")
    expect(off.status).toBe("off")
    expect(na.status).toBe("unavailable")
    expect(on.detail).toBe("caffeinate running")
  })

  test("KeepAwakeState with detail on non-on status", () => {
    const state: KeepAwakeState = { status: "unavailable", detail: "no caffeinate binary" }
    expect(state.detail).toBe("no caffeinate binary")
  })

  test("RunStatus", () => {
    const status: RunStatus = { activity: "working", step: 1, totalSteps: 3, identity: { project: "my-project", pipeline: "default" } }
    expect(status.activity).toBe("working")
    expect(status.identity.project).toBe("my-project")
    expect(status.outcome).toBeUndefined()
  })

  test("RunStatus with outcome", () => {
    const completed: RunStatus = { activity: "stopped", step: 3, totalSteps: 3, identity: { project: "p", pipeline: "d" }, outcome: "completed" }
    const failed: RunStatus = { activity: "stopped", step: 2, totalSteps: 3, identity: { project: "p", pipeline: "d" }, outcome: "failed" }
    expect(completed.outcome).toBe("completed")
    expect(failed.outcome).toBe("failed")
  })

  test("RunStatus all activity states with step bounds", () => {
    const working: RunStatus = { activity: "working", step: 1, totalSteps: 5, identity: { project: "p", pipeline: "d" } }
    const waiting: RunStatus = { activity: "waiting", step: 2, totalSteps: 5, identity: { project: "p", pipeline: "d" } }
    const paused: RunStatus = { activity: "paused", step: 2, totalSteps: 5, identity: { project: "p", pipeline: "d" } }
    const stopped: RunStatus = { activity: "stopped", step: 5, totalSteps: 5, identity: { project: "p", pipeline: "d" } }
    expect(working.activity).toBe("working")
    expect(waiting.activity).toBe("waiting")
    expect(paused.activity).toBe("paused")
    expect(stopped.activity).toBe("stopped")
  })

  test("FinishProposal", () => {
    const proposal: FinishProposal = { branch: "main", commitCount: 3, subject: "fix things", body: ["line 1", "line 2"], notes: ["note 1"] }
    expect(proposal.branch).toBe("main")
    expect(proposal.commitCount).toBe(3)
    expect(proposal.subject).toBe("fix things")
  })

  test("FinishProposal empty arrays", () => {
    const proposal: FinishProposal = { branch: "feat", commitCount: 0, subject: "empty", body: [], notes: [] }
    expect(proposal.body).toEqual([])
    expect(proposal.notes).toEqual([])
  })

  test("FinishOutcome", () => {
    const outcome: FinishOutcome = { sha: "abc123", branch: "main", backupRef: "refs/backup", replaced: 2 }
    expect(outcome.sha).toBe("abc123")
    expect(outcome.replaced).toBe(2)
  })

  test("FinishOutcome zero replaced", () => {
    const outcome: FinishOutcome = { sha: "abc", branch: "b", backupRef: "r", replaced: 0 }
    expect(outcome.replaced).toBe(0)
  })

  test("ProgressTodo", () => {
    const todo: ProgressTodo = { content: "write tests", status: "pending" }
    expect(todo.content).toBe("write tests")
    expect(todo.status).toBe("pending")
  })

  test("ProgressDiffSummary", () => {
    const summary: ProgressDiffSummary = { files: 5, additions: 100, deletions: 20 }
    expect(summary.files).toBe(5)
    expect(summary.additions).toBe(100)
  })

  test("ProgressDiffSummary zero values", () => {
    const summary: ProgressDiffSummary = { files: 0, additions: 0, deletions: 0 }
    expect(summary.files).toBe(0)
  })

  test("ProgressUsage and ProgressStepUsage", () => {
    const usage: ProgressUsage = { sessionID: "ses_1", cost: 0.01, model: "gpt-4" }
    const stepUsage: ProgressStepUsage = { ...usage, stepID: "step-1" }
    expect(stepUsage.stepID).toBe("step-1")
    expect(stepUsage.sessionID).toBe("ses_1")
  })

  test("ProgressUsage without optional fields", () => {
    const usage: ProgressUsage = {}
    expect(usage.sessionID).toBeUndefined()
    expect(usage.cost).toBeUndefined()
    expect(usage.tokens).toBeUndefined()
  })

  test("ProgressAttempt", () => {
    const attempt: ProgressAttempt = { attempt: 1, model: "gpt-4" }
    expect(attempt.attempt).toBe(1)
    expect(attempt.model).toBe("gpt-4")
  })

  test("ProgressAttempt without model", () => {
    const attempt: ProgressAttempt = { attempt: 0 }
    expect(attempt.model).toBeUndefined()
  })

  test("HumanReviewPromptInfo", () => {
    const info: HumanReviewPromptInfo = { stepName: "test", iterations: 2, kind: "interactive", canRetry: true }
    expect(info.stepName).toBe("test")
    expect(info.kind).toBe("interactive")
    expect(info.canRetry).toBe(true)
  })

  test("HumanReviewPromptInfo with failure kind and error", () => {
    const info: HumanReviewPromptInfo = { stepName: "test", iterations: 1, kind: "failure", error: "API error", canRetry: true }
    expect(info.kind).toBe("failure")
    expect(info.error).toBe("API error")
  })

  test("HumanReviewPromptInfo without kind and canRetry", () => {
    const info: HumanReviewPromptInfo = { stepName: "test", iterations: 0 }
    expect(info.kind).toBeUndefined()
    expect(info.canRetry).toBeUndefined()
  })

  test("ProgressMessageChannel", () => {
    const channels: ProgressMessageChannel[] = ["reasoning", "response", "tool", "bash"]
    for (const c of channels) {
      expect(["reasoning", "response", "tool", "bash"]).toContain(c)
    }
  })

  test("RunIdentity", () => {
    const id: RunIdentity = { project: "proj", pipeline: "pipe", branch: "feat" }
    expect(id.project).toBe("proj")
    expect(id.branch).toBe("feat")
  })

  test("RunIdentity without branch", () => {
    const id: RunIdentity = { project: "proj", pipeline: "pipe" }
    expect(id.branch).toBeUndefined()
  })

  test("PermissionPromptInfo", () => {
    const info: PermissionPromptInfo = { id: "p1", permission: "write", patterns: ["*"], command: "rm -rf /", sessionID: "ses_1" }
    expect(info.id).toBe("p1")
    expect(info.permission).toBe("write")
    expect(info.command).toBe("rm -rf /")
  })

  test("PermissionPromptInfo with optional fields", () => {
    const info: PermissionPromptInfo = {
      id: "p2",
      permission: "read",
      patterns: [],
      target: "/tmp",
      description: "read access",
      judgeReason: "safe operation",
      explain: async () => "explanation",
    }
    expect(info.target).toBe("/tmp")
    expect(info.judgeReason).toBe("safe operation")
    expect(typeof info.explain).toBe("function")
  })

  test("PermissionPromptInfo minimal", () => {
    const info: PermissionPromptInfo = { id: "p3", permission: "exec", patterns: ["ls"] }
    expect(info.command).toBeUndefined()
    expect(info.sessionID).toBeUndefined()
  })

  test("FinishSeam interface shape", () => {
    const seam: FinishSeam = {
      prepare: async () => ({ ok: true, proposal: { branch: "b", commitCount: 1, subject: "s", body: [], notes: [] } }),
      apply: async () => ({ sha: "a", branch: "b", backupRef: "r", replaced: 0 }),
      edit: async () => undefined,
      push: async () => {},
      canOpenPullRequest: () => false,
      openPullRequest: async () => {},
    }
    expect(typeof seam.prepare).toBe("function")
    expect(typeof seam.push).toBe("function")
    expect(seam.canOpenPullRequest()).toBe(false)
  })

  test("FinishSeam prepare returning ok: false", () => {
    const seam: FinishSeam = {
      prepare: async () => ({ ok: false, message: "nothing to squash" }),
      apply: async () => ({ sha: "a", branch: "b", backupRef: "r", replaced: 0 }),
      edit: async () => undefined,
      push: async () => {},
      canOpenPullRequest: () => true,
      openPullRequest: async () => {},
    }
    expect(seam.canOpenPullRequest()).toBe(true)
  })
})