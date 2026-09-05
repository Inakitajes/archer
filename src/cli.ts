import { readFile, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { buildAgentRegistry, ejectAgentPrompt, emptyHooksConfig, globalConfigPath, loadMergedConvoyConfig, selectPipelineSpec, writeDefaultGlobalConfig, writeDefaultProjectConfig, type ConvoyDefaults } from "./config"
import { readControlFile } from "./control-client"
import { detectBaseRef, currentBranch, listChangedFiles, resolveWorktreeDefault } from "./git"
import { openRouterKeySources } from "./limits"
import { log } from "./log"
import { builtInAgents, defaultGptModel, defaultGptVariant, defaultPipeline, defaultPipelineName, hasWritableStep, resolvePipeline, splitModelVariant, validateStepFilters } from "./pipeline"
import { consensusStep } from "./quality-score"
import { defaultMaxConcurrentAgents, parseModel } from "./runner"
import { buildRunPlan, type BuildRunPlanInput } from "./run-plan"
import { confirmRunPlan, renderRunPlan } from "./run-review"
import { loadPrdHistoryPreview } from "./prd-history"
import { loadOpenSpecBundle, openSpecPromptFor } from "./openspec"
import { isModelGateway, modelGatewayChoices, modelGateways, type ModelGateway } from "./model-routing"
import { browseRuns, isControlLive, isServerLive } from "./runs"
import { browseSpecs, buildIterateSessionInput, loadSpecsView } from "./specs"
import { deleteKeychainSecret, keychainAvailable, storeKeychainSecret } from "./secrets"
import type { Pipeline, RunOptions, RunPlan } from "./types"
import { isValidRunID, resumeWorkspace } from "./workspace"
import { readRunMetadata, type RunMetadata } from "./metadata"
import { preflightRunPlan } from "./preflight"
import type { LaunchBranchCheck, LaunchBranchProposal, LaunchRunPreparation, LaunchRunSelection } from "./launch-tui"
import type { FinishOptions } from "./finish-command"
import type { SpinOptions } from "./spin"
import type { CloseOptions } from "./feature-close-command"
import { formatVersion } from "./version"
import type { UpdateResult } from "./update"
import type { TuiRoute } from "./tui-session"
import type { HomeDestination } from "./home-tui"

/**
 * Flags as written: every scalar stays undefined until the user sets it, so
 * resolveRunOptions can tell "flag given" from "flag at its default" and apply
 * the precedence chain flag > .convoy/config.yaml defaults > built-in default.
 */
export type ParsedArgs = {
  prompt?: string
  promptFile?: string
  help?: boolean
  pipeline?: string
  files: string[]
  onlySteps: string[]
  skipSteps: string[]
  resumeRunID?: string
  keepRunDir?: boolean
  modelOverride?: string
  /** --advisor: force an advising model on every eligible step, whatever config says. */
  advisorOverride?: string
  /** --no-advisor: run every step without an advisor, whatever config says. */
  advisorDisabled?: boolean
  tui?: boolean
  notify?: boolean
  humanReview?: boolean
  maxConcurrent?: number
  baseRef?: string
  /** --worktree / --no-worktree: isolate the run on a fresh branch in its own worktree. */
  worktree?: boolean
  /** --branch: pin the worktree branch name instead of asking the naming model for one. */
  branch?: string
  /**
   * Repo to auto-detect the base ref in when it differs from targetDir. TUI
   * worktree runs point targetDir at the fresh worktree, whose checked-out
   * branch is the new agent branch — the current-branch fallback must look at
   * the original repo instead.
   */
  baseDetectionDir?: string
  targetDir: string
  includeDirty?: boolean
  yolo?: boolean
  smart?: boolean
  smartModel?: string
  gateway?: ModelGateway
  planOnly?: boolean
  noConfirm?: boolean
  /** --change: explicit OpenSpec change id; wins over every selection heuristic. */
  change?: string
}

export type InitOptions = {
  targetDir: string
  global: boolean
  force: boolean
  quiet: boolean
}

export type CliCommand =
  | { type: "help"; text: string }
  | { type: "run"; options: RunOptions }
  | { type: "runs"; runID?: string }
  | { type: "specs"; targetDir: string }
  | { type: "spin"; options: SpinOptions }
  | { type: "opencode-install" }
  | { type: "close"; options: CloseOptions }
  | { type: "config"; targetDir: string }
  | { type: "init"; options: InitOptions }
  | { type: "agents"; action: "eject"; agentName: string; options: InitOptions }
  | { type: "finish"; options: FinishOptions }
  | { type: "auth"; provider: "openrouter"; action: "set" | "remove" | "status" }
  | { type: "version" }
  | { type: "update"; checkOnly: boolean }
  | { type: "coordinate"; launchPath: string }

export async function parseAndRun(argv: string[]) {
  if (shouldLaunchHome(argv, process.stdin.isTTY, process.stdout.isTTY)) {
    await runHomeSession(process.cwd())
    return
  }

  const command = await parseCommand(argv)
  if (command.type === "coordinate") {
    // Internal: the detached coordinator's child boot (`--coordinate` is not
    // advertised in --help). CONVOY_COORDINATE_READY points at the parent's
    // ready file, which ControlProgress writes as soon as the run exists.
    const { runCoordinateBoot } = await import("./coordinate")
    const code = await runCoordinateBoot(command.launchPath, process.env.CONVOY_COORDINATE_READY)
    process.exitCode = code
    return
  }
  if (command.type === "help") {
    process.stdout.write(command.text)
    return
  }
  if (command.type === "version") {
    process.stdout.write(`${formatVersion()}\n`)
    return
  }
  if (command.type === "update") {
    const { runUpdate } = await import("./update")
    writeUpdateResult(await runUpdate({ checkOnly: command.checkOnly }))
    return
  }
  if (command.type === "runs") {
    await openRunsBrowser(command.runID)
    return
  }
  if (command.type === "specs") {
    await openSpecsBrowser(command.targetDir)
    return
  }
  if (command.type === "spin") {
    const { runSpin, printSpinHandoff } = await import("./spin")
    const result = await runSpin(command.options)
    printSpinHandoff(result)
    return
  }
  if (command.type === "opencode-install") {
    const { runOpencodeInstallCommand } = await import("./opencode-install")
    await runOpencodeInstallCommand()
    return
  }
  if (command.type === "close") {
    const { runCloseCommand } = await import("./feature-close-command")
    await runCloseCommand(command.options)
    return
  }
  if (command.type === "config") {
    await openConfigEditor(command.targetDir)
    return
  }
  if (command.type === "auth") {
    await runAuthCommand(command.action)
    return
  }
  if (command.type === "finish") {
    const { runFinishCommand } = await import("./finish-command")
    await runFinishCommand(command.options)
    return
  }
  if (command.type === "init") {
    const result = command.options.global
      ? await writeDefaultGlobalConfig(command.options.force)
      : await writeDefaultProjectConfig(command.options.targetDir, command.options.force)
    if (!command.options.quiet) {
      const scope = command.options.global ? "global config" : "project config"
      process.stdout.write(`${result.created ? "created" : "ensured"} ${scope}: ${result.path}\n`)
    }
    return
  }
  if (command.type === "agents") {
    const configDir = command.options.global ? dirname(globalConfigPath()) : join(command.options.targetDir, ".convoy")
    const result = await ejectAgentPrompt(configDir, command.agentName, command.options.force)
    if (!command.options.quiet) {
      process.stdout.write(
        result.created
          ? `ejected ${command.agentName}: ${result.path}\n\nThis file now overrides the built-in prompt and will keep doing so across upgrades. Delete it to go back to the built-in.\n`
          : `${result.path} already exists; pass --force to overwrite it\n`,
      )
    }
    return
  }

  const plan = command.options.plan ?? (await buildReviewedPlan(command.options))
  if (command.options.planOnly) {
    process.stdout.write(renderRunPlan(plan))
    return
  }
  // A pipeline named "goal-fix" is reserved: goal fragments are internal to the
  // owning pipeline's terminal goal step, so no public pipeline by that name
  // exists and requesting one must never start an unbriefed improvement flow.
  if (plan.pipeline.name === "goal-fix") {
    throw new Error('no public pipeline named "goal-fix" exists; goal fragments are internal to a pipeline\'s terminal goal step — run a pipeline that declares one (e.g. convoy -p ship).')
  }
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (interactive && !command.options.noConfirm) {
    if (!(await confirmRunPlan(plan))) {
      log.info("Run cancelled")
      return
    }
  } else {
    process.stdout.write(renderRunPlan(plan, true))
  }
  await preflightRunPlan(plan)
  // Nothing has touched the repo yet; the worktree is the first effect, and only
  // once the plan has been accepted.
  let options = command.options
  if (options.worktree) {
    const { ensureRepoReady } = await import("./git")
    await ensureRepoReady(options.targetDir, { baseRef: options.baseRef, allowDirty: true })
    options = await prepareWorktreeForRun(options.targetDir, options)
  }
  await executeRun(options, plan)
}

/** Only a truly bare invocation with interactive input and output owns the home screen. */
export function shouldLaunchHome(argv: readonly string[], stdinTTY: boolean | undefined, stdoutTTY: boolean | undefined): boolean {
  return argv.length === 0 && stdinTTY === true && stdoutTTY === true
}

/** One alternate-screen owner routes every destination until Home itself quits. */
async function runHomeSession(targetDir: string): Promise<void> {
  // Probe the Kitty graphics protocol before the session renderer takes
  // stdin; over SSH the client's environment doesn't travel, so the terminal
  // itself has to answer.
  const { probeKittyGraphics } = await import("./kitty-graphics")
  const kittyGraphics = await probeKittyGraphics()
  const [{ launchHomeTui }, { createTuiSession }] = await Promise.all([import("./home-tui"), import("./tui-session")])
  const session = await createTuiSession(kittyGraphics)
  let interrupted = false
  const route: TuiRoute = {
    session,
    onInterrupt: () => {
      interrupted = true
    },
  }

  try {
    await runHomeNavigationLoop({
      interrupted: () => interrupted,
      openHome: (initialSelection) => launchHomeTui(targetDir, { route, initialSelection, kittyGraphics }),
      openDestination: async (selection) => {
        if (selection === "pipelines") await launchInteractiveRun(targetDir, undefined, undefined, route)
        else if (selection === "specs") await openSpecsBrowser(targetDir, route)
        else if (selection === "runs") await openRunsBrowser(undefined, route)
        else await openConfigEditor(targetDir, route)
      },
    })
  } finally {
    session.destroy()
  }
}

/** Pure navigation loop: destination close means back; only Home close quits. */
export async function runHomeNavigationLoop(options: {
  interrupted: () => boolean
  openHome: (initialSelection?: HomeDestination) => Promise<HomeDestination | undefined>
  openDestination: (selection: HomeDestination) => Promise<void>
}): Promise<void> {
  let lastSelection: HomeDestination | undefined
  while (!options.interrupted()) {
    const selection = await options.openHome(lastSelection)
    if (!selection || options.interrupted()) return
    lastSelection = selection
    await options.openDestination(selection)
  }
}

/** Builds the operator-reviewed plan, including a checkout-local PRD history preview. */
async function buildReviewedPlan(input: BuildRunPlanInput): Promise<RunPlan> {
  // Lookup the launch checkout's current branch, not `input.branch` — that is the
  // *new* worktree name when isolate is on, and would miss history sitting here.
  let branch: string | undefined
  try {
    branch = await currentBranch(input.targetDir)
  } catch {
    branch = undefined
  }
  const preview = await loadPrdHistoryPreview({
    targetDir: input.targetDir,
    enabled: input.prdHistory,
    isolateWorktree: Boolean(input.worktree),
    attachesHistory: input.pipeline.steps.some((step) => step.type === "agent" && step.prdHistory),
    branch,
    excludeRunID: input.resumeRunID || undefined,
  })
  // An OpenSpec contract, when the repo has one: discovered against the launch
  // checkout (before any worktree isolate), so the launcher and `--change`
  // resolve the change the same way the runtime attaches it later.
  const openspec = await loadOpenSpecBundle({
    targetDir: input.targetDir,
    explicitId: input.change,
    branch,
    ...(input.baseRef && input.baseRef !== "HEAD" ? { diffFiles: await listChangedFiles(input.baseRef, input.targetDir).catch(() => []) } : {}),
  })
  // An explicitly pinned change is authoritative: resolving to nothing must
  // refuse the run rather than silently fall back to diff inference — the
  // operator asked for that contract, and a typo or an archived id should
  // surface here, before any worktree or agent run.
  if (input.change && (!openspec || openspec.changeIds.length === 0)) {
    throw new Error(`--change "${input.change}" matched no active change under openspec/changes/ (archived or absent; run without --change to auto-resolve)`)
  }
  // Selection rule 5: in an OpenSpec repo, the default implementation pipeline
  // (full-cycle) needs a change contract; review keeps today's diff-inference fallback.
  if (openspec && openspec.changeIds.length === 0 && input.pipeline.name === defaultPipelineName) {
    throw new Error("no change; run /opsx:propose first (or pass --change <id>)")
  }
  return buildRunPlan({ ...input, prdHistoryPreview: preview, ...(openspec ? { openspec } : {}) })
}

/** The result of deciding whether goal mode applies to a resolved run. */
export type GoalModeDecision = { mode: "off" } | { mode: "on"; goal: number; maxIterations: number; plateau: number }

/**
 * Pure decision: does this run enter goal mode, and with what policy? Goal
 * execution is enabled exclusively by the pipeline's own terminal goal step —
 * the resolver validated its structure and fragment roles, so there is nothing
 * left to reject here. Exported so the classification is exercised by tests
 * rather than left untested inside the module-private execution path.
 */
export function goalModeFor(plan: RunPlan): GoalModeDecision {
  const goal = plan.pipeline.goalPlan
  if (!goal) return { mode: "off" }
  return { mode: "on", goal: goal.target, maxIterations: goal.maxIterations, plateau: goal.plateau }
}

/** Runs the plan; the coordinator enters the goal loop when the reviewed pipeline declares a terminal goal step. */
async function executeRun(options: RunOptions, plan: RunPlan, route?: TuiRoute): Promise<void> {
  await spawnAndAttachRun(options, plan, route)
}

/**
 * Every production run becomes a detached coordinator plus, on a TTY, an
 * auto-attached controller dashboard. Tests keep calling `run()` in-process
 * with an injected `progress`.
 */
async function spawnAndAttachRun(options: RunOptions, plan: RunPlan, route?: TuiRoute): Promise<void> {
  const { CoordinatorBootTimeoutError, forwardCoordinatorLogs, launchPayload, rmPendingLaunch, spawnCoordinator, waitForCoordinatorReady, writePendingLaunch } = await import("./coordinate")
  const pending = await writePendingLaunch(launchPayload(options, plan))
  let child: { pid: number; exited: Promise<number> } | undefined
  try {
    child = await spawnCoordinator(pending)
    const ready = await waitForCoordinatorReady(pending.readyPath)
    // The coordinator is live; attach or wait, depending on the terminal.
    if (options.tui && process.stdout.isTTY) {
      const { openRunDashboard } = await import("./attach")
      await openRunDashboard(ready.runID, { ctrlC: "abort" }, route)
      // The attach resolved because the user backgrounded the run; land on the
      // runs menu with it selected (the coordinator keeps running). Liveness
      // is the coordinator's, not iteration 1's OpenCode server: a goal loop
      // releases each iteration's server while the coordinator lives on.
      if (await isCoordinatorLiveFor(ready.runID)) {
        const resumed = await openRunsBrowser(await currentCoordinatedRunID(ready.runID), route)
        // A resume/retry ran its own coordinator inside the browser and owns
        // the exit code; a run still alive after the browser was backgrounded
        // on purpose — a successful handoff is exit 0.
        if (resumed || (await isCoordinatorLiveFor(ready.runID))) return
      }
      // The run is over and the user watched it end: the CLI's exit code is
      // the coordinator's (0 on success, non-zero on failure or abort).
      const code = await child.exited
      process.exitCode = code
      // A failed run's error went to the coordinator's log, not this terminal;
      // a deliberate abort (130) already said goodbye on the dashboard.
      if (code !== 0 && code !== 130) await printCoordinatorFailure(pending.logPath)
      await rmPendingLaunch(pending.dir)
      return
    }
    // --no-tui / CI: don't attach; stream the coordinator's log to the
    // terminal, wait for its exit, and forward the exit code.
    process.stdout.write(`coordinator ${child.pid} running; logs: ${pending.logPath}\n`)
    const forwarder = await forwardCoordinatorLogs(pending.logPath, (chunk) => process.stdout.write(chunk))
    const code = await child.exited
    await forwarder.stop()
    process.exitCode = code
    // The log was forwarded in full — the pending dir holds nothing the
    // parent hasn't already shown.
    await rmPendingLaunch(pending.dir)
  } catch (error) {
    // Boot timeout or spawn failure: surface it, keep the workspace resumable.
    if (child) {
      try {
        process.kill(child.pid, "SIGTERM")
      } catch {
        // Already gone.
      }
    }
    log.warn(`coordinator failed to start; pending launch left at ${pending.launchPath}`)
    if (error instanceof CoordinatorBootTimeoutError) {
      log.error(`  → ${error.message}`)
      log.error(`  → coordinator log: ${pending.logPath}`)
      // The friendly lines above are the error; a zero exit would hide the
      // failure from scripts and CI. The workspace stays resumable with `R`.
      process.exitCode = 1
    } else {
      throw error
    }
  }
}

/** Surfaces the coordinator's last words on a failed TTY run: its stderr went to the pending log, not this terminal. */
async function printCoordinatorFailure(logPath: string): Promise<void> {
  try {
    const body = await readFile(logPath, "utf8")
    const tail = body.trimEnd().split("\n").slice(-30)
    if (tail.length > 0) process.stderr.write(`coordinator failed (last log lines):\n${tail.join("\n")}\n`)
  } catch {
    // Log unreadable; the exit code already says it failed.
  }
}

/** Reads the run's liveness through the run-history module (pid + TCP probe). */
async function isServerLiveFor(runID: string): Promise<boolean> {
  const workspace = await resumeWorkspace(runID).catch(() => undefined)
  if (!workspace) return false
  const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
  return Boolean(metadata && (await isServerLive(metadata.server)))
}

/**
 * Whether the run's *coordinator* is still alive. The control server outlives
 * every per-iteration OpenCode server, so this (not server liveness) is what
 * "the run is still going" means for a backgrounded run — especially mid-goal-
 * loop, where each iteration's server dies while the loop continues.
 */
async function isCoordinatorLiveFor(runID: string): Promise<boolean> {
  const control = await readControlFile(runID)
  if (!control) return isServerLiveFor(runID)
  return isControlLive(control)
}

/**
 * The runID a coordinated run is currently on. A goal cycle runs inside one
 * logical run, so this is the run's own ID; the helper remains for callers
 * that need the current run ID from the control file.
 */
async function currentCoordinatedRunID(fallback: string): Promise<string> {
  const control = await readControlFile(fallback)
  if (!control) return fallback
  try {
    const response = await fetch(`${control.url}/status`, {
      headers: { authorization: `Bearer ${control.token}` },
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return fallback
    const status = (await response.json()) as { runID?: string }
    return status.runID ?? fallback
  } catch {
    return fallback
  }
}

/**
 * Creates the run's isolated worktree and repoints the options at it. Shared by
 * the launcher, where the branch was already confirmed in the branch step, and
 * the headless path, where it is either pinned with --branch or proposed by the
 * naming model.
 */
export async function prepareWorktreeForRun(sourceDir: string, options: RunOptions): Promise<RunOptions> {
  const { createIsolatedWorktree } = await import("./worktree")
  // A pinned name is sanitized the same way the launcher sanitizes a typed one;
  // an unusable one is a flag error, not something to silently rename around.
  const branch = options.branch
    ? (await checkInteractiveBranchName(sourceDir, options.branch)).branch
    : (await proposeInteractiveBranchName(sourceDir, { prompt: options.prompt })).branch
  if (!branch) throw new Error(`--branch "${options.branch}" isn't usable as a git branch name`)
  const worktree = await createIsolatedWorktree({ targetDir: sourceDir, branch })
  log.info(`running in isolated worktree (branch: ${worktree.branch})`)
  log.info(`  dir: ${worktree.dir}`)
  // A fresh worktree starts clean, so there is nothing dirty left to include.
  return { ...options, targetDir: worktree.dir, branch: worktree.branch, includeDirty: false }
}

async function launchInteractiveRun(
  targetDir: string,
  presetChange?: string,
  presetFeature?: { worktreeDir: string; branch: string },
  route?: TuiRoute,
) {
  // Imported lazily so normal CLI invocations don't pull in OpenTUI until they
  // explicitly ask for the zero-argument interactive launcher.
  const { launchRunTui } = await import("./launch-tui")
  const selection = await launchRunTui(
    {
      targetDir,
      // A specs-viewer handoff arrives with the change already chosen: the
      // launcher pins that spec row instead of running its auto-detect heuristics.
      ...(presetChange ? { presetChange } : {}),
      // A control-board "continue" arrives with the feature's worktree and
      // branch already chosen: the launcher reuses them and never asks the namer.
      ...(presetFeature ? { presetFeature: { changeID: presetChange ?? "", ...presetFeature } } : {}),
      prepareRun: (runSelection) => prepareInteractiveRun(targetDir, runSelection),
      proposeBranchName: (input) => proposeInteractiveBranchName(targetDir, input),
      checkBranchName: (name) => checkInteractiveBranchName(targetDir, name),
    },
    route,
  )
  if (!selection) return
  if (selection.action === "runs") {
    await openRunsBrowser(undefined, route)
    return
  }
  if (selection.action === "config") {
    await openConfigEditor(targetDir, route)
    return
  }

  let options = selection.options
  const plan = selection.plan
  const runSelection = selection.selection
  await preflightRunPlan(plan)
  if (runSelection.initializeGit) {
    const { initializeRepoWithInitialCommit } = await import("./git")
    await initializeRepoWithInitialCommit(targetDir, { baseRef: options.baseRef === "HEAD" ? undefined : options.baseRef })
  }
  // Revalidate Git only after the native Review has been accepted. In
  // particular, validate the source before a worktree can create a branch.
  // A feature-row "continue" handoff executes inside the feature's existing
  // worktree — its own checkout with its own dirt. The launcher's cwd (where
  // the board was opened, e.g. main) is irrelevant to that run, so the
  // readiness gate checks the run's home directory, not it. Otherwise a
  // stranded uncommitted change on main (a first-class board state) would
  // block continuing an unrelated feature (SC-5).
  const { ensureRepoReady } = await import("./git")
  const executionDir = presetFeature?.worktreeDir ?? targetDir
  await ensureRepoReady(executionDir, {
    baseRef: options.baseRef,
    includeDirty: options.includeDirty,
    // A fresh worktree starts clean, so source changes are intentionally left
    // untouched and don't need to be included in this run.
    allowDirty: options.worktree,
  })
  if (options.worktree) {
    if (!options.branch) throw new Error("worktree plan is missing its confirmed branch name")
    options = await prepareWorktreeForRun(targetDir, options)
  }
  await executeRun(options, plan, route)
}

async function prepareInteractiveRun(targetDir: string, selection: LaunchRunSelection): Promise<LaunchRunPreparation> {
  const parsed = parseArgs([])
  parsed.targetDir = selection.targetDir
  parsed.baseDetectionDir = targetDir
  parsed.prompt = selection.prompt
  parsed.pipeline = selection.pipeline
  parsed.humanReview = selection.humanReview
  parsed.tui = selection.tui
  parsed.includeDirty = selection.includeDirty
  parsed.keepRunDir = selection.keepRunDir
  parsed.yolo = selection.yolo
  parsed.smart = selection.smart
  parsed.gateway = selection.gateway
  parsed.worktree = Boolean(selection.isolateWorktree)
  if (selection.branchName) parsed.branch = selection.branchName
  if (selection.change) parsed.change = selection.change

  const options = { ...(await resolveRunOptions(parsed)), prompt: selection.prompt }
  // The branch was named and confirmed in the launcher's branch step, so the
  // plan the user reviews already names the branch the run will create.
  const plan = await buildReviewedPlan({
    ...options,
    ...(selection.worktreeDir ? { worktreeDir: selection.worktreeDir } : {}),
  })
  return { options, plan }
}

/** Asks the configured naming model for a branch name for the launcher's branch step. */
async function proposeInteractiveBranchName(targetDir: string, input: { prompt: string; guidance?: string }): Promise<LaunchBranchProposal> {
  const { defaultBranchNameModel, proposeBranchName } = await import("./worktree")
  const config = await loadMergedConvoyConfig(targetDir)
  const model = config?.defaults.branchNameModel ?? defaultBranchNameModel
  const proposal = await proposeBranchName({ ...input, targetDir, model })
  return { ...proposal, model }
}

/** Sanitizes a candidate branch name and reports the free name it would take, plus its worktree path. */
async function checkInteractiveBranchName(targetDir: string, name: string): Promise<LaunchBranchCheck> {
  const { cleanBranchName, ensureFreeBranchName, resolveWorktreeDir } = await import("./worktree")
  // A hand-written name keeps whatever prefix (or none) the user chose; only
  // the model's proposals are held to the conventional `type/` shape.
  const cleaned = cleanBranchName(name, { authored: true })
  if (!cleaned) return { branch: "", dir: "" }
  const free = await ensureFreeBranchName(cleaned, targetDir)
  // The preview must resolve the same way creation does, so what the user
  // confirms is the directory the worktree actually lands in.
  return { branch: free, dir: await resolveWorktreeDir(free, targetDir), ...(free === cleaned ? {} : { suffixed: true }) }
}

/**
 * @returns true when the browser left via a resume/retry (which started its
 *   own coordinator and owns the CLI's exit code), false when the user quit.
 */
async function openRunsBrowser(initialRunID?: string, route?: TuiRoute): Promise<boolean> {
  // The browser can open a run's dashboard and come back, so loop until the
  // user resumes (which hands off to a real run) or quits.
  let currentRunID = initialRunID
  for (;;) {
    const resolution = await browseRuns(currentRunID, route)
    if (resolution.type === "retry") {
      const options = await retryOptions(resolution.runID, resolution.targetDir)
      const plan = options.plan ?? (await buildReviewedPlan({ ...options, promptSource: "retry" }))
      if (!(await confirmRunPlan(plan))) return false
      await preflightRunPlan(plan)
      // A resumed/retried run is also a coordinator: same spawn + auto-attach path.
      await executeRun(options, plan, route)
      return true
    }
    if (resolution.type === "resume") {
      const options = await resumeOptions(resolution.runID, resolution.targetDir)
      const plan = options.plan ?? (await buildReviewedPlan({ ...options, promptSource: "resume" }))
      if (!(await confirmRunPlan(plan))) return false
      await preflightRunPlan(plan)
      await executeRun(options, plan, route)
      return true
    }
    if (resolution.type === "open") {
      // Lazily imported: attaching pulls in the dashboard + opencode client.
      // A menu attach is a controller (ctrlC detaches); observer while a
      // controller is already attached.
      const { openRunDashboard } = await import("./attach")
      await openRunDashboard(resolution.runID, { ctrlC: "detach" }, route)
      currentRunID = resolution.runID
      continue
    }
    return false
  }
}

async function openConfigEditor(targetDir: string, route?: TuiRoute) {
  // Imported lazily so normal runs never pull in the opentui editor.
  const { editConfigTui } = await import("./config-tui")
  await editConfigTui({ targetDir, route })
}

/**
 * Routes the specs browser's resolutions. apply-change hands off to the
 * interactive launcher with the change pinned (launchInteractiveRun's preset),
 * iterate-change opens a standalone OpenCode session rooted at this repo (the
 * operator authors OpenSpec changes there — Convoy never writes them), and
 * exit simply ends. Each half is thin over specs.ts, whose pieces are unit-
 * tested; the interactive halves are covered by component tests.
 */
export async function openSpecsBrowser(targetDir: string, route?: TuiRoute): Promise<void> {
  const resolution = await browseSpecs(targetDir, route)
  if (resolution.type === "apply-change") {
    await launchInteractiveRun(targetDir, resolution.changeID, undefined, route)
    return
  }
  if (resolution.type === "iterate-change") {
    const view = await loadSpecsView(targetDir)
    const input = buildIterateSessionInput(targetDir, view, resolution.changeID)
    const { openIterateOpencodeWindow } = await import("./opencode")
    // The run-dir grant lets the standalone session read its own planning
    // files without prompting; it outlives Convoy and does its own authoring.
    await openIterateOpencodeWindow(input)
    return
  }
  if (resolution.type === "spin-change") {
    // Spin out reuses `convoy spin`'s whole flow verbatim: same refusals,
    // same worktree conventions, same /move handoff.
    const { runSpin, printSpinHandoff } = await import("./spin")
    const result = await runSpin({ targetDir, changeID: resolution.changeID })
    printSpinHandoff(result)
    return
  }
  if (resolution.type === "continue-change") {
    await launchInteractiveRun(targetDir, resolution.changeID, { worktreeDir: resolution.worktreeDir, branch: resolution.branch }, route)
    return
  }
  if (resolution.type === "close-change") {
    // The board's handoff goes through the dual-mode dispatcher: a TTY gets
    // the live checklist (progress, message confirmation, cleanup offers),
    // a pipe gets the headless stdout summary — same event stream either way.
    const { runCloseCommand } = await import("./feature-close-command")
    await runCloseCommand(
      {
        targetDir,
        changeID: resolution.changeID,
        worktreeDir: resolution.worktreeDir,
        branch: resolution.branch,
      },
      route,
    )
    return
  }
  if (resolution.type === "archive-change-main") {
    const { runArchiveOnMain } = await import("./feature-close-command")
    await runArchiveOnMain({ targetDir, changeID: resolution.changeID })
    return
  }
}

// The browser resumes with default flags; metadata recovers both the repo the
// run was launched against and the pipeline it was running.
async function resumeOptions(runID: string, targetDir?: string): Promise<RunOptions> {
  const parsed = parseArgs([])
  parsed.resumeRunID = runID
  if (targetDir) parsed.targetDir = targetDir
  const options: RunOptions = { ...(await resolveRunOptions(parsed)), prompt: "" }
  const workspace = await resumeWorkspace(runID)
  const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
  assertResumableRun(metadata, runID)
  if (metadata?.pipeline) options.pipeline = metadata.pipeline
  options.gateway = metadata?.modelRouting?.gateway ?? "configured"
  try {
    options.prompt = await readFile(resolve(workspace.dir, "prd.md"), "utf8")
  } catch {
    // Legacy/incomplete workspace.
  }
  options.plan = await buildReviewedPlan({ ...options, promptSource: "resume" })
  return options
}

// Retry is a fresh run that reuses the selected run's original prompt and
// pipeline config: a new run dir from step 0, not a resume of the old one.
// Like resume, the prompt and pipeline come back from the run's metadata so the
// user doesn't have to retype or reconfigure anything.
async function retryOptions(runID: string, targetDir?: string): Promise<RunOptions> {
  // The recorded target may have been a worktree that's since been removed; a
  // retry starts a fresh run, so falling back to the current directory keeps it
  // runnable instead of failing on a missing path.
  const resolvedTarget = (targetDir && (await dirExists(targetDir))) ? targetDir : process.cwd()
  const parsed = parseArgs([])
  parsed.targetDir = resolvedTarget
  const options: RunOptions = { ...(await resolveRunOptions(parsed)), prompt: "" }
  const workspace = await resumeWorkspace(runID)
  const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
  assertResumableRun(metadata, runID, { retry: true })
  if (metadata?.pipeline) options.pipeline = metadata.pipeline
  options.gateway = metadata?.modelRouting?.gateway ?? "configured"
  try {
    options.prompt = await readFile(resolve(workspace.dir, "prd.md"), "utf8")
  } catch {
    // Legacy/incomplete workspace.
  }
  options.plan = await buildReviewedPlan({ ...options, promptSource: "retry" })
  return options
}

/**
 * Refuses to resume or retry a legacy schema-v3 `goal-fix` record. Those runs
 * were recorded by the retired child-run host: their frozen pipeline is a plain
 * `goal-fix` pipeline with no terminal goal step, so replaying it would start
 * an unbriefed improvement flow — exactly what the reserved-name guard exists
 * to prevent. The record remains readable historically (the runs browser shows
 * it); only the "continue" surfaces reject it, before any plan is built.
 * Exported so the resume/retry refusal is covered by regression tests.
 */
export function assertResumableRun(metadata: RunMetadata | undefined, runID: string, options: { retry?: boolean } = {}): void {
  if (metadata?.pipeline?.name !== "goal-fix") return
  throw new Error(
    `run ${runID} is a legacy goal-fix run recorded by an earlier Convoy; ${options.retry ? "retrying" : "resuming"} it would start an unbriefed improvement flow. ` +
      "Goal fragments are now internal to a pipeline's terminal goal step — run a pipeline that declares one (e.g. convoy -p ship) instead.",
  )
}

async function dirExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * The management key never touches convoy's argv, env, or disk: `security`
 * itself prompts for the value and the status report only says which sources
 * exist, never what they contain.
 */
async function runAuthCommand(action: "set" | "remove" | "status") {
  if (action === "status") {
    const sources = await openRouterKeySources()
    const lines = [
      "openrouter key sources (in precedence order):",
      `  keychain (convoy auth openrouter)  ${sources.keychain ? "configured — exact /credits balance" : "not set"}`,
      `  env OPENROUTER_API_KEY             ${sources.env ? "set" : "not set"}`,
      `  opencode auth.json                 ${sources.opencode ? "present" : "not found"}`,
    ]
    if (!sources.keychain) lines.push("  without a management key the header meter falls back to /key (key limit or monthly spend)")
    process.stdout.write(`${lines.join("\n")}\n`)
    return
  }
  if (action === "remove") {
    const removed = await deleteKeychainSecret("openrouter")
    process.stdout.write(removed ? "removed the openrouter key from the keychain\n" : "no openrouter key in the keychain\n")
    return
  }
  if (!keychainAvailable()) {
    throw new Error("the keychain is only available on macOS; set OPENROUTER_API_KEY in the environment instead")
  }
  process.stdout.write('storing the OpenRouter management key in the macOS Keychain (service "convoy"):\n')
  const stored = await storeKeychainSecret("openrouter")
  if (!stored) throw new Error("security add-generic-password failed; the key was not stored")
  process.stdout.write("openrouter key stored — the run header will show the exact credit balance\n")
}

export async function parseCommand(argv: string[]): Promise<CliCommand> {
  if (argv[0] === "--coordinate") {
    const launchPath = argv[1]
    if (launchPath === undefined || launchPath.startsWith("-")) {
      throw new Error("--coordinate requires a launch file path (internal use)")
    }
    return { type: "coordinate", launchPath }
  }
  if (argv.length === 1 && (argv[0] === "--version" || argv[0] === "-V")) return { type: "version" }
  if (argv[0] === "update") {
    if (argv.length === 1) return { type: "update", checkOnly: false }
    if (argv.length === 2 && argv[1] === "--check") return { type: "update", checkOnly: true }
    if (argv.length === 2 && (argv[1] === "--help" || argv[1] === "-h")) return { type: "help", text: updateHelp() }
    throw new Error("usage: convoy update [--check]")
  }
  if (argv[0] === "auth") {
    const rest = argv.slice(1)
    if (rest.length === 0 || (rest.length === 1 && rest[0] === "status")) {
      return { type: "auth", provider: "openrouter", action: "status" }
    }
    if (rest[0] === "openrouter") {
      if (rest.length === 1) return { type: "auth", provider: "openrouter", action: "set" }
      if (rest.length === 2 && rest[1] === "--remove") return { type: "auth", provider: "openrouter", action: "remove" }
    }
    throw new Error("usage: convoy auth [status] | convoy auth openrouter [--remove]")
  }
  if (argv[0] === "runs") {
    const rest = argv.slice(1)
    if (rest.length > 1) throw new Error("usage: convoy runs [run-id]")
    if (rest[0] !== undefined && !isValidRunID(rest[0])) throw new Error(`invalid run id: ${rest[0]}`)
    return { type: "runs", runID: rest[0] }
  }
  if (argv[0] === "specs") {
    // No positionals or flags yet — the viewer reads the whole OpenSpec state.
    if (argv.length > 1) throw new Error("usage: convoy specs")
    return { type: "specs", targetDir: process.cwd() }
  }
  if (argv[0] === "control") {
    if (argv.length > 1) throw new Error("usage: convoy control")
    return { type: "specs", targetDir: process.cwd() }
  }
  if (argv[0] === "spin") {
    if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      const { spinHelp } = await import("./spin")
      return { type: "help", text: spinHelp() }
    }
    return { type: "spin", options: parseSpinArgs(argv.slice(1)) }
  }
  if (argv[0] === "close") {
    if (argv.slice(1).some((arg) => arg === "--help" || arg === "-h")) {
      const { closeHelp } = await import("./feature-close-command")
      return { type: "help", text: closeHelp() }
    }
    const { parseCloseArgs } = await import("./feature-close-command")
    return { type: "close", options: parseCloseArgs(argv.slice(1)) }
  }
  if (argv[0] === "config") {
    if (argv.length > 1) throw new Error("usage: convoy config")
    return { type: "config", targetDir: process.cwd() }
  }
  if (argv[0] === "init") {
    const parsed = parseInitArgs(argv.slice(1))
    if (parsed.help) return { type: "help", text: initHelp() }
    return { type: "init", options: parsed }
  }
  if (argv[0] === "agents") {
    const rest = argv.slice(1)
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") return { type: "help", text: agentsHelp() }
    if (rest[0] !== "eject") throw new Error("usage: convoy agents eject <agent> [--global] [--dir <path>] [--force]")
    // The agent name is positional; everything after it reuses init's flag
    // parser so --global/--dir/--force mean exactly what they mean for init.
    const name = rest[1]
    if (name === undefined || name.startsWith("-")) {
      if (name === "--help" || name === "-h") return { type: "help", text: agentsHelp() }
      throw new Error("usage: convoy agents eject <agent> [--global] [--dir <path>] [--force]")
    }
    const parsed = parseInitArgs(rest.slice(2))
    if (parsed.help) return { type: "help", text: agentsHelp() }
    return { type: "agents", action: "eject", agentName: name, options: parsed }
  }
  if (argv[0] === "finish") {
    const { finishHelp, parseFinishArgs } = await import("./finish-command")
    const parsed = parseFinishArgs(argv.slice(1))
    if (parsed.help) return { type: "help", text: finishHelp() }
    return { type: "finish", options: parsed }
  }
  if (argv[0] === "opencode") {
    const rest = argv.slice(1)
    if (rest.length === 0 || rest[0] === "--help" || rest[0] === "-h") {
      const { opencodeInstallHelp } = await import("./opencode-install")
      return { type: "help", text: opencodeInstallHelp() }
    }
    if (rest[0] !== "install" || rest.length > 1) throw new Error("usage: convoy opencode install")
    return { type: "opencode-install" }
  }

  const parsed = parseArgs(argv)
  if (parsed.help) return { type: "help", text: help() }

  const hasInlinePrompt = parsed.prompt !== undefined
  const hasPromptFile = parsed.promptFile !== undefined
  const hasResume = parsed.resumeRunID !== undefined

  if (hasInlinePrompt && hasPromptFile) {
    throw new Error("use either a positional prompt or --prompt-file, not both")
  }
  if (hasResume && (hasInlinePrompt || hasPromptFile)) {
    throw new Error("--resume continues a previous run with its original PRD; it can't take a new prompt")
  }
  if (hasResume && !isValidRunID(parsed.resumeRunID!)) throw new Error(`invalid run id: ${parsed.resumeRunID}`)

  let prompt = parsed.prompt ?? ""
  if (hasPromptFile) {
    prompt = await readFile(resolve(process.cwd(), parsed.promptFile!), "utf8")
  }

  const missingPromptMessage =
    "need a prompt (positional or --prompt-file) or --resume <id>, or the selected pipeline must provide a defaultPrompt"
  // An explicit-but-empty source is still explicit: report it as empty rather
  // than silently replacing it with the selected pipeline's default.
  if (!prompt && !hasResume && (hasInlinePrompt || hasPromptFile)) throw new Error(missingPromptMessage)

  // Resolve once so the selected pipeline and its fallback prompt always come
  // from the same merged-config snapshot.
  const resolvedOptions = await resolveRunOptions(parsed)
  if (!prompt && !hasResume) {
    // A pinned OpenSpec change is the contract: inject a short canned prompt
    // so `convoy --change add-login -p implement` does not require a brief.
    if (parsed.change) {
      prompt = openSpecPromptFor(resolvedOptions.pipeline.name)
    } else if (!hasInlinePrompt && !hasPromptFile && resolvedOptions.pipeline.defaultPrompt) {
      // A concrete-action pipeline (review, ship, hunter, ...) may carry a
      // defaultPrompt so `convoy -p review` runs without typing one. Anything
      // that counts as an explicit prompt source (positional, --prompt-file)
      // was already read above, so only a genuinely empty invocation falls back.
      prompt = resolvedOptions.pipeline.defaultPrompt
    }
    if (!prompt) throw new Error(missingPromptMessage)
  }

  const options: RunOptions = { ...resolvedOptions, prompt }
  // The gateway the run froze at launch, for the review's resume-override banner.
  let resumeGateway: ModelGateway | undefined
  if (hasResume) {
    const workspace = await resumeWorkspace(parsed.resumeRunID!)
    const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
    // The reserved-name guard runs here, before any plan is built: replaying a
    // legacy goal-fix record as a resume would start an unbriefed improvement
    // flow. The record stays readable in history, but never continuable.
    assertResumableRun(metadata, parsed.resumeRunID!)
    if (metadata?.pipeline) options.pipeline = metadata.pipeline
    if (parsed.gateway === undefined) options.gateway = metadata?.modelRouting?.gateway ?? "configured"
    else resumeGateway = metadata?.modelRouting?.gateway ?? "configured"
    try {
      options.prompt = await readFile(resolve(workspace.dir, "prd.md"), "utf8")
    } catch {
      // Legacy/incomplete workspaces retain the empty resume prompt.
    }
  }
  // Resume filters can only be checked after metadata has restored its frozen
  // pipeline. Validate them before building a potentially empty review plan.
  validateStepFilters(options.pipeline, options)
  const promptSource: RunPlan["prompt"]["source"] = hasResume ? "resume" : hasPromptFile ? "file" : hasInlinePrompt ? "inline" : "default"
  options.plan = await buildReviewedPlan({
    ...options,
    promptSource,
    ...(resumeGateway ? { resumeGateway } : {}),
  })
  return { type: "run", options }
}

type ParsedInitArgs = InitOptions & { help?: boolean }

/** `convoy spin [--change <id>] [--prefix <type>]` — no positionals. */
export function parseSpinArgs(argv: string[]): SpinOptions {
  const options: SpinOptions = { targetDir: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--change") {
      const value = argv[++i]
      if (!value || value.startsWith("-")) throw new Error("--change requires a change id")
      options.changeID = value
      continue
    }
    if (arg.startsWith("--change=")) {
      options.changeID = arg.slice("--change=".length)
      continue
    }
    if (arg === "--prefix") {
      const value = argv[++i]
      if (!value || value.startsWith("-")) throw new Error("--prefix requires a conventional type (feat, change, fix, …)")
      options.prefix = value
      continue
    }
    if (arg.startsWith("--prefix=")) {
      options.prefix = arg.slice("--prefix=".length)
      continue
    }
    throw new Error(`usage: convoy spin [--change <id>] [--prefix <type>] (unexpected argument: ${arg})`)
  }
  return options
}

function parseInitArgs(argv: string[]): ParsedInitArgs {
  const parsed: ParsedInitArgs = {
    targetDir: process.cwd(),
    global: false,
    force: false,
    quiet: false,
  }
  let hasDir = false

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (!raw.startsWith("-")) throw new Error("usage: convoy init [--global] [--force] [--dir <path>]")

    const { flag, value } = splitFlag(raw)
    const noValue = () => {
      if (value !== undefined) throw new Error(`${flag} does not take a value`)
    }
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        noValue()
        parsed.help = true
        return parsed
      case "--global":
        noValue()
        parsed.global = true
        break
      case "--force":
        noValue()
        parsed.force = true
        break
      case "--quiet":
        noValue()
        parsed.quiet = true
        break
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        hasDir = true
        break
      default:
        throw new Error(`unknown init flag: ${flag}`)
    }
  }

  if (parsed.global && hasDir) throw new Error("use either --global or --dir, not both")
  return parsed
}

/** Applies the precedence chain and resolves the pipeline the run will execute. */
export async function resolveRunOptions(parsed: ParsedArgs): Promise<Omit<RunOptions, "prompt">> {
  const config = await loadMergedConvoyConfig(parsed.targetDir)
  const defaults = config?.defaults ?? {}

  const humanReview = parsed.humanReview ?? Boolean(process.stdin.isTTY && process.stdout.isTTY)

  const agents = buildAgentRegistry(config)
  const pipelineName = parsed.pipeline ?? defaults.pipeline ?? defaultPipelineName
  let pipeline: Pipeline
  try {
    pipeline = resolvePipeline({
      name: pipelineName,
      spec: selectPipelineSpec(config, pipelineName),
      agents,
      defaultModel: defaults.model,
      defaultAdvisor: defaults.advisor,
      defaultAdvisorMaxCalls: defaults.advisorMaxCalls,
    })
  } catch (error) {
    // A resumed run replays the pipeline frozen in its metadata; a config
    // that has since broken must not block it. New runs surface the error.
    if (!parsed.resumeRunID) throw error
    pipeline = defaultPipeline()
  }
  // --no-human-review / --no-human-step (and non-interactive defaults) drop manual gates from
  // the run entirely, so they never show up as steps.
  if (!humanReview) pipeline = { ...pipeline, steps: pipeline.steps.filter((step) => step.type !== "human") }

  if (parsed.modelOverride) parseModel(splitModelVariant(parsed.modelOverride).model)
  if (parsed.advisorOverride) parseModel(splitModelVariant(parsed.advisorOverride).model)
  if (parsed.smartModel) parseModel(splitModelVariant(parsed.smartModel).model)
  // Smart auto-accept always needs a concrete judge model; resolve the fallback
  // chain here so the runner can stay oblivious to config and built-in defaults.
  const smartJudgeModel =
    parsed.smartModel || defaults.autoAcceptJudgeModel || parsed.modelOverride || defaults.model || `${defaultGptModel}#${defaultGptVariant}`

  // Goal execution is enabled exclusively by the pipeline's own terminal goal
  // step: `pipeline.goalPlan` was resolved and validated by resolvePipeline, and
  // travels with the reviewed plan. There is no goal flag and no separate
  // goal-fix pipeline to resolve.
  const options: Omit<RunOptions, "prompt"> = {
    files: [...(config?.attachments ?? []), ...parsed.files],
    onlySteps: parsed.onlySteps,
    skipSteps: parsed.skipSteps,
    resumeRunID: parsed.resumeRunID ?? "",
    prdHistory: defaults.prdHistory ?? true,
    ...(parsed.change ? { change: parsed.change } : {}),
    keepRunDir: parsed.keepRunDir ?? true,
    modelOverride: parsed.modelOverride ?? "",
    advisorOverride: parsed.advisorOverride ?? "",
    advisorDisabled: parsed.advisorDisabled ?? false,
    advisorAuditPolicy: defaults.advisorAuditPolicy ?? "summary",
    tui: parsed.tui ?? Boolean(process.stdout.isTTY && process.stderr.isTTY),
    notify: parsed.notify,
    notifications: config?.notifications ?? {},
    humanReview,
    maxConcurrentAgents: parsed.maxConcurrent ?? pipeline.maxConcurrentAgents ?? defaults.maxConcurrentAgents ?? defaultMaxConcurrentAgents,
    baseRef: await resolveBaseRef(parsed, defaults),
    targetDir: parsed.targetDir,
    // A resumed run continues in the directory its metadata recorded — which is
    // already the worktree, when the original run made one — so it never creates
    // another.
    worktree: parsed.resumeRunID ? false : await resolveWorktreeOption(parsed, defaults),
    ...(parsed.branch ? { branch: parsed.branch } : {}),
    includeDirty: parsed.includeDirty ?? false,
    yolo: parsed.yolo ?? false,
    smart: parsed.smart ?? false,
    smartJudgeModel,
    gateway: parsed.gateway ?? config?.modelRouting?.gateway ?? "configured",
    gatewayExplicit: parsed.gateway !== undefined,
    modelRoutingOverrides: config?.modelRouting?.overrides ?? {},
    planOnly: parsed.planOnly ?? false,
    noConfirm: parsed.noConfirm ?? false,
    pipeline,
    agents,
    permissions: config?.permissions ?? { allow: [], deny: [] },
    hooks: config?.hooks ?? emptyHooksConfig(),
    ...(config?.loopGuard ? { loopGuard: config.loopGuard } : {}),
  }

  // Fast feedback for typos; a resumed run validates again in the runner
  // against the pipeline frozen in its metadata.
  if (!options.resumeRunID) validateStepFilters(pipeline, options)

  return options
}

// Worktree source: flag > config defaults.worktree > the current branch.
// An unset config means "decide per branch", not "always isolate": on a trunk a
// run should get its own worktree, but on a branch you're already where you
// want the work. The launcher applies the same default itself, so an interactive
// run reaches this with parsed.worktree already set.
async function resolveWorktreeOption(parsed: ParsedArgs, defaults: ConvoyDefaults): Promise<boolean> {
  const explicit = parsed.worktree ?? defaults.worktree
  if (explicit !== undefined) return explicit
  const auto = await resolveWorktreeDefault(parsed.targetDir)
  log.info(`worktree: ${auto.isolate ? "on" : "off"} (${auto.reason})`)
  return auto.isolate
}

// Base source: flag > config defaults.baseRef > auto-detection (never persisted).
// An explicit base that doesn't exist stays a hard error in ensureRepoReady.
async function resolveBaseRef(parsed: ParsedArgs, defaults: ConvoyDefaults): Promise<string> {
  const explicit = parsed.baseRef ?? defaults.baseRef
  if (explicit) return explicit
  const detected = await detectBaseRef(parsed.baseDetectionDir ?? parsed.targetDir)
  if (!detected) return "HEAD" // non-repo / zero commits: ensureRepoReady reports the real problem
  log.info(`base ref: ${detected.ref} (auto-detected)`)
  return detected.ref
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    files: [],
    onlySteps: [],
    skipSteps: [],
    targetDir: process.cwd(),
  }
  const positional: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (raw === "--") {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (!raw.startsWith("-")) {
      positional.push(raw)
      continue
    }

    const { flag, value } = splitFlag(raw)
    const takeValue = () => {
      if (value !== undefined) return value
      const next = argv[++i]
      // A following flag is not a value; catching it here beats silently
      // consuming it (e.g. `--prompt-file --only x`).
      if (next === undefined || (next.startsWith("-") && next !== "-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        parsed.help = true
        return parsed
      case "--prompt-file":
      case "--prd":
        parsed.promptFile = takeValue()
        break
      case "--file":
      case "-f":
        parsed.files.push(takeValue())
        break
      case "--pipeline":
      case "-p":
        parsed.pipeline = takeValue()
        break
      case "--only":
        parsed.onlySteps.push(...listValue(takeValue()))
        break
      case "--skip":
        parsed.skipSteps.push(...listValue(takeValue()))
        break
      case "--resume":
        parsed.resumeRunID = takeValue()
        break
      case "--keep-run-dir":
        parsed.keepRunDir = true
        break
      case "--no-keep-run-dir":
        parsed.keepRunDir = false
        break
      case "--include-dirty":
        parsed.includeDirty = true
        break
      case "--yolo":
        parsed.yolo = true
        break
      case "--smart":
        parsed.smart = true
        break
      case "--smart-model":
        parsed.smartModel = takeValue()
        break
      case "--model":
        parsed.modelOverride = takeValue()
        break
      case "--advisor":
        parsed.advisorOverride = takeValue()
        parsed.advisorDisabled = false
        break
      case "--no-advisor":
        if (value !== undefined) throw new Error("--no-advisor does not take a value")
        parsed.advisorDisabled = true
        parsed.advisorOverride = undefined
        break
      case "--gateway": {
        const gateway = takeValue()
        if (!isModelGateway(gateway)) throw new Error(`--gateway must be ${modelGatewayChoices()}`)
        parsed.gateway = gateway
        break
      }
      case "--plan":
        if (value !== undefined) throw new Error("--plan does not take a value")
        parsed.planOnly = true
        break
      case "--no-confirm":
        if (value !== undefined) throw new Error("--no-confirm does not take a value")
        parsed.noConfirm = true
        break
      case "--tui":
        parsed.tui = true
        break
      case "--no-tui":
        parsed.tui = false
        break
      case "--notify":
        if (value !== undefined) throw new Error("--notify does not take a value")
        parsed.notify = true
        break
      case "--no-notify":
        if (value !== undefined) throw new Error("--no-notify does not take a value")
        parsed.notify = false
        break
      case "--human-review":
      case "--human-step":
        parsed.humanReview = true
        break
      case "--no-human-review":
      case "--no-human-step":
        parsed.humanReview = false
        break
      case "--max-concurrent":
        parsed.maxConcurrent = parseInt(takeValue(), 10)
        if (!Number.isInteger(parsed.maxConcurrent) || parsed.maxConcurrent < 1) {
          throw new Error("--max-concurrent must be a positive integer")
        }
        break
      case "--worktree":
        if (value !== undefined) throw new Error("--worktree does not take a value")
        parsed.worktree = true
        break
      case "--no-worktree":
        if (value !== undefined) throw new Error("--no-worktree does not take a value")
        parsed.worktree = false
        break
      case "--branch":
        parsed.branch = takeValue()
        break
      case "--change":
        parsed.change = takeValue()
        break
      case "--base":
        parsed.baseRef = takeValue()
        break
      case "--goal":
      case "--goal-max-iterations":
      case "--goal-plateau": {
        // Retired with the embedded goal step: no run flag may create or alter
        // goal behavior, and the refusal happens here — before plan review,
        // worktree creation, or any other side effect.
        const value = takeValue()
        throw new Error(
          `retired flag: ${flag}\n\nGoal targets and stopping policy live exclusively in a pipeline's terminal \`goal\` step; CLI flags no longer create or alter goal behavior.\n\nMove the policy into the pipeline (the last step):\n\n  - goal:\n      target: 85          # 1–100\n      maxIterations: 3    # default 3\n      plateau: 3          # default 3\n      improve:            # writable directed-fix steps; briefStep receives the score brief\n        briefStep: fix\n        steps:\n          - agent: goal-fixer\n            name: fix\n      measure:            # read-only scoring steps ending in one quality-score deliverable\n        steps:\n          - ...\n\nSee \`convoy config\` or the README's pipeline section for the full embedded syntax.`,
        )
      }
      case "--dir":
        parsed.targetDir = resolve(process.cwd(), takeValue())
        break
      default:
        throw new Error(`unknown flag: ${flag}`)
    }
  }

  if (positional.length > 0) parsed.prompt = positional.join(" ")
  return parsed
}

function parsePositiveInt(value: string, flag: string, max?: number): number {
  // Strict integer parsing: a goal of "90abc", "1.5", or "90 " must be
  // rejected instead of silently coerced by parseInt. When `max` is given,
  // both bounds share one message so the 0 and >max edges agree on the range.
  const outOfRange = max !== undefined ? `${flag} must be an integer from 1 to ${max}` : `${flag} must be a positive integer`
  if (!/^[0-9]+$/.test(value)) throw new Error(outOfRange)
  const parsed = parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed < 1 || (max !== undefined && parsed > max)) throw new Error(outOfRange)
  return parsed
}

function splitFlag(raw: string) {
  const index = raw.indexOf("=")
  if (index === -1) return { flag: raw, value: undefined }
  return { flag: raw.slice(0, index), value: raw.slice(index + 1) }
}

function listValue(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
}

function help() {
  return `convoy [prompt]

Sequential OpenCode agent pipeline for implementing features.

Usage:
  convoy
  convoy "Add onboarding"
  convoy --prompt-file prd.md --file lib/onboarding --file test/onboarding_test.dart
  convoy --pipeline bug-fix --prompt-file bug.md
  convoy init
  convoy agents eject <agent>
  convoy finish
  convoy update [--check]
  convoy runs [run-id]
  convoy specs
  convoy spin
  convoy close
  convoy opencode install
  convoy config
  convoy auth openrouter

Commands:
  convoy                   Open the home TUI: Pipelines, Specs, Runs, or Config
                           (Pipelines continues to the interactive run launcher)
  init                     Create .convoy/config.yaml in the target repo
  init --global            Create ~/.convoy/config.yaml
  agents eject <agent>     Copy one built-in agent prompt to agents/<agent>.md to
                           override it ("convoy agents" lists the available ones)
  finish                   Squash this branch's convoy commits into one conventional commit
                           created with your own git identity, so it lands signed and attributed
                           ("convoy finish --help" for options; [f] on the run dashboard does the same)
  update [--check]         Check GitHub Releases for a newer official binary, or install it
                           (source checkouts are never modified)
  runs [run-id]            Browse run history: resume a run, read its summary/reports,
                           or open a subshell in its run dir (under ~/.convoy/runs)
  specs                     The feature board: every active change and canonical spec
                             with live derived state (stage, tasks, runs, sync, merged-ness)
                             and row actions — spin out, continue, close, archive on main
                             ("convoy control" remains as a compatibility alias)
  spin                      Spin an uncommitted OpenSpec change out of the base checkout into
                            an isolated worktree on a conventionally named branch (feat/…, fix/…,
                            change/…) and print the /move handoff for the current OpenCode session
  close                     Close a feature in one sequence: preflight, sync the base branch,
                             archive via the OpenSpec CLI, squash convoy's commits, and merge
                             into the base branch ("convoy close --help" for options)
  opencode install          Install the global /convoy-spin OpenCode command — a thin wrapper at
                             ~/.config/opencode/commands/convoy-spin.md that runs convoy spin
                             from a session (opt-in, idempotent; touches no other command file)
  config                   View and edit the global (~/.convoy) and current project config in a TUI
  auth openrouter          Store an OpenRouter management key in the macOS Keychain for the
                           header credits meter (--remove deletes it; "auth status" lists sources)

Flags:
  --version, -V            Print Convoy's version, commit, and build platform
  --prompt-file <path>     Read the PRD/prompt from a file
  --file, -f <path>        Attach a file or directory to all steps (repeatable)
   --pipeline, -p <name>    Pipeline to run (default: "full-cycle"), which writes,
                            audits, then measures and iterates on a terminal goal
                            step until the score clears 90
  --only <steps>           Run only these pipeline steps
  --skip <steps>           Skip these pipeline steps
  --resume <id>            Resume a previous run by its ID (steps with an existing report are
                           skipped; the run replays the pipeline it started with)
  --keep-run-dir           Keep the run dir when done (default)
  --no-keep-run-dir        Delete the run dir on successful completion
  --yolo                   Auto-allow ask-level permissions (hard denylist still applies; shift+tab cycles it live in the TUI)
  --smart                  Smart auto-accept: an AI judge auto-allows safe ask-level requests and escalates risky ones (shift+tab cycles)
  --smart-model <provider/model[#variant]> Model for the smart auto-accept judge (default: defaults.autoAcceptJudgeModel, else the run's model)
  --include-dirty          Include existing changes in the first commit
  --model <provider/model[#variant]> Force a model for OpenCode steps (Claude Code steps keep their CLI model)
  --advisor <provider/model[#variant]> Force an advising model on every OpenCode step: a stronger model
                           consulted at decision points (before the first write, before declaring done,
                           and on demand) that reads the step's transcript but never runs tools
  --no-advisor             Run every step without an advisor, whatever the config sets
  --gateway <${modelGateways.join("|")}> Route all OpenCode models through the selected gateway
  --plan                   Print the complete resolved plan without creating or running anything
  --no-confirm             Show a compact plan and start without the interactive confirmation
  --tui                    Show visual phase progress (default in interactive terminals)
  --no-tui                 Disable visual phase progress
  --notify                 Enable desktop notifications for this run, overriding notifications.enabled in config
  --no-notify              Disable desktop notifications for this run (the terminal title still updates)
  --human-step             Enable human steps (alias: --human-review; default in interactive terminals)
  --no-human-step          Drop all human steps (alias: --no-human-review)
  --max-concurrent <n>     Max agents running at once within a parallel group (default: ${defaultMaxConcurrentAgents}); smaller groups are unaffected
  --base <ref>             Branch/base for calculating diffs (default: auto-detected — origin's default branch, else main/master/develop/trunk, else the current branch)
  --worktree               Run on a fresh branch in its own worktree
                           (location: repo convention, then defaults.worktreeLocation, then ~/.convoy/worktrees)
  --no-worktree            Run in the current working tree instead
                           (default: worktree on a trunk branch, current tree on any other)
  --branch <name>          Name for the worktree branch, instead of asking the naming model
  --change <id>            OpenSpec change id to review/implement (openspec/changes/<id>).
                           Resolves the spec bundle (current specs + that change) as the contract
                           attached to every step, and overrides every selection heuristic.
                           The launcher lists active changes so you can pick one instead of
                           typing a prompt. A run without --change on a single-change branch
                           auto-resolves the active change.
  --dir <path>             Target repo (default: cwd)

Goal mode:
  Pipelines enter goal execution exclusively by declaring one terminal goal
  step (the pipeline's last step). There are no goal CLI flags; retired flags
  print a migration error. See the Quality scoring section.

Config files:
  ~/.convoy/config.yaml    user defaults, created by make install or convoy init --global
  .convoy/config.yaml      project-local overrides, created by convoy init
  agents/*.md              Markdown prompts loaded by matching the agent name; only
                           present once you eject one, and they shadow the built-in

Config keys:
  defaults:                model, baseRef, pipeline, worktree, worktreeLocation, prdHistory,
                           autoAcceptJudgeModel, branchNameModel, commitMessageModel
  modelRouting:            gateway and explicit per-logical-model overrides
  agents:                  project agents or built-in overrides; prompts live at agents/<name>.md
  pipelines:               named step lists mixing agents and human gates
  permissions:             allow/deny additions to the bash policy (deny always wins)
  hooks:                   pre/post shell commands, globally or per pipeline
  attachments:             files attached to every step
  The same schema lives globally at ~/.convoy/config.yaml; project config merges on top.
  Precedence: CLI flags > project config > global config > built-in defaults.
`
}

function updateHelp() {
  return `convoy update [--check]

Check the latest stable GitHub Release for a binary matching this platform.
Without --check, download, verify, and atomically install the newer binary.
Only official standalone release binaries can update themselves; source
checkouts are never modified.

Options:
  --check                  Report whether an update is available without changing files
`
}

function writeUpdateResult(result: UpdateResult) {
  switch (result.status) {
    case "source-install":
      process.stdout.write(`${result.message}\n`)
      return
    case "up-to-date":
      process.stdout.write(`convoy ${result.currentVersion} is up to date (latest: v${result.latestVersion})\n`)
      return
    case "update-available":
      process.stdout.write(`update available: ${result.currentVersion} → v${result.latestVersion} (${result.assets.binary.name})\n`)
      return
    case "updated":
      process.stdout.write(`updated convoy ${result.currentVersion} → v${result.latestVersion} (${result.assetName})\n`)
  }
}

function initHelp() {
  return `convoy init [--global] [--force] [--dir <path>]

Create Convoy's default config file. An existing config is not overwritten unless --force is set.

Writes no agent prompts: a prompt file under agents/ permanently overrides its
built-in, so copying them all would freeze every prompt at the installed version.
Use "convoy agents eject <agent>" to copy the one you actually want to change.

Options:
  --global                 Write ~/.convoy/config.yaml instead of a project config
  --dir <path>             Target repo for .convoy/config.yaml (default: cwd)
  --force                  Overwrite an existing config file
  --quiet                  Suppress status output
`
}

function agentsHelp() {
  return `convoy agents eject <agent> [--global] [--force] [--dir <path>]

Copy one built-in agent prompt to agents/<agent>.md so you can edit it.

The copy takes precedence over the built-in from then on, including across
upgrades -- "convoy update" ships new built-in prompts that an ejected file will
shadow. Eject only what you mean to own, and delete the file to return to the
built-in. Delete the file to return to the built-in.

Options:
  --global                 Write ~/.convoy/agents/<agent>.md instead of a project prompt
  --dir <path>             Target repo for .convoy/agents/<agent>.md (default: cwd)
  --force                  Overwrite an existing prompt file
  --quiet                  Suppress status output

Agents:
${builtInAgents
  .map((agent) => agent.name)
  .sort()
  .map((name) => `  ${name}`)
  .join("\n")}
`
}
