import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { buildAgentRegistry, ejectAgentPrompt, emptyHooksConfig, globalConfigPath, loadMergedConvoyConfig, selectPipelineSpec, writeDefaultGlobalConfig, writeDefaultProjectConfig, type ConvoyDefaults } from "./config"
import { detectBaseRef, resolveWorktreeDefault } from "./git"
import { openRouterKeySources } from "./limits"
import { log } from "./log"
import { builtInAgents, defaultGptModel, defaultGptVariant, defaultPipeline, defaultPipelineName, resolvePipeline, splitModelVariant, validateStepFilters } from "./pipeline"
import { defaultMaxConcurrentAgents, parseModel, run } from "./runner"
import { buildRunPlan } from "./run-plan"
import { confirmRunPlan, renderRunPlan } from "./run-review"
import { isModelGateway, type ModelGateway } from "./model-routing"
import { browseRuns } from "./runs"
import { deleteKeychainSecret, keychainAvailable, storeKeychainSecret } from "./secrets"
import type { Pipeline, RunOptions } from "./types"
import { isValidRunID, resumeWorkspace } from "./workspace"
import { readRunMetadata } from "./metadata"
import { preflightRunPlan } from "./preflight"
import type { LaunchBranchCheck, LaunchBranchProposal, LaunchRunPreparation, LaunchRunSelection } from "./launch-tui"
import type { FinishOptions } from "./finish-command"
import { formatVersion } from "./version"
import type { UpdateResult } from "./update"

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
  maxAttempts?: number
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
  | { type: "config"; targetDir: string }
  | { type: "init"; options: InitOptions }
  | { type: "agents"; action: "eject"; agentName: string; options: InitOptions }
  | { type: "finish"; options: FinishOptions }
  | { type: "auth"; provider: "openrouter"; action: "set" | "remove" | "status" }
  | { type: "version" }
  | { type: "update"; checkOnly: boolean }

export async function parseAndRun(argv: string[]) {
  if (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY) {
    await launchInteractiveRun(process.cwd())
    return
  }

  const command = await parseCommand(argv)
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

  const plan = command.options.plan ?? buildRunPlan(command.options)
  if (command.options.planOnly) {
    process.stdout.write(renderRunPlan(plan))
    return
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
  await run({ ...options, plan })
}

/**
 * Creates the run's isolated worktree and repoints the options at it. Shared by
 * the launcher, where the branch was already confirmed in the branch step, and
 * the headless path, where it is either pinned with --branch or proposed by the
 * naming model.
 */
async function prepareWorktreeForRun(sourceDir: string, options: RunOptions): Promise<RunOptions> {
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

async function launchInteractiveRun(targetDir: string) {
  // Imported lazily so normal CLI invocations don't pull in OpenTUI until they
  // explicitly ask for the zero-argument interactive launcher.
  const { launchRunTui } = await import("./launch-tui")
  const selection = await launchRunTui({
    targetDir,
    prepareRun: (runSelection) => prepareInteractiveRun(targetDir, runSelection),
    proposeBranchName: (input) => proposeInteractiveBranchName(targetDir, input),
    checkBranchName: (name) => checkInteractiveBranchName(targetDir, name),
  })
  if (!selection) return
  if (selection.action === "runs") {
    await openRunsBrowser()
    return
  }
  if (selection.action === "config") {
    await openConfigEditor(targetDir)
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
  const { ensureRepoReady } = await import("./git")
  await ensureRepoReady(targetDir, {
    baseRef: options.baseRef,
    includeDirty: options.includeDirty,
    maxAttempts: options.maxAttempts,
    // A fresh worktree starts clean, so source changes are intentionally left
    // untouched and don't need to be included in this run.
    allowDirty: options.worktree,
  })
  if (options.worktree) {
    if (!options.branch) throw new Error("worktree plan is missing its confirmed branch name")
    options = await prepareWorktreeForRun(targetDir, options)
  }
  await run({ ...options, plan, noConfirm: true })
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
  if (selection.includeDirty) parsed.maxAttempts = 1

  const options = { ...(await resolveRunOptions(parsed)), prompt: selection.prompt }
  // The branch was named and confirmed in the launcher's branch step, so the
  // plan the user reviews already names the branch the run will create.
  const plan = buildRunPlan({
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
  const { cleanBranchName, ensureFreeBranchName, worktreeDirFor } = await import("./worktree")
  // A hand-written name keeps whatever prefix (or none) the user chose; only
  // the model's proposals are held to the conventional `type/` shape.
  const cleaned = cleanBranchName(name, { authored: true })
  if (!cleaned) return { branch: "", dir: "" }
  const free = await ensureFreeBranchName(cleaned, targetDir)
  return { branch: free, dir: worktreeDirFor(free), ...(free === cleaned ? {} : { suffixed: true }) }
}

async function openRunsBrowser(initialRunID?: string) {
  // The browser can open a run's dashboard and come back, so loop until the
  // user resumes (which hands off to a real run) or quits.
  let currentRunID = initialRunID
  for (;;) {
    const resolution = await browseRuns(currentRunID)
    if (resolution.type === "resume") {
      const options = await resumeOptions(resolution.runID, resolution.targetDir)
      const plan = options.plan ?? buildRunPlan({ ...options, promptSource: "resume" })
      if (!(await confirmRunPlan(plan))) return
      await preflightRunPlan(plan)
      await run({ ...options, plan })
      return
    }
    if (resolution.type === "open") {
      // Lazily imported: attaching pulls in the dashboard + opencode client.
      const { openRunDashboard } = await import("./attach")
      await openRunDashboard(resolution.runID)
      currentRunID = resolution.runID
      continue
    }
    return
  }
}

async function openConfigEditor(targetDir: string) {
  // Imported lazily so normal runs never pull in the opentui editor.
  const { editConfigTui } = await import("./config-tui")
  await editConfigTui({ targetDir })
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
  if (metadata?.pipeline) options.pipeline = metadata.pipeline
  options.gateway = metadata?.modelRouting?.gateway ?? "configured"
  try {
    options.prompt = await readFile(resolve(workspace.dir, "prd.md"), "utf8")
  } catch {
    // Legacy/incomplete workspace.
  }
  options.plan = buildRunPlan({ ...options, promptSource: "resume" })
  return options
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

  const parsed = parseArgs(argv)
  if (parsed.help) return { type: "help", text: help() }

  if (parsed.prompt && parsed.promptFile) {
    throw new Error("use either a positional prompt or --prompt-file, not both")
  }
  if (parsed.resumeRunID && (parsed.prompt || parsed.promptFile)) {
    throw new Error("--resume continues a previous run with its original PRD; it can't take a new prompt")
  }

  let prompt = parsed.prompt ?? ""
  if (parsed.promptFile) {
    prompt = await readFile(resolve(process.cwd(), parsed.promptFile), "utf8")
  }

  if (!prompt && !parsed.resumeRunID) {
    throw new Error("need a prompt (positional or --prompt-file) or --resume <id>")
  }

  const options: RunOptions = { ...(await resolveRunOptions(parsed)), prompt }
  // The gateway the run froze at launch, for the review's resume-override banner.
  let resumeGateway: ModelGateway | undefined
  if (parsed.resumeRunID) {
    const workspace = await resumeWorkspace(parsed.resumeRunID)
    const metadata = await readRunMetadata(resolve(workspace.dir, "metadata.json"))
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
  options.plan = buildRunPlan({
    ...options,
    promptSource: parsed.resumeRunID ? "resume" : parsed.promptFile ? "file" : "inline",
    ...(resumeGateway ? { resumeGateway } : {}),
  })
  return { type: "run", options }
}

type ParsedInitArgs = InitOptions & { help?: boolean }

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

  const options: Omit<RunOptions, "prompt"> = {
    files: [...(config?.attachments ?? []), ...parsed.files],
    onlySteps: parsed.onlySteps,
    skipSteps: parsed.skipSteps,
    resumeRunID: parsed.resumeRunID ?? "",
    keepRunDir: parsed.keepRunDir ?? true,
    modelOverride: parsed.modelOverride ?? "",
    advisorOverride: parsed.advisorOverride ?? "",
    advisorDisabled: parsed.advisorDisabled ?? false,
    advisorAuditPolicy: defaults.advisorAuditPolicy ?? "summary",
    tui: parsed.tui ?? Boolean(process.stdout.isTTY && process.stderr.isTTY),
    notify: parsed.notify,
    notifications: config?.notifications ?? {},
    humanReview,
    maxAttempts: parsed.maxAttempts ?? defaults.maxAttempts ?? 2,
    maxConcurrentAgents: parsed.maxConcurrent ?? defaults.maxConcurrentAgents ?? defaultMaxConcurrentAgents,
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
        if (!isModelGateway(gateway)) throw new Error('--gateway must be "configured", "direct", "openrouter", or "vercel"')
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
      case "--max-attempts":
        parsed.maxAttempts = parseInt(takeValue(), 10)
        if (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1) {
          throw new Error("--max-attempts must be a positive integer")
        }
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
      case "--base":
        parsed.baseRef = takeValue()
        break
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
  convoy config
  convoy auth openrouter

Commands:
  convoy                   Open an interactive TUI launcher to pick a pipeline,
                           enter a prompt, and toggle run options
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
  config                   View and edit the global (~/.convoy) and current project config in a TUI
  auth openrouter          Store an OpenRouter management key in the macOS Keychain for the
                           header credits meter (--remove deletes it; "auth status" lists sources)

Flags:
  --version, -V            Print Convoy's version, commit, and build platform
  --prompt-file <path>     Read the PRD/prompt from a file
  --file, -f <path>        Attach a file or directory to all steps (repeatable)
  --pipeline, -p <name>    Pipeline to run (default: "implement"), which runs
                           implementer,patterns,security,design,tests,adversarial
  --only <steps>           Run only these pipeline steps
  --skip <steps>           Skip these pipeline steps
  --resume <id>            Resume a previous run by its ID (steps with an existing report are
                           skipped; the run replays the pipeline it started with)
  --keep-run-dir           Keep the run dir when done (default)
  --no-keep-run-dir        Delete the run dir on successful completion
  --yolo                   Auto-allow ask-level permissions (hard denylist still applies; shift+tab cycles it live in the TUI)
  --smart                  Smart auto-accept: an AI judge auto-allows safe ask-level requests and escalates risky ones (shift+tab cycles)
  --smart-model <provider/model[#variant]> Model for the smart auto-accept judge (default: defaults.autoAcceptJudgeModel, else the run's model)
  --include-dirty          Include existing changes in the first commit (requires --max-attempts 1)
  --model <provider/model[#variant]> Force a model for OpenCode steps (Claude Code steps keep their CLI model)
  --advisor <provider/model[#variant]> Force an advising model on every OpenCode step: a stronger model
                           consulted at decision points (before the first write, before declaring done,
                           and on demand) that reads the step's transcript but never runs tools
  --no-advisor             Run every step without an advisor, whatever the config sets
  --gateway <configured|direct|openrouter|vercel> Route all OpenCode models through the selected gateway
  --plan                   Print the complete resolved plan without creating or running anything
  --no-confirm             Show a compact plan and start without the interactive confirmation
  --tui                    Show visual phase progress (default in interactive terminals)
  --no-tui                 Disable visual phase progress
  --notify                 Enable desktop notifications for this run, overriding notifications.enabled in config
  --no-notify              Disable desktop notifications for this run (the terminal title still updates)
  --human-step             Enable human steps (alias: --human-review; default in interactive terminals)
  --no-human-step          Drop all human steps (alias: --no-human-review)
  --max-attempts <n>       Attempts per step before failing (default: 2)
  --max-concurrent <n>     Max agents running at once within a parallel group (default: ${defaultMaxConcurrentAgents}); smaller groups are unaffected
  --base <ref>             Branch/base for calculating diffs (default: auto-detected — origin's default branch, else main/master/develop/trunk, else the current branch)
  --worktree               Run on a fresh branch in its own worktree under ~/.convoy/worktrees
  --no-worktree            Run in the current working tree instead
                           (default: worktree on a trunk branch, current tree on any other)
  --branch <name>          Name for the worktree branch, instead of asking the naming model
  --dir <path>             Target repo (default: cwd)

Config files:
  ~/.convoy/config.yaml    user defaults, created by make install or convoy init --global
  .convoy/config.yaml      project-local overrides, created by convoy init
  agents/*.md              Markdown prompts loaded by matching the agent name; only
                           present once you eject one, and they shadow the built-in

Config keys:
  defaults:                model, maxAttempts, baseRef, pipeline, worktree, autoAcceptJudgeModel,
                           branchNameModel, commitMessageModel
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
