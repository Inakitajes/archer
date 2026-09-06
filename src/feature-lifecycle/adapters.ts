import { readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve } from "node:path"

import { branchUpstream, execFile, findWorktreeDirForBranch, statusPorcelain } from "../git"
import { listRuns, type RunEntry } from "../runs"
import { openspecDirName, collectDirRelativeMarkdown } from "../openspec"

/**
 * Structured read adapters (capability `feature-lifecycle`, design D5, task
 * 2.2): thin wrappers around Git, run-history, and artifact reads that return
 * typed observations — including explicit unknown/unreadable states. A
 * run-discovery failure is `unknown`, never an empty live-run set; a Git
 * status failure is unreadable, never "clean". Everything above the adapters
 * reasons over the typed results, so no consumer can accidentally treat a
 * read failure as a negative fact.
 */

export type Observation<T> = { kind: "known"; value: T } | { kind: "unknown"; reason: string }

export function known<T>(value: T): Observation<T> {
  return { kind: "known", value }
}

export function unknown<T = never>(reason: string): Observation<T> {
  return { kind: "unknown", reason }
}

export function isKnown<T>(observation: Observation<T>): observation is { kind: "known"; value: T } {
  return observation.kind === "known"
}

/** Run history with liveness; `unknown` when the history cannot be read. */
export async function observeRuns(): Promise<Observation<RunEntry[]>> {
  try {
    return known(await listRuns())
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}

/** Live run IDs attached to a worktree path (realpath-compared). */
export async function observeLiveRunsAt(targetDir: string): Promise<Observation<string[]>> {
  const entries = await observeRuns()
  if (entries.kind === "unknown") return entries
  let resolvedTarget: string
  try {
    resolvedTarget = await realpath(targetDir)
  } catch {
    resolvedTarget = resolve(targetDir)
  }
  const live: string[] = []
  for (const entry of entries.value) {
    if (!entry.live || !entry.targetDir) continue
    let same = false
    try {
      same = (await realpath(entry.targetDir)) === resolvedTarget
    } catch {
      same = resolve(entry.targetDir) === resolvedTarget
    }
    if (same) live.push(entry.runID)
  }
  return known(live)
}

/** Git status porcelain; `unknown` when unreadable (never the empty string). */
export async function observeStatus(dir: string): Promise<Observation<string>> {
  try {
    return known(await statusPorcelain(dir))
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}

/** The branch checked out at `dir`; unknown on a detached/unreadable HEAD is surfaced. */
export async function observeBranch(dir: string): Promise<Observation<string | undefined>> {
  const result = await execFile("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, allowFailure: true })
  if (result.exitCode !== 0) return unknown(result.stderr || "git rev-parse failed")
  const branch = result.stdout.trim()
  return known(branch === "HEAD" ? undefined : branch)
}

/** Where a branch is checked out, via Git's own inventory (never a path guess). */
export async function observeWorktreeForBranch(branch: string, cwd: string): Promise<Observation<string | undefined>> {
  try {
    return known((await findWorktreeDirForBranch(branch, cwd)) ?? undefined)
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Task counts for one change: from the OpenSpec CLI when it answers, from
 * checkbox parsing otherwise, `unknown` when neither can read the tree
 * (design D5 — the fallback chain stays; failure is never "0 tasks").
 */
export async function observeTaskCounts(dir: string): Promise<Observation<ReadonlyMap<string, { done: number; total: number }>>> {
  const { openspecTaskCounts } = await import("../control-board")
  try {
    return known(await openspecTaskCounts(dir))
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}

/** Reads a change's markdown files relative to its root. */
export async function observeChangeFiles(checkoutDir: string, changeId: string): Promise<Observation<string[]>> {
  try {
    return known(await collectDirRelativeMarkdown(join(checkoutDir, openspecDirName, "changes", changeId), "."))
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}

/** Reads one file as text, typed. */
export async function observeFileText(path: string): Promise<Observation<string>> {
  try {
    return known(await readFile(path, "utf8"))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ENOENT") return unknown("file does not exist")
    return unknown(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Whether a candidate path resolves inside `root` without escaping through
 * `..` (symlink escape is checked by the caller via realpath where it
 * matters — archive verification resolves real paths before reading).
 */
export function relativeWithin(root: string, candidate: string): string | undefined {
  if (candidate === "" || isAbsolute(candidate)) return undefined
  const rel = relative(resolve(root), resolve(join(root, candidate)))
  if (rel === "" || rel.startsWith("..")) return undefined
  return rel.split("\\").join("/")
}

/** The upstream of a branch, factually observed (never interpreted). */
export async function observeUpstream(branch: string, cwd: string): Promise<Observation<string | undefined>> {
  try {
    return known(await branchUpstream(branch, cwd).catch(() => undefined))
  } catch (error) {
    return unknown(error instanceof Error ? error.message : String(error))
  }
}
