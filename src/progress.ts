import { log } from "./log"
import type { StepRunner } from "./types"
import type { AdvisorEvent, AdvisorPhaseAggregate } from "./advisor-events"

export type ProgressPhase = {
  name: string
  description: string
  /** Shared by every member of a concurrent group (a `parallel:` block, or a step fanned out across `models:`); absent on human gates. */
  groupId?: string
  /** Pre-fan-out logical name; equals `name` unless this step was produced by a `models:` fan-out. Absent on human gates. */
  stepName?: string
  /** The model this step is configured to run, so a fanned-out member can be labelled by its model before it starts. */
  plannedModel?: string
  /** The variant paired with `plannedModel`, when the model shorthand carried one. */
  plannedVariant?: string
  /** Execution engine for the step; absent means OpenCode. The TUI's session window ([o]) branches on this. */
  runner?: StepRunner
  /** Whether Convoy restricts this phase to audit-only behavior. */
  readOnly?: boolean
  plannedAdvisor?: string
  advisorMaxCalls?: number
}

export type ProgressTokens = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export type ProgressUsage = {
  sessionID?: string
  cost?: number
  tokens?: ProgressTokens
  model?: string
}

export type ProgressStepUsage = ProgressUsage & {
  stepID?: string
}

export type ProgressAttempt = {
  attempt: number
  model?: string
}

export type ActivityKind =
  | "tool"
  | "bash"
  | "think"
  | "write"
  | "step"
  | "retry"
  | "permission"
  | "todo"
  | "diff"
  | "error"
  | "info"
  | "system"

export type ProgressTodo = {
  content: string
  status: string
}

/** One raw slice of a phase's live session transcript (see ProgressUI.phaseMessage). */
export type ProgressMessageChannel = "reasoning" | "response" | "tool" | "bash"

/**
 * A verbatim chunk of the model's output for the session transcript. For
 * "reasoning"/"response" the `text` is an incremental delta appended to the
 * open block of that channel; for "tool"/"bash" it is one complete action
 * marker (a tool call or shell command) forming its own line.
 *
 * `partID` identifies the provider-side block the delta belongs to. A change of
 * partID closes the open transcript block, so the separate reasoning summaries a
 * model emits stay separate thoughts instead of concatenating into one paragraph.
 */
export type ProgressMessage = { channel: ProgressMessageChannel; text: string; partID?: string }

export type ProgressDiffSummary = {
  files: number
  additions: number
  deletions: number
}

export type PermissionReply = "once" | "always" | "reject"

/**
 * Shared mutable switch between the permission gate and the TUI, cycled live
 * with shift+tab in the dashboard:
 *   - "off":   every ask-level permission prompts the user.
 *   - "all":   every ask-level permission is allowed blindly ("once").
 *   - "smart": each request is handed to an external AI judge; safe ones are
 *              allowed, risky (or unjudgeable) ones fall back to prompting.
 * The opencode-level denylist is unaffected — denied commands never reach the
 * gate at all. Seeded by --yolo ("all") / --smart ("smart").
 */
export type AutoAcceptMode = "off" | "all" | "smart"
export type AutoAccept = { mode: AutoAcceptMode }

export type ProgressPhaseSnapshot = {
  status: "completed" | "skipped" | "failed"
  sessionID?: string
  durationMs?: number
  cost?: number
  tokens?: ProgressTokens
  model?: string
  advisor?: AdvisorPhaseAggregate
  advisorEvents?: AdvisorEvent[]
}

export type PermissionPromptInfo = {
  id: string
  permission: string
  patterns: string[]
  command?: string
  target?: string
  description?: string
  sessionID?: string
  /** Present when smart auto-accept's judge escalated this request; explains why. */
  judgeReason?: string
  /**
   * Asks the judge for a prose explanation of this request ([e] in the dashboard).
   * Provided by the gate, which holds the opencode client and the judge model;
   * absent when there is no judge to ask.
   */
  explain?(signal?: AbortSignal): Promise<string>
}

export type HumanReviewAction = "continue" | "iterate" | "abort" | "retry"

export type HumanReviewPromptInfo = {
  stepName: string
  iterations: number
  /** Gate mode. "interactive" is the mid-step takeover gate (armed with [i]); "failure" is a failed step waiting for a decision; absent for pipeline human steps. */
  kind?: "interactive" | "failure"
  /** The SDK error a failed step surfaced, shown in the dashboard instead of a generic label. */
  error?: string
  /** Whether [r] (retry clean) is offered: true only for a failure gate with a baseline snapshot. */
  canRetry?: boolean
}

export type RunOutcome = {
  status: "completed" | "failed"
  error?: string
  /** Run workspace dir; still alive while the finish screen is up (cleanup happens after). */
  runDir: string
  /** This run's consensus quality score, when the pipeline scored itself. */
  qualityScore?: number
  /** The goal loop's score trajectory including this run, oldest first; absent when not in goal mode. */
  goalTrajectory?: number[]
  /**
   * Another goal-loop iteration will follow this run. The runner suppresses the
   * finish-screen hold so the loop runs unattended instead of waiting on a
   * keypress between iterations.
   */
  goalContinues?: boolean
}

export type RunControlState = "running" | "pausing" | "paused"

/** The proposed squash, as the finish screen shows it. */
export type FinishProposal = {
  branch: string
  /** How many convoy commits would be replaced. */
  commitCount: number
  subject: string
  body: string[]
  /** Caveats worth showing above the editor: a user commit the walk stopped at, a fallback message. */
  notes: string[]
}

export type FinishOutcome = {
  sha: string
  branch: string
  /** Ref holding the pre-squash tip, so the user can undo. */
  backupRef: string
  replaced: number
}

/**
 * Lets the finish screen offer [f] without importing git or opencode: the host
 * (runner.ts for a live run, attach.ts for a reopened one) supplies both halves,
 * exactly as the launcher receives its branch-naming callbacks.
 */
export type FinishSeam = {
  /** Gathers the commits to replace plus a proposed message, or explains why it can't. */
  prepare(): Promise<{ ok: true; proposal: FinishProposal } | { ok: false; message: string }>
  /** Rewrites the branch. Called with the TUI suspended, so signing can prompt on the terminal. */
  apply(message: { subject: string; body: string[] }): Promise<FinishOutcome>
  /** Opens the user's editor on the full message, returning the edited text. TUI suspended. */
  edit(message: { subject: string; body: string[] }): Promise<{ subject: string; body: string[] } | undefined>
  /** Pushes the finished branch and sets its upstream. TUI suspended, for credential prompts. */
  push(branch: string): Promise<void>
  /** Whether `gh` is installed, so the finish screen only offers a PR when one can be opened. */
  canOpenPullRequest(): boolean
  /** Opens a pull request with the squashed message as title and body. TUI suspended. */
  openPullRequest(message: { subject: string; body: string[] }): Promise<void>
}

/** Host-local screen/idle sleep assertion, intentionally never persisted with a run. */
export type KeepAwakeState = {
  status: "off" | "on" | "unavailable"
  detail?: string
}

/**
 * What the run is doing right now, for surfaces outside the dashboard (the
 * terminal title, desktop notifications). Deliberately distinct from
 * RunStatusKind in runs.ts, which classifies a *finished* run in the history
 * browser; this one is about a live run's moment-to-moment activity.
 *
 * Derived with a fixed precedence: stopped > paused > waiting > working.
 */
export type RunActivity = "working" | "waiting" | "paused" | "stopped"

/** What this run is *about*, for a glanceable tab title. Every field is best effort. */
export type RunIdentity = {
  /** Last segment of the target directory. */
  project: string
  pipeline: string
  branch?: string
}

/** Host-local run state, intentionally never persisted with a run. */
export type RunStatus = {
  activity: RunActivity
  /** 1-based index of the concurrent batch in flight. */
  step: number
  /** Batch count, not flat step count: a `parallel:` block or a `models:` fan-out is one. */
  totalSteps: number
  identity: RunIdentity
  /** Set once the run reaches its finish screen. */
  outcome?: "completed" | "failed"
}

export type ProgressUI = {
  /** `runDir` is the run workspace (where phase reports land); passed early so the reports tab works during a live run, not just on the finish screen. */
  start(runID: string, targetDir: string, runDir?: string): void
  serverReady(url: string): void
  phaseStarted(name: string, detail?: string): void
  phaseRunning(name: string, detail?: string): void
  /** Structured attempt counter and model for the phase, so UIs can place them without parsing detail strings. */
  phaseAttempt(name: string, info: ProgressAttempt): void
  phaseSession(name: string, sessionID: string): void
  /** `pulse` marks heartbeat noise (provider busy, streaming…) that updates the live status line but stays out of the activity feed. */
  phaseActivity(name: string, detail: string, kind?: ActivityKind, pulse?: boolean): void
  /** Streams the model's real output into the phase's live session transcript: verbatim reasoning/response deltas plus one-line tool/bash action markers. Unlike phaseActivity, this is the raw stream, not a summarized log line. */
  phaseMessage(name: string, message: ProgressMessage): void
  phaseStepUsage(name: string, usage: ProgressStepUsage): void
  phaseUsageTotal(name: string, usage: ProgressUsage): void
  /** One durable advisor lifecycle event, already linked to its real phase. */
  phaseAdvisorEvent(name: string, event: AdvisorEvent): void
  phaseTodos(name: string, todos: ProgressTodo[]): void
  phaseDiff(name: string, summary: ProgressDiffSummary): void
  phaseCompleted(name: string, detail?: string): void
  phaseSkipped(name: string): void
  phaseFailed(name: string, detail?: string): void
  /** Replays a phase finished in a previous run (--resume) with its real duration, cost, and session. */
  phaseRestored(name: string, snapshot: ProgressPhaseSnapshot): void
  /** When present, the UI resolves permission prompts itself (no terminal fallback). */
  askPermission?(info: PermissionPromptInfo): Promise<PermissionReply>
  /** When present, the UI keeps manual review gates inside the dashboard. */
  askHumanReview?(info: HumanReviewPromptInfo): Promise<HumanReviewAction>
  /** True while the user has armed interactive takeover ([i]) for this phase: the runner holds a successful finish on the gate. */
  isInteractiveTakeover?(name: string): boolean
  /** Holds the dashboard open on a finish screen (phase browser) and resolves when the user dismisses it. */
  runFinished?(outcome: RunOutcome): Promise<void>
  /** True when the finish screen handed the run dir to an iterate session ([i]), so cleanup must skip it. */
  keepRunDirRequested?(): boolean
  /** Persistent cooperative pause state; pausing waits for the current atomic batch. */
  runControlState?(state: RunControlState, activePhases: number): void
  /** Host-local keep-awake state, driven by the optional macOS Caffeinate process. */
  keepAwakeState?(state: KeepAwakeState): void
  /**
   * Live run state for surfaces outside the dashboard. The TUI implements this
   * by setting the terminal title only — the dashboard itself never changes
   * appearance because of it.
   */
  runStatus?(status: RunStatus): void
  message(message: string): void
  suspend(): void
  resume(): void
  stop(): void
}

export const noopProgress: ProgressUI = {
  start() {},
  serverReady() {},
  phaseStarted() {},
  phaseRunning() {},
  phaseAttempt() {},
  phaseSession() {},
  phaseActivity() {},
  phaseMessage() {},
  phaseStepUsage() {},
  phaseUsageTotal() {},
  phaseAdvisorEvent() {},
  phaseTodos() {},
  phaseDiff() {},
  phaseCompleted() {},
  phaseSkipped() {},
  phaseFailed() {},
  phaseRestored() {},
  message() {},
  suspend() {},
  resume() {},
  stop() {},
}

export async function createProgressUI(
  phases: readonly ProgressPhase[],
  enabled: boolean,
  onAbort?: () => void,
  autoAccept?: AutoAccept,
  controls?: { onPauseToggle?: () => void; onKeepAwakeToggle?: () => void; finish?: FinishSeam },
): Promise<ProgressUI> {
  if (!enabled || !process.stdout.isTTY) return noopProgress

  try {
    const { createTuiProgress } = await import("./tui")
    const progress = await createTuiProgress(phases, onAbort, autoAccept, controls)
    log.mute(true)
    return progress
  } catch (error) {
    log.mute(false)
    log.warn(`OpenTUI unavailable; falling back to plain logs: ${error instanceof Error ? error.message : String(error)}`)
    return noopProgress
  }
}
