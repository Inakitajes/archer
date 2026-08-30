import { stdout } from "node:process"
import { stat } from "node:fs/promises"
import { resolve } from "node:path"
import type { Readable } from "node:stream"

import { archiveChangeOnMain, runClose, type CloseEvent, type CloseInput, type CloseMessageProposal, type CloseResult, type CloseStep } from "./feature-close"
import { stripControlBytes } from "./commit-message"
import {
  applyCloseEvent,
  initialCloseChecklistState,
  renderCloseChecklist,
  type CloseChecklistRow,
  type CloseChecklistRowStatus,
  type CloseChecklistState,
} from "./close-presentation"
import { editMessageInEditor } from "./finish"
import { branchUpstream, execFile, mainWorktreeDir, pushRefspec, removeWorktree } from "./git"
import { log } from "./log"
import { ask, isInteractiveTerminal } from "./terminal-input"
import type { CloseFollowUpId, CloseFollowUpItem, CloseFollowUpStatus, CloseTui } from "./close-tui"
import type { TuiRoute } from "./tui-session"

export {
  applyCloseEvent,
  initialCloseChecklistState,
  renderCloseChecklist,
  type CloseChecklistRow,
  type CloseChecklistRowStatus,
  type CloseChecklistState,
} from "./close-presentation"

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

export async function runCloseCommand(options: CloseOptions, route?: TuiRoute): Promise<void> {
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
    ...(options.message !== undefined ? { message: options.message } : {}),
  }
  // The board's close-change handoff lands here too: a TTY gets the checklist,
  // a pipe gets the stdout summary — one dispatcher, no second call site.
  if (closeSurface() === "tty") await runCloseInteractive(input, {}, route)
  else await runCloseHeadless(input)
}

/** Which renderer the command surface uses; a seam so mode selection stays testable. */
export function closeSurface(interactive: boolean = isInteractiveTerminal()): "tty" | "headless" {
  return interactive ? "tty" : "headless"
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
        stepState.set(event.step, event.detail ? `${event.step}: ${strip(event.detail)}` : `${event.step}: completed`)
        break
      case "step-skipped":
        stepState.set(event.step, `${event.step}: skipped — ${strip(event.reason)}`)
        break
      case "step-failed":
        stepState.set(event.step, `${event.step}: failed — ${strip(firstLine(event.message))}`)
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
  // Every printed command is prefixed `git -C <mainDir>` and quotes only the
  // path tokens, so it is executable from inside the feature worktree (the
  // natural close cwd) and survives paths with spaces (SC-2).
  const gitC = `git -C ${shq(mainDir)}`

  let push: CloseFollowUps["push"]
  let pushRemediation: string | undefined
  const upstream = await branchUpstream(args.baseRef, mainDir).catch(() => undefined)
  const [remote, ...remoteRest] = (upstream ?? "").split("/")
  const remoteBranch = remoteRest.join("/")
  if (remote && remoteBranch) {
    push = { remote, refspec: `${args.baseRef}:${remoteBranch}`, command: `${gitC} push ${remote} ${args.baseRef}:${remoteBranch}` }
  } else {
    pushRemediation = `${args.baseRef} has no configured upstream — set one first: ${gitC} branch --set-upstream-to=<remote>/<branch> ${args.baseRef}`
  }

  let worktreeRemoval: string | undefined
  const isMainCheckout = (await sameDir(mainDir, args.worktreeDir)) === true
  const worktreeExists = await stat(args.worktreeDir).then(
    () => true,
    () => false,
  )
  if (!isMainCheckout && worktreeExists) worktreeRemoval = `${gitC} worktree remove ${shq(args.worktreeDir)}`

  return {
    ...(push ? { push } : {}),
    ...(pushRemediation ? { pushRemediation } : {}),
    ...(worktreeRemoval ? { worktreeRemoval } : {}),
    branchDelete: `${gitC} branch -d ${args.branch}`,
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

export async function runCloseInteractive(input: CloseInput, io: CloseIO = {}, route?: TuiRoute): Promise<void> {
  // `io` remains on the signature for backwards-compatible unit seams around
  // the plain prompt helpers below. Production interactive close owns an
  // OpenTUI alternate screen from the first preflight event to cleanup.
  void io
  const { openCloseTui } = await import("./close-tui")
  const tui = await openCloseTui(input.targetDir, undefined, route)
  try {
    const result = await runClose({
      ...input,
      onEvent: (event) => tui.onEvent(event),
      withTerminal: (action) => tui.withTerminal(action),
      resolveMessage: async (proposal) => {
        let notice: string | undefined
        for (;;) {
          const decision = await tui.confirmMessage(proposal, notice)
          if (decision === "accept") return proposal.message
          if (decision === "cancel") return undefined

          // $EDITOR needs the real terminal; suspend OpenTUI's alternate
          // screen/raw input and restore the same checklist afterward.
          const edited = await tui.withTerminal(() => editMessageInEditor(proposal.message))
          if (!edited) {
            notice = "Editor cancelled; review the proposal again or cancel close."
            continue
          }
          return edited.body.length === 0 ? edited.subject : `${edited.subject}\n\n${edited.body.map((line) => `- ${line}`).join("\n")}`
        }
      },
    })
    const followUps = await resolveCloseFollowUps({
      targetDir: input.targetDir,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
    })
    await offerCloseFollowUpsTui(tui, {
      ...followUps,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
      targetDir: input.targetDir,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
    // Keep the failed checklist and remediation inside the TUI until the
    // operator dismisses it; no cursor-control fragments leak into the shell.
    await tui.showFailure(message)
  } finally {
    tui.destroy()
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

/**
 * The TTY side of the resolver gate (design D4): show the composed message,
 * accept or edit. Edit delegates verbatim to `editMessageInEditor` — the same
 * GIT_EDITOR/VISUAL/EDITOR resolution and comment stripping `finish` uses. An
 * emptied editor or a declined prompt returns undefined, which stops the
 * sequence before the squash lands; nothing commits before the choice.
 */
export async function confirmCloseMessage(
  proposal: CloseMessageProposal,
  deps: { renderer?: { break(): void } } & CloseIO = {},
): Promise<string | undefined> {
  deps.renderer?.break()
  const out = deps.output ?? stdout
  for (;;) {
    out.write("\n")
    if (proposal.error) out.write("(the writing model failed, so this message is derived from the proposal and the step commits)\n")
    out.write(`${indent(strip(proposal.message))}\n\n`)
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

type InteractiveFollowUpState = Partial<
  Record<CloseFollowUpId, { status: Extract<CloseFollowUpStatus, "running" | "completed" | "failed">; error?: string }>
>

/**
 * Optional cleanup in the OpenTUI surface. All three actions remain visible,
 * including disabled prerequisites, and a failed action stays selectable for
 * retry. Quitting is the deliberate "leave the rest for later" choice.
 */
async function offerCloseFollowUpsTui(tui: CloseTui, followUps: FollowUpOffers): Promise<void> {
  const mainDir = (await mainWorktreeDir(followUps.targetDir).catch(() => undefined)) ?? followUps.targetDir
  const state: InteractiveFollowUpState = {}

  const items = async (): Promise<CloseFollowUpItem[]> => {
    const worktreeExists = await stat(followUps.worktreeDir).then(
      () => true,
      () => false,
    )
    const cwdInside = processCwdInside(followUps.worktreeDir)

    const push: CloseFollowUpItem = followUps.push
      ? {
          id: "push",
          label: `Push ${followUps.baseRef}`,
          detail: `Push to ${followUps.push.remote} with the explicit refspec ${followUps.push.refspec}.`,
          command: followUps.push.command,
          status: state.push?.status ?? "available",
          ...(state.push?.error ? { error: state.push.error } : {}),
        }
      : {
          id: "push",
          label: `Push ${followUps.baseRef}`,
          detail: followUps.pushRemediation ?? "No configured upstream is available.",
          status: "unavailable",
        }

    let worktree: CloseFollowUpItem
    if (state.worktree?.status === "completed") {
      worktree = { id: "worktree", label: "Remove worktree", detail: followUps.worktreeDir, status: "completed" }
    } else if (!followUps.worktreeRemoval || !worktreeExists) {
      worktree = { id: "worktree", label: "Remove worktree", detail: "No separate feature worktree remains.", status: "unavailable" }
    } else if (cwdInside) {
      worktree = {
        id: "worktree",
        label: "Remove worktree",
        detail: "Leave this worktree in your shell before removing it.",
        command: followUps.worktreeRemoval,
        status: "unavailable",
      }
    } else {
      worktree = {
        id: "worktree",
        label: "Remove worktree",
        detail: followUps.worktreeDir,
        command: followUps.worktreeRemoval,
        status: state.worktree?.status ?? "available",
        ...(state.worktree?.error ? { error: state.worktree.error } : {}),
      }
    }

    let branch: CloseFollowUpItem
    if (state.branch?.status === "completed") {
      branch = { id: "branch", label: `Delete ${followUps.branch}`, detail: "Feature branch deleted.", status: "completed" }
    } else if (worktreeExists) {
      branch = {
        id: "branch",
        label: `Delete ${followUps.branch}`,
        detail: "Remove the feature worktree first; git cannot delete a checked-out branch.",
        command: followUps.branchDelete,
        status: "unavailable",
      }
    } else if (cwdInside) {
      branch = {
        id: "branch",
        label: `Delete ${followUps.branch}`,
        detail: "Leave the removed worktree path in your shell before deleting its branch.",
        command: followUps.branchDelete,
        status: "unavailable",
      }
    } else {
      branch = {
        id: "branch",
        label: `Delete ${followUps.branch}`,
        detail: "Delete the local feature branch after its worktree is gone.",
        command: followUps.branchDelete,
        status: state.branch?.status ?? "available",
        ...(state.branch?.error ? { error: state.branch.error } : {}),
      }
    }
    return [push, worktree, branch]
  }

  for (;;) {
    const resolution = await tui.selectFollowUp(await items())
    if (resolution.type === "done") return
    const id = resolution.id
    state[id] = { status: "running" }
    tui.updateFollowUps(await items())
    try {
      if (id === "push") {
        if (!followUps.push) continue
        await tui.withTerminal(() => pushRefspec(followUps.push!.remote, followUps.push!.refspec, mainDir))
      } else if (id === "worktree") {
        if (!followUps.worktreeRemoval) continue
        await removeWorktree(followUps.worktreeDir, mainDir)
      } else {
        const result = await execFile("git", ["branch", "-d", followUps.branch], { cwd: mainDir, allowFailure: true })
        if (result.exitCode !== 0) throw new Error(result.stderr || `git branch -d ${followUps.branch} failed`)
      }
      state[id] = { status: "completed" }
    } catch (error) {
      state[id] = { status: "failed", error: error instanceof Error ? error.message : String(error) }
    }
  }
}

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
  // offer only exists once that dependency cleared. The worktree may be gone
  // already (removed between runs or by hand) — then the branch is deletable
  // now and the immediate command is printed, not a wait (SC-9).
  const worktreeStillExists = await stat(followUps.worktreeDir).then(
    () => true,
    () => false,
  )
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
  } else if (!worktreeStillExists && !processCwdInside(followUps.worktreeDir)) {
    out.write(`next: ${followUps.branchDelete}\n`)
  } else if (worktreeStillExists && !processCwdInside(followUps.worktreeDir)) {
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

// The single-key `ask` confirmation and the interactive-terminal check live in
// `terminal-input.ts`, shared with `finish` so their SIGINT/EOF semantics stay
// identical (SC-3).

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

In a terminal the sequence renders in a full-screen TUI — each step's
completion, skip (with reason), or failure visible as it happens, and the
merge's shape (fast-forward or merge commit) narrated. The squashed commit's
message is composed from the change's proposal and touched capabilities, with
a deterministic fallback when no model answers; the scope is always the single
touched capability, and the change id is named in the body. You confirm, edit,
or cancel the message inside the TUI before it lands.

Once merged, push, worktree removal, and branch deletion stay in that TUI as
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

/** The display/commit boundary sanitizer for model- and git-derived text (SC-4). */
function strip(value: string | undefined): string {
  return stripControlBytes(value ?? "")
}

/** Quotes a token for the shell only when it would otherwise break out of a bare word. */
function shq(value: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
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
