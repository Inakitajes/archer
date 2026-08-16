import { stdout } from "node:process"

import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import { getSessionEventHub } from "./event-hub"
import { log } from "./log"
import { noopProgress, type AutoAccept, type PermissionPromptInfo, type PermissionReply, type ProgressUI } from "./progress"
import { explainCommand, judgeCommand } from "./safety-judge"
import { createTerminalInput, type TerminalInput } from "./terminal-input"

type PermissionRequest = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: { messageID: string; callID: string }
}

type Reply = PermissionReply

export type PermissionGate = {
  stop(): Promise<void>
  /**
   * While a session is paused, its permission requests are left for whoever owns
   * the terminal (e.g. an interactive OpenCode TUI the user opened with [o]).
   * Structural bash-checkpoint decisions still run: pausing must not make a
   * read-only verify session's hard refusal human-approvable.
   * Sibling sessions in the same `models:`/`parallel` batch keep being handled,
   * so a failed step's recovery can never deadlock a live sibling's prompts.
   *
   * Omit `sessionID` to pause every session (the solo human-review gate, which
   * never shares a batch with live siblings).
   */
  pause(sessionID?: string): void
  resume(sessionID?: string): void
}

/**
 * What the advisor checkpoint wants done with an `edit` request.
 *
 * - `advise`: this is the phase's first write and it hasn't consulted yet.
 *   Reject carrying the advice, which the executor reads mid-turn and retries on.
 * - `allow`: an advised phase that already consulted. Allowed immediately, never
 *   escalated — advised agents run with `edit: "ask"` purely so this hook can
 *   see the first write, so without this branch every later edit would start
 *   prompting a human that today is never asked.
 * - `defer`: not the checkpoint's business; handle as normal.
 */
export type AdvisorGateDecision = { action: "advise"; message: string } | { action: "allow" } | { action: "defer" }

export type AdvisorCheckpoint = (request: { sessionID: string; permission: string; summary: string }) => Promise<AdvisorGateDecision>

/**
 * What the bash checkpoint wants done with a `bash` request that reached the
 * gate (i.e. was not allowlisted by the agent's policy).
 *
 * - `reject`: the request must be refused, carrying an informative message the
 *   executor reads instead of a generic denial. This is the deny-informativo
 *   for read-only verify phases: the model learns the design ("scope already
 *   ran the checks") and stops retrying variants that would trip the loop guard.
 * - `allow`: grant the single call immediately, without prompting.
 * - `defer`: not the checkpoint's business; handle as normal (prompt/auto-accept).
 */
export type BashGateDecision = { action: "allow" } | { action: "reject"; message: string } | { action: "defer" }

export type BashCheckpoint = (request: { sessionID: string; permission: string; summary: string }) => Promise<BashGateDecision>

/**
 * The single, reusable refusal for commands a read-only verify phase may not
 * run. Kept as one string so the runner, the tests, and any future watcher
 * (see the PRD's follow-up) all say exactly the same thing.
 */
export const readOnlyBashRefusalMessage =
  "Command refused: this is a read-only audit phase. Only read-only check commands are permitted, and the scope step already ran them — the outputs are in the scope report's Checks section. Do not retry this command or variants; cite that evidence or reason statically."

export type StartGateOptions = {
  client: OpencodeClient
  progress?: ProgressUI
  interactive: boolean
  directory: string
  /** When enabled, ask-level requests are auto-allowed ("once") instead of prompting. */
  autoAccept?: AutoAccept
  /** Model used by the smart auto-accept judge; required for "smart" mode to do anything. */
  judgeModel?: { providerID: string; modelID: string }
  /**
   * Consulted for `edit` requests before anything else, including --yolo. It is
   * not a safety decision, so auto-accept must not skip it: the point of the
   * checkpoint is that the first write of a phase is preceded by a consultation,
   * which is what makes the advisor reliable rather than a matter of judgement.
   */
  advisorCheckpoint?: AdvisorCheckpoint
  /**
   * Consulted for `bash` requests after the advisor checkpoint and before
   * auto-accept, including --yolo — the same structural guarantee as the
   * advisor checkpoint. For read-only verify phases it refuses commands the
   * read-only policy left to "ask" with an informative message (see
   * readOnlyBashRefusalMessage); for every other phase it defers, so the
   * normal prompt/auto-accept handling is unchanged.
   */
  bashCheckpoint?: BashCheckpoint
  /** Serializes terminal input with the phase gate so a --no-tui parallel run never opens two readlines on stdin. */
  terminalInput?: TerminalInput
  /** The opencode server URL for [i] inspect to attach to. Absent in readline fallback on non-macOS. */
  serverUrl?: string
}

export function startPermissionGate(options: StartGateOptions): PermissionGate {
  const progress = options.progress ?? noopProgress
  const controller = new AbortController()
  const handled = new Set<string>()
  const queue = serialQueue()
  // Session-scoped pause: only the session an interactive TUI owns is left for
  // that owner. A directory-wide flag would also drop the prompts of live
  // siblings in the same parallel batch, deadlocking them waiting for replies
  // Convoy would never send. `pausedAll` covers the solo human-review gate,
  // which never shares a batch with concurrent siblings.
  const pausedSessions = new Set<string>()
  let pausedAll = false
  const terminalInput = options.terminalInput ?? createTerminalInput()

  // permission.asked is delivered on the directory-scoped event bus, so we share
  // the run's single subscription for that directory (see event-hub) instead of
  // opening a second one just for the gate. onAny sees every event regardless of
  // session, which is what a permission request — not tied to one phase — needs.
  const hub = getSessionEventHub(options.client, options.directory)
  const unsubscribe = hub.onAny((payload) => {
    if (controller.signal.aborted) return
    if (!isPermissionAsked(payload)) return
    const request = payload.properties
    if (handled.has(request.id)) return
    if (pausedAll || pausedSessions.has(request.sessionID)) {
      // Interactive takeover owns ordinary prompts, but it must not bypass the
      // structural checkpoint that enforces read-only verify bash refusals.
      // A deferred decision is deliberately left unanswered for the owner.
      const checkpoint = options.bashCheckpoint
      if (!checkpoint || request.permission !== "bash") return
      handled.add(request.id)
      queue(async () => {
        const answered = await applyBashCheckpoint(options.client, request, progress, options.directory, checkpoint)
        // Deferred requests still belong to the interactive owner. Preserve the
        // old paused-session behavior if the event is replayed after resume.
        if (!answered) handled.delete(request.id)
      })
      return
    }
    handled.add(request.id)
    queue(() =>
      handleRequest(options.client, request, options.interactive, progress, options.directory, options.autoAccept, options.judgeModel, controller.signal, options.advisorCheckpoint, terminalInput, options.serverUrl, options.bashCheckpoint),
    )
  })

  return {
    async stop() {
      unsubscribe()
      controller.abort(new Error("permission gate stopped"))
    },
    pause(sessionID) {
      if (sessionID) pausedSessions.add(sessionID)
      else pausedAll = true
    },
    resume(sessionID) {
      if (sessionID) pausedSessions.delete(sessionID)
      else pausedAll = false
    },
  }
}

function isPermissionAsked(payload: unknown): payload is { type: "permission.asked"; properties: PermissionRequest } {
  if (!payload || typeof payload !== "object") return false
  const type = (payload as { type?: unknown }).type
  if (type !== "permission.asked") return false
  const properties = (payload as { properties?: unknown }).properties
  return Boolean(properties && typeof properties === "object" && "id" in properties)
}

async function handleRequest(
  client: OpencodeClient,
  request: PermissionRequest,
  interactive: boolean,
  progress: ProgressUI,
  directory: string,
  autoAccept?: AutoAccept,
  judgeModel?: { providerID: string; modelID: string },
  signal?: AbortSignal,
  advisorCheckpoint?: AdvisorCheckpoint,
  terminalInput: TerminalInput = createTerminalInput(),
  serverUrl?: string,
  bashCheckpoint?: BashCheckpoint,
) {
  const summary = describeRequest(request)

  // Before every other branch, including --yolo: the checkpoint is structural,
  // not a safety judgement, and skipping it would turn "the first write is
  // preceded by a consultation" back into something the model decides.
  if (advisorCheckpoint && request.permission === "edit") {
    const decision = await advisorCheckpoint({ sessionID: request.sessionID, permission: request.permission, summary })
    if (decision.action === "advise") {
      log.info(`[permission] advisor checkpoint held the first write: ${summary}`)
      progress.message(`advisor consulted before first write: ${summary}`)
      await reply(client, request.id, directory, "reject", decision.message)
      return
    }
    if (decision.action === "allow") {
      await reply(client, request.id, directory, "once")
      return
    }
  }

  // The bash checkpoint answers commands a read-only verify phase may not run.
  // Same placement as the advisor checkpoint — before auto-accept — because
  // the deny-informativo is structural, not a judgement: --yolo must not let a
  // refused command through, or the model learns it can just retry. Allowlisted
  // checks never reach the gate, so this only sees commands the read-only
  // policy left to "ask".
  if (bashCheckpoint && request.permission === "bash") {
    if (await applyBashCheckpoint(client, request, progress, directory, bashCheckpoint, summary)) return
  }

  // Read at handling time, not subscription time: the TUI flips this live.
  // Opencode's denylist already rejected anything hard-denied, so whatever
  // reaches here is exactly the "ask" bucket auto-accept is meant to cover.
  if (autoAccept?.mode === "all") {
    log.info(`[permission] auto-allowed (auto-accept on): ${summary}`)
    progress.message(`auto-allowed: ${summary}`)
    await reply(client, request.id, directory, "once")
    return
  }

  // Smart mode delegates the call to an AI judge running outside the agentic
  // loop. A "safe" verdict auto-allows; anything else (incl. judge failure,
  // which is fail-closed) drops through to the normal human prompt below.
  let judgeReason: string | undefined
  let verdictReason: string | undefined
  if (autoAccept?.mode === "smart" && judgeModel) {
    progress.message(`evaluating safety: ${summary}`)
    const verdict = await judgeCommand(client, { request: promptInfo(request), model: judgeModel, directory, signal })
    if (verdict.safe) {
      log.info(`[permission] smart-allowed: ${summary} — ${verdict.reason}`)
      progress.message(`smart-allowed: ${summary} — ${verdict.reason}`)
      await reply(client, request.id, directory, "once")
      return
    }
    log.info(`[permission] smart auto-accept escalating to user: ${summary} — ${verdict.reason}`)
    judgeReason = `flagged by safety judge: ${verdict.reason}`
    verdictReason = verdict.reason
  }

  if (!interactive) {
    log.warn(`[permission] auto-rejecting ${request.permission} (no TTY): ${summary}`)
    await reply(client, request.id, directory, "reject", "Convoy rejected: non-interactive run")
    return
  }

  // The TUI resolves the prompt in-place; suspending to readline is only the
  // plain-logs fallback so the run never drops to a bare black screen. That
  // fallback goes through the shared terminal-input arbiter so it can never
  // race a phase-gate readline for the same stdin in a --no-tui parallel run.
  const ask = progress.askPermission?.bind(progress)
  if (ask) {
    const answer = await ask(promptInfoForUser(request, judgeReason, verdictReason, judgeModel, client, directory, signal))
    log.info(`[permission] replied ${answer} for ${request.permission}`)
    await reply(client, request.id, directory, answer, answer === "reject" ? "rejected by user" : undefined)
    return
  }

  const answer = await terminalInput.withInput(async (prompt) => {
    progress.suspend()
    try {
      log.section("permission request")
      stdout.write(formatRequest(request, judgeReason))
      for (;;) {
        const raw = (await prompt.ask("approve? [o]nce, [a]lways, [r]eject, [e]xplain, [i]nspect > ")).trim().toLowerCase()
        if (raw === "o" || raw === "once" || raw === "y" || raw === "yes") return "once" as Reply
        if (raw === "a" || raw === "always") return "always" as Reply
        if (raw === "r" || raw === "reject" || raw === "n" || raw === "no") return "reject" as Reply
        if (raw === "e" || raw === "explain") {
          if (judgeModel) {
            const explanation = await explainCommand(client, {
              request: promptInfo(request),
              model: judgeModel,
              directory,
              signal: AbortSignal.any([signal ?? new AbortController().signal, new AbortController().signal]),
              verdictReason,
            })
            stdout.write(`\n${explanation}\n\n`)
          } else {
            stdout.write("\nno safety judge configured to explain this\n\n")
          }
          continue
        }
        if (raw === "i" || raw === "inspect") {
          if (serverUrl && request.sessionID) {
            try {
              const { openOpencodeSessionWindow } = await import("./opencode")
              const backend = await openOpencodeSessionWindow({ url: serverUrl, targetDir: directory, sessionID: request.sessionID })
              stdout.write(`\nopened session in ${backend}\n\n`)
            } catch (error) {
              stdout.write(`\ncouldn't open session: ${error instanceof Error ? error.message : String(error)}\n\n`)
            }
          } else if (!serverUrl) {
            stdout.write("\nno live opencode server to attach to\n\n")
          } else {
            stdout.write("\nthis request has no session to inspect\n\n")
          }
          continue
        }
        stdout.write("Choose o, a, r, e, or i.\n")
      }
    } finally {
      progress.resume()
    }
  })
  log.info(`[permission] replied ${answer} for ${request.permission}`)
  await reply(client, request.id, directory, answer, answer === "reject" ? "rejected by user" : undefined)
}

/** Applies only the structural bash checkpoint; false leaves normal ownership unchanged. */
async function applyBashCheckpoint(
  client: OpencodeClient,
  request: PermissionRequest,
  progress: ProgressUI,
  directory: string,
  checkpoint: BashCheckpoint,
  summary = describeRequest(request),
): Promise<boolean> {
  const decision = await checkpoint({ sessionID: request.sessionID, permission: request.permission, summary })
  if (decision.action === "reject") {
    log.info(`[permission] read-only verify phase refused bash: ${summary}`)
    progress.message(`command refused (read-only verify phase): ${summary}`)
    await reply(client, request.id, directory, "reject", decision.message)
    return true
  }
  if (decision.action === "allow") {
    log.info(`[permission] bash checkpoint allowed: ${summary}`)
    await reply(client, request.id, directory, "once")
    return true
  }
  return false
}

function promptInfo(request: PermissionRequest, judgeReason?: string): PermissionPromptInfo {
  return {
    id: request.id,
    permission: request.permission,
    patterns: request.patterns.slice(0, 5),
    command: pickString(request.metadata, ["command", "cmd"]) || undefined,
    target: pickString(request.metadata, ["path", "file", "url"]) || undefined,
    description: pickString(request.metadata, ["description"]) || undefined,
    sessionID: request.sessionID,
    ...(judgeReason ? { judgeReason } : {}),
  }
}

/**
 * Builds the `PermissionPromptInfo` for the user-facing prompt (TUI or readline).
 * This is the same as `promptInfo` but adds the `explain` callback when a judge
 * model is available. `promptInfo` itself stays free of callbacks because it is
 * also the `JudgeRequest` that feeds `judgeCommand`.
 */
function promptInfoForUser(
  request: PermissionRequest,
  judgeReason?: string,
  verdictReason?: string,
  judgeModel?: { providerID: string; modelID: string },
  client?: OpencodeClient,
  directory?: string,
  signal?: AbortSignal,
): PermissionPromptInfo {
  const info = promptInfo(request, judgeReason)
  if (judgeModel && client && directory) {
    info.explain = (explainSignal?: AbortSignal) => {
      const combined = signal && explainSignal ? AbortSignal.any([signal, explainSignal]) : (signal ?? explainSignal)
      return explainCommand(client, {
        request: promptInfo(request),
        model: judgeModel,
        directory,
        signal: combined,
        verdictReason,
      })
    }
  }
  return info
}

async function reply(client: OpencodeClient, requestID: string, directory: string, choice: Reply, message?: string) {
  // The reply must carry the same directory scope as the session that asked,
  // or a server hosting multiple instances routes it to the wrong one.
  const result = await client.permission.reply({ requestID, directory, reply: choice, ...(message ? { message } : {}) })
  if (result.error) log.warn(`[permission] reply error for ${requestID}: ${String((result.error as { message?: unknown }).message ?? result.error)}`)
}

function describeRequest(request: PermissionRequest) {
  const command = pickString(request.metadata, ["command", "cmd", "path", "url", "file"])
  if (command) return `${request.permission}: ${truncate(command, 200)}`
  if (request.patterns.length > 0) return `${request.permission}: ${request.patterns.slice(0, 3).join(", ")}`
  return request.permission
}

function formatRequest(request: PermissionRequest, judgeReason?: string) {
  const lines: string[] = [""]
  if (judgeReason) lines.push(`⚠ ${judgeReason}`)
  lines.push(`category: ${request.permission}`)
  if (request.tool) lines.push(`tool call: ${request.tool.callID}`)
  lines.push(`session: ${request.sessionID}`)
  if (request.patterns.length > 0) lines.push(`patterns: ${request.patterns.slice(0, 5).join(", ")}`)
  const command = pickString(request.metadata, ["command", "cmd"])
  if (command) lines.push(`command: ${truncate(command, 400)}`)
  const path = pickString(request.metadata, ["path", "file", "url"])
  if (path) lines.push(`target: ${truncate(path, 400)}`)
  const description = pickString(request.metadata, ["description"])
  if (description) lines.push(`note: ${truncate(description, 240)}`)
  lines.push("")
  return `${lines.join("\n")}\n`
}

function pickString(metadata: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  return ""
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…`
}

function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve()
  return (job: () => Promise<unknown>) => {
    tail = tail.then(job, job)
  }
}
