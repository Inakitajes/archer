import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

import type { DiffTotals } from "./git"
import type { PhaseMetadataStatus } from "./metadata"

export type Workspace = {
  dir: string
  runID: string
}

const runIDPattern = /^\d{8}-\d{6}-[a-z0-9]{4}$/

export async function createWorkspace(prompt: string): Promise<Workspace> {
  const runID = newRunID()
  const dir = runDir(runID)

  await mkdir(dir, { recursive: true, mode: 0o700 })
  for (const sub of ["logs", "reports", "diffs", "events"]) {
    await mkdir(join(dir, sub), { mode: 0o700 })
  }
  await writeFile(join(dir, "prd.md"), prompt, { mode: 0o600 })

  return { dir, runID }
}

export async function resumeWorkspace(runID: string): Promise<Workspace> {
  const dir = runDir(runID)
  try {
    await stat(dir)
  } catch {
    throw new Error(`run ${runID} doesn't exist at ${dir}`)
  }
  return { dir, runID }
}

export async function cleanupWorkspace(workspace: Workspace) {
  assertInsideRunsRoot(workspace.dir)
  await rm(workspace.dir, { recursive: true, force: true })
}

export type ScoreboardRow = {
  name: string
  status: PhaseMetadataStatus | undefined
  diff: DiffTotals | undefined
}

/**
 * Renders the per-phase diffstat scoreboard as a Markdown table.
 *
 * Returns `undefined` when every phase has no diff data (all-read-only or
 * no-commit run), so the caller can omit the section entirely.
 */
export function renderScoreboard(rows: ScoreboardRow[]): string | undefined {
  const withData = rows.filter((row) => row.diff !== undefined)
  if (withData.length === 0) return undefined

  const totalFiles = withData.reduce((sum, row) => sum + row.diff!.files, 0)
  const totalInsertions = withData.reduce((sum, row) => sum + row.diff!.insertions, 0)
  const totalDeletions = withData.reduce((sum, row) => sum + row.diff!.deletions, 0)
  const totalDelta = totalInsertions - totalDeletions

  const lines: string[] = [
    "## Scoreboard",
    "",
    "| Phase | Files | + | − | Δ net |",
    "|---|---|---|---|---|",
  ]

  for (const row of rows) {
    if (row.diff) {
      const delta = row.diff.insertions - row.diff.deletions
      const deltaStr = delta >= 0 ? `+${delta}` : `${delta}`
      lines.push(`| ${row.name} | ${row.diff.files} | +${row.diff.insertions} | −${row.diff.deletions} | ${deltaStr} |`)
    } else {
      lines.push(`| ${row.name} | — | — | — | — |`)
    }
  }

  const totalDeltaStr = totalDelta >= 0 ? `+${totalDelta}` : `${totalDelta}`
  lines.push(`| **Total** | **${totalFiles}** | **+${totalInsertions}** | **−${totalDeletions}** | **${totalDeltaStr}** |`)

  return lines.join("\n")
}

export async function writeSummary(workspace: Workspace, phaseNames: string[], extraSections: readonly string[] = [], scoreboard?: string) {
  const chunks: string[] = [`# convoy run ${workspace.runID} - summary`, ""]

  if (scoreboard) chunks.push(scoreboard, "")

  for (const section of extraSections) chunks.push(section, "")

  for (const name of phaseNames) {
    chunks.push(`## ${name}`, "")
    try {
      chunks.push(await readFile(join(workspace.dir, "reports", `${name}.md`), "utf8"))
    } catch {
      chunks.push("_(no report)_")
    }
    chunks.push("")
  }

  await writeFile(join(workspace.dir, "SUMMARY.md"), chunks.join("\n"))
}

export function runDir(runID: string) {
  validateRunID(runID)
  return childPath(runsRoot(), runID)
}

export function runsRoot() {
  return join(convoyHome(), "runs")
}

/**
 * The directory that contains convoy's `.convoy` home — the user's home by
 * default, relocatable via CONVOY_HOME. It plays the same role for the global
 * config that a repo root plays for a project, so agent-prompt paths resolve
 * the same way (`<root>/.convoy/agents/<name>.md`).
 */
export function convoyRoot() {
  return process.env.CONVOY_HOME || homedir()
}

/** Convoy's per-user home, holding run history and the global config. */
export function convoyHome() {
  return join(convoyRoot(), ".convoy")
}

/** Path of the global config file (default name); the loader also accepts config.yml. */
export function globalConfigPath() {
  return join(convoyHome(), "config.yaml")
}

/** Where prompts for global custom agents live, mirroring a project's .convoy/agents. */
export function globalAgentsDir() {
  return join(convoyHome(), "agents")
}

/**
 * A Convoy-owned OpenCode config directory, passed to the server as
 * OPENCODE_CONFIG_DIR so `tools/advisor.ts` is discovered.
 *
 * Convoy-owned rather than the repo's `.opencode/` (which would show up in git
 * status and in the read-only baseline checks) or the user's
 * `~/.config/opencode/` (which would leak the tool into their own sessions).
 * Verified against opencode 1.18.5: the variable is additive, so the user's
 * global config, plugins and MCP servers keep loading exactly as before.
 * Persistent, so the dependency install OpenCode kicks off in such a directory
 * happens once rather than per run.
 */
export function opencodeConfigDir() {
  return join(convoyHome(), "opencode")
}

export function isValidRunID(runID: string) {
  return runIDPattern.test(runID)
}

function validateRunID(runID: string) {
  if (!isValidRunID(runID)) throw new Error(`invalid run id: ${runID}`)
}

// Local time, not UTC: run IDs are read by humans next to their wall clock.
function newRunID() {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  return `${date}-${time}-${randomSlug(4)}`
}

function randomSlug(size: number) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  for (const byte of bytes) out += chars[byte % chars.length]
  return out
}

function childPath(root: string, child: string) {
  const resolvedRoot = resolve(root)
  const resolvedPath = resolve(resolvedRoot, child)
  const pathFromRoot = relative(resolvedRoot, resolvedPath)
  if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) {
    throw new Error(`path outside ${resolvedRoot}: ${resolvedPath}`)
  }
  return resolvedPath
}

function assertInsideRunsRoot(path: string) {
  const pathFromRoot = relative(resolve(runsRoot()), resolve(path))
  if (!pathFromRoot) throw new Error(`path outside a specific run: ${path}`)
  childPath(runsRoot(), pathFromRoot)
}
