import { homedir } from "node:os"
import { basename } from "node:path"
import { existsSync } from "node:fs"

import { BoxRenderable, StyledText, TextRenderable, bg, bold, createCliRenderer, decodePasteBytes, fg, stripAnsiSequences, t } from "@opentui/core"

import { defaultAdvisorMaxCalls } from "./advisor"
import { buildAgentRegistry, emptyHooksConfig, loadMergedConvoyConfig } from "./config"
import { currentBranch, resolveWorktreeDefault } from "./git"
import { hooksForPipeline } from "./hooks"
import { startLimitsPoller } from "./limits"
import { builtInPipelines, defaultPipelineName, hasWritableStep, resolvePipeline } from "./pipeline"
import { stepRunnerFor } from "./step-runners"
import { gatewayLabel, modelGateways, type ModelGateway } from "./model-routing"
import { consensusStep } from "./quality-score"
import { prdHistoryFile, prdHistoryPreviewCopy, readPrdHistoryIndex, resolvePrdHistoryPreview, type PrdHistoryEntry, type PrdHistoryPreview } from "./prd-history"
import { runReviewLines } from "./review-tui"
import { clipChunks, hintsRow, joinLines, limitsRow, moreHintsMarker, padBetween, paletteForTerminal, plain, raw, setTheme, spinnerFrame, terminalBackgroundHex, theme, truncate } from "./tui-theme"
import { shortVersion } from "./version"

import type { ConvoyConfig } from "./config"
import type { WorktreeDefault } from "./git"
import type { BoxOptions, CliRenderer, KeyEvent, PasteEvent, TextChunk } from "@opentui/core"
import type { LimitsSnapshot } from "./limits"
import type { AgentSpec, AgentStep, HookSet, HookSpec, RunOptions, RunPlan, Step } from "./types"
import type { Hint, PaletteColor } from "./tui-theme"

export type LaunchRunSelection = {
  targetDir: string
  prompt: string
  pipeline: string
  humanReview: boolean
  tui: boolean
  includeDirty: boolean
  keepRunDir: boolean
  yolo: boolean
  smart: boolean
  gateway: ModelGateway
  /** Goal mode: keep fixing until the quality score reaches this value (1–100). Only set for scored pipelines when goal mode is on. */
  goal?: number
  /** Worktree creation is intentionally deferred until after plan confirmation. */
  isolateWorktree?: boolean
  /** The branch confirmed in the branch step; the worktree is created with exactly this name. */
  branchName?: string
  /** Where that branch will be checked out. */
  worktreeDir?: string
  /** Empty repositories are initialized only after the review is confirmed. */
  initializeGit?: boolean
}

/** A branch name suggested for the run, plus where it came from so the step can say so. */
export type LaunchBranchProposal = {
  branch: string
  /** "declared" when the PRD already named the branch, "model" when the namer answered, "prompt" when it was derived locally, "fallback" for the timestamp. */
  source: "declared" | "model" | "prompt" | "fallback"
  /** Why the model call didn't produce the name; shown as a hint, never as a blocker. */
  error?: string
  /** The naming model that was asked, for attribution in the UI. */
  model?: string
}

/** Whether a candidate branch name can still be created, and where it would live. */
export type LaunchBranchCheck = {
  /** The name after sanitizing plus any collision suffix; may differ from what was passed in. */
  branch: string
  dir: string
  /** Set when the passed name was already taken and had to be suffixed. */
  suffixed?: boolean
}

export type LaunchNavigationSelection =
  | { action: "runs" }
  | { action: "config" }

export type LaunchRunPreparation = {
  /** The exact options and immutable plan that will be handed to the runner. */
  options: RunOptions
  plan: RunPlan
}

export type LaunchReviewedRun = LaunchRunPreparation & {
  action: "run"
  selection: LaunchRunSelection
}

export type LaunchRunTuiResult = LaunchReviewedRun | LaunchNavigationSelection | undefined

export type LaunchRunTuiOptions = {
  targetDir: string
  /** Resolves the run without effects so Review and the runner share one frozen plan. */
  prepareRun(selection: LaunchRunSelection): Promise<LaunchRunPreparation>
  /** Asks the naming model for a branch name. Injected so the launcher stays free of the worktree/opencode modules. */
  proposeBranchName(input: { prompt: string; guidance?: string }): Promise<LaunchBranchProposal>
  /** Sanitizes a candidate and reports where it would live, suffixing it when the name is taken. */
  checkBranchName(name: string): Promise<LaunchBranchCheck>
}

/** Checkout-local history the launcher preloads so the notice can update as toggles change. */
export type LaunchHistoryContext = {
  enabled: boolean
  branch?: string
  entries: readonly PrdHistoryEntry[]
}

// One resolved step, flattened for the preview: `groupId` ties concurrent
// steps together (the runner batches same-groupId steps), and `stepName` is
// the pre-fan-out logical name shared by every `models:` variant. The tree in
// the detail pane reconstructs phases (groups) → agents (stepNames) → models
// from this, so it must survive resolution rather than collapse to a name.
type StepNode = {
  stepName: string
  /** Empty for human gates, which never run concurrently. */
  groupId: string
  kind: "agent" | "human"
  /** Short model label (e.g. "claude-opus-5"); empty for human gates. */
  modelLabel: string
  advisorLabel?: string
}

// One shell hook that would run around the selected pipeline, flattened for
// the preview: global hooks plus the pipeline's own, in execution order.
type HookNode = {
  stage: "pre" | "post"
  /** Display label: the hook's name, falling back to its command text. */
  label: string
  /** Post-hooks only: set when the hook deviates from the "success" default. */
  when?: "failure" | "always"
}

export type PipelineChoice = {
  name: string
  description: string
  source: "built-in" | "configured"
  isDefault: boolean
  steps: StepNode[]
  hooks: HookNode[]
  valid: boolean
  advisedSteps: number
  /** True when the pipeline ends in a quality-score-report step, enabling goal mode. */
  scored: boolean
  error?: string
  /** Prompt text to prefill when launching this pipeline without a prompt; undefined when the prompt stays mandatory. */
  defaultPrompt?: string
  /** Alternative prompts Tab can cycle through while the prompt field is clean. */
  suggestedPrompts?: string[]
  /** True when a resolved agent step will attach the branch's historical PRD. */
  attachesPrdHistory?: boolean
}

type ToggleKey = "smart" | "yolo" | "humanReview" | "includeDirty" | "keepRunDir" | "tui" | "worktree"

type ToggleSpec = {
  key: ToggleKey
  label: string
  flag: string
  description: string
}

type Mode = "pipelines" | "prompt" | "options" | "branch" | "review"

/** The two editable fields of the branch step. */
type BranchField = "name" | "guidance"

/**
 * The prompt field's clean/dirty state: whether its text came from a default or
 * suggestion (`fromDefault`), which default/suggestion it is currently showing
 * (`lastDefault`), and where the Tab suggestion cycle stands. Extracted as a
 * plain value so the prefill/swap/cycle decisions are unit-testable without a
 * renderer; `LaunchPicker` applies the returned states to its own fields.
 */
export type PromptFieldState = {
  prompt: string
  fromDefault: boolean
  lastDefault?: string
  suggestionIndex: number
  hasCycledSuggestions: boolean
}

export function emptyPromptField(): PromptFieldState {
  return { prompt: "", fromDefault: false, suggestionIndex: 0, hasCycledSuggestions: false }
}

/** A clean field holding a default or suggestion: still swappable and Tab-cycleable. */
function cleanPromptField(prompt: string): PromptFieldState {
  return { prompt, fromDefault: true, lastDefault: prompt, suggestionIndex: 0, hasCycledSuggestions: false }
}

/**
 * What opening the prompt step does to a clean field: an empty field adopts the
 * pipeline's defaultPrompt; any existing text (typed, or preserved from another
 * pipeline) is left untouched.
 */
export function prefillPromptField(state: PromptFieldState, defaultPrompt: string | undefined): PromptFieldState {
  if (state.prompt === "" && defaultPrompt) return cleanPromptField(defaultPrompt)
  return state
}

/**
 * What the field becomes after switching to a pipeline with the given default.
 * A clean field (empty, or still holding the previous default) adopts the new
 * default — or clears when the new pipeline has none. User-typed text is
 * preserved across the switch.
 */
export function promptAfterPipelineSwitch(state: PromptFieldState, nextDefaultPrompt: string | undefined): PromptFieldState {
  if (state.fromDefault && state.lastDefault !== undefined) {
    if (state.prompt === "" || state.prompt === state.lastDefault) {
      return nextDefaultPrompt ? cleanPromptField(nextDefaultPrompt) : emptyPromptField()
    }
    // The prompt was edited after a default was applied: it is user text now.
    return markPromptEdited(state)
  }
  if (state.prompt === "" && nextDefaultPrompt) return cleanPromptField(nextDefaultPrompt)
  return state
}

/** A user edit marks the field dirty: text is preserved but no longer swappable or cycleable. */
export function markPromptEdited(state: PromptFieldState): PromptFieldState {
  return { ...state, fromDefault: false, lastDefault: undefined, suggestionIndex: 0, hasCycledSuggestions: false }
}

/** Trims the submitted value without making an untouched generated prompt look user-edited. */
export function trimPromptField(state: PromptFieldState): PromptFieldState {
  const prompt = state.prompt.trim()
  return state.fromDefault && state.lastDefault === state.prompt ? { ...state, prompt, lastDefault: prompt } : { ...state, prompt }
}

/**
 * Tab while the field is clean (empty or holding a default/suggestion): the
 * next suggestedPrompt, wrapping around — the first press shows the first
 * suggestion, repeats advance. Returns undefined when Tab does nothing.
 */
export function nextPromptSuggestion(state: PromptFieldState, suggestions: readonly string[] | undefined): PromptFieldState | undefined {
  if (!suggestions || suggestions.length === 0) return undefined
  if (!state.fromDefault && state.prompt !== "") return undefined
  const index = state.hasCycledSuggestions ? (state.suggestionIndex + 1) % suggestions.length : 0
  const prompt = suggestions[index]!
  return { prompt, fromDefault: true, lastDefault: prompt, suggestionIndex: index, hasCycledSuggestions: true }
}

type Modal =
  | { kind: "message"; title: string; message: string; footer?: string }
  | { kind: "loading"; title: string; message: string; footer?: string }
  | { kind: "confirm"; title: string; message: string; footer?: string; onConfirm: () => void }

const toggles: readonly ToggleSpec[] = [
  {
    key: "smart",
    label: "Smart auto-accept",
    flag: "--smart",
    description: "An AI judge auto-allows safe ask-level permission requests and escalates risky ones.",
  },
  {
    key: "yolo",
    label: "Auto-accept permissions",
    flag: "--yolo",
    description: "Allow every ask-level permission request automatically. The hard denylist still applies.",
  },
  {
    key: "humanReview",
    label: "Human gates",
    flag: "--human-step / --no-human-step",
    description: "Keep manual checkpoints in pipelines that define them.",
  },
  {
    key: "includeDirty",
    label: "Include dirty tree",
    flag: "--include-dirty",
    description: "Include existing local changes in the first phase commit.",
  },
  {
    key: "keepRunDir",
    label: "Keep run directory",
    flag: "--keep-run-dir / --no-keep-run-dir",
    description: "Preserve the run workspace under ~/.convoy/runs after the run finishes.",
  },
  {
    key: "tui",
    label: "Progress dashboard",
    flag: "--tui / --no-tui",
    description: "Show the full-screen dashboard while the pipeline is running.",
  },
  {
    key: "worktree",
    label: "Isolate in a worktree",
    flag: "--worktree / --no-worktree",
    description:
      "Create a new branch + git worktree (named from your prompt) and run Convoy there, leaving the current branch untouched. Finish the run with [f] to squash its commits into one signed conventional commit.",
  },
]

/** The default target a scored run aims for when goal mode is toggled on in the launcher. */
export const defaultGoalTarget = 90

/** The terminal width at or below which the launcher stacks its two panels. */
export const compactLaunchMaxWidth = 84

/** Adjusts a goal target by delta, clamped to 1–100 (never 0: a 0 goal would make the loop a no-op). */
export function adjustGoalTarget(current: number, delta: number): number {
  return Math.max(1, Math.min(100, current + delta))
}

export async function launchRunTui(options: LaunchRunTuiOptions): Promise<LaunchRunTuiResult> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("convoy needs an interactive terminal to open the launcher")
  }

  const config = await loadMergedConvoyConfig(options.targetDir)
  const choices = pipelineChoices(config, buildAgentRegistry(config))

  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  // No targetFps: it only applies while opentui's own loop runs, which convoy
  // never starts — frames come on demand, paced by the ticker below.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  // Unset config means "decide per branch": isolating is right on a trunk, but
  // on a branch you're already where the work should land.
  const worktree =
    config?.defaults.worktree === undefined
      ? await resolveWorktreeDefault(options.targetDir)
      : { isolate: config.defaults.worktree, reason: "set by defaults.worktree" }
  const history = await loadLaunchHistory(options.targetDir, config?.defaults.prdHistory ?? true)
  return new LaunchPicker(renderer, options.targetDir, choices, config?.modelRouting?.gateway ?? "configured", worktree, options, history).result
}

async function loadLaunchHistory(targetDir: string, enabled: boolean): Promise<LaunchHistoryContext> {
  try {
    const entries = (await readPrdHistoryIndex(targetDir)).filter((entry) => {
      try {
        return existsSync(prdHistoryFile(targetDir, entry))
      } catch {
        return false
      }
    })
    return { enabled, entries, branch: await currentBranch(targetDir) }
  } catch {
    return { enabled, entries: [] }
  }
}

export function pipelineChoices(config: ConvoyConfig | undefined, agents: readonly AgentSpec[]): PipelineChoice[] {
  const configured = config?.pipelines ?? {}
  const defaultName = config?.defaults.pipeline ?? defaultPipelineName
  const hooksConfig = config?.hooks ?? emptyHooksConfig()
  const names = [...new Set([...Object.keys(builtInPipelines), ...Object.keys(configured)])].sort((a, b) => a.localeCompare(b))
  names.sort((a, b) => (a === defaultName ? -1 : b === defaultName ? 1 : 0))

  return names.map((name) => {
    const spec = configured[name] ?? builtInPipelines[name]!
    const source: PipelineChoice["source"] = configured[name] ? "configured" : "built-in"
    const hooks = hookNodes(hooksForPipeline(hooksConfig, name))
    try {
      const pipeline = resolvePipeline({
        name,
        spec,
        agents,
        defaultModel: config?.defaults.model,
        defaultAdvisor: config?.defaults.advisor,
        defaultAdvisorMaxCalls: config?.defaults.advisorMaxCalls,
      })
      return {
        name,
        description: spec.description ?? "No description",
        source,
        isDefault: name === defaultName,
        steps: pipeline.steps.map(stepNode),
        hooks,
        valid: true,
        advisedSteps: pipeline.steps.filter((step) => step.type === "agent" && Boolean(step.resolvedAdvisor ?? step.advisor)).length,
        // Goal mode needs both a consensus score step and a writable step: a
        // report-only scored pipeline (review, review-lite) would be mutated by
        // the goal-fixer, contradicting its "makes no changes" contract.
        scored: Boolean(consensusStep(pipeline)) && hasWritableStep(pipeline),
        defaultPrompt: pipeline.defaultPrompt,
        suggestedPrompts: pipeline.suggestedPrompts,
        attachesPrdHistory: pipeline.steps.some((step) => step.type === "agent" && step.prdHistory),
      }
    } catch (error) {
      return {
        name,
        description: spec.description ?? "No description",
        source,
        isDefault: name === defaultName,
        steps: [],
        hooks,
        valid: false,
        advisedSteps: 0,
        scored: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })
}

function hookNodes(set: HookSet): HookNode[] {
  const node = (stage: HookNode["stage"]) => (hook: HookSpec): HookNode => ({
    stage,
    label: (hook.name ?? hook.command).replace(/\s+/g, " ").trim(),
    ...(stage === "post" && (hook.when === "failure" || hook.when === "always") ? { when: hook.when } : {}),
  })
  return [...set.pre.map(node("pre")), ...set.post.map(node("post"))]
}

function stepNode(step: Step): StepNode {
  if (step.type === "human") return { stepName: step.name, groupId: "", kind: "human", modelLabel: "", advisorLabel: "" }
  const advisor = step.resolvedAdvisor?.target ?? step.advisor
  const cap = step.advisorMaxCalls ?? defaultAdvisorMaxCalls
  return {
    stepName: step.stepName,
    groupId: step.groupId,
    kind: "agent",
    modelLabel: launcherStepModelLabel(step),
    advisorLabel: advisor ? `${shortModelLabel(advisor)} advisor ×${cap}` : "",
  }
}

export function launcherStepModelLabel(step: Pick<AgentStep, "model" | "variant" | "runner">): string {
  const runner = stepRunnerFor(step.runner)
  return runner.id === "opencode" ? shortModelLabel(step.model, step.variant) : runner.modelLabel(step.model)
}

/** Drops the provider path from a model id so the tree shows "claude-opus-5", not "anthropic/claude-opus-5#…". */
function shortModelLabel(model: string, variant?: string): string {
  const base = model.slice(model.lastIndexOf("/") + 1)
  return variant ? `${base} ${variant}` : base
}

export class LaunchPicker {
  readonly result: Promise<LaunchRunTuiResult>

  private resolveResult!: (selection: LaunchRunTuiResult) => void
  private mode: Mode = "pipelines"
  private selected = 0
  private scroll = 0
  private prompt = ""
  private cursor = 0
  private promptScroll = 0
  private promptError = ""
  /** True while the prompt text came from a default or suggestion, not the user. */
  private promptFromDefault = false
  /** The default/suggestion currently in the field, for clean/dirty swap detection. */
  private lastDefaultPrompt?: string
  /** Index into the selected pipeline's suggestedPrompts the Tab cycle is showing. */
  private suggestionIndex = 0
  /** True once Tab has been used at all, so a repeat press advances past the first suggestion. */
  private hasCycledSuggestions = false
  private optionIndex = 0
  private optionScroll = 0
  private message = ""
  private modal?: Modal
  private prepared?: LaunchReviewedRun
  private reviewScroll = 0
  private reviewTotalLines = 0
  private reviewFullPrompt = false

  // Branch step state. `branchDir` is the worktree path for the current name,
  // and `branchEdited` flips as soon as the user types: a proposed name may be
  // auto-suffixed on collision, a hand-written one never is.
  private branchName = ""
  /** The prompt the current name was proposed for, so editing the prompt re-names the branch. */
  private branchPrompt = ""
  private branchCursor = 0
  private branchGuidance = ""
  private branchGuidanceCursor = 0
  private branchField: BranchField = "name"
  private branchDir = ""
  private branchSource: LaunchBranchProposal["source"] | "manual" = "manual"
  private branchNote = ""
  private branchError = ""
  private branchChecking = false

  private readonly toggleState: Record<ToggleKey, boolean> = {
    smart: true,
    yolo: false,
    humanReview: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    includeDirty: false,
    keepRunDir: true,
    tui: Boolean(process.stdout.isTTY && process.stderr.isTTY),
    // Always overwritten in the constructor, from defaults.worktree or the branch.
    worktree: true,
  }

  // Goal mode: only visible and toggleable for scored pipelines. The target
  // persists across pipeline switches; runSelection gates it on the selected
  // pipeline actually being scored, so a stale true never leaks into a
  // non-scored run.
  private goalEnabled = false
  private goalTarget = defaultGoalTarget

  private readonly ticker: ReturnType<typeof setInterval>
  // When the screen was last rebuilt, so the ticker can hold its old 250ms pace
  // while nothing is animating.
  private lastRenderAt = 0
  private readonly stopLimits: () => void
  private limits?: LimitsSnapshot
  private readonly headerText: TextRenderable
  private readonly bodyBox: BoxRenderable
  private readonly pipelineText: TextRenderable
  private readonly pipelineBox: BoxRenderable
  private readonly detailText: TextRenderable
  private readonly detailBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly overlay: BoxRenderable
  private readonly modalBox: BoxRenderable
  private readonly modalText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []
  private pipelineRows: (number | undefined)[] = []
  private optionRows: (number | undefined)[] = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handlePaste = (event: PasteEvent) => {
    if (this.mode !== "prompt" && this.mode !== "branch") return
    event.preventDefault()
    event.stopPropagation()
    const text = sanitizePaste(stripAnsiSequences(decodePasteBytes(event.bytes)))
    if (!text) return
    if (this.mode === "branch") {
      // Branch fields are single-line; a pasted newline would desync the cursor.
      this.insertBranchText(text.replace(/\n+/g, " ").trim())
      return
    }
    this.insertPromptText(text)
    this.markPromptDirty()
    this.promptError = ""
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.finish(undefined)
      return
    }

    key.preventDefault()
    key.stopPropagation()
    const modal = this.modal
    if (modal) {
      if (modal.kind === "confirm") {
        if (key.name === "return" || key.name === "linefeed") {
          this.modal = undefined
          modal.onConfirm()
        } else if (key.name === "escape" || key.name === "q") {
          this.modal = undefined
          this.render()
        }
        return
      }
      // Only the message modal can be dismissed; loading blocks input until the async job finishes.
      if (modal.kind === "message" && (key.name === "return" || key.name === "linefeed" || key.name === "escape" || key.name === "space" || key.name === "q")) {
        this.modal = undefined
        this.render()
      }
      return
    }
    switch (this.mode) {
      case "pipelines":
        this.handlePipelineKey(key)
        break
      case "prompt":
        this.handlePromptKey(key)
        break
      case "options":
        this.handleOptionsKey(key)
        break
      case "branch":
        this.handleBranchKey(key)
        break
      case "review":
        this.handleReviewKey(key)
        break
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    private readonly choices: PipelineChoice[],
    private gateway: ModelGateway,
    private readonly worktreeDefault: WorktreeDefault,
    // Named `callbacks` rather than `hooks`: this file already uses "hooks" for the pipeline's shell hooks.
    private readonly callbacks: Pick<LaunchRunTuiOptions, "prepareRun" | "proposeBranchName" | "checkBranchName">,
    private readonly history: LaunchHistoryContext = { enabled: true, entries: [] },
  ) {
    this.toggleState.worktree = worktreeDefault.isolate
    const defaultIndex = choices.findIndex((choice) => choice.isDefault)
    this.selected = defaultIndex >= 0 ? defaultIndex : 0
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "convoy-launch-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })

    // The version rides the border instead of a content row: it never changes
    // while the launcher is open, so it costs nothing to draw it once as chrome.
    const header = this.panel({
      id: "convoy-launch-header",
      height: 4,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: ` convoy ${shortVersion()} `,
      titleAlignment: "left",
    })
    const body = new BoxRenderable(renderer, { id: "convoy-launch-body", width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 })

    const selectFromList = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      // Review is deliberately a committed, read-only screen: use Escape to
      // return to Options instead of changing the pipeline behind its plan.
      if (this.modal || this.mode === "review") return
      const row = event.y - this.pipelineText.y
      const index = this.pipelineRows[row]
      if (index === undefined) return
      this.mode = "pipelines"
      this.promptError = ""
      this.selectPipeline(index)
    }

    const pipeline = this.panel({
      id: "convoy-launch-pipelines",
      height: "100%",
      width: this.pipelineWidth(),
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " pipelines ",
      titleAlignment: "left",
      onMouseDown: selectFromList,
    })
    pipeline.text.onMouseDown = selectFromList

    const selectOption = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      if (this.mode !== "options" || this.modal) return
      event.preventDefault()
      event.stopPropagation()
      const row = event.y - this.detailText.y
      const index = this.optionRows[row]
      if (index === undefined) return
      this.optionIndex = index
      this.toggleOption()
    }

    const scrollReview = (event: LauncherWheelEvent) => {
      if (this.mode !== "review" || this.modal) return
      const delta = wheelDelta(event)
      if (delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      this.scrollReview(delta)
    }

    const detail = this.panel({
      id: "convoy-launch-detail",
      flexGrow: 1,
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " run setup ",
      titleAlignment: "left",
      onMouseDown: selectOption,
      onMouseScroll: scrollReview,
    })
    detail.text.onMouseDown = selectOption
    detail.text.onMouseScroll = scrollReview
    const footer = this.panel({ id: "convoy-launch-footer", height: 3, borderColor: theme.borderDim, backgroundColor: theme.bg })

    this.headerText = header.text
    this.bodyBox = body
    this.pipelineText = pipeline.text
    this.pipelineBox = pipeline.box
    this.detailText = detail.text
    this.detailBox = detail.box
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header.box, background: "bg", border: "border" },
      { box: pipeline.box, background: "bg", border: "borderDim" },
      { box: detail.box, background: "bg", border: "borderDim" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    body.add(pipeline.box)
    body.add(detail.box)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    renderer.root.add(shell)

    // Modals float over the whole canvas, matching config-tui/runs-tui: an
    // absolute overlay centers a rounded accent-bordered box painted on
    // theme.overlay so it masks the setup screen underneath.
    this.overlay = new BoxRenderable(renderer, {
      id: "convoy-launch-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      alignItems: "center",
      justifyContent: "center",
      visible: false,
    })
    this.modalBox = new BoxRenderable(renderer, {
      id: "convoy-launch-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modalBox.add(this.modalText)
    this.overlay.add(this.modalBox)
    renderer.root.add(this.overlay)
    this.paletteTargets.push({ box: this.modalBox, background: "overlay", border: "accent" })

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.keyInput.on("paste", this.handlePaste)
    renderer.on("theme_mode", this.handleThemeMode)

    // Faster than the spinner's 100ms step while a loading modal is up, so its
    // rotation is painted frame by frame instead of sampled late; otherwise the
    // old 250ms clock/meters cadence.
    this.ticker = setInterval(() => {
      if (this.modal?.kind === "loading" || Date.now() - this.lastRenderAt >= 250) this.render()
    }, 80)
    this.stopLimits = startLimitsPoller((snapshot) => {
      this.limits = snapshot
    })
    this.render()
  }

  private handlePipelineKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        this.moveSelection(-1)
        return
      case "down":
      case "j":
        this.moveSelection(1)
        return
      case "pageup":
        this.moveSelection(-this.pipelineVisibleRows())
        return
      case "pagedown":
        this.moveSelection(this.pipelineVisibleRows())
        return
      case "home":
        this.moveSelection(-this.choices.length)
        return
      case "end":
        this.moveSelection(this.choices.length)
        return
      case "return":
      case "linefeed":
        this.openPrompt()
        return
      case "r":
        this.finish({ action: "runs" })
        return
      case "c":
        this.finish({ action: "config" })
        return
      case "q":
      case "escape":
        this.finish(undefined)
        return
    }
  }

  private handlePromptKey(key: KeyEvent) {
    if (key.name === "escape") {
      this.mode = "pipelines"
      this.promptError = ""
      this.render()
      return
    }
    const enterAction = promptEnterAction(key)
    if (enterAction === "newline") {
      this.insertPromptText("\n")
      this.markPromptDirty()
      this.promptError = ""
      this.render()
      return
    }
    if (enterAction === "submit") {
      if (!this.prompt.trim()) {
        this.promptError = "Write a prompt before continuing."
      } else {
        this.applyPromptFieldState(trimPromptField(this.promptFieldState()))
        this.cursor = this.prompt.length
        this.promptError = ""
        this.mode = "options"
        this.optionIndex = 0
      }
      this.render()
      return
    }
    if (key.name === "tab") {
      this.cycleSuggestion()
      return
    }
    if (key.name === "backspace" || (key.ctrl && key.name === "h")) {
      if (this.cursor > 0) {
        this.prompt = this.prompt.slice(0, this.cursor - 1) + this.prompt.slice(this.cursor)
        this.cursor -= 1
        this.markPromptDirty()
      }
      this.promptError = ""
      this.render()
      return
    }
    if (key.ctrl && key.name === "u") {
      this.prompt = ""
      this.cursor = 0
      this.markPromptDirty()
      this.promptError = ""
      this.render()
      return
    }
    if ((key.ctrl && key.name === "a") || key.name === "home") {
      this.cursor = 0
      this.render()
      return
    }
    if ((key.ctrl && key.name === "e") || key.name === "end") {
      this.cursor = this.prompt.length
      this.render()
      return
    }
    if (key.name === "left") {
      this.cursor = clamp(this.cursor - 1, 0, this.prompt.length)
      this.render()
      return
    }
    if (key.name === "right") {
      this.cursor = clamp(this.cursor + 1, 0, this.prompt.length)
      this.render()
      return
    }

    const text = typedText(key)
    if (text) {
      this.insertPromptText(text)
      this.markPromptDirty()
      this.promptError = ""
      this.render()
    }
  }

  /**
   * Tab while the prompt field is clean (empty or still holding a default or
   * previous suggestion) inserts the next suggestedPrompt, wrapping around.
   * The first press shows the first suggestion; repeats advance through the
   * list. A user-edited prompt is left alone.
   */
  private cycleSuggestion() {
    const choice = this.currentChoice()
    const next = nextPromptSuggestion(this.promptFieldState(), choice.suggestedPrompts)
    if (!next) return
    this.applyPromptFieldState(next)
    this.cursor = this.prompt.length
    this.promptError = ""
    this.render()
  }

  private insertPromptText(text: string) {
    this.prompt = this.prompt.slice(0, this.cursor) + text + this.prompt.slice(this.cursor)
    this.cursor += text.length
  }

  /** Marks the field as user-owned: the text is preserved across switches and Tab stops cycling. */
  private markPromptDirty() {
    const state = markPromptEdited(this.promptFieldState())
    this.applyPromptFieldState(state)
  }

  private promptFieldState(): PromptFieldState {
    return {
      prompt: this.prompt,
      fromDefault: this.promptFromDefault,
      lastDefault: this.lastDefaultPrompt,
      suggestionIndex: this.suggestionIndex,
      hasCycledSuggestions: this.hasCycledSuggestions,
    }
  }

  private applyPromptFieldState(state: PromptFieldState) {
    this.prompt = state.prompt
    this.promptFromDefault = state.fromDefault
    this.lastDefaultPrompt = state.lastDefault
    this.suggestionIndex = state.suggestionIndex
    this.hasCycledSuggestions = state.hasCycledSuggestions
  }

  private handleOptionsKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        this.moveOption(-1)
        return
      case "down":
      case "j":
        this.moveOption(1)
        return
      case " ":
      case "space":
        this.toggleOption()
        return
      case "left":
        if (this.optionIndex >= toggles.length && this.goalEnabled) {
          this.goalTarget = adjustGoalTarget(this.goalTarget, -5)
          this.render()
        }
        return
      case "right":
        if (this.optionIndex >= toggles.length && this.goalEnabled) {
          this.goalTarget = adjustGoalTarget(this.goalTarget, 5)
          this.render()
        }
        return
      case "return":
      case "linefeed":
      case "s":
        this.startRun()
        return
      case "g":
        this.gateway = modelGateways[(modelGateways.indexOf(this.gateway) + 1) % modelGateways.length]!
        this.render()
        return
      case "p":
      case "escape":
        this.mode = "prompt"
        this.cursor = this.prompt.length
        this.render()
        return
      case "r":
        this.finish({ action: "runs" })
        return
      case "c":
        this.finish({ action: "config" })
        return
      case "q":
        this.finish(undefined)
        return
    }
  }

  private handleBranchKey(key: KeyEvent) {
    switch (branchActionForKey(key)) {
      case "next-field":
        this.branchField = this.branchField === "name" ? "guidance" : "name"
        this.render()
        return
      case "previous-field":
        this.branchField = this.branchField === "guidance" ? "name" : "guidance"
        this.render()
        return
      case "regenerate":
        void this.proposeBranch({ guidance: this.branchGuidance })
        return
      case "submit":
        // Enter on the hint box means "name it with this", which is the whole
        // point of the box when the prompt was too thin to name anything.
        if (this.branchField === "guidance" && this.branchGuidance.trim()) void this.proposeBranch({ guidance: this.branchGuidance })
        else void this.acceptBranch()
        return
      case "clear":
        this.setBranchField("")
        return
      case "line-start":
        this.setBranchCursor(0)
        return
      case "line-end":
        this.setBranchCursor(this.branchFieldValue().length)
        return
      case "cursor-left":
        this.setBranchCursor(this.branchFieldCursor() - 1)
        return
      case "cursor-right":
        this.setBranchCursor(this.branchFieldCursor() + 1)
        return
      case "delete-back": {
        const value = this.branchFieldValue()
        const at = this.branchFieldCursor()
        if (at > 0) this.setBranchField(value.slice(0, at - 1) + value.slice(at), at - 1)
        else this.render()
        return
      }
      case "back":
        this.mode = "options"
        this.branchError = ""
        this.render()
        return
    }

    const text = typedText(key)
    if (text) this.insertBranchText(text)
  }

  private branchFieldValue() {
    return this.branchField === "name" ? this.branchName : this.branchGuidance
  }

  private branchFieldCursor() {
    return this.branchField === "name" ? this.branchCursor : this.branchGuidanceCursor
  }

  private setBranchField(value: string, cursor = value.length) {
    if (this.branchField === "name") {
      this.branchName = value
      this.branchCursor = clamp(cursor, 0, value.length)
      // The typed name owns the outcome from here: no silent collision suffix,
      // and no conventional prefix forced onto it. The proposal's attribution
      // and its checked path no longer describe what's in the field.
      this.branchSource = "manual"
      this.branchDir = ""
      this.branchNote = ""
      this.branchError = ""
    } else {
      this.branchGuidance = value
      this.branchGuidanceCursor = clamp(cursor, 0, value.length)
    }
    this.render()
  }

  private setBranchCursor(cursor: number) {
    const value = this.branchFieldValue()
    if (this.branchField === "name") this.branchCursor = clamp(cursor, 0, value.length)
    else this.branchGuidanceCursor = clamp(cursor, 0, value.length)
    this.render()
  }

  private insertBranchText(text: string) {
    const value = this.branchFieldValue()
    const at = this.branchFieldCursor()
    this.setBranchField(value.slice(0, at) + text + value.slice(at), at + text.length)
  }

  private handleReviewKey(key: KeyEvent) {
    switch (reviewActionForKey(key)) {
      case "scroll-back":
        this.scrollReview(-1)
        return
      case "scroll-forward":
        this.scrollReview(1)
        return
      case "page-back":
        this.scrollReview(-this.reviewVisibleRows())
        return
      case "page-forward":
        this.scrollReview(this.reviewVisibleRows())
        return
      case "top":
        this.reviewScroll = 0
        this.render()
        return
      case "bottom":
        this.reviewScroll = Math.max(0, this.reviewTotalLines - this.reviewVisibleRows())
        this.render()
        return
      case "toggle-prompt":
        this.reviewFullPrompt = !this.reviewFullPrompt
        this.reviewScroll = 0
        this.render()
        return
      case "start":
        if (this.prepared) this.finish(this.prepared)
        return
      case "back":
        this.prepared = undefined
        this.mode = this.toggleState.worktree ? "branch" : "options"
        this.reviewScroll = 0
        this.reviewTotalLines = 0
        this.render()
        return
      case "cancel":
        this.finish(undefined)
        return
    }
  }

  private scrollReview(delta: number) {
    const maxScroll = Math.max(0, this.reviewTotalLines - this.reviewVisibleRows())
    this.reviewScroll = clamp(this.reviewScroll + delta, 0, maxScroll)
    this.render()
  }

  private openPrompt() {
    const choice = this.currentChoice()
    if (!choice.valid) {
      this.message = `Pipeline "${choice.name}" is invalid: ${choice.error ?? "unknown error"}`
      this.render()
      return
    }
    this.message = ""
    // A clean field adopts the pipeline's default prompt on first open, so a
    // concrete-action pipeline launches without typing. An already-typed prompt
    // (returning from options, or a previous pipeline's preserved text) is kept.
    this.applyPromptFieldState(prefillPromptField(this.promptFieldState(), choice.defaultPrompt))
    this.mode = "prompt"
    this.cursor = this.prompt.length
    this.promptScroll = 0
    this.render()
  }

  private startRun() {
    const choice = this.currentChoice()
    if (!choice.valid) {
      this.message = `Pipeline "${choice.name}" is invalid: ${choice.error ?? "unknown error"}`
      this.render()
      return
    }
    // Worktree runs stop to agree on a branch name first; everything else goes
    // straight to the review as before.
    if (this.toggleState.worktree) {
      // A name already agreed for this exact prompt is kept; a rewritten prompt
      // gets a fresh proposal rather than a stale name.
      if (this.branchName && this.branchPrompt === this.prompt) {
        this.mode = "branch"
        this.render()
        return
      }
      void this.proposeBranch({})
      return
    }
    void this.prepareReview(choice.name)
  }

  /**
   * Asks for a name and lands on the branch step. A failure never blocks: the
   * step opens with whatever could be derived (or empty), so the user can type
   * the name or describe it and regenerate.
   */
  private async proposeBranch(input: { guidance?: string }) {
    this.mode = "branch"
    this.branchField = "name"
    this.modal = { kind: "loading", title: "naming the branch", message: "Asking the namer for a branch name…" }
    this.render()
    try {
      const proposal = await this.callbacks.proposeBranchName({ prompt: this.prompt, guidance: input.guidance?.trim() || undefined })
      const checked = await this.callbacks.checkBranchName(proposal.branch)
      if (!checked.branch) throw new Error("the proposed name had nothing usable in it")
      this.branchPrompt = this.prompt
      this.branchName = checked.branch
      this.branchCursor = checked.branch.length
      this.branchDir = checked.dir
      this.branchSource = proposal.source
      this.branchError = ""
      this.branchNote = branchProposalNote(proposal, checked)
    } catch (error) {
      this.branchName = ""
      this.branchCursor = 0
      this.branchDir = ""
      this.branchSource = "manual"
      this.branchNote = ""
      this.branchError = `Couldn't propose a name (${error instanceof Error ? error.message : String(error)}). Write one, or describe it below and press ctrl+R.`
      this.branchField = "guidance"
    } finally {
      this.modal = undefined
      this.render()
    }
  }

  /** Validates the current name and moves on to the review with it frozen in. */
  private async acceptBranch() {
    const typed = this.branchName.trim()
    if (!typed) {
      this.branchError = "Write a branch name, or describe it below and press ctrl+R."
      this.render()
      return
    }
    if (this.branchChecking) return
    this.branchChecking = true
    try {
      const checked = await this.callbacks.checkBranchName(typed)
      if (!checked.branch) {
        this.branchError = "That name has no usable characters for a git branch."
        this.render()
        return
      }
      // A hand-written name is never silently renamed: show the free name it
      // would become and let the next Enter confirm it.
      if (checked.suffixed && this.branchSource === "manual" && checked.branch !== typed) {
        this.branchName = checked.branch
        this.branchCursor = checked.branch.length
        this.branchDir = checked.dir
        this.branchError = `"${typed}" already exists — press enter again to use ${checked.branch}.`
        this.render()
        return
      }
      this.branchName = checked.branch
      this.branchCursor = checked.branch.length
      this.branchDir = checked.dir
      this.branchError = ""
      await this.prepareReview(this.currentChoice().name)
    } catch (error) {
      this.branchError = error instanceof Error ? error.message : String(error)
      this.render()
    } finally {
      this.branchChecking = false
    }
  }

  private async prepareReview(pipelineName: string) {
    this.modal = { kind: "loading", title: "preparing review", message: "Resolving the exact run plan…" }
    this.render()
    try {
      const { repoBootstrapStatus } = await import("./git")
      const status = await repoBootstrapStatus(this.targetDir)
      const selection = this.runSelection(pipelineName, status !== "ready")
      const preparation = await this.callbacks.prepareRun(selection)
      this.prepared = { action: "run", selection, ...preparation }
      this.mode = "review"
      this.reviewScroll = 0
      this.reviewTotalLines = 0
      this.reviewFullPrompt = false
      this.modal = undefined
      this.render()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.modal = { kind: "message", title: "can't prepare the review", message, footer: "esc dismiss · adjust options and try again" }
      this.render()
    }
  }

  private runSelection(pipelineName: string, initializeGit = false): LaunchRunSelection {
    return {
      targetDir: this.targetDir,
      prompt: this.prompt,
      pipeline: pipelineName,
      humanReview: this.toggleState.humanReview,
      tui: this.toggleState.tui,
      includeDirty: this.toggleState.includeDirty,
      keepRunDir: this.toggleState.keepRunDir,
      yolo: this.toggleState.yolo,
      smart: this.toggleState.smart,
      gateway: this.gateway,
      ...(this.goalEnabled && this.currentChoice().scored ? { goal: this.goalTarget } : {}),
      isolateWorktree: this.toggleState.worktree,
      ...(this.toggleState.worktree && this.branchName ? { branchName: this.branchName, worktreeDir: this.branchDir } : {}),
      ...(initializeGit ? { initializeGit: true } : {}),
    }
  }

  private toggleOption() {
    const key = toggles[this.optionIndex]?.key
    if (!key) {
      // The goal row sits after the boolean toggles and only exists for scored pipelines.
      if (this.currentChoice().scored) this.goalEnabled = !this.goalEnabled
      this.render()
      return
    }
    const next = !this.toggleState[key]
    this.toggleState[key] = next
    if (key === "smart" && next) this.toggleState.yolo = false
    if (key === "yolo" && next) this.toggleState.smart = false
    // A fresh worktree is always clean, so includeDirty is meaningless there.
    if (key === "worktree" && next) this.toggleState.includeDirty = false
    if (key === "includeDirty" && next) this.toggleState.worktree = false
    this.render()
  }

  private moveSelection(delta: number) {
    const newIndex = clamp(this.selected + delta, 0, this.choices.length - 1)
    this.selectPipeline(newIndex)
  }

  /** Applies one pipeline selection consistently for keyboard and mouse input. */
  private selectPipeline(newIndex: number) {
    this.message = ""
    if (newIndex === this.selected) {
      this.render()
      return
    }
    this.selected = newIndex
    const newChoice = this.currentChoice()

    // Swap the default prompt cleanly when the field is empty or still holds
    // the previous pipeline's default; a user-typed prompt is preserved across
    // the switch so moving away and back never discards work.
    this.applyPromptFieldState(promptAfterPipelineSwitch(this.promptFieldState(), newChoice.defaultPrompt))

    this.render()
  }

  private moveOption(delta: number) {
    this.optionIndex = clamp(this.optionIndex + delta, 0, this.optionCount() - 1)
    this.render()
  }

  /** Number of selectable rows in the options step: the built-in toggles plus the goal row when the pipeline is scored. */
  private optionCount(): number {
    return toggles.length + (this.currentChoice().scored ? 1 : 0)
  }

  private currentChoice() {
    return this.choices[this.selected] ?? this.choices[0]!
  }

  private finish(selection: LaunchRunTuiResult) {
    clearInterval(this.ticker)
    this.stopLimits()
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.keyInput.off("paste", this.handlePaste)
    this.renderer.off("theme_mode", this.handleThemeMode)
    if (!this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult(selection)
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: "rounded",
      paddingX: 1,
      paddingY: 0,
      ...options,
    })
    const text = new TextRenderable(this.renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    box.add(text)
    return { box, text }
  }

  private render() {
    if (this.renderer.isDestroyed) return
    this.lastRenderAt = Date.now()
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const reviewing = this.mode === "review"
    const compact = this.usesCompactLayout()
    // The Review step owns the whole screen: the pipeline list would only
    // repeat what the plan already freezes, and the plan needs the width.
    this.pipelineBox.visible = !reviewing
    const pipelineWidth = compact ? innerWidth + 4 : this.pipelineWidth()
    // In compact mode both panels occupy the shell's full inner width. Wide
    // screens retain the sidebar, but measure the detail panel from the actual
    // inner width rather than a fixed 40-column floor that could overflow.
    const detailWidth = reviewing || compact ? innerWidth : Math.max(34, innerWidth - pipelineWidth - 1)
    const bodyHeight = this.compactBodyHeight()
    const pipelineHeight = compact ? this.compactPipelineHeight(bodyHeight) : bodyHeight

    this.bodyBox.flexDirection = compact ? "column" : "row"
    this.pipelineBox.width = compact ? "100%" : pipelineWidth
    this.pipelineBox.height = compact ? pipelineHeight : "100%"
    this.detailBox.width = compact || reviewing ? "100%" : detailWidth
    this.detailBox.height = compact ? "auto" : "100%"
    this.detailBox.title = reviewing ? " review " : " run setup "
    // Mirror the dashboard focus cue: the accented border marks where Enter,
    // Esc, and the navigation keys apply in the current setup step.
    this.pipelineBox.borderColor = this.mode === "pipelines" ? theme.accent : theme.borderDim
    this.detailBox.borderColor = this.mode === "pipelines" ? theme.borderDim : theme.accent
    this.headerText.content = this.headerContent(innerWidth)
    // Panels reserve 4 cells of chrome (rounded border + paddingX:1 each side),
    // so lay out the rows against the inner text width — matching detailWidth
    // below. Passing the full box width made every right-aligned badge overflow
    // and wrap onto its own line.
    this.pipelineText.content = this.pipelineContent(pipelineWidth - 4)
    this.detailText.content = this.detailContent(compact || reviewing ? innerWidth : detailWidth - 4)
    this.footerText.content = this.footerContent(innerWidth)
    this.renderModal()
    this.renderer.requestRender()
  }

  private renderModal() {
    const modal = this.modal
    this.overlay.visible = Boolean(modal)
    if (!modal) return
    const boxWidth = this.modalWidth()
    const width = boxWidth - 6
    const lines: StyledText[] = []

    this.modalBox.title = ` ${truncate(modal.title, boxWidth - 8)} `
    this.modalBox.borderColor = modal.kind === "message" ? theme.yellow : theme.accent

    if (modal.kind === "loading") {
      const frame = spinnerFrame(Date.now())
      lines.push(new StyledText([fg(theme.accent)(frame), raw("  "), fg(theme.text)(truncate(modal.message, width - 3))]))
    } else {
      for (const line of wrapWords(modal.message, width)) lines.push(new StyledText([fg(theme.text)(line)]))
    }
    lines.push(plain(""))
    const footer = modal.footer ?? (modal.kind === "message" ? "press any key to dismiss" : modal.kind === "confirm" ? "enter confirm · esc cancel" : "please wait…")
    lines.push(new StyledText([fg(theme.dim)(footer)]))

    this.modalBox.width = boxWidth
    this.modalBox.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }

  private modalWidth() {
    return clamp(this.renderer.width - 8, 34, 80)
  }

  // No "◆ convoy" branding here: the launcher is convoy's own front door, so
  // the target project is the header's anchor and the meter row stays clean.
  // The version still shows, but as the header box's border title so neither
  // content row has to give up space for it.
  private headerContent(width: number) {
    const project = basename(this.targetDir) || this.targetDir
    const title: TextChunk[] = [fg(theme.faint)("target "), bold(fg(theme.text)(truncate(project, Math.max(12, width - 32))))]
    // The branch step only exists for worktree runs, so the stage row grows and
    // shrinks with the toggle instead of showing a step that can't be reached.
    const steps: Array<{ label: string; mode: Mode }> = [
      { label: "pipeline", mode: "pipelines" },
      { label: "prompt", mode: "prompt" },
      { label: "options", mode: "options" },
      ...(this.toggleState.worktree ? [{ label: "branch", mode: "branch" as Mode }] : []),
      { label: "review", mode: "review" },
    ]
    const stage: TextChunk[] = []
    const currentStep = steps.find((step) => step.mode === this.mode)
    if (width < 60 && currentStep) {
      stage.push(bold(fg(theme.accent)(currentStep.label)))
    } else {
      for (const [index, step] of steps.entries()) {
        if (index > 0) stage.push(fg(theme.faint)(" → "))
        stage.push(this.mode === step.mode ? bold(fg(theme.accent)(step.label)) : fg(theme.dim)(step.label))
      }
    }
    const line1 = padBetween(title, stage, width)
    return joinLines([line1, limitsRow(this.limits, Date.now(), width)])
  }

  private pipelineContent(width: number) {
    const visible = this.pipelineVisibleRows()
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1
    this.scroll = clamp(this.scroll, 0, Math.max(0, this.choices.length - visible))

    const rows: StyledText[] = []
    this.pipelineRows = []
    for (let index = this.scroll; index < Math.min(this.choices.length, this.scroll + visible); index++) {
      const selected = index === this.selected
      rows.push(pipelineRow(this.choices[index]!, selected, width))
      this.pipelineRows.push(index)
    }
    while (rows.length < visible) {
      rows.push(plain(""))
      this.pipelineRows.push(undefined)
    }
    return joinLines(rows)
  }

  private detailContent(width: number) {
    this.optionRows = []
    switch (this.mode) {
      case "pipelines":
        return this.pipelineDetail(width)
      case "prompt":
        return this.promptDetail(width)
      case "options":
        return this.optionsDetail(width)
      case "branch":
        return this.branchDetail(width)
      case "review":
        return this.reviewDetail(width)
    }
  }

  private pipelineDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(t`${bold(fg(theme.text)(choice.name))}`)
    lines.push(new StyledText([fg(choice.source === "configured" ? theme.teal : theme.faint)(choice.source), choice.isDefault ? fg(theme.green)(" · default") : raw("")]))
    lines.push(plain(""))
    for (const line of wrapWords(choice.description, width)) lines.push(t`${fg(theme.dim)(line)}`)
    lines.push(plain(""))
    if (!choice.valid) {
      lines.push(t`${fg(theme.red)("invalid pipeline")}`)
      for (const line of wrapWords(choice.error ?? "unknown error", width)) lines.push(t`${fg(theme.dim)(line)}`)
    } else {
      lines.push(t`${fg(theme.faint)("steps")}`)
      for (const line of stepTree(choice.steps, width)) lines.push(line)
      const agentSteps = choice.steps.filter((step) => step.kind === "agent").length
      lines.push(plain(""), t`${fg(theme.teal)(`Advisors: ${choice.advisedSteps}/${agentSteps} steps advised`)}`)
    }
    this.pushHistoryNotice(lines, width, "picker")
    lines.push(plain(""))
    for (const line of hookLines(choice.hooks, width)) lines.push(line)
    if (this.message) {
      lines.push(plain(""))
      for (const line of wrapWords(this.message, width)) lines.push(t`${fg(theme.red)(line)}`)
    }
    return joinLines(lines)
  }

  private promptDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(choice.name))]))
    lines.push(plain(""))
    // Wrap the instructions explicitly so the field budget below counts the
    // rows they actually take once the panel is too narrow for one line.
    const describeLines = wrapWords("Describe what Convoy should do. Paste freely; Shift+Enter adds a line.", width)
    for (const line of describeLines) lines.push(t`${fg(theme.dim)(line)}`)
    lines.push(plain(""))

    const fieldWidth = Math.max(10, width - 2)
    const contentWidth = Math.max(1, fieldWidth)
    // Rows the panel spends besides the field: the pipeline line, the blanks,
    // the instructions, and the trailing blank + hint. The field shrinks to
    // keep its own border inside the panel on short screens; the hint (which
    // repeats what the footer shows) is the first row the panel clips.
    const fixedRows = describeLines.length + 5
    const inputHeight = Math.max(3, Math.min(20, this.detailContentHeight() - fixedRows))
    const visibleRows = Math.max(1, inputHeight - 2)
    const wrapped = wrapPromptLines(this.prompt, contentWidth)
    const { row: cursorRow, col: cursorCol } = cursorPosition(this.prompt, this.cursor, contentWidth)

    if (cursorRow < this.promptScroll) this.promptScroll = cursorRow
    if (cursorRow >= this.promptScroll + visibleRows) this.promptScroll = cursorRow - visibleRows + 1
    this.promptScroll = clamp(this.promptScroll, 0, Math.max(0, wrapped.length - visibleRows))

    const start = this.promptScroll
    const end = Math.min(wrapped.length, start + visibleRows)
    const placeholder = "Add onboarding, fix bug #123, review current diff…"

    lines.push(new StyledText([fg(theme.faint)("┌" + "─".repeat(fieldWidth) + "┐")]))
    for (let r = start; r < end; r++) {
      const seg = wrapped[r] ?? ""
      const chunks: TextChunk[] = [fg(theme.faint)("│")]
      if (r === cursorRow) {
        if (!this.prompt && r === 0) {
          const placeholderText = truncate(placeholder, Math.max(0, fieldWidth - 1))
          chunks.push(cursorChunk(" "))
          chunks.push(fg(theme.faint)(placeholderText))
          chunks.push(fg(theme.faint)(" ".repeat(Math.max(0, fieldWidth - 1 - placeholderText.length)) + "│"))
        } else {
          const col = clamp(cursorCol, 0, Math.max(0, fieldWidth - 1))
          const before = seg.slice(0, col)
          const cursorCell = seg[col] ?? " "
          const after = seg.slice(col + 1)
          const used = before.length + 1 + after.length
          chunks.push(fg(theme.text)(before))
          chunks.push(cursorChunk(cursorCell))
          chunks.push(fg(theme.text)(after))
          chunks.push(fg(theme.faint)(" ".repeat(Math.max(0, fieldWidth - used)) + "│"))
        }
      } else {
        chunks.push(fg(this.prompt ? theme.text : theme.faint)(seg))
        chunks.push(fg(theme.faint)(" ".repeat(Math.max(0, fieldWidth - seg.length)) + "│"))
      }
      lines.push(new StyledText(chunks))
    }
    for (let r = end; r < start + visibleRows; r++) {
      lines.push(new StyledText([fg(theme.faint)("│"), fg(theme.faint)(" ".repeat(fieldWidth) + "│")]))
    }
    lines.push(new StyledText([fg(theme.faint)("└" + "─".repeat(fieldWidth) + "┘")]))

    if (this.promptError) {
      lines.push(plain(""))
      lines.push(t`${fg(theme.red)(this.promptError)}`)
    }
    lines.push(plain(""))
    const hint = "shift+enter newline · enter options · ←/→ move · ctrl+U clear · esc back"
    const suggestions = choice.suggestedPrompts
    // The accent slot carries one status: while Tab can cycle suggestions it
    // says how many, otherwise a multi-line prompt owns up to its height. The
    // row is clipped rather than wrapped, so a narrow panel degrades to an
    // ellipsis instead of spilling extra lines into the fixed-height box.
    const suggestionCount = suggestions?.length ?? 0
    const canCycleSuggestions = suggestionCount > 0 && (this.promptFromDefault || this.prompt === "")
    const status =
      canCycleSuggestions
        ? `tab: ${suggestionCount} suggestion${suggestionCount === 1 ? "" : "s"}`
        : wrapped.length > 1
          ? `${wrapped.length} lines`
          : ""
    // Suggestion discovery wins the left edge because this row is clipped in
    // ordinary-width terminals; putting the status last made Tab invisible.
    const hintChunks: TextChunk[] = canCycleSuggestions
      ? [fg(theme.accent)(status), fg(theme.faint)(" · "), fg(theme.faint)(hint)]
      : [fg(theme.faint)(hint)]
    if (!canCycleSuggestions && status) hintChunks.push(fg(theme.faint)(" · "), fg(theme.accent)(status))
    lines.push(new StyledText(clipChunks(hintChunks, width)))
    return joinLines(lines)
  }

  private optionsDetail(width: number) {
    const choice = this.currentChoice()
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(choice.name))]))
    lines.push(new StyledText([fg(theme.faint)("prompt   "), fg(theme.text)(truncate(this.prompt, Math.max(10, width - 9)))]))
    this.pushHistoryNotice(lines, width, "options")
    lines.push(plain(""))
    lines.push(t`${fg(theme.dim)("Toggle extra run parameters, then press Enter to review.")}`)
    lines.push(new StyledText([fg(theme.faint)("gateway  "), bold(fg(theme.text)(gatewayLabel(this.gateway))), fg(theme.dim)("  (g to change)")]))
    lines.push(plain(""))

    this.optionRows = Array(lines.length).fill(undefined)
    for (const [index, spec] of toggles.entries()) {
      const selected = index === this.optionIndex
      const enabled = this.toggleState[spec.key]
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      const toggle = toggleSwitch(enabled)
      const label = selected ? bold(fg(theme.text)(spec.label)) : fg(theme.text)(spec.label)
      const flag = fg(enabled ? theme.green : theme.dim)(spec.flag)
      lines.push(padBetween([marker, ...toggle, raw(" "), label], [flag], width))
      this.optionRows.push(index)
      // The worktree default depends on which branch you're on, so say why it
      // landed where it did — otherwise the checkbox looks like it moves on its own.
      const description =
        spec.key === "worktree"
          ? `Default ${this.worktreeDefault.isolate ? "on" : "off"}: ${this.worktreeDefault.reason}. ${spec.description}`
          : spec.description
      lines.push(new StyledText([raw("        "), fg(theme.dim)(truncate(description, Math.max(8, width - 8)))]))
      this.optionRows.push(index)
    }

    // Goal mode toggle: only for scored pipelines. Sits after the boolean
    // toggles and uses left/right to adjust the target by 5.
    if (this.currentChoice().scored) {
      const selected = this.optionIndex >= toggles.length
      const enabled = this.goalEnabled
      const marker = selected ? fg(theme.accent)("▸ ") : raw("  ")
      const toggle = toggleSwitch(enabled)
      const label = selected ? bold(fg(theme.text)("Goal mode")) : fg(theme.text)("Goal mode")
      const flag = fg(enabled ? theme.green : theme.dim)(enabled ? `--goal ${this.goalTarget}` : `--goal ${defaultGoalTarget}`)
      lines.push(padBetween([marker, ...toggle, raw(" "), label], [flag], width))
      this.optionRows.push(toggles.length)
      const description = enabled
        ? `Keep fixing until the quality score reaches ${this.goalTarget}/100. ←/→ adjust the target.`
        : "Keep fixing until the quality score reaches a target (default 90). Only for scored pipelines."
      lines.push(new StyledText([raw("        "), fg(theme.dim)(truncate(description, Math.max(8, width - 8)))]))
      this.optionRows.push(toggles.length)
    }

    const flags = this.enabledFlags()
    lines.push(plain(""))
    this.optionRows.push(undefined)
    const flagsPrefix = "will run with "
    const flagsText = flags.length ? flags.join(" ") : "no extra flags"
    lines.push(new StyledText([fg(theme.faint)(flagsPrefix), fg(theme.text)(truncate(flagsText, Math.max(1, width - flagsPrefix.length)))]))
    this.optionRows.push(undefined)

    // The toggle list outgrows the panel in compact mode (and on short wide
    // screens), so window it the way the pipeline list does: the selected
    // toggle and its description stay in view instead of the selection
    // walking off the bottom of the panel.
    const visible = Math.max(1, this.detailContentHeight())
    const selectedRow = this.optionRows.findIndex((row) => row === this.optionIndex)
    if (selectedRow >= 0) {
      // The flags summary belongs to the last toggle: reaching it bottoms the
      // window out so the summary scrolls into view rather than staying clipped.
      const selectedEnd = this.optionIndex === this.optionCount() - 1 ? lines.length - 1 : selectedRow + 1
      if (selectedRow < this.optionScroll) this.optionScroll = selectedRow
      if (selectedEnd >= this.optionScroll + visible) this.optionScroll = selectedEnd - visible + 1
    }
    this.optionScroll = clamp(this.optionScroll, 0, Math.max(0, lines.length - visible))
    const windowed = lines.slice(this.optionScroll, this.optionScroll + visible)
    this.optionRows = this.optionRows.slice(this.optionScroll, this.optionScroll + visible)
    while (windowed.length < visible) {
      windowed.push(plain(""))
      this.optionRows.push(undefined)
    }
    return joinLines(windowed)
  }

  private branchDetail(width: number) {
    const lines: StyledText[] = []
    lines.push(new StyledText([fg(theme.faint)("pipeline "), bold(fg(theme.text)(this.currentChoice().name))]))
    lines.push(plain(""))
    // Wrapped explicitly so the focus-follow window below counts the rows the
    // introduction actually takes on narrow panels.
    for (const line of wrapWords("Name the branch and worktree for this run. Nothing is created until you confirm.", width)) {
      lines.push(t`${fg(theme.dim)(line)}`)
    }
    lines.push(plain(""))

    const fieldWidth = Math.max(10, Math.min(width - 2, 60))
    lines.push(new StyledText([fg(theme.faint)("branch")]))
    lines.push(...textField(this.branchName, this.branchCursor, fieldWidth, this.branchField === "name", "feat/short-name"))

    if (this.branchDir) {
      lines.push(new StyledText([fg(theme.faint)("worktree "), fg(theme.dim)(truncate(displayHome(this.branchDir), Math.max(8, width - 9)))]))
    } else if (this.branchName) {
      lines.push(new StyledText([fg(theme.faint)("worktree "), fg(theme.dim)("checked when you press enter")]))
    } else {
      lines.push(plain(""))
    }
    if (this.branchNote) lines.push(new StyledText([fg(theme.faint)(truncate(this.branchNote, width))]))
    else lines.push(plain(""))

    lines.push(plain(""))
    const guidanceRow = lines.length
    lines.push(new StyledText([fg(theme.faint)("hint "), fg(theme.dim)("optional — say how you want it named, then enter")]))
    lines.push(...textField(this.branchGuidance, this.branchGuidanceCursor, fieldWidth, this.branchField === "guidance", "e.g. name it after the budget limits"))

    if (this.branchError) {
      lines.push(plain(""))
      for (const line of wrapWords(this.branchError, width)) lines.push(t`${fg(theme.red)(line)}`)
    }

    // Both fields rarely fit at once in compact mode, so the window follows
    // the focused field: the name field shows the top of the form, and tabbing
    // to the guidance hint pulls its label and box into view.
    const visible = Math.max(1, this.detailContentHeight())
    if (lines.length <= visible) return joinLines(lines)
    const scroll =
      this.branchField === "guidance" ? clamp(guidanceRow + 4 - visible, 0, Math.max(0, lines.length - visible)) : 0
    return joinLines(lines.slice(scroll, scroll + visible))
  }

  private reviewDetail(width: number) {
    const prepared = this.prepared
    if (!prepared) return joinLines([t`${fg(theme.red)("Unable to load the run review.")}`])

    const reviewRows = runReviewLines(prepared.plan, width, { fullPrompt: this.reviewFullPrompt })
    const visible = this.reviewVisibleRows()
    const maxScroll = Math.max(0, reviewRows.length - visible)
    this.reviewScroll = clamp(this.reviewScroll, 0, maxScroll)
    this.reviewTotalLines = reviewRows.length

    const lines = reviewRows.slice(this.reviewScroll, this.reviewScroll + visible)
    while (lines.length < visible) lines.push(plain(""))
    return joinLines(lines)
  }

  private historyPreview(): PrdHistoryPreview {
    return resolvePrdHistoryPreview({
      enabled: this.history.enabled,
      isolateWorktree: this.toggleState.worktree,
      attachesHistory: Boolean(this.currentChoice().attachesPrdHistory),
      branch: this.history.branch,
      entries: this.history.entries,
      fileExists: () => true,
    })
  }

  /**
   * Picker stays quiet unless this checkout already has a PRD (browsing should
   * not nag on every empty review). Options always shows attach-capable outcomes,
   * including "none — will infer".
   */
  private pushHistoryNotice(lines: StyledText[], width: number, surface: "picker" | "options") {
    const preview = this.historyPreview()
    if (surface === "picker" && !preview.found) return
    const copy = prdHistoryPreviewCopy(preview)
    if (!copy) return
    const tone = copy.tone === "attach" ? theme.teal : copy.tone === "warn" ? theme.yellow : theme.dim
    lines.push(plain(""))
    lines.push(new StyledText([fg(theme.faint)("history  "), fg(tone)(truncate(copy.headline, Math.max(8, width - 9)))]))
    if (copy.detail) {
      lines.push(new StyledText([raw("         "), fg(theme.dim)(truncate(copy.detail, Math.max(8, width - 9)))]))
    }
  }

  private enabledFlags() {
    const flags = [`--pipeline ${this.currentChoice().name}`]
    flags.push(`--gateway ${this.gateway}`)
    if (this.toggleState.smart) flags.push("--smart")
    if (this.toggleState.yolo) flags.push("--yolo")
    flags.push(this.toggleState.humanReview ? "--human-step" : "--no-human-step")
    if (this.toggleState.includeDirty) flags.push("--include-dirty")
    if (!this.toggleState.keepRunDir) flags.push("--no-keep-run-dir")
    flags.push(this.toggleState.tui ? "--tui" : "--no-tui")
    flags.push(this.toggleState.worktree ? "--worktree" : "--no-worktree")
    if (this.goalEnabled && this.currentChoice().scored) flags.push(`--goal ${this.goalTarget}`)
    return flags
  }

  /**
   * One row per mode, shed by priority when the terminal is too narrow — the
   * shared helper appends a dim count so a shortened row still admits there are
   * keys it isn't showing. Priority 1 is whatever gets you back out.
   */
  private footerContent(width: number) {
    const row = (hints: Hint[], right: TextChunk[]) => hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker })

    if (this.mode === "pipelines") {
      return row(
        [
          { keys: "↑/↓", label: "select", priority: 2, tone: "dim" },
          { keys: "enter", label: "prompt", priority: 3 },
          { keys: "r", label: "runs", priority: 4 },
          { keys: "c", label: "config", priority: 5 },
          { keys: "q", label: "quit", priority: 1 },
        ],
        [fg(theme.faint)(`${this.selected + 1}/${this.choices.length}`)],
      )
    }
    if (this.mode === "prompt") {
      return row(
        [
          { keys: "type/paste", label: "", priority: 4, tone: "dim" },
          { keys: "shift+enter", label: "newline", priority: 3 },
          { keys: "enter", label: "options", priority: 2 },
          { keys: "esc", label: "back", priority: 1 },
        ],
        [fg(theme.faint)(`${this.prompt.length} char${this.prompt.length === 1 ? "" : "s"}`)],
      )
    }
    if (this.mode === "branch") {
      return row(
        [
          { keys: "enter", label: this.branchField === "guidance" ? "name it from the hint" : "review", priority: 2 },
          { keys: "tab", label: "field", priority: 3 },
          { keys: "ctrl+R", label: "rename", priority: 4 },
          { keys: "esc", label: "options", priority: 1 },
        ],
        [fg(theme.faint)(this.branchField === "name" ? "branch" : "hint")],
      )
    }
    if (this.mode === "review") {
      const end = Math.min(this.reviewScroll + this.reviewVisibleRows(), this.reviewTotalLines)
      return row(
        [
          { keys: "↑/↓", label: "scroll", priority: 3, tone: "dim" },
          { keys: "pgup/pgdn", label: "page", priority: 4 },
          { keys: "p", label: this.reviewFullPrompt ? "collapse prompt" : "expand prompt", priority: 5 },
          { keys: "enter/s", label: "start", priority: 2 },
          { keys: "esc", label: "options", priority: 1 },
          { keys: "q", label: "cancel", priority: 6 },
        ],
        [fg(theme.faint)(`${end}/${this.reviewTotalLines}`)],
      )
    }
    return row(
      [
        { keys: "↑/↓", label: "select", priority: 3, tone: "dim" },
        { keys: "space", label: "toggle", priority: 2 },
        { keys: "g", label: "gateway", priority: 5 },
        { keys: "enter", label: "review", priority: 4 },
        { keys: "p", label: "prompt", priority: 6 },
        { keys: "q", label: "quit", priority: 1 },
      ],
      [fg(theme.faint)(`${this.optionIndex + 1}/${this.optionCount()}`)],
    )
  }

  // The pipeline sidebar is capped at one third of the inner width so the
  // prompt/options panel gets the bulk of the screen; clamped so very narrow
  // terminals still show enough of each pipeline name to disambiguate.
  private pipelineWidth() {
    const inner = Math.max(40, this.renderer.width - 6)
    return clamp(Math.floor(inner / 3), 22, 44)
  }

  private usesCompactLayout() {
    return this.renderer.width <= compactLaunchMaxWidth
  }

  // Enough rows to browse a short list without crowding out the selected
  // pipeline's setup form below it.
  private compactPipelineHeight(bodyHeight: number) {
    return Math.max(5, Math.min(9, Math.floor(bodyHeight * 0.35)))
  }

  private compactBodyHeight() {
    // Header (4), footer (3), and the detail panel's top/bottom borders (2).
    return Math.max(8, this.renderer.height - 9)
  }

  private pipelineVisibleRows() {
    return this.usesCompactLayout() ? Math.max(1, this.compactPipelineHeight(this.compactBodyHeight()) - 2) : this.listHeight()
  }

  private detailContentHeight() {
    if (!this.usesCompactLayout()) return this.listHeight()
    const bodyHeight = this.compactBodyHeight()
    return bodyHeight - this.compactPipelineHeight(bodyHeight) - 1
  }

  private reviewVisibleRows() {
    // Review hides the pipeline panel and owns the whole body in both
    // layouts, so its budget is the full body height — not the detail panel's
    // compact share, which would leave the review half-empty.
    return this.usesCompactLayout() ? Math.max(3, this.compactBodyHeight()) : this.listHeight()
  }

  private listHeight() {
    // Header (4) + footer (3) + list panel borders (2).
    return Math.max(3, this.renderer.height - 9)
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

/** A boxed single-line input, styled like the prompt editor's field. */
function textField(value: string, cursor: number, width: number, focused: boolean, placeholder: string): StyledText[] {
  const border = focused ? theme.accent : theme.faint
  const inner = Math.max(1, width)
  // Scroll the window so the cursor stays visible in a value longer than the box.
  const start = Math.max(0, Math.min(cursor - inner + 1, Math.max(0, value.length - inner + 1)))
  const visible = value.slice(start, start + inner)
  const column = clamp(cursor - start, 0, inner - 1)

  const chunks: TextChunk[] = [fg(border)("│")]
  if (!value) {
    const text = truncate(placeholder, Math.max(0, inner - 1))
    if (focused) chunks.push(cursorChunk(" "), fg(theme.faint)(text), fg(theme.faint)(" ".repeat(Math.max(0, inner - 1 - text.length))))
    else chunks.push(fg(theme.faint)(text), raw(" ".repeat(Math.max(0, inner - text.length))))
  } else if (focused) {
    const before = visible.slice(0, column)
    const at = visible[column] ?? " "
    const after = visible.slice(column + 1)
    chunks.push(fg(theme.text)(before), cursorChunk(at), fg(theme.text)(after))
    chunks.push(raw(" ".repeat(Math.max(0, inner - before.length - 1 - after.length))))
  } else {
    chunks.push(fg(theme.text)(visible), raw(" ".repeat(Math.max(0, inner - visible.length))))
  }
  chunks.push(fg(border)("│"))

  return [
    new StyledText([fg(border)("┌" + "─".repeat(inner) + "┐")]),
    new StyledText(chunks),
    new StyledText([fg(border)("└" + "─".repeat(inner) + "┘")]),
  ]
}

/** Attribution line under the branch field: who proposed the name, and whether it had to move. */
export function branchProposalNote(proposal: LaunchBranchProposal, check: LaunchBranchCheck): string {
  const origin =
    proposal.source === "declared"
      ? "taken from the document"
      : proposal.source === "model"
        ? `proposed by ${proposal.model || "the naming model"}`
        : proposal.source === "prompt"
          ? "derived from your prompt (the naming model didn't answer)"
          : "generic name (nothing to derive it from)"
  return check.suffixed ? `${origin} · renamed, the original was taken` : origin
}

function displayHome(path: string): string {
  const home = homedir()
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

export type BranchAction =
  | "next-field"
  | "previous-field"
  | "regenerate"
  | "submit"
  | "clear"
  | "line-start"
  | "line-end"
  | "cursor-left"
  | "cursor-right"
  | "delete-back"
  | "back"

/**
 * Keyboard contract for the branch step. Plain letters are never bound here —
 * both fields are text inputs, so anything printable must reach them.
 */
export function branchActionForKey(key: Pick<KeyEvent, "name" | "ctrl" | "shift">): BranchAction | undefined {
  if (key.ctrl) {
    switch (key.name) {
      case "r":
        return "regenerate"
      case "u":
        return "clear"
      case "a":
        return "line-start"
      case "e":
        return "line-end"
      case "h":
        return "delete-back"
    }
    return undefined
  }
  switch (key.name) {
    case "tab":
      return key.shift ? "previous-field" : "next-field"
    // Some terminals report shift+tab as its own key rather than a modifier.
    case "backtab":
      return "previous-field"
    case "return":
    case "linefeed":
      return "submit"
    case "home":
      return "line-start"
    case "end":
      return "line-end"
    case "left":
      return "cursor-left"
    case "right":
      return "cursor-right"
    case "backspace":
      return "delete-back"
    case "escape":
      return "back"
  }
  return undefined
}

export type ReviewAction = "scroll-back" | "scroll-forward" | "page-back" | "page-forward" | "top" | "bottom" | "toggle-prompt" | "start" | "back" | "cancel"

/** Keyboard contract for the launcher's native Review step. */
export function reviewActionForKey(key: Pick<KeyEvent, "name" | "shift">): ReviewAction | undefined {
  switch (key.name) {
    case "up":
    case "k":
      return "scroll-back"
    case "down":
    case "j":
      return "scroll-forward"
    case "pageup":
      return "page-back"
    case "pagedown":
    case "space":
      return "page-forward"
    case "home":
      return "top"
    case "end":
      return "bottom"
    case "p":
      return "toggle-prompt"
    case "return":
    case "linefeed":
    case "s":
      return "start"
    case "escape":
      return "back"
    case "q":
      return "cancel"
  }
  return undefined
}

type LauncherWheelEvent = {
  scroll?: { direction: string; delta: number }
  preventDefault(): void
  stopPropagation(): void
}

function wheelDelta(event: LauncherWheelEvent): number {
  const scroll = event.scroll
  if (!scroll || (scroll.direction !== "up" && scroll.direction !== "down")) return 0
  const magnitude = Math.max(1, Math.round(scroll.delta || 1))
  return scroll.direction === "up" ? -magnitude : magnitude
}

// A slider-style toggle: the knob (●) sits on the right when on, left when
// off, over a colored track. The state label is padded to a fixed 3-cell
// column so the labels that follow stay aligned across on/off rows. Returns
// the chunks so the caller can splice them into the row's left column.
function toggleSwitch(enabled: boolean): TextChunk[] {
  if (enabled) {
    return [fg(theme.green)("━━●"), bold(fg(theme.green)(" on "))]
  }
  return [fg(theme.faint)("●━━"), fg(theme.dim)(" off")]
}

export function typedText(key: KeyEvent): string | undefined {
  if (key.ctrl) return undefined
  const name = key.name
  if (name === "space") return " "
  // Accept regular typing (single-char name) or an unrecognized multi-char
  // raw (plain-text paste from terminals without bracketed-paste support).
  // Named keys like arrows/delete carry printable-looking escape sequences
  // in `raw` and must not be inserted as text.
  if (name !== "" && name.length !== 1) return undefined
  const rawValue = key.raw
  if (typeof rawValue !== "string" || rawValue.length === 0) return undefined
  let out = ""
  for (const ch of rawValue) {
    const code = ch.codePointAt(0)!
    if (code >= 0x20 && code !== 0x7f) out += ch
  }
  return out || undefined
}

export function promptEnterAction(key: Pick<KeyEvent, "name" | "shift">): "newline" | "submit" | undefined {
  if (key.name !== "return" && key.name !== "linefeed") return undefined
  return key.shift ? "newline" : "submit"
}

function cursorChunk(text: string): TextChunk {
  return bg(theme.accent)(fg(theme.chipText)(text || " "))
}

export function sanitizePaste(text: string): string {
  // Normalize CR/CRLF to LF (preserving line breaks), collapse tabs to a
  // single space so they don't desync the wrap/cursor column math, and
  // strip any remaining control bytes that some terminals leak outside
  // bracketed-paste frames (ANSI escapes are already gone via
  // stripAnsiSequences above).
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
}

export function wrapPromptLines(text: string, width: number): string[] {
  if (width < 1) return [""]
  const result: string[] = []
  for (const line of text.split("\n")) {
    if (line.length === 0) {
      result.push("")
      continue
    }
    for (let i = 0; i < line.length; i += width) result.push(line.slice(i, i + width))
  }
  return result.length ? result : [""]
}

export function cursorPosition(text: string, cursor: number, width: number): { row: number; col: number } {
  let row = 0
  let col = 0
  const end = Math.min(cursor, text.length)
  for (let i = 0; i < end; i++) {
    const ch = text[i]!
    if (ch === "\n") {
      row += 1
      col = 0
      continue
    }
    if (col >= width) {
      row += 1
      col = 0
    }
    col += 1
  }
  return { row, col }
}

function wrapWords(text: string, width: number) {
  const words = text.replace(/\s+/g, " ").trim().split(" ")
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (!current) {
      current = word
      continue
    }
    if (current.length + 1 + word.length > width) {
      lines.push(current)
      current = word
    } else {
      current += ` ${word}`
    }
  }
  if (current) lines.push(current)
  return lines.length ? lines : [""]
}

// One row per pipeline: a selection dot, the name, and an optional
// right-aligned badge. The dot fills only for the selected row; default/custom
// state is carried by the badge so unselected dots stay visually uniform.
// Exported as a pure helper so the narrow-width badge threshold stays covered
// by a direct unit test, like stepTree and hookLines beside it.
export function pipelineRow(choice: PipelineChoice, selected: boolean, width: number): StyledText {
  const dot = choice.valid ? fg(selected ? theme.accent : theme.dim)(selected ? "●" : "○") : fg(theme.red)("!")
  const badgeText = width >= 30 && (choice.isDefault ? "default" : choice.source === "configured" ? "custom" : "")
  const badge: TextChunk[] = badgeText ? [fg(choice.isDefault ? theme.green : theme.teal)(badgeText)] : []
  // Prefix is dot (1) + space (1); reserve the badge plus a
  // 1-cell gap so a long name truncates instead of wrapping into the badge.
  const nameWidth = Math.max(3, width - 2 - (badgeText ? badgeText.length + 1 : 0))
  const name = truncate(choice.name, nameWidth)
  const label = selected ? bold(fg(theme.text)(name)) : fg(theme.text)(name)
  return padBetween([dot, raw(" "), label], badge, width)
}

// Renders the resolved steps as a tree that shows the run shape the old flat
// list hid: sequential phases stack as `○` nodes top-to-bottom, and any phase
// whose steps run concurrently — a `parallel:` block, or one agent fanned
// across `models:` — forks into branches. Phases come from `groupId` (same id
// = one concurrent batch), agents within a phase from `stepName`, and the
// leaves are the per-model variants.
export function stepTree(steps: readonly StepNode[], width: number): StyledText[] {
  type Agent = { stepName: string; models: string[] }
  type Phase = { kind: "agent" | "human"; groupId: string; agents: Agent[] }

  const phases: Phase[] = []
  for (const node of steps) {
    const last = phases[phases.length - 1]
    // Human gates never batch; each is its own phase. Agent steps join the
    // current phase only while the groupId holds (contiguous by construction).
    if (node.kind === "human" || !last || last.kind !== "agent" || last.groupId !== node.groupId) {
      phases.push({ kind: node.kind, groupId: node.groupId, agents: [{ stepName: node.stepName, models: node.modelLabel ? [relationshipLabel(node)] : [] }] })
      continue
    }
    const agent = last.agents.find((candidate) => candidate.stepName === node.stepName)
    if (agent) agent.models.push(relationshipLabel(node))
    else last.agents.push({ stepName: node.stepName, models: [relationshipLabel(node)] })
  }

  const lines: StyledText[] = []
  const fit = (text: string, used: number) => truncate(text, Math.max(6, width - used))

  for (const phase of phases) {
    if (phase.kind === "human") {
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.yellow)(fit(phase.agents[0]!.stepName, 2)), fg(theme.faint)("  · manual gate")]))
      continue
    }
    const total = phase.agents.reduce((sum, agent) => sum + agent.models.length, 0)

    // A lone single-model step is just a sequential leaf, but still show the
    // resolved model so non-multi-model pipelines are as explicit as fanned-out
    // ones.
    if (total === 1) {
      const agent = phase.agents[0]!
      const model = agent.models[0] ?? ""
      const stepName = fitNameWithModel(agent.stepName, model, width)
      const modelLabel = truncate(model, Math.max(1, width - 6 - stepName.length))
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.text)(stepName), fg(theme.faint)("  · "), fg(theme.dim)(modelLabel)]))
      continue
    }

    // One agent, many models: fan the models out under the step node.
    if (phase.agents.length === 1) {
      const agent = phase.agents[0]!
      const name = fit(agent.stepName, 2)
      lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.text)(name), fg(theme.faint)("  · "), fg(theme.faint)(truncate(`${agent.models.length} models`, Math.max(3, width - 6 - name.length)))]))
      pushModels(lines, agent.models, "  ", width)
      continue
    }

    // A parallel block: several agents run concurrently, each maybe fanned.
    const perAgent = phase.agents[0]!.models.length
    const uniform = perAgent > 1 && phase.agents.every((agent) => agent.models.length === perAgent)
    const annotation = uniform ? `${phase.agents.length} agents × ${perAgent} models` : `${phase.agents.length} agents`
    lines.push(new StyledText([fg(theme.faint)("○ "), fg(theme.text)("parallel"), fg(theme.faint)("  · "), fg(theme.faint)(truncate(annotation, Math.max(3, width - 14)))]))
    phase.agents.forEach((agent, index) => {
      const last = index === phase.agents.length - 1
      const elbow = last ? "└─ " : "├─ "
      if (agent.models.length === 1) {
        const stepName = fit(agent.stepName, 5)
        lines.push(new StyledText([fg(theme.faint)("  " + elbow), fg(theme.text)(stepName), raw("  "), fg(theme.dim)(fit(agent.models[0]!, 7 + stepName.length))]))
      } else {
        lines.push(new StyledText([fg(theme.faint)("  " + elbow), fg(theme.text)(fit(agent.stepName, 5))]))
        pushModels(lines, agent.models, last ? "     " : "  │  ", width)
      }
    })
  }
  return lines
}

function relationshipLabel(node: StepNode): string {
  return node.advisorLabel ? `${node.modelLabel} → ${node.advisorLabel}` : node.modelLabel
}

// Previews the shell hooks that wrap the selected pipeline — global hooks
// plus the pipeline's own — so the launcher shows whether a run has side
// effects configured before it starts. Mirrors the step tree's row shape:
// `○ <stage>  · <label>`, with an extra annotation for non-default post-hook
// `when` values. Stages pad to the same width so labels align across rows.
export function hookLines(hooks: readonly HookNode[], width: number): StyledText[] {
  if (hooks.length === 0) return [new StyledText([fg(theme.faint)("hooks  · none")])]

  const lines: StyledText[] = [t`${fg(theme.faint)("hooks")}`]
  for (const hook of hooks) {
    const stage = hook.stage.padEnd(4)
    const annotation = hook.when === "failure" ? "on failure" : hook.when === "always" ? "always" : ""
    const used = 2 + stage.length + 4 + (annotation ? annotation.length + 4 : 0)
    const label = truncate(hook.label, Math.max(6, width - used))
    const chunks: TextChunk[] = [fg(theme.faint)("○ "), fg(theme.teal)(stage), fg(theme.faint)("  · "), fg(theme.text)(label)]
    if (annotation) chunks.push(fg(theme.faint)("  · " + annotation))
    lines.push(new StyledText(chunks))
  }
  return lines
}

function fitNameWithModel(stepName: string, model: string, width: number) {
  const chrome = 6 // "○ " + "  · "
  const available = Math.max(1, width - chrome)
  const modelBudget = Math.min(model.length, Math.max(1, Math.floor(available / 2)))
  return truncate(stepName, Math.max(1, available - modelBudget))
}

// Model leaves under a step node; `prefix` carries the ancestor spine so the
// leaf connectors line up under the parent's branch.
function pushModels(lines: StyledText[], models: readonly string[], prefix: string, width: number) {
  models.forEach((model, index) => {
    const leaf = index === models.length - 1 ? "└ " : "├ "
    lines.push(new StyledText([fg(theme.faint)(prefix + leaf), fg(theme.dim)(truncate(model, Math.max(6, width - prefix.length - 2)))]))
  })
}
