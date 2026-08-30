import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { Readable } from "node:stream"

import { archiveChangeOnMain, runClose, type CloseEvent, type CloseInput, type CloseMessageProposal, type CloseResult, type CloseStep } from "./feature-close"
import { editMessageInEditor } from "./finish"
import { branchUpstream, execFile, mainWorktreeDir, pushRefspec, removeWorktree } from "./git"
import { log } from "./log"

/**
 * The `convoy close` command surface. One close sequence, two renderers
 * (design D3/D6): in a TTY the sequence renders as a live checklist with the
 * composed message confirmed before it lands and deliberate follow-up offers;
 * headless, the same event stream prints as a factual stdout summary whose
 * follow-up commands are executable and safe, and nothing interactive is
 * attempted.
 */

export type CloseOptions = {
  targetDir: string
  /** Finish a feature worktree by branch instead of the current directory. */
  branch?: string
  /** The worktree directory, when the caller (the board) already resolved it. */
  worktreeDir?: string
  changeID?: string
  /** Continue a stopped sequence from the first incomplete step. */
  resume?: boolean
  message?: string
  /** Print what would happen's inputs and exit without touching the repo. */
  dryRun?: boolean
  help?: boolean
}

export async function runCloseCommand(options: CloseOptions): Promise<void> {
  if (options.dryRun) {
    stdout.write(`close would run: preflight → sync → archive → squash → merge${options.resume ? " (resuming)" : ""}\n`)
    return
  }
  const input: CloseInput = {
    targetDir: options.targetDir,
    ...(options.worktreeDir ? { worktreeDir: resolve(options.worktreeDir) } : {}),
    ...(options.branch ? { branch: options.branch } : {}),
    ...(options.changeID ? { changeID: options.changeID } : {}),
    ...(options.resume ? { resume: true } : {}),
    ...(options.message ? { message: options.message } : {}),
  }
  // The board's close-change handoff lands here too: a TTY gets the checklist,
  // a pipe gets the stdout summary — one dispatcher, no second call site.
  if (closeSurface() === "tty") await runCloseInteractive(input)
  else await runCloseHeadless(input)
}

/** Which renderer the command surface uses; a seam so mode selection stays testable. */
export function closeSurface(interactive: boolean = interactiveTerminal()): "tty" | "headless" {
  return interactive ? "tty" : "headless"
}

function interactiveTerminal(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

// ---------------------------------------------------------------------------
// Headless: the event stream printed as a factual stdout summary
// ---------------------------------------------------------------------------

export async function runCloseHeadless(input: CloseInput): Promise<void> {
  const events: CloseEvent[] = []
  let result: CloseResult | undefined
  let failure: string | undefined
  try {
    result = await runClose({ ...input, onEvent: (event) => events.push(event) })
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
  }
  if (result) {
    const followUps = await resolveCloseFollowUps({
      targetDir: input.targetDir,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
    })
    stdout.write(formatCloseEvents(events, { followUps }))
    return
  }
  stdout.write(formatCloseEvents(events, { failure }))
  log.error(failure ?? "close failed")
}

/**
 * The headless formatter over the close event stream (task 3.1): per-step
 * final states, the merge shape, and — on success — the follow-up commands in
 * safe execution order (push, worktree removal, branch deletion). Push prints
 * its explicit remote and refspec, or a remediation when no upstream exists —
 * never an invalid bare `git push main`.
 */
export function formatCloseEvents(events: readonly CloseEvent[], extra: { followUps?: CloseFollowUps; failure?: string } = {}): string {
  const lines: string[] = []
  const stepState = new Map<CloseStep, string>()

  for (const event of events) {
    switch (event.type) {
      case "preflight":
        lines.push(`preflight: ${event.summary}`)
        break
      case "preflight-failed":
        lines.push("preflight failed:")
        for (const blocker of event.blockers) lines.push(`  ${blocker.message}`)
        break
      case "step-started":
        break
      case "step-completed":
        stepState.set(event.step, event.detail ? `${event.step}: ${event.detail}` : `${event.step}: completed`)
        break
      case "step-skipped":
        stepState.set(event.step, `${event.step}: skipped — ${event.reason}`)
        break
      case "step-failed":
        stepState.set(event.step, `${event.step}: failed — ${firstLine(event.message)}`)
        break
      case "merge-shape":
        break
      case "result":
        lines.push(...stepState.values())
        lines.push(`closed ${event.result.changeID}: ${event.result.branch} → ${event.result.baseRef}`)
        if (extra.followUps) lines.push(...formatCloseFollowUps(extra.followUps))
        break
    }
  }
  // A stop never reaches the result event: the per-step states carry the story.
  if (!events.some((event) => event.type === "result")) lines.push(...stepState.values())
  if (extra.failure) lines.push(firstLine(extra.failure))
  return `${lines.join("\n")}\n`
}

/** The follow-up cleanup, resolved from git state (design D7). */
export type CloseFollowUps = {
  /** Present only when the base branch has a configured upstream. */
  push?: { remote: string; refspec: string; command: string }
  /** The concrete setup step when push is unavailable; never an invalid push command. */
  pushRemediation?: string
  /** The worktree-removal command, present while the worktree still exists. */
  worktreeRemoval?: string
  branchDelete?: string
}

/**
 * Resolves what cleanup is even possible: the base branch's configured
 * upstream becomes an explicit push refspec; a worktree that still exists and
 * isn't the main checkout gets a removal command; branch deletion follows the
 * worktree's dependency.
 */
export async function resolveCloseFollowUps(args: {
  targetDir: string
  baseRef: string
  branch: string
  worktreeDir: string
}): Promise<CloseFollowUps> {
  const mainDir = (await mainWorktreeDir(args.targetDir).catch(() => undefined)) ?? args.targetDir

  let push: CloseFollowUps["push"]
  let pushRemediation: string | undefined
  const upstream = await branchUpstream(args.baseRef, mainDir).catch(() => undefined)
  const [remote, ...remoteRest] = (upstream ?? "").split("/")
  const remoteBranch = remoteRest.join("/")
  if (remote && remoteBranch) {
    push = { remote, refspec: `${args.baseRef}:${remoteBranch}`, command: `git push ${remote} ${args.baseRef}:${remoteBranch}` }
  } else {
    pushRemediation = `${args.baseRef} has no configured upstream — set one first: git branch --set-upstream-to=<remote>/<branch> ${args.baseRef}`
  }

  let worktreeRemoval: string | undefined
  const isMainCheckout = (await sameDir(mainDir, args.worktreeDir)) === true
  const worktreeExists = await stat(args.worktreeDir).then(
    () => true,
    () => false,
  )
  if (!isMainCheckout && worktreeExists) worktreeRemoval = `git worktree remove ${args.worktreeDir}`

  return {
    ...(push ? { push } : {}),
    ...(pushRemediation ? { pushRemediation } : {}),
    ...(worktreeRemoval ? { worktreeRemoval } : {}),
    branchDelete: `git branch -d ${args.branch}`,
  }
}

/** The printed follow-up block, in the order a safe execution would run. */
export function formatCloseFollowUps(followUps: CloseFollowUps): string[] {
  const lines = ["", "optional follow-ups (never automatic):"]
  if (followUps.push) lines.push(`  ${followUps.push.command}`)
  else if (followUps.pushRemediation) lines.push(`  push unavailable — ${followUps.pushRemediation}`)
  if (followUps.worktreeRemoval) lines.push(`  ${followUps.worktreeRemoval}`)
  if (followUps.branchDelete) lines.push(`  ${followUps.branchDelete}`)
  return lines
}

// ---------------------------------------------------------------------------
// TTY: the live checklist, the message gate, and the deliberate cleanups
// ---------------------------------------------------------------------------

export async function runCloseInteractive(input: CloseInput, io: CloseIO = {}): Promise<void> {
  const renderer = createCloseChecklistRenderer(frameWrite(io))
  try {
    const result = await runClose({
      ...input,
      onEvent: (event) => renderer.onEvent(event),
      resolveMessage: (proposal) => confirmCloseMessage(proposal, { renderer, ...io }),
    })
    const followUps = await resolveCloseFollowUps({
      targetDir: input.targetDir,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
    })
    await offerCloseFollowUps({ ...followUps, baseRef: result.baseRef, branch: result.branch, worktreeDir: result.worktreeDir, targetDir: input.targetDir }, io)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
    // The checklist keeps its final frame (the failed step and its
    // remediation stay visible); the full stop message goes below it.
    renderer.break()
    frameWrite(io)("\n")
    log.error(message)
  }
}

// -- checklist ----------------------------------------------------------------

export type CloseChecklistRowStatus = "pending" | "running" | "completed" | "skipped" | "failed"

export type CloseChecklistRow = {
  step: CloseStep
  status: CloseChecklistRowStatus
  detail?: string
}

export type CloseChecklistState = {
  preflight?: string
  preflightFailed?: readonly string[]
  rows: readonly CloseChecklistRow[]
  /** The failed step's stop message; the failed row already carries its first line. */
  failed?: string
  result?: CloseResult
}

const closeSteps: readonly CloseStep[] = ["sync", "archive", "squash", "merge"]

export function initialCloseChecklistState(): CloseChecklistState {
  return { rows: closeSteps.map((step) => ({ step, status: "pending" as const })) }
}

/** The pure reducer from close events to checklist state — one source of narration. */
export function applyCloseEvent(state: CloseChecklistState, event: CloseEvent): CloseChecklistState {
  const withRow = (step: CloseStep, update: Partial<CloseChecklistRow>): CloseChecklistState => ({
    ...state,
    rows: state.rows.map((row) => (row.step === step ? { ...row, ...update, detail: update.detail ?? (update.status === "running" ? undefined : row.detail) } : row)),
  })
  switch (event.type) {
    case "preflight":
      return { ...state, preflight: event.summary }
    case "preflight-failed":
      return { ...state, preflightFailed: event.blockers.map((blocker) => blocker.message) }
    case "step-started":
      return withRow(event.step, { status: "running" })
    case "step-completed":
      return withRow(event.step, { status: "completed", detail: event.detail })
    case "step-skipped":
      return withRow(event.step, { status: "skipped", detail: event.reason })
    case "step-failed": {
      const line = firstLine(event.message)
      const prefix = `${event.step}: `
      const detail = line.startsWith(prefix) ? line.slice(prefix.length) : line
      return { ...withRow(event.step, { status: "failed", detail }), failed: event.message }
    }
    case "merge-shape":
      // The merge row's completed detail already narrates the shape.
      return state
    case "result":
      return { ...state, result: event.result }
  }
}

/** The pure frame renderer — the same lines the live driver rewrites in place. */
export function renderCloseChecklist(state: CloseChecklistState): string[] {
  const lines: string[] = []
  if (state.preflightFailed) {
    lines.push("close preflight failed:")
    for (const message of state.preflightFailed) lines.push(`  ${message}`)
    return lines
  }
  if (state.preflight) lines.push(`preflight: ${state.preflight}`)
  for (const row of state.rows) {
    if (row.status === "pending") {
      lines.push(`  ○ ${row.step}`)
    } else if (row.status === "running") {
      lines.push(`  ▸ ${row.step}…`)
    } else if (row.status === "completed") {
      lines.push(`  ✓ ${row.step}${row.detail ? ` — ${row.detail}` : ""}`)
    } else if (row.status === "skipped") {
      lines.push(`  ⊘ ${row.step} — skipped: ${row.detail}`)
    } else {
      lines.push(`  ✗ ${row.step}${row.detail ? ` — ${row.detail}` : ""}`)
    }
  }
  if (state.result) {
    lines.push("")
    lines.push(`closed ${state.result.changeID}: ${state.result.branch} → ${state.result.baseRef}`)
  }
  return lines
}

/**
 * The live driver: rewrites the frame in place with cursor-up + clear. A
 * `break()` releases the frame (before a prompt or an editor takes the
 * terminal); the next event prints a fresh frame below instead of rewriting.
 */
export function createCloseChecklistRenderer(write: (text: string) => void = (text) => stdout.write(text)) {
  let state = initialCloseChecklistState()
  let drawn = 0
  const redraw = () => {
    const frame = renderCloseChecklist(state)
    if (drawn > 0) write(`\x1b[${drawn}A\x1b[J`)
    for (const line of frame) write(`${line}\n`)
    drawn = frame.length
  }
  return {
    onEvent(event: CloseEvent) {
      state = applyCloseEvent(state, event)
      redraw()
    },
    break() {
      drawn = 0
    },
    state: () => state,
  }
}

// -- message gate ---------------------------------------------------------------

/** Injectable terminal I/O, so the interactive surfaces stay key-driver testable. */
export type CloseIO = {
  input?: Readable
  output?: {
    write(text: string): unknown
  }
}

const frameWrite = (io: CloseIO) => (text: string) => (io.output ?? stdout).write(text)

/**
 * The TTY side of the resolver gate (design D4): show the composed message,
 * accept or edit. Edit delegates verbatim to `editMessageInEditor` — the same
 * GIT_EDITOR/VISUAL/EDITOR resolution and comment stripping `finish` uses. An
 * emptied editor or a declined prompt returns undefined, which stops the
 * sequence before the squash lands; nothing commits before the choice.
 */
export async function confirmCloseMessage(
  proposal: CloseMessageProposal,
  deps: { renderer?: ReturnType<typeof createCloseChecklistRenderer> } & CloseIO = {},
): Promise<string | undefined> {
  deps.renderer?.break()
  const out = deps.output ?? stdout
  for (;;) {
    out.write("\n")
    if (proposal.error) out.write("(the writing model failed, so this message is derived from the proposal and the step commits)\n")
    out.write(`${indent(proposal.message)}\n\n`)
    const answer = await ask("Commit with this message? [y/e/N] ", deps)
    if (answer === "y") return proposal.message
    if (answer === "e") {
      const edited = await editMessageInEditor(proposal.message)
      if (!edited) {
        out.write("editor cancelled — nothing has landed\n")
        continue
      }
      return edited.body.length === 0 ? edited.subject : `${edited.subject}\n\n${edited.body.map((line) => `- ${line}`).join("\n")}`
    }
    return undefined
  }
}

// -- follow-up offers -------------------------------------------------------------

type FollowUpOffers = CloseFollowUps & { baseRef: string; branch: string; worktreeDir: string; targetDir: string }

/**
 * Cleanup follows git's dependency graph (design D7): push is independent;
 * worktree removal must succeed before branch deletion is offered. Every
 * action is a deliberate choice, a failure keeps the action available for
 * retry, and nothing runs without an explicit yes.
 */
export async function offerCloseFollowUps(followUps: FollowUpOffers, io: CloseIO = {}): Promise<void> {
  const out = io.output ?? stdout
  out.write("\n")
  const mainDir = (await mainWorktreeDir(followUps.targetDir).catch(() => undefined)) ?? followUps.targetDir

  if (followUps.push) {
    const accepted = await offerAction(
      "push",
      `Push ${followUps.baseRef} to ${followUps.push.remote} (${followUps.push.refspec})? [y/N] `,
      () => pushRefspec(followUps.push!.remote, followUps.push!.refspec, mainDir),
      io,
    )
    if (!accepted) out.write(`next: ${followUps.push.command}\n`)
  } else if (followUps.pushRemediation) {
    out.write(`push unavailable — ${followUps.pushRemediation}\n`)
  }

  let worktreeRemoved = false
  if (followUps.worktreeRemoval) {
    if (processCwdInside(followUps.worktreeDir)) {
      out.write(`to remove the worktree once you're out of it: ${followUps.worktreeRemoval}\n`)
    } else {
      worktreeRemoved = await offerAction(
        "worktree removal",
        `Remove the worktree at ${followUps.worktreeDir}? [y/N] `,
        () => removeWorktree(followUps.worktreeDir, mainDir),
        io,
      )
      if (worktreeRemoved) out.write("worktree removed\n")
      else out.write(`next: ${followUps.worktreeRemoval}\n`)
    }
  }

  // git refuses to delete a branch that is checked out in a worktree, so the
  // offer only exists once that dependency cleared.
  if (worktreeRemoved) {
    const deleted = await offerAction(
      "branch deletion",
      `Delete the branch ${followUps.branch}? [y/N] `,
      async () => {
        const result = await execFile("git", ["branch", "-d", followUps.branch], { cwd: mainDir, allowFailure: true })
        if (result.exitCode !== 0) throw new Error(result.stderr || `git branch -d ${followUps.branch} failed`)
      },
      io,
    )
    if (deleted) out.write(`branch ${followUps.branch} deleted\n`)
    else out.write(`next: ${followUps.branchDelete}\n`)
  } else if (!processCwdInside(followUps.worktreeDir)) {
    out.write(`next (after the worktree is removed): ${followUps.branchDelete}\n`)
  }
}

/** One deliberate action with retry: a failure keeps the offer alive; N prints the command instead. */
async function offerAction(label: string, question: string, action: () => Promise<void>, io: CloseIO): Promise<boolean> {
  for (;;) {
    if ((await ask(question, io)) !== "y") return false
    try {
      await action()
      return true
    } catch (error) {
      log.warn(`${label} failed: ${error instanceof Error ? error.message : String(error)} — answer y to retry, N to skip`)
    }
  }
}

/** Removing the directory the process sits in leaves the shell nowhere; print the command instead. */
function processCwdInside(dir: string): boolean {
  const cwd = resolve(process.cwd())
  const target = resolve(dir)
  return cwd === target || cwd.startsWith(`${target}/`)
}

/**
 * Single-key confirmation in the style of `finish`'s prompt, including its
 * raw-mode SIGINT handling and its EOF-must-resolve rule: a stdin that closes
 * (a pipe, a closed terminal) resolves rather than leaving the close hanging.
 */
async function ask(question: string, io: CloseIO = {}): Promise<string> {
  // Bun's readline types only accept the exact process streams; the injectable
  // I/O is structurally compatible, so the cast stays at this one boundary.
  const prompt = createInterface({ input: (io.input ?? stdin) as typeof stdin, output: (io.output ?? stdout) as typeof stdout })
  const controller = new AbortController()
  let interrupted = false
  prompt.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  const closed = new Promise<string>((resolvePromise) => prompt.once("close", () => resolvePromise("")))
  try {
    const answer = await Promise.race([prompt.question(question, { signal: controller.signal }), closed])
    return answer.trim().toLowerCase()
  } catch (error) {
    if (interrupted && error instanceof Error && error.name === "AbortError") {
      ;(io.output ?? stdout).write("\n")
      return ""
    }
    throw error
  } finally {
    prompt.close()
  }
}

// ---------------------------------------------------------------------------

/** Archive-on-main for probably-merged changes, routed from the board. */
export async function runArchiveOnMain(input: { targetDir: string; changeID: string }): Promise<void> {
  try {
    const result = await archiveChangeOnMain(input)
    stdout.write(
      result.committed
        ? `archived ${input.changeID} in the main checkout and committed on the base branch\n`
        : `openspec archived ${input.changeID} with nothing to commit\n`,
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(message)
    process.exitCode = 1
  }
}

export function closeHelp(): string {
  return `convoy close

Close a feature in one resumable sequence: preflight, sync the base branch
into the feature branch, archive the change through the OpenSpec CLI, squash
convoy's commits into one conventional commit (your identity, your signature),
and merge the feature branch into the base branch from the main checkout.

In a terminal the sequence renders as a live checklist — each step's
completion, skip (with reason), or failure visible as it happens, and the
merge's shape (fast-forward or merge commit) narrated. The squashed commit's
message is composed from the change's proposal and touched capabilities, with
a deterministic fallback when no model answers; the scope is always the single
touched capability, and the change id is named in the body. You confirm or
edit the message before it lands.

Once merged, push, worktree removal, and branch deletion are offered as
separate, deliberate actions — never automatic. Push names the configured
remote and refspec explicitly, and is unavailable (with the setup step) when
the base branch has no upstream; branch deletion is only offered after the
worktree has been removed, because git refuses to delete a checked-out branch.
Headless (piped) runs print the same facts as a stdout summary plus executable
commands, and attempt nothing interactive.

The feature is resolved from the current worktree, or pass --branch <name> to
target another feature's worktree.

Usage:
  convoy close [--branch <name>] [--change <id>] [--resume] [--message <subject>]

Options:
  --branch <name>    Close the feature worktree carrying this branch
  --change <id>      Pin the OpenSpec change id (default: the branch's id)
  --resume           Continue a stopped sequence from the first incomplete step
  --message <text>   Exact message for the squashed commit; skips composition
                     and confirmation
  --dry-run          Print the sequence without touching anything
`
}

export function parseCloseArgs(argv: string[]): CloseOptions {
  const options: CloseOptions = { targetDir: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const value = (): string => {
      const next = argv[++i]
      if (!next || next.startsWith("-")) throw new Error(`${arg} requires a value`)
      return next
    }
    if (arg === "--branch") options.branch = value()
    else if (arg.startsWith("--branch=")) options.branch = arg.slice("--branch=".length)
    else if (arg === "--change") options.changeID = value()
    else if (arg.startsWith("--change=")) options.changeID = arg.slice("--change=".length)
    else if (arg === "--message") options.message = value()
    else if (arg.startsWith("--message=")) options.message = arg.slice("--message=".length)
    else if (arg === "--resume") options.resume = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--worktree-dir") options.worktreeDir = value()
    else throw new Error(`usage: convoy close [--branch <name>] [--change <id>] [--resume] [--message <subject>] (unexpected argument: ${arg})`)
  }
  return options
}

// -- shared helpers -------------------------------------------------------------

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? value
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

async function sameDir(a: string, b: string): Promise<boolean | undefined> {
  const aExists = await stat(a).then(
    () => true,
    () => false,
  )
  const bExists = await stat(b).then(
    () => true,
    () => false,
  )
  if (!aExists || !bExists) return undefined
  const { realpath } = await import("node:fs/promises")
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return a === b
  }
}
