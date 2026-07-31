import { link, mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import type { AssistantMessage, FilePartInput, OpencodeClient, Part } from "@opencode-ai/sdk/v2"

import { advisorNeedsOf, completionQuestion, type AdvisorUsage, type ModelSelection } from "./advisor"
import { advisorTokenEnv, advisorUrlEnv, installAdvisorTool, startAdvisorBridge, type AdvisorBridge } from "./advisor-bridge"
import { readAdvisorSplit, renderAdvisorSplit } from "./advisor-report"
import { createAdvisorRuntime, totalAdvisorUsage, type AdvisorPhaseHandle, type AdvisorRuntime } from "./advisor-runtime"
import { aggregateAdvisorEvents, createAdvisorEventJournal, readAdvisorEvents, type AdvisorEvent, type AdvisorEventJournal } from "./advisor-events"
import { opencodeConfig } from "./agents"
import { fileParts } from "./attachments"
import { Caffeinate } from "./caffeinate"
import { ensureClaudeAvailable, promptClaudePhase } from "./claude-code"
import { addAllAndCommit, createCleanRepoSnapshot, describeRepoSnapshotDifference, diffTotals, dirtyFilesPreview, dirtyTreeError, ensureRepoReady, resolveCommit, restoreRepoSnapshot, type DiffTotals, type RepoSnapshot, statusPorcelain, writeDiff } from "./git"
import { hookPhaseNames, hooksForPipeline, runHooks, type HookStage } from "./hooks"
import { getSessionEventHub, payloadProperties } from "./event-hub"
import { runHumanReviewGate } from "./human"
import { log } from "./log"
import { openRunMetadata, recordProgress, type RunMetadataStore } from "./metadata"
import { openOpencodeSessionWindow, startOpencode } from "./opencode"
import { startPermissionGate, type PermissionGate } from "./permissions"
import { splitModelVariant, synthesizeReadOnlyAgents, validateStepFilters } from "./pipeline"
import {
  createProgressUI,
  noopProgress,
  type ActivityKind,
  type AutoAccept,
  type ProgressDiffSummary,
  type ProgressMessage,
  type ProgressPhase,
  type ProgressStepUsage,
  type ProgressTodo,
  type ProgressTokens,
  type ProgressUI,
  type ProgressUsage,
  type RunControlState,
  type RunOutcome,
} from "./progress"
import { discoverProjectContextFiles } from "./project-context"
import { createStepRunnerImpl, stepRunnerFor, stepRunnerModel, type StepRunnerId, type StepRunnerImpl } from "./step-runners"
import type { AgentSpec, AgentStep, HookSet, HookSpec, Pipeline, RunOptions, Step } from "./types"
import { addTokens, emptyTokens, tokensFromValue } from "./usage"
import { cleanupWorkspace, createWorkspace, opencodeConfigDir, renderScoreboard, resumeWorkspace, type Workspace, writeSummary } from "./workspace"

export type ActiveSession = {
  client: OpencodeClient
  sessionID: string
  directory: string
  phaseName: string
}

export class UserAbortError extends Error {
  constructor(message = "aborted by user") {
    super(message)
    this.name = "UserAbortError"
  }
}

export function isUserAbortError(error: unknown): error is UserAbortError {
  return error instanceof UserAbortError || (error instanceof Error && error.name === "UserAbortError")
}

/**
 * Whether an unhandled rejection is the known-benign abort that the opencode SDK
 * leaks when its SSE reader is cancelled (the reader rejects without being
 * awaited). Only these are safe to swallow at the process level; anything else is
 * a real fault and must stay visible. See main.ts's unhandledRejection handler.
 */
export function isIgnorableRejection(reason: unknown): boolean {
  if (isUserAbortError(reason)) return true
  if (reason instanceof Error) {
    if (reason.name === "AbortError") return true
    return /\baborted?\b/i.test(reason.message)
  }
  return false
}

export function shouldRetryAttempt(error: unknown, signal: AbortSignal, attempt: number, maxAttempts: number) {
  return !signal.aborted && !isUserAbortError(error) && attempt < maxAttempts
}

export class RunShutdown {
  private readonly controller = new AbortController()
  private readonly activeSessions = new Map<string, ActiveSession>()
  private abortingSessions: Promise<void> | undefined
  private requests = 0
  private forceTimer: ReturnType<typeof setTimeout> | undefined

  get signal() {
    return this.controller.signal
  }

  get aborted() {
    return this.controller.signal.aborted
  }

  request(source: string) {
    this.requests++
    if (this.requests > 1) {
      log.warn(`${source} received again; forcing exit`)
      process.exit(130)
    }

    log.warn(`${source} received; aborting active OpenCode session(s) and shutting down`)
    this.controller.abort(new UserAbortError(`${source} received`))
    this.forceTimer = setTimeout(() => {
      log.warn("Shutdown cleanup timed out; forcing exit")
      process.exit(130)
    }, 15_000)
    this.forceTimer.unref?.()
  }

  throwIfRequested() {
    if (this.aborted) throw this.abortError()
  }

  abortError(fallback?: unknown) {
    if (isUserAbortError(this.signal.reason)) return this.signal.reason
    if (isUserAbortError(fallback)) return fallback
    return new UserAbortError()
  }

  setActiveSession(session: ActiveSession) {
    this.activeSessions.set(session.phaseName, session)
  }

  clearActiveSession(phaseName: string, sessionID: string) {
    if (this.activeSessions.get(phaseName)?.sessionID === sessionID) this.activeSessions.delete(phaseName)
  }

  async abortActiveSessions(progress?: ProgressUI) {
    if (this.abortingSessions) return this.abortingSessions
    const sessions = [...this.activeSessions.values()]
    if (sessions.length === 0) return

    this.abortingSessions = (async () => {
      await Promise.allSettled(
        sessions.map(async (session) => {
          progress?.phaseActivity(session.phaseName, "aborting active OpenCode session")
          try {
            const response = await session.client.session.abort({ sessionID: session.sessionID, directory: session.directory })
            if (response.error) log.warn(`couldn't abort OpenCode session ${session.sessionID}: ${formatSdkError(response.error)}`)
          } catch (error) {
            log.warn(`couldn't abort OpenCode session ${session.sessionID}: ${formatSdkError(error)}`)
          }
        }),
      )
    })().finally(() => {
      this.abortingSessions = undefined
    })

    return this.abortingSessions
  }

  dispose() {
    if (this.forceTimer) clearTimeout(this.forceTimer)
  }
}

/** Cooperative pause controller: an in-flight parallel batch remains atomic. */
export class RunControl {
  private state: RunControlState
  private activePhases = 0
  private waiters: Array<() => void> = []
  private progress?: ProgressUI

  constructor(private readonly metadata: RunMetadataStore) {
    this.state = metadata.controlState()
  }

  bind(progress: ProgressUI) {
    this.progress = progress
    this.publish()
  }

  beginBatch(activePhases: number) {
    this.activePhases = activePhases
  }

  async toggle() {
    if (this.state === "running") await this.requestPause()
    else await this.resume()
  }

  async requestPause() {
    if (this.state !== "running") return
    this.state = this.activePhases > 0 ? "pausing" : "paused"
    await this.metadata.setControlState(this.state)
    this.publish()
  }

  async resume() {
    if (this.state === "running") return
    this.state = "running"
    await this.metadata.setControlState("running")
    this.publish()
    for (const resolve of this.waiters.splice(0)) resolve()
  }

  async awaitRunnable(signal?: AbortSignal) {
    if (this.state === "running") return
    if (signal?.aborted) throw signal.reason ?? new UserAbortError()
    await new Promise<void>((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }
      const abort = () => {
        const index = this.waiters.indexOf(resume)
        if (index >= 0) this.waiters.splice(index, 1)
        reject(signal?.reason ?? new UserAbortError())
      }
      this.waiters.push(resume)
      signal?.addEventListener("abort", abort, { once: true })
    })
  }

  async checkpointAfterBatch(signal?: AbortSignal) {
    this.activePhases = 0
    if (this.state === "pausing") {
      this.state = "paused"
      await this.metadata.setControlState("paused")
      this.publish()
    }
    await this.awaitRunnable(signal)
  }

  private publish() {
    this.progress?.runControlState?.(this.state, this.activePhases)
  }
}

/** Exclusive per-run lease preventing two coordinators from mutating one pipeline. */
export async function acquireRunLease(workspace: Workspace): Promise<() => Promise<void>> {
  const path = join(workspace.dir, "coordinator.lock")
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`
  // Publish a complete owner record before atomically linking it into the lock
  // pathname. `open(path, "wx")` exposes an empty lock between creation and
  // write, letting another coordinator delete it and acquire the same run.
  const candidate = `${path}.${randomUUID()}.candidate`
  await writeFile(candidate, token, { encoding: "utf8", mode: 0o600, flag: "wx" })
  try {
    await link(candidate, path)
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error
    const owner = Number((await readFile(path, "utf8").catch(() => "")).split(":", 1)[0])
    if (owner > 0 && processIsAlive(owner)) throw new Error(`run ${workspace.runID} is already controlled by process ${owner}`)
    // Never reclaim a lease with a read-then-unlink sequence: two resumptions
    // can both observe a stale owner and one can remove the other's new lock.
    // Failing closed preserves exclusive ownership; an operator can remove a
    // stale lock after verifying no coordinator still owns the run.
    throw new Error(`run ${workspace.runID} has a stale coordinator lease at ${path}; remove it only after confirming no Convoy coordinator is running`)
  } finally {
    await unlink(candidate).catch(() => undefined)
  }

  return async () => {
    // Cooperating coordinators cannot replace an extant lock, so checking the
    // token before unlinking cannot race with a newly acquired lease.
    const current = await readFile(path, "utf8").catch(() => "")
    if (current === token) await unlink(path).catch(() => undefined)
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "EPERM")
  }
}

/**
 * Groups the flat step list into batches the runner executes together: a
 * human gate is always its own batch, and consecutive agent steps sharing a
 * groupId (a `parallel:` block, or one step fanned out across `models:`) form
 * one batch that runs concurrently. Validation guarantees group members are
 * always contiguous, so a linear scan suffices.
 */
export function planBatches(steps: readonly Step[]): Step[][] {
  const batches: Step[][] = []
  for (const step of steps) {
    const last = batches[batches.length - 1]
    const lastFirst = last?.[0]
    if (step.type === "agent" && lastFirst?.type === "agent" && step.groupId !== undefined && lastFirst.groupId === step.groupId) {
      last.push(step)
    } else {
      batches.push([step])
    }
  }
  return batches
}

/** Default cap on how many agents run at once inside one concurrent group. */
export const defaultMaxConcurrentAgents = 30

/**
 * Bounds how many jobs run at once. A group smaller than `limit` is never
 * throttled; a larger fan-out queues the overflow so the run never holds more
 * than `limit` live model sessions — each with its own event stream and poll
 * timer — open at the same time.
 */
export function createConcurrencyLimiter(limit: number) {
  let active = 0
  const waiters: Array<() => void> = []
  const release = () => {
    active--
    waiters.shift()?.()
  }
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve))
    active++
    try {
      return await job()
    } finally {
      release()
    }
  }
}

/** Every group member runs to completion before the pipeline fails; this aggregates their failures into one error. */
export class PhaseGroupError extends Error {
  readonly failures: { name: string; error: unknown }[]

  constructor(failures: { name: string; error: unknown }[]) {
    super(failures.map((failure) => `[${failure.name}] ${formatSdkError(failure.error)}`).join("; "))
    this.name = "PhaseGroupError"
    this.failures = failures
  }
}

type GitLock = <T>(job: () => Promise<T>) => Promise<T>

/**
 * Serializes git operations across concurrently-running phases in the same
 * group: their agent sessions run fully in parallel, but git.ts's mutating
 * calls (`git add`, `git commit`, `git reset --hard`) would otherwise race on
 * `.git/index.lock`. Forced-read-only group members never actually change the
 * tree, so this only ever arbitrates housekeeping, not real content conflicts.
 */
export function createGitLock(): GitLock {
  let tail: Promise<unknown> = Promise.resolve()
  return function withGitLock<T>(job: () => Promise<T>): Promise<T> {
    const run = tail.then(job, job)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

function installShutdownSignals(shutdown: RunShutdown) {
  // Bun delivers the numeric signal value to handlers; normalize for logs.
  const handler = (signal: NodeJS.Signals | number) =>
    shutdown.request(typeof signal === "number" ? (signal === 15 ? "SIGTERM" : signal === 2 ? "SIGINT" : `signal ${signal}`) : signal)
  process.on("SIGINT", handler)
  process.on("SIGTERM", handler)
  return () => {
    process.off("SIGINT", handler)
    process.off("SIGTERM", handler)
  }
}

export async function run(options: RunOptions) {
  // CLI callers hand the exact reviewed plan to the runner. Keep accepting
  // legacy programmatic RunOptions for API/tests, but never re-resolve a plan.
  const modelOverride = options.modelOverride
  if (options.plan) {
    options.pipeline = options.plan.pipeline
    options.onlySteps = []
    options.skipSteps = []
    options.modelOverride = ""
    if (options.plan.smartJudge) options.smartJudgeModel = options.plan.smartJudge.model.target
  }
  if (options.plan) ensureClaudeAvailable(options.plan.pipeline)
  await ensureRepoReady(options.targetDir, {
    includeDirty: options.includeDirty,
    maxAttempts: options.maxAttempts,
    baseRef: options.baseRef,
    allowDirty: Boolean(options.resumeRunID),
  })

  const workspace = options.resumeRunID
    ? await resumeWorkspace(options.resumeRunID)
    : await createWorkspace(options.prompt)

  let runErr: unknown
  let opencode: Awaited<ReturnType<typeof startOpencode>> | undefined
  let progress: ProgressUI = noopProgress
  let permissions: PermissionGate | undefined
  let advisorBridge: AdvisorBridge | undefined
  let advisorJournal: AdvisorEventJournal | undefined
  let metadata: RunMetadataStore | undefined
  let control: RunControl | undefined
  let caffeinate: Caffeinate | undefined
  let releaseLease: (() => Promise<void>) | undefined
  let hookSet = options.plan?.hooks ?? hooksForPipeline(options.hooks, options.pipeline.name)
  let pipelineNameForHooks = options.pipeline.name
  let postHooksStarted = false
  const shutdown = new RunShutdown()
  const removeSignalHandlers = installShutdownSignals(shutdown)

  const autoAccept: AutoAccept = { mode: options.yolo ? "all" : options.smart ? "smart" : "off" }
  // cli.ts always resolves a concrete model string (--smart-model → config →
  // --model → defaults.model), so smart mode never lacks a judge.
  const judgeModel = parseModel(splitModelVariant(options.smartJudgeModel).model)

  try {
    releaseLease = await acquireRunLease(workspace)
    metadata = await openRunMetadata(workspace, options.targetDir, options.pipeline, {
      gateway: options.plan?.modelRouting.gateway ?? options.gateway ?? "configured",
      gatewayOverride: options.gatewayExplicit ?? false,
      modelOverride: Boolean(modelOverride),
      // The plan has already applied --only/--skip. Never re-expand a reviewed
      // resume back to the entire persisted pipeline.
      useExecutionPipeline: Boolean(options.resumeRunID && options.plan),
    })
    const pipeline = metadata.pipeline
    pipelineNameForHooks = pipeline.name
    hookSet = options.plan?.hooks ?? hooksForPipeline(options.hooks, pipeline.name)
    validateStepFilters(pipeline, options)
    // Parallel/multi-model steps are forced read-only and point at a synthesized
    // "<agent>__ro" variant when their base agent isn't already read-only;
    // register those variants alongside the normal registry for this run.
    const agents = [...options.agents, ...synthesizeReadOnlyAgents(pipeline, options.agents)]
    ensureAgentsAvailable(pipeline, agents)
    // Claude Code is an optional dependency: only a pipeline that actually
    // contains a claude-code step needs the CLI, checked before anything runs.
    ensureClaudeAvailable(pipeline)
    // A run interrupted before its phase commit leaves the tree dirty; on resume
    // offer to commit that work as the interrupted phase and continue. Runs here,
    // before the TUI grabs the terminal, so the readline prompt stays visible.
    await maybeRecoverDirtyTree(workspace, metadata, options)
    control = new RunControl(metadata)
    caffeinate = new Caffeinate()
    // Imported lazily: finish pulls in the commit-message writer (and through it
    // opencode), which a run that never reaches its finish screen shouldn't pay for.
    const { createFinishSeam } = await import("./finish")
    progress = recordProgress(
      await createProgressUI(progressPhases(pipeline, hookSet), options.tui, () => shutdown.request("Ctrl+C"), autoAccept, {
        onPauseToggle: () => {
          void control?.toggle().catch((error) => log.warn(`couldn't persist pause state: ${formatSdkError(error)}`))
        },
        onKeepAwakeToggle: () => {
          void caffeinate?.toggle().catch((error) => log.warn(`couldn't toggle Caffeinate: ${formatSdkError(error)}`))
        },
        finish: createFinishSeam({ cwd: options.targetDir, baseRef: options.baseRef, runDir: workspace.dir }),
      }),
      metadata,
    )
    control.bind(progress)
    caffeinate.bind(progress)
    progress.start(workspace.runID, options.targetDir, workspace.dir)
    log.info(`Run ${workspace.runID} - dir: ${workspace.dir}`)
    // Use the captured flag: options.modelOverride was already cleared when a
    // reviewed plan took over, but the Claude Code notice must still fire.
    const overrideNotice = modelOverrideNotice(pipeline, modelOverride)
    if (overrideNotice) {
      progress.message(overrideNotice)
      log.warn(overrideNotice)
    }
    if (options.yolo) {
      progress.message("YOLO enabled: ask-level permissions will be auto-allowed (denylist still applies); shift+tab toggles")
      log.warn("YOLO enabled: unknown non-denied commands will be auto-allowed")
    } else if (options.smart) {
      progress.message(`smart auto-accept enabled: ${formatModel(judgeModel)} judges each request; risky ones still prompt (shift+tab toggles)`)
      log.warn(`smart auto-accept enabled: ${formatModel(judgeModel)} will auto-allow requests it judges safe`)
    }

    if (!options.resumeRunID) {
      await runHooks("pre", hookSet.pre, {
        workspace,
        targetDir: options.targetDir,
        pipelineName: pipeline.name,
        prompt: options.prompt,
        progress,
        signal: shutdown.signal,
      })
    } else if (hookSet.pre.length > 0) {
      for (const name of hookPhaseNames("pre", hookSet.pre)) progress.phaseSkipped(name)
      progress.message("pre-hooks skipped while resuming an existing run")
      log.info("pre-hooks skipped on resume")
    }

    const extraFiles = await fileParts(options.files, options.targetDir, "error")
    if (extraFiles.length > 0) log.info(`User attachments: ${extraFiles.map((file) => file.filename).join(", ")}`)
    const projectContextFiles = await discoverProjectContextFiles(options.targetDir)
    if (projectContextFiles.length > 0) log.info(`Project context: ${projectContextFiles.join(", ")}`)

    // The signal must only cover the boot wait: the SDK binds it to the server
    // process and would kill opencode the instant Ctrl+C lands, breaking the
    // graceful session-abort that runs during shutdown.
    const boot = new AbortController()
    const abortBoot = () => boot.abort(shutdown.signal.reason)
    shutdown.signal.addEventListener("abort", abortBoot, { once: true })
    // Derived from the frozen pipeline, so a resume rebuilds the same advisor
    // machinery the run started with.
    const advisorNeeds = advisorNeedsOf(pipeline.steps)
    // Everything the on-demand tool needs must exist before the server spawns:
    // the SDK hands opencode Convoy's environment at spawn time, and the tool
    // file is discovered from OPENCODE_CONFIG_DIR at startup. The runtime the
    // bridge serves is created after, once there is a client — hence the
    // deferred lookup.
    let advisors: AdvisorRuntime | undefined
    if (advisorNeeds.agents.size > 0) {
      await installAdvisorTool()
      process.env.OPENCODE_CONFIG_DIR = opencodeConfigDir()
      advisorBridge = await startAdvisorBridge({ advisors: () => advisors })
      process.env[advisorUrlEnv] = advisorBridge.url
      process.env[advisorTokenEnv] = advisorBridge.token
    }
    try {
      opencode = await startOpencode(
        opencodeConfig(workspace.dir, options.targetDir, agents, options.permissions, {
          advisorAgents: advisorNeeds.agents,
          advisorModels: advisorNeeds.models,
        }),
        boot.signal,
      )
    } finally {
      shutdown.signal.removeEventListener("abort", abortBoot)
    }
    progress.serverReady(opencode.url)
    log.info(`opencode SDK ready at ${opencode.url}`)

    advisors = createAdvisorRuntime({
      client: opencode.client,
      directory: options.targetDir,
      signal: shutdown.signal,
      auditPolicy: options.advisorAuditPolicy ?? "summary",
      ...(advisorNeeds.agents.size > 0
        ? {
            onEvent: async (event: AdvisorEvent) => {
              advisorJournal ??= await createAdvisorEventJournal(workspace)
              await advisorJournal.append(event)
              progress.phaseAdvisorEvent(event.phase, event)
              const detail = advisorEventLogLine(event)
              progress.phaseActivity(event.phase, detail, event.type === "advisor.failed" ? "error" : "info")
            },
          }
        : {}),
    })

    permissions = startPermissionGate({
      client: opencode.client,
      progress,
      interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
      directory: options.targetDir,
      autoAccept,
      judgeModel,
      ...(advisorNeeds.agents.size > 0 ? { advisorCheckpoint: advisors.checkpoint } : {}),
    })

    const resuming = Boolean(options.resumeRunID)
    const gitLock = createGitLock()
    // Caps concurrent agents within a group so a large `parallel:`/`models:`
    // fan-out doesn't open dozens of live sessions (each an event stream + poll
    // timer) at once; smaller groups are unaffected.
    const limitAgents = createConcurrencyLimiter(Math.max(1, options.maxConcurrentAgents ?? defaultMaxConcurrentAgents))
    // Narrow once, outside any closure: opencode/metadata are `let`s assigned
    // above, and TS won't retain that narrowing inside the batch's nested
    // arrow functions, but a `const` alias captured here stays narrowed.
    const client = opencode.client
    const serverUrl = opencode.url
    const runMetadata = metadata

    for (const batch of planBatches(pipeline.steps)) {
      shutdown.throwIfRequested()
      await control.awaitRunnable(shutdown.signal)
      const [first] = batch

      if (batch.length === 1 && first?.type === "human") {
        control.beginBatch(1)
        if (shouldSkip(first, options)) {
          progress.phaseSkipped(first.name)
          log.warn(`[${first.name}] skipped by flag`)
          await control.checkpointAfterBatch(shutdown.signal)
          continue
        }
        await runHumanReviewGate(workspace, options, opencode.url, progress, permissions, first.name)
        await control.checkpointAfterBatch(shutdown.signal)
        continue
      }

      const agentBatch = batch as AgentStep[]
      control.beginBatch(agentBatch.filter((step) => !shouldSkip(step, options)).length)
      const results = await Promise.allSettled(
        agentBatch.map(async (step) => {
          if (shouldSkip(step, options)) {
            progress.phaseSkipped(step.name)
            log.warn(`[${step.name}] skipped by flag`)
            return
          }
          await limitAgents(async () => {
            const restored = resuming && (await restorePhaseFromPreviousRun(workspace, runMetadata, step, progress))
            if (!restored) {
              await runPhase(client, workspace, runMetadata, step, options, extraFiles, projectContextFiles, progress, shutdown, gitLock, { serverUrl, permissions }, advisors)
            }
          })
        }),
      )

      // Every batch member runs to completion (Promise.allSettled, not
      // fail-fast) since forced-read-only siblings can't corrupt each other's
      // work; a user abort takes priority and propagates unwrapped so the
      // existing isUserAbortError handling below keeps working.
      const userAbort = results.find((result): result is PromiseRejectedResult => result.status === "rejected" && isUserAbortError(result.reason))
      if (userAbort) throw userAbort.reason
      const failures = results.flatMap((result, index) => (result.status === "rejected" ? [{ name: agentBatch[index]!.name, error: result.reason }] : []))
      await control.checkpointAfterBatch(shutdown.signal)
      if (failures.length > 0) throw new PhaseGroupError(failures)
    }

    progress.message("writing run summary")
    const advisorSection = advisorNeeds.agents.size > 0 ? renderAdvisorSplit(await readAdvisorSplit(workspace.dir)) : undefined
    const scoreboardRows = pipeline.steps.map((step) => ({
      name: step.name,
      status: runMetadata.phaseStatus(step.name),
      diff: runMetadata.phaseDiff(step.name),
    }))
    const scoreboard = renderScoreboard(scoreboardRows)
    await writeSummary(
      workspace,
      pipeline.steps.map((step) => step.name),
      advisorSection ? [advisorSection] : [],
      scoreboard,
    )
    postHooksStarted = true
    await runHooks("post", hookSet.post, {
      workspace,
      targetDir: options.targetDir,
      pipelineName: pipeline.name,
      prompt: options.prompt,
      status: "success",
      progress,
      signal: shutdown.signal,
    })
    await caffeinate.stop()
    await holdFinishScreen(progress, shutdown, { status: "completed", runDir: workspace.dir })
  } catch (error) {
    let failure = error
    if (!postHooksStarted && !isUserAbortError(failure)) {
      postHooksStarted = true
      try {
        await runHooks("post", hookSet.post, {
          workspace,
          targetDir: options.targetDir,
          pipelineName: pipelineNameForHooks,
          prompt: options.prompt,
          status: "failure",
          progress,
          signal: shutdown.signal,
        })
      } catch (hookError) {
        failure = new Error(`${formatSdkError(error)}; post-hook failed: ${formatSdkError(hookError)}`)
      }
    }
    runErr = failure
    if (!isUserAbortError(failure)) {
      await caffeinate?.stop()
      await holdFinishScreen(progress, shutdown, { status: "failed", error: formatSdkError(failure), runDir: workspace.dir })
    }
    throw failure
  } finally {
    removeSignalHandlers()
    if (shutdown.aborted) await shutdown.abortActiveSessions(progress)
    await caffeinate?.stop()
    await permissions?.stop()
    // Before the server: a tool call still in flight would otherwise hang on a
    // socket nobody is going to answer. The credentials go with it — they are
    // inherited by every subprocess Convoy spawns after this, hooks included,
    // and they would point at a bridge that no longer exists.
    advisorBridge?.close()
    delete process.env[advisorUrlEnv]
    delete process.env[advisorTokenEnv]
    // The server dies at the end of this block; clear its metadata entry now so
    // `convoy runs` stops offering to attach to a run that's shutting down.
    metadata?.serverStopped()
    await metadata?.flush().catch((error) => log.warn(`couldn't flush run metadata: ${String(error)}`))
    await releaseLease?.().catch((error) => log.warn(`couldn't release run lease: ${String(error)}`))
    progress.stop()
    shutdown.dispose()

    if (runErr) {
      log.warn(`Run dir preserved at ${workspace.dir}`)
    } else if (options.keepRunDir || progress.keepRunDirRequested?.()) {
      log.info(`Run dir kept at ${workspace.dir}`)
    } else {
      await cleanupWorkspace(workspace).catch((error) => log.warn(`couldn't clean ${workspace.dir}: ${String(error)}`))
    }

    // Kill the server last and return immediately: once it dies, any event
    // stream still held open by the SDK starts failing, and those failures
    // must not get a chance to surface mid-cleanup.
    opencode?.close()
  }
}

// The finish screen holds the run open while the opencode server and the run
// dir are still alive, so [o] can attach to phase sessions and reports stay
// readable. A signal (SIGTERM, a second Ctrl+C) must still tear the run down
// without user input, hence the race against the shutdown signal.
async function holdFinishScreen(progress: ProgressUI, shutdown: RunShutdown, outcome: RunOutcome) {
  if (!progress.runFinished || shutdown.aborted) return
  await Promise.race([
    progress.runFinished(outcome),
    new Promise<void>((resolve) => shutdown.signal.addEventListener("abort", () => resolve(), { once: true })),
  ])
}

// A failed phase can still leave a report behind (the agent writes it
// mid-session before the commit step or a later attempt blows up), so the
// report's existence alone can't prove the phase finished: a phase the
// metadata marks as failed must retry, and its stale report must go first or
// persistPhaseReport would keep it on the rerun.
export async function restorePhaseFromPreviousRun(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  progress: ProgressUI,
): Promise<boolean> {
  if (await phaseNeedsRun(workspace, metadata, phase)) {
    // A failed phase can leave its report behind; drop it so persistPhaseReport
    // writes a fresh one on the rerun instead of keeping the stale one.
    const reportAbs = join(workspace.dir, phase.reportPath)
    if (await exists(reportAbs)) {
      await rm(reportAbs, { force: true })
      log.info(`[${phase.name}] failed in the previous run; retrying`)
    }
    return false
  }

  const snapshot = metadata.snapshot(phase.name)
  if (snapshot) progress.phaseRestored(phase.name, snapshot)
  else progress.phaseCompleted(phase.name, "already completed in previous run")
  log.info(`[${phase.name}] report exists; skipping on resume`)
  return true
}

// A phase still needs to run on resume when its report is missing (it never
// finished) or the metadata marks it failed (its report, if any, is stale).
async function phaseNeedsRun(workspace: Workspace, metadata: RunMetadataStore, phase: AgentStep): Promise<boolean> {
  if (metadata.phaseStatus?.(phase.name) === "skipped") return false
  if (!(await exists(join(workspace.dir, phase.reportPath)))) return true
  // A read-only report is written before the repository boundary is checked.
  // If the process died while still running, resume must revalidate/retry it
  // rather than treating that unfinalized report as completed.
  if (phase.readOnly && metadata.phaseStatus(phase.name) === "running") return true
  return metadata.snapshot(phase.name)?.status === "failed"
}

// The agent phase a resume would run next: the first one still needing a run,
// skipping human gates. The dirty tree belongs to whichever phase was
// interrupted before its commit, which is exactly that phase.
export async function selectInterruptedPhase(
  workspace: Workspace,
  metadata: RunMetadataStore,
  pipeline: Pipeline,
): Promise<AgentStep | undefined> {
  // Lifecycle metadata is authoritative when present: a later running/failed
  // phase must not be hidden by an earlier skipped/completed phase whose agent
  // happened not to produce a report.
  for (const step of pipeline.steps) {
    if (step.type !== "agent") continue
    const status = metadata.phaseStatus?.(step.name)
    if (status === "running" || status === "failed") return step
  }
  for (const step of pipeline.steps) {
    if (step.type !== "agent") continue
    if (await phaseNeedsRun(workspace, metadata, step)) return step
  }
  return undefined
}

// On resume with a dirty tree, offer to commit the interrupted phase's leftover
// work and continue. Runs before the TUI starts so the prompt owns the terminal.
async function maybeRecoverDirtyTree(workspace: Workspace, metadata: RunMetadataStore, options: RunOptions) {
  if (!options.resumeRunID) return
  await assertPendingReadOnlyResumeBaselines(metadata, metadata.pipeline, options.targetDir)
  const phase = await selectInterruptedPhase(workspace, metadata, metadata.pipeline)

  const porcelain = await statusPorcelain(options.targetDir)
  if (porcelain.trim() === "") return

  const dirty = () => dirtyTreeError(options.targetDir, porcelain, { resuming: true })
  // No pending agent phase means the changes don't belong to an interrupted
  // phase (stray edits); leave them for the user rather than guess.
  if (!phase) throw dirty()
  // Read-only output is never recoverable agent work: it may be a concurrent
  // user edit, so committing it under the phase name would misattribute it.
  if (phase.readOnly) throw dirty()
  if (!(stdin.isTTY && stdout.isTTY)) throw dirty()
  if (!(await confirmRecovery(phase.name, porcelain))) throw dirty()

  await commitRecoveredPhase(workspace, metadata, phase, options.targetDir)
}

async function confirmRecovery(phaseName: string, porcelain: string): Promise<boolean> {
  stdout.write(`Resume found uncommitted changes from interrupted phase "${phaseName}":\n${dirtyFilesPreview(porcelain)}\n`)
  const rl = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  let interrupted = false
  // Raw-mode readline swallows the process SIGINT and emits this event instead;
  // without it Ctrl+C at the prompt would hang.
  rl.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  try {
    const answer = (await rl.question(`commit changes as '${phaseName}' and continue? [y/N] > `, { signal: controller.signal })).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } catch (error) {
    if (interrupted) throw new UserAbortError("Ctrl+C received")
    throw error
  } finally {
    rl.close()
  }
}

// Treats the dirty tree as the interrupted phase's output: writes a recovery
// report if the phase never wrote one, commits everything as that phase, and
// marks it completed so the resume loop skips it and runs the rest.
export async function commitRecoveredPhase(
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  targetDir: string,
) {
  if (phase.readOnly) {
    throw new Error(`[${phase.name}] refusing to commit preserved changes from a read-only phase; resolve them manually before resuming`)
  }
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs))) {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, recoveryReport(phase.name))
  }

  const committed = await addAllAndCommit(`convoy(${phase.name}): ${await summaryFromReport(reportAbs)}`, targetDir)
  if (committed) log.info(`[${phase.name}] recovered uncommitted changes into a commit; continuing from the next phase`)
  else log.warn(`[${phase.name}] nothing to commit during recovery`)

  metadata.phaseEnded(phase.name, "completed")
  await metadata.flush()
}

function recoveryReport(phaseName: string) {
  return [
    "# Recovered uncommitted changes",
    "",
    `Phase "${phaseName}" was interrupted before convoy committed its work. The`,
    "uncommitted changes left in the working tree were committed as this phase during a",
    "manual resume recovery, and the pipeline continued from the next phase.",
    "",
  ].join("\n")
}

/** What the mid-step interactive gate needs to reopen the session window and hold permission prompts. */
export type TakeoverContext = {
  serverUrl: string
  permissions?: PermissionGate
}

async function runPhase(
  client: OpencodeClient,
  workspace: Workspace,
  metadata: RunMetadataStore,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
  takeover?: TakeoverContext,
  advisors?: AdvisorRuntime,
) {
  progress.phaseStarted(phase.name, phase.description)
  log.section(`${phase.name} - ${phase.description}`)

  try {
    const prepared = await preparePhaseRun(workspace, phase, options, extraFiles, projectContextFiles)
    const baseline = await gitLock(async () => {
      const snapshot = await createCleanRepoSnapshot(options.targetDir)
      if (phase.readOnly && !snapshot) {
        const porcelain = await statusPorcelain(options.targetDir)
        throw new Error(
          `[${phase.name}] read-only steps require a clean working tree so Convoy can detect unexpected side effects without discarding concurrent user work\n${dirtyFilesPreview(porcelain)}`,
        )
      }
      return snapshot
    })
    if (phase.readOnly && baseline) await metadata.phaseRepositoryBaseline(phase.name, baseline)
    const reportAbs = await withReadOnlyRepositoryBoundary(phase, options.targetDir, baseline, gitLock, async () => {
      const assistantText = await runPhaseWithRetries(client, workspace, phase, options.targetDir, prepared, baseline, progress, shutdown, gitLock, takeover, undefined, advisors)
      return persistPhaseReport(workspace, phase, assistantText)
    })
    const phaseDiff = await gitLock(() => finalizePhaseRepository(phase, reportAbs, options.targetDir, baseline))
    if (phaseDiff) metadata.recordPhaseDiff(phase.name, phaseDiff)
    progress.phaseCompleted(phase.name, "report saved and commit checked")
  } catch (error) {
    progress.phaseFailed(phase.name, formatSdkError(error))
    throw error
  }
}

type PreparedPhaseRun = {
  attachments: FilePartInput[]
  prompt: string
  model: ModelSelection
  maxAttempts: number
}

async function preparePhaseRun(
  workspace: Workspace,
  phase: AgentStep,
  options: RunOptions,
  extraFiles: FilePartInput[],
  projectContextFiles: string[],
): Promise<PreparedPhaseRun> {
  const inputs = [...phase.inputFiles]
  if (phase.inputDiff) {
    const diffRel = join("diffs", `${phase.name}.pre.diff`)
    const diffAbs = join(workspace.dir, diffRel)
    await writeDiff(diffAbs, options.baseRef, options.targetDir)
    inputs.push(diffRel)
  }

  const phaseFiles = await fileParts(inputs, workspace.dir, "skip")
  const contextFiles = await projectContextFileParts(projectContextFiles, options.targetDir)
  const attachments = [...contextFiles, ...phaseFiles, ...extraFiles]
  const prompt = buildPhasePrompt(workspace, phase)
  const model = selectedModel(phase, options.modelOverride)
  const maxAttempts = Math.max(1, phase.maxAttempts ?? options.maxAttempts)

  return { attachments, prompt, model, maxAttempts }
}

async function projectContextFileParts(paths: string[], targetDir: string) {
  const out: FilePartInput[] = []
  for (const path of paths) {
    const parts = await fileParts([path], targetDir, "skip")
    out.push(...parts.map((part) => ({ ...part, filename: path })))
  }
  return out
}

type PhaseRetryDeps = {
  runPhaseAttempt: typeof runPhaseAttempt
  restorePhaseBaseline: typeof restorePhaseBaseline
}

export async function runPhaseWithRetries(
  client: OpencodeClient,
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  baseline: RepoSnapshot | undefined,
  progress: ProgressUI,
  shutdown: RunShutdown,
  gitLock: GitLock,
  takeover?: TakeoverContext,
  deps: PhaseRetryDeps = { runPhaseAttempt, restorePhaseBaseline },
  advisors?: AdvisorRuntime,
) {
  if (!baseline && prepared.maxAttempts > 1) {
    throw new Error(`[${phase.name}] can't retry with dirty working tree; use --max-attempts 1 or clean the repo`)
  }

  let lastError: unknown
  const sessionRef: SessionRef = {}
  // Read fresh at each decision point: the user can arm/disarm [i] mid-attempt.
  const armed = () => Boolean(takeover && progress.isInteractiveTakeover?.(phase.name))

  for (let attempt = 1; attempt <= prepared.maxAttempts; attempt++) {
    shutdown.throwIfRequested()
    progress.phaseAttempt(phase.name, { attempt, maxAttempts: prepared.maxAttempts, model: formatModel(prepared.model) })
    log.info(`[${phase.name}] attempt ${attempt}/${prepared.maxAttempts} with ${formatModel(prepared.model)}`)
    try {
      const assistantText = await deps.runPhaseAttempt(client, workspace, phase, targetDir, prepared, attempt, progress, shutdown, sessionRef, advisors)
      if (armed()) {
        // Armed means "this step is mine": even a clean finish waits for the
        // user's decision before the step commits and the pipeline moves on.
        log.info(`[${phase.name}] attempt succeeded with interactive mode armed; waiting for manual action`)
        await waitForInteractiveGate(phase.name, targetDir, sessionRef.id, takeover!, progress)
      }
      return assistantText
    } catch (error) {
      if (!shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts) && (shutdown.aborted || isUserAbortError(error))) {
        throw shutdown.abortError(error)
      }
      if (armed()) {
        // The user took over (typically esc in the attached OpenCode window):
        // no retry and no baseline restore — their manual work must survive.
        log.info(`[${phase.name}] attempt ended with interactive mode armed (${formatSdkError(error)}); waiting for manual action`)
        if (!(error instanceof LoggedAttemptError)) {
          await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
        }
        await waitForInteractiveGate(phase.name, targetDir, sessionRef.id, takeover!, progress)
        return ""
      }
      lastError = error
      progress.phaseRunning(phase.name, `attempt ${attempt} failed`)
      log.warn(`[${phase.name}] attempt ${attempt} failed: ${formatSdkError(error)}`)
      if (!(error instanceof LoggedAttemptError)) {
        await writeAttemptLog(workspace, phase, attempt, { error: formatSdkError(error) })
      }
      if (shouldRetryAttempt(error, shutdown.signal, attempt, prepared.maxAttempts)) await gitLock(() => deps.restorePhaseBaseline(phase, baseline, targetDir, error))
    }
  }

  if (lastError) {
    await gitLock(() => deps.restorePhaseBaseline(phase, baseline, targetDir, lastError))
    throw lastError
  }

  return ""
}

/** Last session created for the phase's attempts, so the interactive gate can reopen its window. */
type SessionRef = { id?: string }

type InteractiveGateDeps = { openWindow: typeof openOpencodeSessionWindow }

/**
 * The mid-step gate for phases armed with [i]: holds the pipeline until the
 * user picks continue (commit whatever the tree holds and move on), reopens
 * the session window on iterate, or aborts the run — leaving the working tree
 * untouched either way. Permission prompts stay paused while it waits, since
 * the user's attached OpenCode TUI answers its own.
 */
export async function waitForInteractiveGate(
  phaseName: string,
  targetDir: string,
  sessionID: string | undefined,
  takeover: TakeoverContext,
  progress: ProgressUI,
  deps: InteractiveGateDeps = { openWindow: openOpencodeSessionWindow },
): Promise<void> {
  const ask = progress.askHumanReview?.bind(progress)
  if (!ask) return // no dashboard, no gate: arming is impossible without the TUI anyway

  progress.phaseRunning(phaseName, "interactive session — waiting for your decision")
  let iterations = 0
  takeover.permissions?.pause()
  try {
    for (;;) {
      const action = await ask({ stepName: phaseName, iterations, kind: "interactive" })
      if (action === "continue") return
      if (action === "abort") throw new UserAbortError("aborted from interactive session gate")

      iterations++
      if (!sessionID) {
        progress.phaseActivity(phaseName, "no session to reopen; use the OpenCode window you already have", "info")
        continue
      }
      try {
        const backend = await deps.openWindow({ url: takeover.serverUrl, targetDir, sessionID })
        progress.phaseActivity(phaseName, `session reopened in ${backend}; return here and press c to continue`, "system")
      } catch (error) {
        progress.phaseActivity(phaseName, `couldn't reopen the session window: ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }
  } finally {
    takeover.permissions?.resume()
  }
}

async function runPhaseAttempt(
  client: OpencodeClient,
  workspace: Workspace,
  phase: AgentStep,
  targetDir: string,
  prepared: PreparedPhaseRun,
  attempt: number,
  progress: ProgressUI,
  shutdown: RunShutdown,
  sessionRef?: SessionRef,
  advisors?: AdvisorRuntime,
) {
  const input = { client, workspace, phase, targetDir, prepared, attempt, progress, shutdown, sessionRef, advisors }
  const runner = phaseAttemptRunners[stepRunnerFor(phase.runner).id]
  const result = await runner.executeAttempt(input)

  await writeAttemptLog(workspace, phase, attempt, {
    session: result.sessionID,
    agent: phase.agentName,
    model: result.model,
    attachments: prepared.attachments.map((file) => ({ filename: file.filename, mime: file.mime, url: file.url })),
    finish: result.finish,
    cost: result.cost,
    tokens: result.tokens,
    error: result.error,
    // Logged as its own line, never folded into the executor's totals: the whole
    // economic claim of the pattern is that this stays a small fraction.
    ...(result.advisorUsage ? { advisor: totalAdvisorUsage(result.advisorUsage) } : {}),
    // Fallback copy for writeAttemptLog's journal merge; it is replaced by the
    // merged event list before the log is written.
    ...(result.advisorEvents && result.advisorEvents.length > 0 ? { advisorEvents: result.advisorEvents } : {}),
    text: result.assistantText,
  })

  if (result.error) {
    if (isMessageAbortedError(result.error)) throw new SessionAbortedError(result.error)
    throw new LoggedAttemptError(formatSdkError(result.error), { cause: result.error })
  }
  return result.assistantText
}

type PhaseAttemptInput = {
  client: OpencodeClient
  workspace: Workspace
  phase: AgentStep
  targetDir: string
  prepared: PreparedPhaseRun
  attempt: number
  progress: ProgressUI
  shutdown: RunShutdown
  sessionRef?: SessionRef
  /** Absent when no step in the run has an advisor. */
  advisors?: AdvisorRuntime
}

type PhaseAttemptResult = {
  assistantText: string
  sessionID?: string
  model: ModelSelection | string
  finish?: unknown
  cost?: number
  tokens?: unknown
  error?: unknown
  advisorUsage?: readonly AdvisorUsage[]
  advisorEvents?: readonly AdvisorEvent[]
}

const phaseAttemptRunners: Record<StepRunnerId, StepRunnerImpl<PhaseAttemptInput, PhaseAttemptResult>> = {
  opencode: createStepRunnerImpl("opencode", executeOpenCodePhaseAttempt),
  "claude-code": createStepRunnerImpl("claude-code", executeClaudeCodePhaseAttempt),
}

async function executeOpenCodePhaseAttempt(input: PhaseAttemptInput): Promise<PhaseAttemptResult> {
  const result = await promptPhase(input.client, {
    phase: input.phase,
    workspace: input.workspace,
    targetDir: input.targetDir,
    prompt: input.prepared.prompt,
    model: input.prepared.model,
    attachments: input.prepared.attachments,
    progress: input.progress,
    shutdown: input.shutdown,
    sessionRef: input.sessionRef,
    attempt: input.attempt,
    ...(input.advisors ? { advisors: input.advisors } : {}),
  })
  const assistantText = extractAssistantText(result.parts)
  // Totals for the whole attempt, not the final message: the attempt log's
  // executor figures are what the advisor split is measured against, and a
  // headline ratio computed from one message of a many-message phase would
  // understate the executor by however much it happened to do first.
  const usage = combinedAssistantUsage(result.assistantInfos, result.info.sessionID)
  return {
    assistantText,
    sessionID: result.info.sessionID,
    model: input.prepared.model,
    finish: result.info.finish,
    cost: usage?.cost ?? result.info.cost,
    tokens: usage?.tokens ?? result.info.tokens,
    error: result.info.error,
    ...(result.advisorUsage && result.advisorUsage.length > 0 ? { advisorUsage: result.advisorUsage } : {}),
    ...(result.advisorEvents && result.advisorEvents.length > 0 ? { advisorEvents: result.advisorEvents } : {}),
  }
}

/**
 * The claude-code twin of the OpenCode attempt: same prompt, same attempt log
 * shape, same report contract (read-only step → the report is the final
 * assistant text), executed by the local `claude` CLI instead of a session.
 */
async function executeClaudeCodePhaseAttempt(input: PhaseAttemptInput): Promise<PhaseAttemptResult> {
  const result = await promptClaudePhase({
    phase: input.phase,
    workspace: input.workspace,
    targetDir: input.targetDir,
    prompt: input.prepared.prompt,
    attachments: input.prepared.attachments,
    attempt: input.attempt,
    progress: input.progress,
    shutdown: input.shutdown,
    ...(input.sessionRef ? { sessionRef: input.sessionRef } : {}),
  })
  return {
    assistantText: result.assistantText,
    sessionID: result.sessionID,
    model: stepRunnerFor(input.phase.runner).modelLabel(input.phase.model),
    finish: result.finish,
    cost: result.cost,
    tokens: result.tokens,
    error: result.error,
  }
}

async function persistPhaseReport(workspace: Workspace, phase: AgentStep, assistantText: string) {
  const reportAbs = join(workspace.dir, phase.reportPath)
  if (!(await exists(reportAbs)) && assistantText.trim() !== "") {
    await mkdir(dirname(reportAbs), { recursive: true })
    await writeFile(reportAbs, assistantText)
  }

  if (!(await exists(reportAbs))) {
    log.warn(`[${phase.name}] agent didn't write the expected report at ${reportAbs}`)
  }

  return reportAbs
}

async function commitPhase(phase: AgentStep, reportAbs: string, targetDir: string): Promise<string | undefined> {
  const message = `convoy(${phase.name}): ${await summaryFromReport(reportAbs)}`
  const committed = await addAllAndCommit(message, targetDir)
  if (!committed) {
    log.info(`[${phase.name}] no changes - no commit`)
    return undefined
  }
  log.info(`[${phase.name}] commit: ${message}`)
  // Resolve the new HEAD so the caller can compute a per-phase diffstat.
  return resolveCommit("HEAD", targetDir)
}

export async function finalizePhaseRepository(
  phase: AgentStep,
  reportAbs: string,
  targetDir: string,
  baseline: RepoSnapshot | undefined,
  originalError?: unknown,
): Promise<DiffTotals | undefined> {
  if (!phase.readOnly) {
    const newHead = await commitPhase(phase, reportAbs, targetDir)
    if (newHead && baseline) {
      return diffTotals(baseline.head, newHead, targetDir)
    }
    return undefined
  }
  if (!baseline) throw new Error(`[${phase.name}] read-only step has no clean repository baseline`)

  const difference = await describeRepoSnapshotDifference(baseline, targetDir)
  if (!difference) {
    log.info(`[${phase.name}] read-only step left the repository unchanged`)
    return undefined
  }

  if (originalError instanceof ReadOnlyRepositoryMutationError) throw originalError
  const message = `[${phase.name}] repository changed during a read-only step; Convoy left these changes intact to avoid discarding concurrent user work\n${difference}${
      originalError === undefined ? "" : `\nOriginal failure: ${formatSdkError(originalError)}`
    }`
  if (isUserAbortError(originalError)) throw new UserAbortError(message)
  throw new ReadOnlyRepositoryMutationError(message)
}

async function restorePhaseBaseline(phase: AgentStep, baseline: RepoSnapshot | undefined, targetDir: string, originalError: unknown) {
  if (!baseline) return
  if (phase.readOnly) {
    await finalizePhaseRepository(phase, "", targetDir, baseline, originalError)
    return
  }
  try {
    await restoreRepoSnapshot(baseline, targetDir)
  } catch (restoreError) {
    throw new Error(
      `[${phase.name}] failed and couldn't restore git snapshot: ${formatSdkError(restoreError)}; original error: ${formatSdkError(
        originalError,
      )}`,
    )
  }
}

class ReadOnlyRepositoryMutationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ReadOnlyRepositoryMutationError"
  }
}

/**
 * Checks the read-only boundary in a finally block so aborts, failed attempts,
 * and report persistence errors cannot bypass mutation detection. Detection is
 * deliberately non-destructive because Convoy cannot distinguish an extension
 * side effect from a user's concurrent edit in the same working tree.
 */
export async function withReadOnlyRepositoryBoundary<T>(
  phase: AgentStep,
  targetDir: string,
  baseline: RepoSnapshot | undefined,
  gitLock: GitLock,
  action: () => Promise<T>,
): Promise<T> {
  if (!phase.readOnly) return action()
  if (!baseline) throw new Error(`[${phase.name}] read-only step has no clean repository baseline`)

  let originalError: unknown
  try {
    return await action()
  } catch (error) {
    originalError = error
    throw error
  } finally {
    await gitLock(() => finalizePhaseRepository(phase, "", targetDir, baseline, originalError))
  }
}

export async function assertReadOnlyResumeBaseline(metadata: RunMetadataStore, phase: AgentStep, targetDir: string): Promise<void> {
  if (!phase.readOnly) return
  const baseline = metadata.repositoryBaseline(phase.name)
  if (!baseline) return
  const difference = await describeRepoSnapshotDifference(baseline, targetDir)
  if (!difference) return
  throw new Error(
    `[${phase.name}] repository changed since this read-only phase began; Convoy left the changes intact. Restore the recorded HEAD/branch or start a new run before resuming\n${difference}`,
  )
}

export async function assertPendingReadOnlyResumeBaselines(metadata: RunMetadataStore, pipeline: Pipeline, targetDir: string): Promise<void> {
  for (const step of pipeline.steps) {
    if (step.type !== "agent" || !step.readOnly) continue
    const status = metadata.phaseStatus(step.name)
    if (status !== "running" && status !== "failed") continue
    await assertReadOnlyResumeBaseline(metadata, step, targetDir)
  }
}

async function promptPhase(
  client: OpencodeClient,
  input: {
    phase: AgentStep
    workspace: Workspace
    targetDir: string
    prompt: string
    model: ModelSelection
    attachments: FilePartInput[]
    progress: ProgressUI
    shutdown: RunShutdown
    sessionRef?: SessionRef
    advisors?: AdvisorRuntime
    attempt: number
  },
): Promise<SessionResult> {
  input.shutdown.throwIfRequested()
  const session = await client.session.create({
    directory: input.targetDir,
    title: `convoy ${input.workspace.runID} ${input.phase.name}`,
    metadata: { convoyRunID: input.workspace.runID, convoyPhase: input.phase.name },
  }, { signal: input.shutdown.signal })
  if (session.error) throw new Error(formatSdkError(session.error))
  if (!session.data?.id) throw new Error("opencode didn't return session id")

  if (input.sessionRef) input.sessionRef.id = session.data.id
  // Registered here and not earlier: the permission gate and the on-demand tool
  // both find a phase by its live session, which only exists now.
  const advisor = input.advisors?.begin(session.data.id, input.phase, input.attempt)
  input.progress.phaseSession(input.phase.name, session.data.id)
  input.shutdown.setActiveSession({ client, sessionID: session.data.id, directory: input.targetDir, phaseName: input.phase.name })
  log.info(`[${input.phase.name}] session: ${session.data.id}`)

  // The prompt is fired asynchronously and completion is detected through the
  // event stream plus status polling. A single blocking HTTP request can't
  // survive a phase that runs for an hour (Bun kills idle sockets after 5min).
  const watcher = watchSession(client, {
    directory: input.targetDir,
    phaseName: input.phase.name,
    sessionID: session.data.id,
    progress: input.progress,
    signal: input.shutdown.signal,
  })

  try {
    // Don't fire the prompt until the event stream is listening, or the first
    // events of a fast-failing session are lost.
    await Promise.race([watcher.ready, sleep(3_000)])
    input.shutdown.throwIfRequested()

    const accepted = await client.session.promptAsync({
      sessionID: session.data.id,
      directory: input.targetDir,
      agent: input.phase.agentName,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      parts: [...input.attachments, { type: "text", text: input.prompt }],
    }, { signal: input.shutdown.signal })
    if (accepted.error) throw new Error(formatSdkError(accepted.error))
    const first = await watcher.result
    input.shutdown.throwIfRequested()

    // The deliverable is durable by now — the phase wrote its report or edited
    // the repo before going idle — which is what makes this the right place for
    // the "is it actually done?" consultation: a session that dies during the
    // call loses nothing.
    const reviewed = advisor ? await applyCompletionCheckpoint(client, { ...input, sessionID: session.data.id }, first, advisor) : first

    const usage = combinedAssistantUsage(reviewed.assistantInfos, session.data.id)
    if (usage) {
      input.progress.phaseUsageTotal(input.phase.name, usage)
      log.info(`[${input.phase.name}] usage: ${formatUsageForLog(usage)}`)
    }
    return {
      ...reviewed,
      ...(advisor && advisor.usage.length > 0 ? { advisorUsage: [...advisor.usage] } : {}),
      ...(advisor && advisor.events.length > 0 ? { advisorEvents: [...advisor.events] } : {}),
    }
  } catch (error) {
    if (!input.shutdown.aborted && !isUserAbortError(error)) {
      await abortSessionQuietly(client, session.data.id, input.targetDir, input.phase.name)
    }
    throw error
  } finally {
    advisor?.end()
    if (input.shutdown.aborted) await input.shutdown.abortActiveSessions(input.progress)
    input.shutdown.clearActiveSession(input.phase.name, session.data.id)
    await watcher.stop()
  }
}

type SessionResult = {
  info: AssistantMessage
  parts: Part[]
  assistantInfos: AssistantMessage[]
  /** Present only when this attempt consulted an advisor; kept apart from executor usage so the split stays visible. */
  advisorUsage?: readonly AdvisorUsage[]
  advisorEvents?: readonly AdvisorEvent[]
}

/** Sentinel the closing checkpoint asks a read-only phase to reply with when the advice changes nothing. */
export const noChangesReply = "NO CHANGES"

/**
 * Consults the advisor once the phase believes it is finished, and gives it one
 * more turn in the SAME session when there is something to act on. Same session
 * on purpose: nothing is re-serialized, so the phase keeps every bit of context
 * it built up.
 *
 * Read-only phases need the sentinel protocol. Their visible output *is* the
 * report — Convoy persists the assistant text verbatim — so a chatty extra turn
 * would corrupt it. They are asked to either re-emit the whole report or reply
 * with the sentinel, and the sentinel case keeps the original text.
 */
async function applyCompletionCheckpoint(
  client: OpencodeClient,
  input: {
    phase: AgentStep
    targetDir: string
    model: ModelSelection
    progress: ProgressUI
    shutdown: RunShutdown
    sessionID: string
  },
  first: SessionResult,
  advisor: AdvisorPhaseHandle,
): Promise<SessionResult> {
  const advice = await advisor.consult("completion", completionQuestion(Boolean(input.phase.readOnly)))
  if (!advice.ok) return first
  input.shutdown.throwIfRequested()

  input.progress.phaseActivity(input.phase.name, "advisor reviewed the finished phase", "info")

  const watcher = watchSession(client, {
    directory: input.targetDir,
    phaseName: input.phase.name,
    sessionID: input.sessionID,
    progress: input.progress,
    signal: input.shutdown.signal,
    // Second turn of a session that already has one: anchored so the result is
    // this turn alone, which is what the composition below assumes.
    sinceMessageID: first.info.id,
  })
  try {
    await Promise.race([watcher.ready, sleep(3_000)])
    const accepted = await client.session.promptAsync({
      sessionID: input.sessionID,
      directory: input.targetDir,
      agent: input.phase.agentName,
      model: { providerID: input.model.providerID, modelID: input.model.modelID },
      variant: input.model.variant,
      parts: [{ type: "text", text: completionFollowUp(input.phase, advice.text) }],
    }, { signal: input.shutdown.signal })
    if (accepted.error) throw new Error(formatSdkError(accepted.error))
    await advisor.delivered(advice.callId, "follow-up")

    const second = await watcher.result
    // The watcher resolves on a terminal error as readily as on a completion, so
    // the review turn's failure surfaces here and not only in the catch below.
    // Propagating it would fail the attempt and roll the finished phase back.
    if (second.info.error) return keepCompletedPhase(input.phase.name, first, formatSdkError(second.info.error))

    const secondText = extractAssistantText(second.parts).trim()
    const unchanged = secondText.length === 0 || secondText.toUpperCase().startsWith(noChangesReply)

    return {
      info: second.info,
      // A read-only phase replaces its report or keeps it; a writing phase's text
      // is only a fallback report, so both turns are kept.
      parts: input.phase.readOnly ? (unchanged ? first.parts : second.parts) : [...first.parts, ...second.parts],
      assistantInfos: [...first.assistantInfos, ...second.assistantInfos],
    }
  } catch (error) {
    if (input.shutdown.aborted || isUserAbortError(error)) throw error
    return keepCompletedPhase(input.phase.name, first, error instanceof Error ? error.message : String(error))
  } finally {
    await watcher.stop()
  }
}

/** The phase already produced a durable deliverable; a failed review turn must not discard it. */
function keepCompletedPhase(phaseName: string, first: SessionResult, reason: string): SessionResult {
  log.warn(`[${phaseName}] advisor review turn failed, keeping the completed phase: ${reason}`)
  return first
}

function completionFollowUp(phase: AgentStep, advice: string): string {
  const protocol = phase.readOnly
    ? `If this changes your findings, reply with your COMPLETE corrected report and nothing else — it replaces what you just produced. If it changes nothing, reply with exactly \`${noChangesReply}\`.`
    : `If this identifies real work, do it now and then say what you changed. If it changes nothing, say so briefly and stop.`

  return [
    "Before this phase is accepted, a reviewing model read your full transcript. Its guidance:",
    "",
    advice,
    "",
    protocol,
    "",
    "Weigh it seriously, but you have first-hand evidence it lacks: if something it claims is contradicted by what you actually read or ran, say so instead of complying.",
  ].join("\n")
}

export type SessionWatcher = {
  result: Promise<SessionResult>
  ready: Promise<void>
  stop(): Promise<void>
}

type ActivityState = {
  reasoningChars: number
  textChars: number
  textTail: string
  currentStepModel: string
  lastReasoningUpdate: number
  lastTextUpdate: number
  lastServerEvent: number
  messageUsage: Map<string, { cost: number; tokens: ProgressTokens }>
  messagePartChannels: Map<string, "reasoning" | "response">
  // Counters behind the synthetic part IDs for the session.next.* stream, which
  // carries no part identity of its own: each reasoning/text burst gets its own
  // transcript block instead of merging into the one before it.
  reasoningPart: number
  textPart: number
  usageSignature: string
}

type SessionSignal =
  | { type: "activity"; kind: ActivityKind; message: string; stepUsage?: ProgressStepUsage; pulse?: boolean }
  | { type: "usage"; usage: ProgressUsage }
  | { type: "todos"; todos: ProgressTodo[]; message: string }
  | { type: "diff"; summary: ProgressDiffSummary }
  | { type: "idle" }
  | { type: "error"; error: string }

const sessionPollMs = 30_000
const maxConsecutivePollFailures = 10

export function watchSession(
  client: OpencodeClient,
  input: {
    directory: string
    phaseName: string
    sessionID: string
    progress: ProgressUI
    signal: AbortSignal
    /**
     * Anchor for a watcher that covers a follow-up turn in an already-used
     * session: everything up to and including this assistant message belongs to
     * the previous turn and is excluded from the result. Omitted, the result
     * covers the whole session — which is the same thing for a fresh one.
     */
    sinceMessageID?: string
  },
): SessionWatcher {
  const controller = new AbortController()
  const state = newActivityState()

  let settled = false
  let sawWork = false
  let idlePollsWithoutResult = 0
  let lastSessionError: string | undefined
  let verifying: Promise<boolean> | undefined

  let resolveResult!: (value: SessionResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<SessionResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  result.catch(() => {}) // the watcher may be stopped before anyone awaits the result

  // One directory-scoped subscription is shared across all phases; this watcher
  // just registers for its own session's events (see event-hub).
  const hub = getSessionEventHub(client, input.directory)

  const finish = (outcome: { value?: SessionResult; error?: unknown }) => {
    if (settled) return
    settled = true
    controller.abort(new Error("session watcher finished"))
    if (outcome.value) resolveResult(outcome.value)
    else rejectResult(outcome.error)
  }

  const onExternalAbort = () => finish({ error: new UserAbortError() })
  input.signal.addEventListener("abort", onExternalAbort, { once: true })
  if (input.signal.aborted) onExternalAbort()

  // A session is complete once its last assistant message either finished or
  // carries a terminal error. Verified against the server, never assumed.
  const verifyCompletion = () => {
    if (settled) return Promise.resolve(true)
    verifying ??= (async () => {
      try {
        const response = await client.session.messages({ sessionID: input.sessionID, directory: input.directory })
        if (response.error || !response.data) return false
        const assistant = response.data.filter(
          (message): message is { info: AssistantMessage; parts: Part[] } => message.info.role === "assistant",
        )
        // A result describes ONE turn. The server hands back the whole session,
        // so a follow-up watcher drops everything through its anchor: a caller
        // that composes two turns would otherwise double-count their usage and
        // concatenate the first turn's report onto the second's.
        const anchor = input.sinceMessageID ? assistant.findIndex((message) => message.info.id === input.sinceMessageID) : -1
        const turn = anchor === -1 ? assistant : assistant.slice(anchor + 1)
        const last = turn[turn.length - 1]
        if (!last || (!last.info.time.completed && !last.info.error)) return false
        finish({
          value: {
            info: last.info,
            parts: turn.flatMap((message) => message.parts),
            assistantInfos: turn.map((message) => message.info),
          },
        })
        return true
      } catch {
        return false
      } finally {
        verifying = undefined
      }
    })()
    return verifying
  }

  const handleSignal = async (signal: SessionSignal) => {
    switch (signal.type) {
      case "activity":
        if (signal.stepUsage) input.progress.phaseStepUsage(input.phaseName, signal.stepUsage)
        input.progress.phaseActivity(input.phaseName, signal.message, signal.kind, signal.pulse)
        return
      case "usage":
        input.progress.phaseUsageTotal(input.phaseName, signal.usage)
        return
      case "todos":
        input.progress.phaseTodos(input.phaseName, signal.todos)
        input.progress.phaseActivity(input.phaseName, signal.message, "todo")
        return
      case "diff":
        input.progress.phaseDiff(input.phaseName, signal.summary)
        return
      case "error":
        lastSessionError = signal.error
        input.progress.phaseActivity(input.phaseName, `session error: ${signal.error}`, "error")
        await verifyCompletion()
        return
      case "idle":
        input.progress.phaseActivity(input.phaseName, "session idle; collecting results", "info")
        if (!(await verifyCompletion()) && sawWork) {
          finish({ error: new Error(lastSessionError ?? "session went idle without a completed response") })
        }
        return
    }
  }

  // The hub delivers only this session's events (it filters by sessionID), so we
  // describe them into the same activity/message signals the old per-session
  // subscription produced — just without owning a subscription of our own.
  const unsubscribe = hub.onSession(input.sessionID, (payload) => {
    if (settled || controller.signal.aborted) return
    state.lastServerEvent = Date.now()
    const signal = describeSessionActivity(payload, state)
    if (signal) {
      if (signal.type !== "idle" && signal.type !== "error") sawWork = true
      // handleSignal's only async work is completion verification, which is
      // idempotent; fire-and-forget keeps the hub's dispatch non-blocking so one
      // session's network round-trip can't stall the others'.
      void handleSignal(signal).catch(() => {})
    }
    if (settled) return
    // The verbatim model stream for the session transcript, extracted separately
    // so the summarized activity/status signals above are untouched. Appends
    // only — the TUI repaints it on its own ticker.
    const chunk = describeMessageChunk(payload, state)
    if (chunk) {
      sawWork = true
      input.progress.phaseMessage(input.phaseName, chunk)
    }
  })

  const pollLoop = (async () => {
    let failures = 0
    while (!controller.signal.aborted && !settled) {
      await sleep(sessionPollMs, controller.signal)
      if (controller.signal.aborted || settled) return
      try {
        const response = await client.session.status({ directory: input.directory })
        if (response.error) throw new Error(formatSdkError(response.error))
        failures = 0
        const status = response.data?.[input.sessionID]
        if (!status || status.type === "idle") {
          if (await verifyCompletion()) return
          idlePollsWithoutResult++
          const limit = sawWork ? 2 : 4
          if (idlePollsWithoutResult >= limit) {
            finish({ error: new Error(lastSessionError ?? `session ${sawWork ? "went idle" : "never started"} without a completed response`) })
            return
          }
        } else {
          sawWork = true
          idlePollsWithoutResult = 0
          if (Date.now() - state.lastServerEvent >= sessionPollMs) {
            const detail = status.type === "retry" ? `provider retry ${status.attempt}: ${status.message}` : "opencode is still working (no events)"
            input.progress.phaseActivity(input.phaseName, detail, status.type === "retry" ? "retry" : "info")
          }
        }
      } catch (error) {
        failures++
        if (failures >= maxConsecutivePollFailures) {
          finish({ error: new Error(`lost contact with the opencode server: ${formatSdkError(error)}`) })
          return
        }
        input.progress.phaseActivity(input.phaseName, `status check failed (${failures}/${maxConsecutivePollFailures}): ${formatSdkError(error)}`, "error")
      }
    }
  })()

  return {
    result,
    // Readiness now means "the shared subscription is live"; the hub opens it
    // once at run start, before any phase prompts, so early events aren't lost.
    ready: hub.ready,
    async stop() {
      settled = true
      unsubscribe() // last listener to leave tears the shared subscription down
      controller.abort(new Error("session watcher stopped"))
      input.signal.removeEventListener("abort", onExternalAbort)
      // The poll loop unwinds on abort; the race is a safety net so a stuck
      // request can never hold the whole run hostage.
      await Promise.race([pollLoop, sleep(3_000)])
    },
  }
}

async function abortSessionQuietly(client: OpencodeClient, sessionID: string, directory: string, phaseName: string) {
  try {
    const response = await client.session.abort({ sessionID, directory })
    if (response.error) log.warn(`[${phaseName}] couldn't abort session ${sessionID}: ${formatSdkError(response.error)}`)
  } catch (error) {
    log.warn(`[${phaseName}] couldn't abort session ${sessionID}: ${formatSdkError(error)}`)
  }
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      signal?.removeEventListener("abort", done)
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}

function payloadType(payload: unknown) {
  if (!payload || typeof payload !== "object") return ""
  const type = (payload as { type?: unknown }).type
  if (typeof type === "string") return type === "sync" ? String((payload as { name?: unknown }).name ?? "").replace(/\.1$/, "") : type
  const name = (payload as { name?: unknown }).name
  return typeof name === "string" ? name.replace(/\.1$/, "") : ""
}

export function newActivityState(): ActivityState {
  return {
    reasoningChars: 0,
    textChars: 0,
    textTail: "",
    currentStepModel: "",
    lastReasoningUpdate: 0,
    lastTextUpdate: 0,
    lastServerEvent: Date.now(),
    messageUsage: new Map(),
    messagePartChannels: new Map(),
    reasoningPart: 0,
    textPart: 0,
    usageSignature: "",
  }
}

function activity(kind: ActivityKind, message: string, stepUsage?: ProgressStepUsage): SessionSignal {
  return { type: "activity", kind, message, stepUsage }
}

// Heartbeats refresh the live status line but never land in the activity feed.
function pulse(kind: ActivityKind, message: string): SessionSignal {
  return { type: "activity", kind, message, pulse: true }
}

export function describeSessionActivity(payload: unknown, state: ActivityState): SessionSignal | undefined {
  const type = payloadType(payload)
  const properties = payloadProperties(payload)
  if (!properties) return undefined
  const now = Date.now()

  switch (type) {
    case "session.next.prompted":
      return activity("info", "prompt submitted")
    case "session.next.step.started":
      state.currentStepModel = formatModelFromEvent(properties.model)
      return activity("step", `working with ${state.currentStepModel}`)
    case "session.next.step.ended": {
      const message = `step finished: ${pickString(properties, ["finish"]) || "complete"}${formatCost(properties)}`
      return activity("step", message, stepUsageFromEvent(payload, properties, state.currentStepModel))
    }
    case "session.next.step.failed":
      return activity("error", `step failed: ${formatEventError(properties.error)}`)
    case "session.status":
      return describeSessionStatus(properties.status)
    case "session.idle":
      return { type: "idle" }
    case "session.next.reasoning.started":
      state.reasoningChars = 0
      state.lastReasoningUpdate = now
      return activity("think", "thinking…")
    case "session.next.reasoning.delta":
      state.reasoningChars += pickString(properties, ["delta"]).length
      if (now - state.lastReasoningUpdate < 1000) return undefined
      state.lastReasoningUpdate = now
      return activity("think", `thinking… ${formatCharCount(state.reasoningChars)} hidden chars`)
    case "session.next.reasoning.ended":
      return activity("think", "thinking complete")
    case "session.next.text.started":
      state.textChars = 0
      state.textTail = ""
      state.lastTextUpdate = now
      return activity("write", "writing response…")
    case "session.next.text.delta": {
      const delta = pickString(properties, ["delta"])
      state.textChars += delta.length
      state.textTail = `${state.textTail}${delta}`.slice(-160)
      if (now - state.lastTextUpdate < 350) return undefined
      state.lastTextUpdate = now
      return activity("write", `writing (${formatCharCount(state.textChars)}): ${state.textTail}`)
    }
    case "session.next.text.ended":
      return activity("write", `response complete (${formatCharCount(pickString(properties, ["text"]).length || state.textChars)})`)
    case "message.updated":
      return messageUsageSignal(properties, state)
    case "message.part.delta":
      return pulse("write", `streaming ${pickString(properties, ["field"]) || "message"}`)
    case "session.next.tool.input.started":
      return activity("tool", `preparing ${pickString(properties, ["name"]) || "tool"}`)
    case "session.next.tool.called":
      return activity("tool", describeToolCall(properties))
    case "session.next.tool.progress":
      return activity("tool", `tool progress: ${describeToolContent(properties.content)}`)
    case "session.next.tool.success":
      return activity("tool", `tool done: ${describeToolContent(properties.content)}`)
    case "session.next.tool.failed":
      return activity("error", `tool failed: ${formatEventError(properties.error)}`)
    case "session.next.shell.started":
      return activity("bash", pickString(properties, ["command"]))
    case "session.next.shell.ended":
      return activity("bash", `done: ${firstLine(pickString(properties, ["output"]))}`)
    case "session.next.retried":
      return activity("retry", `provider retry ${properties.attempt ?? ""}: ${formatEventError(properties.error)}`)
    case "session.next.compaction.started":
      return activity("info", `compacting context (${pickString(properties, ["reason"]) || "auto"})`)
    case "session.next.compaction.delta":
      return activity("info", "compacting context…")
    case "session.next.compaction.ended":
      return activity("info", "context compaction complete")
    case "permission.asked":
      return activity("permission", `permission requested: ${pickString(properties, ["permission"])}`)
    case "permission.replied":
      return activity("permission", `permission ${pickString(properties, ["reply"])}`)
    case "todo.updated": {
      const todos = todosFromEvent(properties.todos)
      const done = todos.filter((todo) => todo.status === "completed").length
      return { type: "todos", todos, message: `todos updated (${done}/${todos.length} done)` }
    }
    case "session.diff":
      return { type: "diff", summary: diffSummaryFromEvent(properties.diff) }
    case "session.error":
      return { type: "error", error: formatEventError(properties.error) }
    default:
      if (type.startsWith("session.next.")) return activity("info", type.replace(/^session\.next\./, ""))
      return undefined
  }
}

/**
 * Extracts the verbatim model output for the live session transcript, kept
 * separate from describeSessionActivity so the summarized activity/status/feed
 * signals stay unchanged. Reasoning and response arrive as raw incremental
 * deltas (uncapped, unlike pickString), and tool calls / shell commands become
 * one-line action markers. Everything else — usage, todos, diffs, heartbeats —
 * belongs to the activity path, not the transcript.
 */
export function describeMessageChunk(payload: unknown, state?: ActivityState): ProgressMessage | undefined {
  const type = payloadType(payload)
  const properties = payloadProperties(payload)
  if (!properties) return undefined

  switch (type) {
    case "message.part.updated":
      rememberMessagePartChannel(properties, state)
      return undefined
    case "message.part.delta": {
      const text = rawString(properties.delta)
      if (!text || properties.field !== "text") return undefined
      const partID = rawString(properties.partID)
      return { channel: state?.messagePartChannels.get(partID) ?? "response", text, ...(partID ? { partID } : {}) }
    }
    // The session.next.* stream has no part IDs, so each burst is numbered here:
    // a model that emits several reasoning summaries in a row sends one
    // started/delta…/ended cycle per summary, and the counter keeps them apart.
    case "session.next.reasoning.started":
      if (state) state.reasoningPart++
      return undefined
    case "session.next.text.started":
      if (state) state.textPart++
      return undefined
    case "session.next.reasoning.delta": {
      const text = rawString(properties.delta)
      return text ? { channel: "reasoning", text, partID: `reasoning:${state?.reasoningPart ?? 0}` } : undefined
    }
    case "session.next.text.delta": {
      const text = rawString(properties.delta)
      return text ? { channel: "response", text, partID: `text:${state?.textPart ?? 0}` } : undefined
    }
    case "session.next.tool.called":
      return { channel: "tool", text: describeToolCall(properties) }
    case "session.next.shell.started": {
      const command = pickString(properties, ["command"])
      return command ? { channel: "bash", text: command } : undefined
    }
    default:
      return undefined
  }
}

function rememberMessagePartChannel(properties: Record<string, unknown>, state: ActivityState | undefined) {
  if (!state) return
  const part = properties.part
  if (!part || typeof part !== "object") return
  const candidate = part as { id?: unknown; type?: unknown }
  if (typeof candidate.id !== "string") return
  if (candidate.type === "reasoning") state.messagePartChannels.set(candidate.id, "reasoning")
  else if (candidate.type === "text") state.messagePartChannels.set(candidate.id, "response")
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : ""
}

function describeSessionStatus(value: unknown): SessionSignal | undefined {
  if (!value || typeof value !== "object") return undefined
  const status = value as { type?: unknown; attempt?: unknown; message?: unknown }
  if (status.type === "busy") return pulse("info", "provider busy")
  if (status.type === "idle") return pulse("info", "provider idle")
  if (status.type === "retry") {
    return activity("retry", `provider retry ${status.attempt ?? ""}: ${typeof status.message === "string" ? status.message : "waiting"}`)
  }
  return undefined
}

function todosFromEvent(value: unknown): ProgressTodo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const todo = item as { content?: unknown; status?: unknown }
    if (typeof todo.content !== "string") return []
    return [{ content: todo.content, status: typeof todo.status === "string" ? todo.status : "pending" }]
  })
}

function diffSummaryFromEvent(value: unknown): ProgressDiffSummary {
  if (!Array.isArray(value)) return { files: 0, additions: 0, deletions: 0 }
  let additions = 0
  let deletions = 0
  for (const item of value) {
    if (!item || typeof item !== "object") continue
    const diff = item as { additions?: unknown; deletions?: unknown }
    if (typeof diff.additions === "number") additions += diff.additions
    if (typeof diff.deletions === "number") deletions += diff.deletions
  }
  return { files: value.length, additions, deletions }
}

function formatCharCount(value: number) {
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function formatModelFromEvent(value: unknown) {
  if (!value || typeof value !== "object") return "selected model"
  const model = value as { providerID?: unknown; id?: unknown; variant?: unknown }
  const provider = typeof model.providerID === "string" ? model.providerID : "provider"
  const id = typeof model.id === "string" ? model.id : "model"
  const variant = typeof model.variant === "string" && model.variant ? `#${model.variant}` : ""
  return `${provider}/${id}${variant}`
}

function formatCost(properties: Record<string, unknown>) {
  const tokens = tokensFromValue(properties.tokens)
  const cost = typeof properties.cost === "number" ? `, $${properties.cost.toFixed(4)}` : ""
  if (!tokens) return cost
  const reasoning = tokens.reasoning ? `/${tokens.reasoning}` : ""
  return `, tokens ${tokens.input}/${tokens.output}${reasoning}${cost}`
}

function stepUsageFromEvent(payload: unknown, properties: Record<string, unknown>, model: string): ProgressStepUsage | undefined {
  const usage = usageFromRecord(properties)
  if (!usage) return undefined
  return {
    ...usage,
    stepID: payloadID(payload),
    sessionID: typeof properties.sessionID === "string" ? properties.sessionID : undefined,
    model: model || usage.model,
  }
}

// Assistant messages carry cumulative cost/tokens that opencode refreshes on
// every model round-trip, so message.updated is the live usage signal; step
// deltas only matter as fallback until the first one arrives.
function messageUsageSignal(properties: Record<string, unknown>, state: ActivityState): SessionSignal | undefined {
  const info = properties.info
  if (!info || typeof info !== "object") return undefined
  const message = info as Partial<AssistantMessage> & { role?: unknown }
  if (message.role !== "assistant" || typeof message.id !== "string") return undefined

  const tokens = tokensFromValue(message.tokens)
  const cost = typeof message.cost === "number" && Number.isFinite(message.cost) ? message.cost : 0
  // All-zero updates (message creation) must not claim the authoritative total,
  // or step-delta accounting would be suppressed with nothing to replace it.
  if (!tokens || (tokens.total === 0 && cost === 0)) return undefined
  state.messageUsage.set(message.id, { cost, tokens })

  let totalCost = 0
  let total = emptyTokens()
  for (const usage of state.messageUsage.values()) {
    totalCost += usage.cost
    total = addTokens(total, usage.tokens)
  }

  const signature = `${totalCost.toFixed(6)}:${total.input}:${total.output}:${total.reasoning}:${total.total}`
  if (signature === state.usageSignature) return undefined
  state.usageSignature = signature

  const variant = typeof message.variant === "string" && message.variant ? `#${message.variant}` : ""
  const model = message.providerID && message.modelID ? `${message.providerID}/${message.modelID}${variant}` : undefined
  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
  return { type: "usage", usage: { cost: totalCost, tokens: total, sessionID, model } }
}

function combinedAssistantUsage(infos: AssistantMessage[], sessionID: string): ProgressUsage | undefined {
  if (infos.length === 0) return undefined
  let cost = 0
  let tokens = emptyTokens()
  for (const info of infos) {
    if (typeof info.cost === "number" && Number.isFinite(info.cost)) cost += info.cost
    const messageTokens = tokensFromValue(info.tokens)
    if (!messageTokens) continue
    tokens = addTokens(tokens, messageTokens)
  }
  const last = infos[infos.length - 1]!
  const variant = last.variant ? `#${last.variant}` : ""
  const model = last.providerID && last.modelID ? `${last.providerID}/${last.modelID}${variant}` : undefined
  return { cost, tokens, sessionID, model }
}

function usageFromRecord(values: Record<string, unknown>): ProgressUsage | undefined {
  const cost = typeof values.cost === "number" && Number.isFinite(values.cost) ? values.cost : undefined
  const tokens = tokensFromValue(values.tokens)
  if (cost === undefined && !tokens) return undefined
  return { cost, tokens }
}

function payloadID(payload: unknown) {
  if (!payload || typeof payload !== "object") return undefined
  const id = (payload as { id?: unknown }).id
  return typeof id === "string" ? id : undefined
}

function formatUsageForLog(usage: ProgressUsage) {
  const cost = typeof usage.cost === "number" ? `$${usage.cost.toFixed(4)}` : "cost unavailable"
  const tokens = usage.tokens ? `tokens ${usage.tokens.input}/${usage.tokens.output}${usage.tokens.reasoning ? `/${usage.tokens.reasoning}` : ""}` : "tokens unavailable"
  const model = usage.model ? ` model ${usage.model}` : ""
  return `${cost}, ${tokens}${model}`
}

function describeToolCall(properties: Record<string, unknown>) {
  const tool = pickString(properties, ["tool"]) || "tool"
  const input = properties.input && typeof properties.input === "object" ? (properties.input as Record<string, unknown>) : {}
  const target = pickString(input, ["command", "cmd", "filePath", "path", "pattern", "query", "url", "description"])
  return target ? `${tool}: ${target}` : tool
}

function describeToolContent(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return "done"
  const text = value.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text") as { text?: unknown } | undefined
  if (typeof text?.text === "string" && text.text.trim()) return firstLine(text.text)
  const file = value.find((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "file") as { name?: unknown; uri?: unknown } | undefined
  if (typeof file?.name === "string") return file.name
  if (typeof file?.uri === "string") return file.uri
  return "done"
}

function formatEventError(value: unknown) {
  if (!value || typeof value !== "object") return String(value ?? "unknown error")
  const message = (value as { message?: unknown }).message
  if (typeof message === "string") return message
  const data = (value as { data?: unknown }).data
  if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") return (data as { message: string }).message
  return String((value as { name?: unknown; type?: unknown }).name ?? (value as { type?: unknown }).type ?? "unknown error")
}

function pickString(values: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = values[key]
    if (typeof value === "string" && value.length > 0) return truncate(value, 220)
  }
  return ""
}

function firstLine(value: string) {
  return truncate(value.split("\n").find((line) => line.trim()) ?? "done", 220)
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}

function buildPhasePrompt(workspace: Workspace, phase: AgentStep) {
  return [
    `# Pipeline phase: ${phase.name}`,
    "",
    phase.description,
    "",
    "## Run context",
    `- Run dir: ${workspace.dir}`,
    phase.readOnly
      ? `- Report: Convoy saves your report itself as ${phase.reportPath}; you do not (and cannot) write it.`
      : `- Write your final report to: ${join(workspace.dir, phase.reportPath)}`,
    "- Working directory: the directory where `convoy` was invoked (root of the target repo).",
    "",
    "## Access mode",
    phase.readOnly
      ? "This phase is read-only: Convoy gives you no write, edit, or bash tools, and that is expected — do not try to write any file, and do not apologize for or comment on being unable to. Convoy saves your report itself by concatenating the text you emit and storing it verbatim, so your visible output for this phase must be the report and nothing else: no preamble (\"I'll review…\", \"Let me write the report…\"), no step-by-step narration, and no closing note about writing. Keep any planning in your private reasoning; begin your visible output at the report's first line (e.g. the `#` heading)."
      : "This phase may edit the target repository when the phase-specific instructions call for it.",
    "",
    "## Attachments",
    "You will receive as file attachments: project context files when present, the original PRD, previous phase reports, the cumulative diff against the base branch, and any `--file` passed by the user. Read them before acting.",
    "",
    "## Project context",
    "Convoy automatically attaches these target-repo files when they exist: `.convoy/rules.md`, `AGENTS.md`, and `CLAUDE.md`.",
    "Read them before making changes. `.convoy/rules.md` is the project-specific Convoy contract unless it conflicts with Convoy runtime safety guard rails.",
    "",
    "## Closing",
    "Before finishing, make sure to:",
    phase.readOnly ? "1. Have not modified the target repository." : "1. Have applied necessary changes to the repo code.",
    phase.readOnly
      ? "2. Make the report (markdown, max ~80 lines) your entire visible output — Convoy persists it for you. Nothing before or after it."
      : "2. Have written the report (markdown, max ~80 lines) at the absolute path indicated above. If you can't write it, respond with the exact report content and Convoy will save it.",
    "3. Leave the tree in a compilable state.",
    "",
    "Follow your system prompt instructions for everything else.",
  ].join("\n")
}

export function parseModel(value: string) {
  const [providerID, ...rest] = value.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID || !isSafeModelSegment(providerID) || rest.some((segment) => !isSafeModelSegment(segment))) {
    throw new Error(`invalid model: ${value}`)
  }
  return { providerID, modelID }
}

function isSafeModelSegment(value: string) {
  return value.length > 0 && !/[\s/#\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function selectedModel(phase: AgentStep, override: string): ModelSelection {
  const { label: _label, ...model } = stepRunnerModel(phase.runner, phase.model, phase.variant, override)
  return model
}

function formatModel(model: ModelSelection) {
  const base = `${model.providerID}/${model.modelID}`
  return model.variant ? `${base}#${model.variant}` : base
}

// A fanned-out step (name "clean-code__anthropic-claude-opus-4-7") matches
// --only/--skip by its full name or by its shared stepName ("clean-code"),
// so a filter can target one variant or every variant of a fanned-out step.
export function shouldSkip(step: Step, options: Pick<RunOptions, "onlySteps" | "skipSteps">) {
  const names = step.type === "agent" ? [step.name, step.stepName] : [step.name]
  if (options.onlySteps.length > 0) return !names.some((name) => options.onlySteps.includes(name))
  return names.some((name) => options.skipSteps.includes(name))
}

// A resumed run can outlive its config: the frozen pipeline may reference a
// project agent that has since been renamed or removed. Fail before any
// session starts instead of mid-pipeline.
function ensureAgentsAvailable(pipeline: Pipeline, agents: readonly AgentSpec[]) {
  const available = new Set(agents.map((agent) => agent.name))
  for (const step of pipeline.steps) {
    if (step.type !== "agent" || available.has(step.agentName)) continue
    throw new Error(`pipeline "${pipeline.name}" needs agent "${step.agentName}", which is not defined (removed from .convoy/config.yaml?)`)
  }
}

export function progressPhases(pipeline: Pipeline, hooks?: HookSet): ProgressPhase[] {
  const steps = pipeline.steps.map((step) =>
    step.type === "agent"
      ? {
          name: step.name,
          description: step.description,
          groupId: step.groupId,
          stepName: step.stepName,
          plannedModel: stepRunnerFor(step.runner).modelLabel(step.model),
          ...(step.variant ? { plannedVariant: step.variant } : {}),
          ...(step.runner ? { runner: step.runner } : {}),
          ...(step.readOnly ? { readOnly: true } : {}),
          ...(step.resolvedAdvisor ? { plannedAdvisor: step.resolvedAdvisor.target } : step.advisor ? { plannedAdvisor: step.advisor } : {}),
          ...(step.advisorMaxCalls !== undefined ? { advisorMaxCalls: step.advisorMaxCalls } : {}),
        }
      : { name: step.name, description: step.description },
  )
  if (!hooks) return steps
  // Hooks are dashboard rows too, so their execution is watchable like any
  // step: pre-hooks ahead of the pipeline, post-hooks after it.
  const hookPhase = (stage: HookStage, specs: readonly HookSpec[]) =>
    hookPhaseNames(stage, specs).map((name, index) => ({ name, description: specs[index]!.command }))
  return [...hookPhase("pre", hooks.pre), ...steps, ...hookPhase("post", hooks.post)]
}

export function modelOverrideNotice(pipeline: Pipeline, override: string): string | undefined {
  if (!override) return undefined
  const unaffected = pipeline.steps
    .filter((step): step is AgentStep => step.type === "agent" && !stepRunnerFor(step.runner).capabilities.globalModelOverride)
    .map((step) => step.name)
  if (unaffected.length === 0) return undefined
  return `--model applies to OpenCode steps only; Claude Code steps keep their configured model: ${unaffected.join(", ")}`
}

class LoggedAttemptError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "LoggedAttemptError"
  }
}

/** Typed cancellation returned when Esc aborts an OpenCode message. */
export class SessionAbortedError extends LoggedAttemptError {
  constructor(error: { name: "MessageAbortedError"; data?: { message?: string } }) {
    super(error.data?.message || "OpenCode session message aborted", { cause: error })
    this.name = "SessionAbortedError"
  }
}

export function isMessageAbortedError(error: unknown): error is { name: "MessageAbortedError"; data?: { message?: string } } {
  return Boolean(error && typeof error === "object" && "name" in error && error.name === "MessageAbortedError")
}

function extractAssistantText(parts: Part[]) {
  return parts
    .filter((part): part is Part & { type: "text"; text: string } => part.type === "text")
    .filter((part) => !("synthetic" in part && part.synthetic) && !("ignored" in part && part.ignored))
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
}

async function summaryFromReport(path: string) {
  try {
    const content = await readFile(path, "utf8")
    for (const raw of content.split("\n")) {
      let line = raw.trim().replace(/^#+\s*/, "")
      if (!line) continue
      if (line.length > 72) line = line.slice(0, 72)
      return line
    }
  } catch {
    return "no summary"
  }
  return "no summary"
}

async function writeAttemptLog(workspace: Workspace, phase: AgentStep, attempt: number, payload: unknown) {
  const body: Record<string, unknown> = payload && typeof payload === "object" ? { ...(payload as Record<string, unknown>) } : { value: payload }
  const journaled = (await readAdvisorEvents(workspace.dir)).filter((event) => event.phase === phase.name && event.attempt === attempt)
  // The journal is authoritative, but its appends are allowed to fail without
  // blocking the phase. Merge the attempt's in-memory events (carried on the
  // attempt result for exactly this) so a failed append cannot erase advisor
  // activity from the attempt log. The aggregate's field names stay a superset
  // of the legacy `advisor` shape, so historical readers stay compatible.
  const inMemory = Array.isArray(body.advisorEvents) ? (body.advisorEvents as AdvisorEvent[]) : []
  const seen = new Set(journaled.map((event) => event.id))
  const events = [...journaled, ...inMemory.filter((event) => !seen.has(event.id) && event.phase === phase.name && event.attempt === attempt)]
  if (events.length > 0) {
    const aggregate = aggregateAdvisorEvents(events)
    body.advisor = {
      calls: aggregate.attempted,
      succeeded: aggregate.succeeded,
      failed: aggregate.failed,
      exhausted: aggregate.exhausted,
      byTrigger: aggregate.byTrigger,
      callIds: aggregate.callIds,
      cost: aggregate.cost,
      inputTokens: aggregate.tokens.input + aggregate.tokens.cacheRead + aggregate.tokens.cacheWrite,
      outputTokens: aggregate.tokens.output + aggregate.tokens.reasoning,
      tokens: aggregate.tokens,
      feedback: aggregate.feedback,
      lastAt: aggregate.lastAt,
    }
    body.advisorEvents = events
    body.costSplit = { executor: typeof body.cost === "number" ? body.cost : 0, advisor: aggregate.cost }
  }
  await writeFile(join(workspace.dir, "logs", `${phase.name}.${attempt}.json`), JSON.stringify(body, null, 2), { mode: 0o600 })
}

function advisorEventLogLine(event: AdvisorEvent): string {
  if (event.type === "advisor.requested") return `advisor requested · ${event.trigger} · ${event.budget.used}/${event.budget.max}`
  if (event.type === "advisor.completed") return `advisor completed · ${event.trigger} · ${event.latencyMs}ms${event.usage ? ` · $${event.usage.cost.toFixed(4)}` : ""}`
  if (event.type === "advisor.failed") return `advisor failed · ${event.trigger} · ${event.error.code}`
  if (event.type === "advisor.budget_exhausted") return `advisor budget exhausted · ${event.trigger}`
  if (event.type === "advisor.delivered") return `advisor delivered · ${event.trigger} · ${event.delivery}`
  return `advisor feedback · ${event.trigger} · ${event.outcome}`
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function formatSdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error && "data" in error) {
    const data = (error as { data?: unknown }).data
    if (typeof data === "object" && data && "message" in data) return String((data as { message?: unknown }).message)
  }
  if (typeof error === "object" && error && "name" in error) return String((error as { name?: unknown }).name)
  return String(error)
}
