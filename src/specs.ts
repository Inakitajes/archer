import { readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { stdin, stdout } from "node:process"

import type { FeatureRow, WorktreeWithoutSpec } from "./control-board"
import type { TuiRoute } from "./tui-session"
import {
  collectDirRelativeMarkdown,
  listChangeIds,
  openspecDirName,
  stripYamlFrontmatter,
  titleFromProposal,
} from "./openspec"

/**
 * Read-only specs viewer data layer.
 *
 * `convoy specs` shows the same OpenSpec layout the runner attaches to steps —
 * active changes under `openspec/changes/` and canonical specs under
 * `openspec/specs/` — but for humans. Everything here is pure-ish: loaders do
 * the filesystem reads and return plain entries; classification, prompting,
 * and printing are unit-testable without a repo on disk. Convoy never writes
 * OpenSpec state and never invokes the `openspec` binary (same stance as
 * `openspec.ts`'s bundle loader).
 */

/** The artifact groups a change's markdown files fall into. */
export type SpecArtifactSection = "proposal" | "design" | "tasks" | "delta" | "other"

export type SpecArtifact = {
  section: SpecArtifactSection
  /** First path segment under the change's `specs/` — delta files group per capability. */
  capability?: string
  /** Markdown path relative to the repo root. */
  file: string
}

export type SpecsChangeEntry = {
  kind: "change"
  id: string
  /** First heading of proposal.md; falls back to the id when it's missing or unreadable. */
  title: string
  artifacts: SpecArtifact[]
}

export type SpecsView = {
  /** Absolute normalized project directory the view was loaded from. */
  targetDir: string
  /** False when the target repo has no `openspec/` directory at all. */
  present: boolean
  changes: SpecsChangeEntry[]
  specs: string[]
  /**
   * The control board's derived rows, keyed to `changes` by id, when the board
   * join ran (interactive use). Undefined in plain listings that never need it.
   */
  rows?: FeatureRow[]
  /** Worktrees carrying runs but no OpenSpec change — a peer board section. */
  worktreesWithoutSpec?: WorktreeWithoutSpec[]
  /** The repo's detected base branch, for the sync/merged markers. */
  baseBranch?: string
}

/**
 * What the specs browser can ask Convoy to do next. Action-shaped so later
 * actions fit without reshaping call sites (same pattern as RunsResolution).
 */
export type SpecsResolution =
  | { type: "exit" }
  | { type: "apply-change"; changeID: string }
  | { type: "iterate-change"; changeID: string }
  /** Spin out a stranded change into its own worktree (`convoy spin`'s flow). */
  | { type: "spin-change"; changeID: string }
  /** Continue a feature: the launcher preselects its existing worktree and branch. */
  | { type: "continue-change"; changeID: string; worktreeDir: string; branch: string }
  /** Run the full closing sequence (sync → archive → squash → merge) for a feature. */
  | { type: "close-change"; changeID: string; worktreeDir: string; branch: string }
  /** Archive a probably-merged-but-unarchived change in the main checkout. */
  | { type: "archive-change-main"; changeID: string }

/** Artifact order in the detail view: the named planning sections first, then deltas, then leftovers. */
const sectionOrder: Record<SpecArtifactSection, number> = { proposal: 0, design: 1, tasks: 2, delta: 3, other: 4 }

/**
 * Maps a change-relative markdown path to its artifact section. Name-based on
 * purpose: `proposal.md`, `design.md`, and `tasks.md` are the planning trio;
 * anything under `specs/` is a delta grouped by its first path segment.
 * Unmatched files land in the nearest fitting group (delta under `specs/`,
 * otherwise "Other") so nothing disappears from the view.
 */
export function classifySpecArtifact(relativePath: string): { section: SpecArtifactSection; capability?: string } {
  const base = relativePath.split("/").pop() ?? relativePath
  if (base === "proposal.md") return { section: "proposal" }
  if (base === "design.md") return { section: "design" }
  if (base === "tasks.md") return { section: "tasks" }
  const parts = relativePath.split("/")
  if (parts[0] === "specs") {
    // A capability needs a directory below `specs/`; a lone `specs/foo.md`
    // still belongs to the delta view, just without a capability grouping.
    const capability = parts.length >= 3 ? parts[1] : undefined
    return { section: "delta", ...(capability ? { capability } : {}) }
  }
  return { section: "other" }
}

/** The label the detail view gives an artifact group. */
export function specArtifactLabel(section: SpecArtifactSection, capability?: string): string {
  switch (section) {
    case "proposal":
      return "Proposal"
    case "design":
      return "Design"
    case "tasks":
      return "Tasks"
    case "delta":
      return capability ? `Delta Specs (${capability})` : "Delta Specs"
    case "other":
      return "Other"
  }
}

/**
 * Loads everything the specs browser shows. Returns `{ present: false }` when
 * the repo has no `openspec/` directory — the brownfield signal the command
 * turns into a quiet "no specs found". A change dir that lost its proposal
 * still lists by id; unreadable files never throw. When openspec state exists,
 * the control board's live join (git worktrees, task counts, run plans) is
 * assembled too so the browser renders derived state — every fact computed at
 * load time, nothing persisted.
 */
export async function loadSpecsView(targetDir: string): Promise<SpecsView> {
  targetDir = resolve(targetDir)
  const openspecRoot = join(targetDir, openspecDirName)
  const present = await dirExists(openspecRoot)
  let changes: SpecsChangeEntry[] = []
  let specs: string[] = []
  if (present) {
    const changesDir = join(openspecRoot, "changes")
    const ids = await listChangeIds(changesDir)
    changes = await Promise.all(ids.map((id) => loadSpecsChange(changesDir, id)))

    // Relative to the repo root so detail views can read straight off it.
    specs = await collectDirRelativeMarkdown(join(openspecRoot, "specs"), join(openspecDirName, "specs"))
  }

  // The board join is additive: a failure (git missing, unreadable runs dir)
  // degrades the derived state instead of failing the browser. It still runs
  // without a main openspec directory because isolated run worktrees remain a
  // useful board section on their own.
  try {
    const { assembleControlBoard, createBoardReads } = await import("./control-board")
    const board = await assembleControlBoard(createBoardReads(targetDir))
    // SC-1: spin moves a change's files into a feature worktree, so the board —
    // whose rows are assembled over every `git worktree` — sees features the
    // main checkout's `openspec/changes/` no longer carries. Those worktree
    // changes must land in the Active Changes list too, or a feature spun out
    // while `convoy specs` runs from main appears nowhere and its row actions
    // stay unreachable.
    const merged = await mergeWorktreeChanges(changes, board.rows)
    return {
      targetDir,
      present,
      changes: merged,
      specs,
      rows: board.rows,
      worktreesWithoutSpec: board.worktreesWithoutSpec,
      ...(board.baseBranch ? { baseBranch: board.baseBranch } : {}),
    }
  } catch {
    return { targetDir, present, changes, specs }
  }
}

/**
 * Appends changes the board derived from feature worktrees that the current
 * checkout does not show. Each such change's artifacts are loaded from its own
 * worktree and their file paths are **absolute** — the browser reads them
 * against its process cwd (the launch checkout), and a worktree path is the
 * only one that resolves there. Main-checkout changes keep their repo-relative
 * paths. Order stays alphabetical by id so the list reads stably.
 */
async function mergeWorktreeChanges(changes: SpecsChangeEntry[], rows: FeatureRow[] | undefined): Promise<SpecsChangeEntry[]> {
  if (!rows) return changes
  const seen = new Set(changes.map((change) => change.id))
  const out = [...changes]
  for (const row of rows) {
    if (row.location !== "worktree" || seen.has(row.id)) continue
    const worktreeChangesDir = join(row.worktreeDir ?? "", openspecDirName, "changes")
    // A change with no artifacts still lists by its id (same as main).
    const entry = await loadSpecsChange(worktreeChangesDir, row.id, { absolute: true })
    out.push(entry)
    seen.add(row.id)
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

async function loadSpecsChange(
  changesDir: string,
  id: string,
  options: { absolute?: boolean } = {},
): Promise<SpecsChangeEntry> {
  const changeRoot = join(changesDir, id)
  let title = id
  try {
    const body = await readFile(join(changeRoot, "proposal.md"), "utf8")
    title = titleFromProposal(body, id)
  } catch {
    // A change without a readable proposal still lists by its id.
  }
  const relatives = await collectDirRelativeMarkdown(changeRoot, ".")
  const fileBase = options.absolute
    ? // Absolute so the browser's readFile resolves regardless of its cwd.
      resolve(changeRoot)
    : join(openspecDirName, "changes", id)
  const artifacts = relatives.map((relative) => ({
    ...classifySpecArtifact(relative),
    file: join(fileBase, relative),
  }))
  artifacts.sort((a, b) => sectionOrder[a.section] - sectionOrder[b.section] || a.file.localeCompare(b.file))
  return { kind: "change", id, title, artifacts }
}

/**
 * Plain-text listing for pipes and CI: active changes with their artifact
 * inventory first, canonical specs below. No colors, no control sequences.
 */
export function printSpecsList(view: Pick<SpecsView, "present" | "changes" | "specs">): void {
  stdout.write("\nspecs:\n")
  stdout.write("  active changes:\n")
  if (view.changes.length === 0) {
    stdout.write("    (none)\n")
  } else {
    for (const change of view.changes) {
      const heading = change.title === change.id ? change.id : `${change.id} — ${change.title}`
      stdout.write(`    ${heading}\n`)
      if (change.artifacts.length === 0) {
        stdout.write("      no artifacts\n")
        continue
      }
      for (const artifact of inventory(change)) {
        stdout.write(`      ${artifact}\n`)
      }
    }
  }
  stdout.write("  canonical specs:\n")
  if (view.specs.length === 0) {
    stdout.write("    (none)\n")
    return
  }
  for (const spec of view.specs) stdout.write(`    ${spec}\n`)
}

/** Per-section counts plus each file, e.g. "delta specs (cli): specs/cli/spec.md". */
function inventory(change: SpecsChangeEntry): string[] {
  const lines: string[] = []
  for (const artifact of change.artifacts) {
    const label = specArtifactLabel(artifact.section, artifact.capability)
    lines.push(`${label.toLowerCase()}: ${artifact.file}`)
  }
  return lines
}

/**
 * Interactive entry point for `convoy specs`. Missing or completely empty
 * OpenSpec state prints one line and exits successfully; pipes get the plain
 * listing instead of the TUI (the same rule as `convoy runs`). The browser
 * itself is lazy-imported so non-interactive invocations never pull in opentui.
 */
export async function browseSpecs(targetDir: string, route?: TuiRoute): Promise<SpecsResolution> {
  const view = await loadSpecsView(targetDir)
  if (view.changes.length === 0 && view.specs.length === 0 && (view.worktreesWithoutSpec?.length ?? 0) === 0) {
    if (route) {
      const { showNoticeTui } = await import("./notice-tui")
      await showNoticeTui(route, { title: "specs", message: `No specs found under ${join(view.targetDir, openspecDirName)}` })
      return { type: "exit" }
    }
    stdout.write(`no specs found under ${join(view.targetDir, openspecDirName)}\n`)
    return { type: "exit" }
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    printSpecsList(view)
    return { type: "exit" }
  }
  const { browseSpecsTui } = await import("./specs-browser")
  return browseSpecsTui(view, route)
}

/**
 * The iterate window's opening message for a change — the sibling of
 * `tui.ts`'s `iteratePrompt`. Lists the change's planning files as initial
 * context; edits happen through OpenSpec authoring commands inside the session,
 * not by Convoy. Single line because the whole command travels through `zsh -lc`.
 */
export function specsIteratePrompt(changeID: string, files: readonly string[]): string {
  const list = files.length > 0 ? files.join(", ") : `openspec/changes/${changeID}/`
  return (
    `Continuing the OpenSpec change ${changeID}. First read these planning files: ${list}. ` +
    "proposal.md is the motivation, design.md the approach, tasks.md the checklist, and each delta spec under specs/ records what the change adds or modifies. " +
    "Revise the change with the OpenSpec authoring commands where my instructions ask. After reading, give a one-line status and wait for my instructions."
  )
}

/** The arguments handed to openIterateOpencodeWindow for an iterate handoff. */
export type IterateSessionInput = { targetDir: string; prompt: string; runDir: string }

/**
 * Builds the standalone-session opener input, rooted at the repository
 * directory (where the change's `openspec/changes/<id>/` lives). The run-dir
 * grant lets the session read its own planning files without prompting.
 */
export function buildIterateSessionInput(targetDir: string, view: SpecsView, changeID: string): IterateSessionInput {
  const change = view.changes.find((entry) => entry.id === changeID)
  const files = change?.artifacts.map((artifact) => artifact.file) ?? []
  return { targetDir, prompt: specsIteratePrompt(changeID, files), runDir: targetDir }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir)
    return true
  } catch {
    return false
  }
}

// ── artifact grouping (the board's reading level) ────────────────────────

/**
 * One reading-level group of a subject's artifacts. Delta specs always merge
 * into a single "Delta Specs" group no matter how many capabilities they span
 * — the tab strip stays short and the merged source carries per-capability
 * headings (design D9).
 */
export type SpecGroup = {
  label: string
  /** True when this group merges delta specs across capabilities. */
  delta: boolean
  entries: Array<{ file: string; capability?: string }>
}

/**
 * Groups a change's artifacts into the reading level's stable order:
 * Proposal, Design, Tasks, one merged Delta Specs, then Other. A change with
 * a single group hides the tab strip entirely in the browser.
 */
export function groupChangeArtifacts(change: SpecsChangeEntry): SpecGroup[] {
  const groups: SpecGroup[] = []
  const byLabel = new Map<string, SpecGroup>()
  for (const artifact of change.artifacts) {
    const label = specArtifactLabel(artifact.section, artifact.section === "delta" ? undefined : artifact.capability)
    let group = byLabel.get(label)
    if (!group) {
      group = { label, delta: artifact.section === "delta", entries: [] }
      byLabel.set(label, group)
      groups.push(group)
    }
    group.entries.push({ file: artifact.file, ...(artifact.capability ? { capability: artifact.capability } : {}) })
  }
  return groups
}

/**
 * Builds the one source string a group's readers share — the detail pane's
 * markdown and the copy-to-clipboard payload are the same bytes. Delta groups
 * inject a small heading naming each capability before that capability's
 * files, so a merged tab still says what came from where.
 */
export function specGroupSource(group: SpecGroup, bodyOf: (file: string) => string): string {
  const parts: string[] = []
  for (const entry of group.entries) {
    const body = bodyOf(entry.file)
    if (group.delta && entry.capability) parts.push(`## ${entry.capability}\n\n${body}`)
    else parts.push(body)
  }
  return parts.join("\n\n")
}
