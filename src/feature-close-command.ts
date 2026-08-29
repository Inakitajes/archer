import { stdout } from "node:process"
import { resolve } from "node:path"

import { archiveChangeOnMain, runClose, type CloseInput } from "./feature-close"
import { log } from "./log"

/**
 * The `convoy close` command: the non-interactive driver of the closing
 * sequence. Resolves the feature (board handoff, `--branch`, or the current
 * worktree), runs preflight → sync → archive → squash → merge, and prints the
 * optional follow-ups — push, branch delete, worktree removal — as commands
 * the operator runs deliberately, never automatically.
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
  try {
    const result = await runClose(input)
    stdout.write(`closed ${result.changeID}\n`)
    stdout.write(`  ${result.branch} → ${result.baseRef} (merged)\n`)
    if (result.squashed) stdout.write(`  ${result.squashed.replaced} convoy commit${result.squashed.replaced === 1 ? "" : "s"} squashed into ${result.squashed.sha.slice(0, 8)}\n`)
    stdout.write("\noptional follow-ups (never automatic):\n")
    stdout.write(`  git push ${result.baseRef}\n`)
    stdout.write(`  git branch -d ${result.branch}\n`)
    stdout.write(`  git worktree remove ${result.worktreeDir}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.error(message)
    process.exitCode = 1
  }
}

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

The feature is resolved from the current worktree, or pass --branch <name> to
target another feature's worktree.

Usage:
  convoy close [--branch <name>] [--change <id>] [--resume] [--message <subject>]

Options:
  --branch <name>    Close the feature worktree carrying this branch
  --change <id>      Pin the OpenSpec change id (default: the branch's id)
  --resume           Continue a stopped sequence from the first incomplete step
  --message <text>   Subject for the squashed conventional commit
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
