import type { AdvisorAuditPolicy } from "./advisor-events"
import type { NotificationSettings } from "./notifications"
import type { StepRunnerId } from "./step-runners"
import type { ModelGateway, ModelRoutingOverrides, ResolvedModel } from "./model-routing"

export type RunOptions = {
  prompt: string
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID: string
  keepRunDir: boolean
  modelOverride: string
  /** --advisor: forces this advising model on every advisor-capable step. Empty means "leave config alone". */
  advisorOverride: string
  /** --no-advisor: strips the advisor from every step, whatever config resolved. */
  advisorDisabled: boolean
  /** Content retention for advisor audit events; defaults to hash-only summary. */
  advisorAuditPolicy?: AdvisorAuditPolicy
  gateway?: ModelGateway
  gatewayExplicit?: boolean
  modelRoutingOverrides?: ModelRoutingOverrides
  /** The immutable, reviewed execution description. Legacy programmatic callers may omit it. */
  plan?: RunPlan
  planOnly?: boolean
  noConfirm?: boolean
  tui: boolean
  /** Explicit CLI override for desktop notifications; unset preserves the configured value. */
  notify?: boolean
  /** The merged `notifications:` config block; only the keys the user set. */
  notifications: Partial<NotificationSettings>
  humanReview: boolean
  /** Cap on agents running at once within a concurrent group (`parallel:` block or `models:` fan-out). Groups smaller than this are unaffected. Defaults to `defaultMaxConcurrentAgents` when unset. */
  maxConcurrentAgents?: number
  baseRef: string
  targetDir: string
  /**
   * Run on a fresh branch in its own worktree instead of the current tree. On by
   * default. Consumed before `run()` — the runner only ever sees the resulting
   * `targetDir` — so a resumed run, which continues in its recorded directory,
   * always resolves this to false.
   */
  worktree: boolean
  /** Pins the worktree branch name (`--branch`, or the name confirmed in the launcher) instead of asking the naming model. */
  branch?: string
  includeDirty: boolean
  /** Start with auto-accept enabled: ask-level permissions are allowed without prompting (denylist still applies). */
  yolo: boolean
  /** Start in smart auto-accept: an AI judge allows requests it deems safe and escalates risky ones. */
  smart: boolean
  /** Resolved model for the smart auto-accept judge (--smart-model → config → --model → defaults.model). */
  smartJudgeModel: string
  /**
   * Goal loop: keep fixing until the quality score reaches this value (1–100).
   * Requires a pipeline that ends in a quality-score-report step. CLI --goal
   * beats the pipeline's own `goal:` config.
   */
  goal?: number
  /** Goal loop: cap on fix iterations after the initial run. Defaults to 3. */
  goalMaxIterations?: number
  /** Goal loop: stop when a fix iteration improves the score by less than this many points. Defaults to 3. */
  goalPlateau?: number
  /**
   * Goal loop: the resolved goal-fix pipeline the loop runs for fix iterations
   * (same config chain as the main pipeline). Absent when goal mode is off.
   */
  goalFixPipeline?: Pipeline
  /** Goal loop: scores of the iterations that already ran (this run's own score is appended for display). */
  goalTrajectory?: number[]
  /** Resolved pipeline for new runs; resumed runs replay the pipeline frozen in their metadata. */
  pipeline: Pipeline
  /** Resolved agent registry (built-ins plus project agents) used to assemble the opencode config. */
  agents: AgentSpec[]
  /** Project additions to the bash policy; deny always wins over allow. */
  permissions: PermissionAdditions
  /** Shell hooks configured globally and/or per pipeline. */
  hooks: HooksConfig
}

export type PermissionAdditions = {
  allow: string[]
  deny: string[]
}

export type HookWhen = "success" | "failure" | "always"

export type HookCwd = "target" | "run"

export type HookSpec = {
  /** Optional display name; defaults to the command text. */
  name?: string
  /** Shell command executed through the user's shell (`$SHELL -lc`). */
  command: string
  /** Post-hooks only: run after successful pipelines, failed pipelines, or both. Defaults to success. */
  when?: HookWhen
  /** When true, a non-zero exit logs a warning but does not fail the run. */
  continueOnError?: boolean
  /** Optional timeout; timed-out hooks are terminated and treated as failures. */
  timeoutSeconds?: number
  /** Working directory for the hook. Defaults to the target repo. */
  cwd?: HookCwd
}

export type HookSet = {
  pre: HookSpec[]
  post: HookSpec[]
}

export type HooksConfig = HookSet & {
  /** Pipeline-specific hooks are appended to top-level hooks for matching pipeline names. */
  pipelines: Record<string, HookSet>
}

/**
 * An agent definition: who can run as a pipeline step. Built-ins ship with
 * convoy; projects add their own (prompt at .convoy/agents/<name>.md) or
 * override built-in model/temperature/readOnly from .convoy/config.yaml.
 */
export type AgentSpec = {
  name: string
  description: string
  /** Explicit model from project config; beats defaults.model. */
  model?: string
  /** Built-in preference (e.g. opus for design); loses to defaults.model. */
  defaultModel?: string
  temperature?: number
  /** When true, Convoy disables write/edit/bash tools for this agent. */
  readOnly?: boolean
  /**
   * Gives a read-only agent bash back, under the same policy writable steps get,
   * so a validator can actually run the tests and checks its prompt asks for.
   * Ignored unless `readOnly` is true, and dropped when a step is forced
   * read-only for parallel/multi-model execution: concurrent agents running
   * checks would fight over the same working tree.
   */
  verify?: boolean
  /** Advising model for steps using this agent; beats defaults.advisor, loses to the step's own. */
  advisor?: string
  builtIn: boolean
}

/**
 * Which engine executes an agent step. The default (absent) is the OpenCode
 * SDK; "claude-code" spawns the user's local `claude` CLI instead — read-only
 * audit steps only, authenticated by whatever that install already uses
 * (subscription login or API key).
 */
export type StepRunner = Exclude<StepRunnerId, "opencode">

export type AgentStep = {
  type: "agent"
  name: string
  agentName: string
  description: string
  /** Empty string on claude-code steps that defer to the CLI's default model. */
  model: string
  variant?: string
  /** Frozen logical and physical OpenCode model. Absent only on legacy metadata and Claude Code steps. */
  resolvedModel?: ResolvedModel
  /**
   * Configured advising model (`provider/model[#variant]`) consulted at this
   * step's decision points. Absent means the step runs with no advisor, which
   * is the default: the advisor is opt-in per step.
   */
  advisor?: string
  advisorVariant?: string
  /** Frozen logical and physical advising model, routed through the run's gateway like `resolvedModel`. */
  resolvedAdvisor?: ResolvedModel
  /** Cap on advisor consultations per phase attempt; falls back to the built-in default when absent. */
  advisorMaxCalls?: number
  /** Absent for OpenCode (the default engine). */
  runner?: StepRunner
  inputFiles: readonly string[]
  inputDiff: boolean
  reportPath: string
  /** True when the underlying agent is configured as read-only, or forced read-only for parallel/multi-model execution. */
  readOnly?: boolean
  /** True when this read-only step may still run bash to verify its claims. Never set without `readOnly`. */
  verify?: boolean
  /** Shared by every step produced from the same top-level pipeline entry; the runner batches same-groupId steps to run concurrently. */
  groupId: string
  /** Pre-fan-out logical name; equals `name` unless this step was produced by a `models:` fan-out. */
  stepName: string
  /**
   * A per-step prompt suffix appended to this phase's instructions and no
   * other. Used by the goal loop to hand the goal-fixer the previous scoring
   * round's gaps without leaking them to the re-scorer (which must stay blind
   * to the previous score to avoid anchoring).
   */
  goalBrief?: string
}

export type HumanStep = {
  type: "human"
  name: string
  description: string
}

export type Step = AgentStep | HumanStep

export type Pipeline = {
  name: string
  description?: string
  /** Per-pipeline cap on concurrent agents within a group; unset inherits the defaults/CLI chain. */
  maxConcurrentAgents?: number
  /** Goal loop: keep fixing until the quality score reaches this value. CLI --goal wins. */
  goal?: number
  /** Goal loop: cap on fix iterations after the initial run. */
  goalMaxIterations?: number
  /** Goal loop: stop when a fix iteration improves the score by less than this many points. */
  goalPlateau?: number
  steps: Step[]
}

export type RunPlan = {
  prompt: { source: "inline" | "file" | "resume"; text: string }
  target: {
    directory: string
    baseRef: string
    worktree: boolean
    dirty: boolean
    /** Worktree runs only: the branch name the user confirmed in the launcher's branch step. */
    branch?: string
    /** Worktree runs only: where that branch will be checked out. */
    worktreeDir?: string
  }
  pipeline: Pipeline
  modelRouting: { gateway: ModelGateway }
  smartJudge?: { model: ResolvedModel }
  hooks: HookSet
  attachments: string[]
  permissions: "interactive" | "smart" | "yolo"
  resume?: {
    runID: string
    /** Set when an explicit --gateway reroutes pending phases away from the run's frozen gateway. */
    gatewayOverride?: { original: ModelGateway; pending: ModelGateway }
  }
}
