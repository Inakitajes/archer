import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { resolve } from "node:path"

import { formatCommitMessage } from "./commit-message"
import { loadMergedConvoyConfig } from "./config"
import { applySquash, canOpenPullRequest, defaultRemote, describeSquashPlan, openPullRequest, prepareFinish, resolveFinishBase } from "./finish"
import { mainWorktreeDir, pushBranch, removeWorktree } from "./git"
import { log } from "./log"

export type FinishOptions = {
  /** Repo or worktree holding the run's branch. */
  targetDir: string
  /** Finish another branch's worktree instead of the current directory. */
  branch?: string
  baseRef?: string
  /** Force `-S` for users who sign deliberately rather than via commit.gpgsign. */
  sign?: boolean
  noVerify?: boolean
  /** Open the user's editor on the generated message before committing. */
  edit?: boolean
  /** Skip the confirmation prompt. */
  yes?: boolean
  /** Print what would happen and exit without touching the repo. */
  dryRun?: boolean
  help?: boolean
}

/**
 * Collapses a run's convoy commits into one conventional commit authored and
 * signed by the user. The non-interactive counterpart of the dashboard's [f].
 */
export async function runFinishCommand(options: FinishOptions) {
  const cwd = await resolveFinishDir(options)
  const config = await loadMergedConvoyConfig(cwd)
  const baseRef = await resolveFinishBase(cwd, options.baseRef ?? config?.defaults.baseRef)

  const prepared = await prepareFinish({
    cwd,
    baseRef,
    ...(config?.defaults.commitMessageModel ? { commitMessageModel: config.defaults.commitMessageModel } : {}),
  })
  if (!prepared.ok) {
    // Nothing to do is a normal outcome for a branch already finished, not a
    // crash; say why and exit clean.
    stdout.write(`${prepared.message}\n`)
    return
  }

  const { plan } = prepared
  const message = formatCommitMessage(prepared.message)
  stdout.write(`${describeSquashPlan(plan).join("\n")}\n\n`)
  if (prepared.messageError) stdout.write(`(the writing model failed, so this message is derived from the branch and the step commits)\n`)
  stdout.write(`${indent(message)}\n\n`)

  if (options.dryRun) {
    stdout.write("--dry-run: nothing was changed\n")
    return
  }

  if (!options.yes && !interactive()) {
    // Rewriting history is not something to do because nobody was there to say no.
    stdout.write("not an interactive terminal; re-run with --yes to squash without confirmation\n")
    return
  }
  const answer = options.yes ? "y" : await ask("Squash into this commit? [y/e/N] ")
  if (answer !== "y" && answer !== "e") {
    stdout.write("cancelled\n")
    return
  }

  const result = await applySquash({
    cwd,
    plan,
    message,
    ...(options.sign ? { sign: true } : {}),
    ...(options.noVerify ? { noVerify: true } : {}),
    ...(options.edit || answer === "e" ? { edit: true } : {}),
  })

  stdout.write(`\n${result.sha.slice(0, 8)} replaced ${result.replaced} convoy commit${result.replaced === 1 ? "" : "s"} on ${result.branch}\n`)
  stdout.write(`the previous history is kept at ${result.backupRef} (git reset --hard ${result.backupRef} to undo)\n`)

  await offerFollowUps({ cwd, branch: result.branch, message: prepared.message, yes: Boolean(options.yes) })
}

/** `--branch` finishes another run's worktree; otherwise the current directory is the run's checkout. */
async function resolveFinishDir(options: FinishOptions): Promise<string> {
  if (!options.branch) return options.targetDir
  const { worktreeDirFor } = await import("./worktree")
  const dir = worktreeDirFor(options.branch)
  // Without this the first git call fails on a missing cwd with a spawn error
  // that says nothing about which branch or path was meant.
  if (!(await directoryExists(dir))) {
    throw new Error(`no convoy worktree for branch "${options.branch}" at ${dir}; run convoy finish from the checkout holding that branch instead`)
  }
  return dir
}

async function directoryExists(path: string): Promise<boolean> {
  const { stat } = await import("node:fs/promises")
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

type FollowUpInput = {
  cwd: string
  branch: string
  message: { subject: string; body: string[] }
  yes: boolean
}

/**
 * Push, PR and worktree removal are each offered separately and never happen on
 * their own: the squash is the whole of what `finish` promises, and everything
 * after it leaves the machine or destroys a checkout.
 */
async function offerFollowUps(input: FollowUpInput) {
  // --yes covers the squash only. Pushing and opening a PR are outward-facing,
  // so they always ask — and where there is nobody to ask, they simply don't
  // happen and the commands are printed instead.
  if (input.yes || !interactive()) {
    stdout.write(`\nnext: git push -u ${defaultRemote} ${input.branch}\n`)
    await describeWorktreeRemoval(input)
    return
  }

  if ((await ask(`Push ${input.branch} to ${defaultRemote}? [y/N] `)) === "y") {
    try {
      await pushBranch(input.branch, defaultRemote, input.cwd)
    } catch (error) {
      log.warn(`push failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    if (canOpenPullRequest() && (await ask("Open a pull request with gh? [y/N] ")) === "y") {
      try {
        await openPullRequest(input.cwd, input.message)
      } catch (error) {
        log.warn(error instanceof Error ? error.message : String(error))
      }
    }
  } else {
    stdout.write(`next: git push -u ${defaultRemote} ${input.branch}\n`)
  }

  await offerWorktreeRemoval(input)
}

/**
 * Only offered when the shell isn't standing inside the worktree: removing the
 * directory the process is running in leaves the shell in a path that no longer
 * exists, and a live run's opencode server is still rooted there.
 */
async function offerWorktreeRemoval(input: FollowUpInput) {
  const removal = await worktreeRemoval(input)
  if (!removal) return
  if (!removal.safe) {
    stdout.write(`${removal.hint}\n`)
    return
  }
  if ((await ask(`Remove the worktree at ${input.cwd}? [y/N] `)) !== "y") return
  try {
    await removeWorktree(input.cwd, removal.mainDir)
    stdout.write("worktree removed\n")
  } catch (error) {
    log.warn(`couldn't remove the worktree: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The unattended counterpart: say what could be removed without removing anything. */
async function describeWorktreeRemoval(input: FollowUpInput) {
  const removal = await worktreeRemoval(input)
  if (removal) stdout.write(`${removal.hint}\n`)
}

/**
 * Removal is only safe when the shell isn't standing inside the worktree:
 * deleting the directory the process runs in leaves the shell in a path that no
 * longer exists, and a live run's opencode server is still rooted there.
 */
async function worktreeRemoval(input: FollowUpInput): Promise<{ mainDir: string; safe: boolean; hint: string } | undefined> {
  const mainDir = await mainWorktreeDir(input.cwd)
  if (!mainDir || resolve(mainDir) === resolve(input.cwd)) return undefined
  const cwd = resolve(process.cwd())
  const worktree = resolve(input.cwd)
  const inside = cwd === worktree || cwd.startsWith(`${worktree}/`)
  return {
    mainDir,
    safe: !inside,
    hint: inside
      ? `to remove the worktree once you're out of it: git -C ${mainDir} worktree remove ${input.cwd}`
      : `to remove the worktree: git -C ${mainDir} worktree remove ${input.cwd}`,
  }
}

/**
 * Single-key confirmation in the style of confirmRunPlan, including its raw-mode
 * SIGINT handling. Every question opens its own readline interface, so a stdin
 * that reaches EOF (a pipe, a closed terminal) must resolve rather than leave
 * the promise pending forever and let the process exit mid-flow.
 */
async function ask(question: string): Promise<string> {
  const prompt = createInterface({ input: stdin, output: stdout })
  const controller = new AbortController()
  let interrupted = false
  prompt.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  const closed = new Promise<string>((resolve) => prompt.once("close", () => resolve("")))
  try {
    const answer = await Promise.race([prompt.question(question, { signal: controller.signal }), closed])
    return answer.trim().toLowerCase()
  } catch (error) {
    if (interrupted && error instanceof Error && error.name === "AbortError") {
      stdout.write("\n")
      return ""
    }
    throw error
  } finally {
    prompt.close()
  }
}

/** Whether convoy can still ask the user anything, or should only print what it would have offered. */
function interactive(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

export function indent(value: string) {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}

export function finishHelp() {
  return `convoy finish [--branch <name>] [--base <ref>] [--sign] [--no-verify] [--edit] [--yes] [--dry-run]

Squash the convoy commits on this branch into one conventional commit created with your own
git identity, so it is attributed and signed like anything you commit by hand.

Only commits authored by convoy@local are replaced, and the walk stops at the first commit you
wrote yourself. The pre-squash history is kept at refs/convoy/finish/<branch>.

Options:
  --branch <name>          Finish the worktree of another run's branch instead of this directory
  --base <ref>             Base to floor the squash at (default: defaults.baseRef, else auto-detected)
  --sign                   Force -S, for signing without commit.gpgsign set
  --no-verify              Skip commit hooks (they already ran on every step commit)
  --edit                   Open your editor on the message before committing
  --yes                    Skip the confirmation. Required outside an interactive terminal, and
                           never pushes or opens a PR — those are only ever offered, never implied
  --dry-run                Print what would happen and exit
  --dir <path>             Target repo (default: cwd)
`
}

export function parseFinishArgs(argv: string[]): FinishOptions {
  const options: FinishOptions = { targetDir: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    const index = raw.indexOf("=")
    const flag = index === -1 ? raw : raw.slice(0, index)
    const inlineValue = index === -1 ? undefined : raw.slice(index + 1)
    const takeValue = () => {
      if (inlineValue !== undefined) return inlineValue
      const next = argv[++i]
      if (next === undefined || next.startsWith("-")) throw new Error(`${flag} requires a value`)
      return next
    }

    switch (flag) {
      case "--help":
      case "-h":
        options.help = true
        return options
      case "--branch":
        options.branch = takeValue()
        break
      case "--base":
        options.baseRef = takeValue()
        break
      case "--dir":
        options.targetDir = resolve(process.cwd(), takeValue())
        break
      case "--sign":
        options.sign = true
        break
      case "--no-verify":
        options.noVerify = true
        break
      case "--edit":
        options.edit = true
        break
      case "--yes":
      case "-y":
        options.yes = true
        break
      case "--dry-run":
        options.dryRun = true
        break
      default:
        throw new Error(`unknown flag: ${flag}`)
    }
  }
  return options
}
