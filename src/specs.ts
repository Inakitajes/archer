import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { stdin, stdout } from "node:process"

import {
  collectDirRelativeMarkdown,
  isOpenSpecChangeId,
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
  /** False when the target repo has no `openspec/` directory at all. */
  present: boolean
  changes: SpecsChangeEntry[]
  specs: string[]
}

/**
 * What the specs browser can ask Convoy to do next. Action-shaped so later
 * actions fit without reshaping call sites (same pattern as RunsResolution).
 */
export type SpecsResolution =
  | { type: "exit" }
  | { type: "apply-change"; changeID: string }
  | { type: "iterate-change"; changeID: string }

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
 * still lists by id; unreadable files never throw.
 */
export async function loadSpecsView(targetDir: string): Promise<SpecsView> {
  const openspecRoot = join(targetDir, openspecDirName)
  if (!(await dirExists(openspecRoot))) return { present: false, changes: [], specs: [] }

  const changesDir = join(openspecRoot, "changes")
  const ids = (await listChangeDirs(changesDir)).filter(isOpenSpecChangeId)
  const changes = await Promise.all(ids.map((id) => loadSpecsChange(changesDir, id)))

  // Relative to the repo root so detail views can read straight off it.
  const specs = await collectDirRelativeMarkdown(join(openspecRoot, "specs"), join(openspecDirName, "specs"))
  return { present: true, changes, specs }
}

async function loadSpecsChange(changesDir: string, id: string): Promise<SpecsChangeEntry> {
  const changeRoot = join(changesDir, id)
  let title = id
  try {
    const body = await readFile(join(changeRoot, "proposal.md"), "utf8")
    title = titleFromProposal(body, id)
  } catch {
    // A change without a readable proposal still lists by its id.
  }
  const relatives = await collectDirRelativeMarkdown(changeRoot, ".")
  const artifacts = relatives.map((relative) => ({
    ...classifySpecArtifact(relative),
    file: join(openspecDirName, "changes", id, relative),
  }))
  artifacts.sort((a, b) => sectionOrder[a.section] - sectionOrder[b.section] || a.file.localeCompare(b.file))
  return { kind: "change", id, title, artifacts }
}

/**
 * Plain-text listing for pipes and CI: active changes with their artifact
 * inventory first, canonical specs below. No colors, no control sequences.
 */
export function printSpecsList(view: SpecsView): void {
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
export async function browseSpecs(targetDir: string): Promise<SpecsResolution> {
  const view = await loadSpecsView(targetDir)
  if (!view.present || (view.changes.length === 0 && view.specs.length === 0)) {
    stdout.write(`no specs found under ${join(targetDir, openspecDirName)}\n`)
    return { type: "exit" }
  }
  if (!stdin.isTTY || !stdout.isTTY) {
    printSpecsList(view)
    return { type: "exit" }
  }
  const { browseSpecsTui } = await import("./specs-browser")
  return browseSpecsTui(view)
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

/**
 * Real (non-symlink) directory entries of `openspec/changes/`, sorted. Stray
 * files are skipped here and dotfiles/archive by `isOpenSpecChangeId`.
 */
async function listChangeDirs(dir: string): Promise<string[]> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    return dirents.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}
