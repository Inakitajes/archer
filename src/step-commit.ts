import { createHash } from "node:crypto"
import { readFile, rename, writeFile } from "node:fs/promises"

import { capSubjectWithin, maxCommitSubjectLength, stripControlBytes } from "./commit-text"
import type { StagedChangeEvidence } from "./git"
import { isValidRunID, type Workspace } from "./workspace"

/**
 * The message an intermediate Convoy commit carries (capability
 * `step-commit-messages`, design D1):
 *
 * ```text
 * convoy(<step>): <semantic subject>
 *
 * - <concrete detail>
 *
 * Convoy-Run: <complete run ID>
 * ```
 *
 * This module owns the format and is deliberately independent of `runner.ts`
 * and the final squash composer (`commit-message.ts`): it only normalizes,
 * bounds, and renders text, so normal finalization, interrupted recovery, and
 * human-iteration commits all produce byte-for-byte comparable messages.
 */

/** The structured commit description a writable phase may submit with its report. */
export type StepCommitDescription = {
  subject: string
  details?: string[]
}

/** How the commit came to be; only the fallback subject and details differ. */
export type StepCommitMode = "phase" | "recovery" | "human"

/** The subject budget details are bounded to (design D1). */
export const maxStepDetailLength = 120
export const maxStepDetails = 3

/** Conservative input-size limits at the tool boundary; the renderer bounds further. */
export const maxCommitDescriptionFieldLength = 300

/** The trailer Convoy appends to every intermediate commit; Convoy, not agent content, owns the value. */
export const convoyRunTrailerKey = "Convoy-Run"

/**
 * Boundary validation for the optional `commit` payload of `write_report`
 * (design D2): a non-empty single-line subject and zero to three non-empty
 * single-line details. Oversized but structurally valid prose is left for the
 * renderer to bound; multiline or over-count input is rejected so the phase
 * can correct and resubmit while its turn is still open.
 */
export function validateCommitDescription(value: unknown): { commit: StepCommitDescription } | { error: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "commit must be an object with a subject" }
  const record = value as Record<string, unknown>
  const subjectError = singleLineFieldError(record.subject, "commit.subject")
  if (subjectError) return { error: subjectError }
  if (!("details" in record) || record.details === undefined) {
    return { commit: { subject: (record.subject as string).trim() } }
  }
  if (!Array.isArray(record.details)) return { error: "commit.details must be an array of strings" }
  if (record.details.length > maxStepDetails) return { error: `commit.details must contain at most ${maxStepDetails} entries` }
  const details: string[] = []
  for (const [index, detail] of record.details.entries()) {
    const error = singleLineFieldError(detail, `commit.details[${index}]`)
    if (error) return { error }
    details.push((detail as string).trim())
  }
  return { commit: { subject: (record.subject as string).trim(), details } }
}

function singleLineFieldError(value: unknown, label: string): string | undefined {
  if (typeof value !== "string") return `${label} must be a string`
  const trimmed = value.trim()
  if (trimmed === "") return `${label} must be a non-empty string`
  if (/[\n\r]/.test(value)) return `${label} must be a single line`
  if (value.length > maxCommitDescriptionFieldLength) {
    return `${label} must be at most ${maxCommitDescriptionFieldLength} characters`
  }
  return undefined
}

/**
 * Collapses untrusted text to one safe subject line: control bytes and ANSI
 * sequences stripped, heading markers removed, line breaks and repeated
 * whitespace collapsed, surrounding quotes and trailing punctuation dropped.
 */
export function normalizeCommitLine(value: string): string {
  return stripControlBytes(value)
    .replace(/^#+\s*/, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[`'"]+|[`'"]+$/g, "")
    .replace(/\.+$/, "")
    .trim()
}

/** Detail lines lose their line breaks; a trailer-shaped detail is dropped entirely so the run trailer stays authoritative. */
function normalizeDetailLine(value: string): string {
  const collapsed = stripControlBytes(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "")
    .trim()
  if (new RegExp(`^${convoyRunTrailerKey}\\s*:`, "i").test(collapsed)) return ""
  return capSubjectWithin("", collapsed, maxStepDetailLength)
}

/** Role/process labels a report's first line may reduce to; exact after normalization. */
const genericReportLabels = new Set([
  "report",
  "test report",
  "tests report",
  "security audit",
  "adversarial review",
  "design polish",
  "quality score",
  "quality score report",
  "quality-score report",
  "quality report",
  "recovered uncommitted changes",
  "human step",
  "prd report",
  "scope report",
])

/** Role words whose bare `<role> report` heading carries no repository outcome. */
const genericReportRoles = new Set([
  "implementer",
  "reviewer",
  "advisor",
  "verifier",
  "scorer",
  "orchestrator",
  "runner",
  "human",
  "phase",
  "agent",
  "step",
  "test",
  "security",
  "design",
  "scope",
  "prd",
  "tests",
  "adversary",
  "judge",
])

/**
 * Whether a normalized report line is only a role/process label (design D4).
 * Deliberately narrow and exact: `<phase> report`, `test report`, `security
 * audit`, `adversarial review`, `design polish`, and the phase's own name plus
 * "report". A label followed by a concrete suffix remains useful.
 */
export function isGenericReportLabel(line: string, phaseName?: string): boolean {
  const normalized = normalizeCommitLine(line).toLowerCase()
  if (!normalized) return false
  if (genericReportLabels.has(normalized)) return true
  if (phaseName) {
    const lowered = phaseName.toLowerCase()
    if (normalized === lowered || normalized === `${lowered} report`) return true
  }
  const roleReport = /^([\w-]+) report$/.exec(normalized)
  return roleReport ? genericReportRoles.has(roleReport[1]!) : false
}

/** The hierarchy's second source: the report's first useful, non-generic line (design D4). */
export function subjectFromReport(report: string, phaseName?: string): string | undefined {
  for (const raw of report.split("\n")) {
    const line = normalizeCommitLine(raw)
    if (!line) continue
    if (isGenericReportLabel(line, phaseName)) return undefined
    return capSubjectWithin("", line, maxCommitSubjectLength)
  }
  return undefined
}

/**
 * The hierarchy's third source, built from the exact staged change set after
 * `git add -A` (design D5): one path becomes `update <path>`, several become
 * their common directory or a file count. Up to three status/path entries
 * become deterministic detail bullets.
 */
export function descriptionFromStagedEvidence(evidence: StagedChangeEvidence): { subject: string; details: string[] } | undefined {
  const paths = evidence.paths.filter(Boolean)
  if (paths.length === 0) return undefined

  const details = evidence.statuses
    .map((status, index) => `${status} ${paths[index] ?? ""}`.trim())
    .slice(0, maxStepDetails)

  if (paths.length === 1) return { subject: `update ${paths[0]!}`, details }

  const area = commonDirectory(paths)
  const subject = area ? `update ${area}/` : `update ${paths.length} files`
  return { subject, details }
}

/** The longest common leading directory of the staged paths, or undefined when they share none. */
function commonDirectory(paths: readonly string[]): string | undefined {
  const split = paths.map((path) => path.split("/"))
  if (split.some((parts) => parts.length < 2)) return undefined
  let common = split[0]!.slice(0, -1)
  for (const parts of split.slice(1)) {
    let index = 0
    while (index < common.length && common[index] === parts[index]) index++
    common = common.slice(0, index)
    if (common.length === 0) return undefined
  }
  return common.join("/")
}

/** The honest per-mode fallbacks (design D4): no source failure blocks the commit. */
const fallbackSubjects: Record<StepCommitMode, string> = {
  phase: "apply phase changes",
  recovery: "recover interrupted phase changes",
  human: "apply manual changes",
}

export type StepCommitContext = {
  runID: string
  step: string
  /** The agent name, used only to recognize the phase's own generic report label. */
  phaseName?: string
  mode: StepCommitMode
  /** The persisted Markdown report, when one exists. */
  report?: string
  /** A hash-matched structured description from the report sidecar, when one loaded. */
  structured?: StepCommitDescription
}

/**
 * Selects the commit description in the hierarchy's order (design D4):
 * structured data, useful report content, staged-change evidence, then the
 * mode's honest fallback. Staged evidence still contributes detail bullets for
 * every non-structured source, since git knows exactly what entered the commit.
 */
export function composeStepCommitDescription(context: StepCommitContext, evidence: StagedChangeEvidence = { paths: [], statuses: [] }): StepCommitDescription {
  if (context.structured) return context.structured

  const details = evidence.statuses
    .map((status, index) => normalizeDetailLine(`${status} ${evidence.paths[index] ?? ""}`))
    .filter(Boolean)
    .slice(0, maxStepDetails)

  const reportSubject = subjectFromReport(context.report ?? "", context.phaseName)
  if (reportSubject) return details.length > 0 ? { subject: reportSubject, details } : { subject: reportSubject }

  const fromEvidence = descriptionFromStagedEvidence(evidence)
  if (fromEvidence) {
    const merged = (fromEvidence.details.length > 0 ? fromEvidence.details : details).map(normalizeDetailLine).filter(Boolean).slice(0, maxStepDetails)
    return merged.length > 0 ? { subject: fromEvidence.subject, details: merged } : { subject: fromEvidence.subject }
  }

  return details.length > 0 ? { subject: fallbackSubjects[context.mode], details } : { subject: fallbackSubjects[context.mode] }
}

export type StepCommitMessageFactoryInput = {
  workspace: Workspace
  step: string
  mode: StepCommitMode
  /** The agent name, used only to recognize the phase's own generic report label. */
  phaseName?: string
  /** The phase report's absolute path inside the workspace, when one exists. */
  reportPath?: string
}

/**
 * Builds the asynchronous message factory `addAllAndCommit` invokes after
 * staging (designs D5/D6). The factory closes over run ID, step identity,
 * report path, and mode; loads the hash-matched sidecar and the persisted
 * report; composes through the source hierarchy; and renders with exactly one
 * authoritative `Convoy-Run` trailer. An agent cannot override provenance
 * through report content: only Convoy decides the trailer value.
 */
export function stepCommitMessageFactory(input: StepCommitMessageFactoryInput): (evidence: StagedChangeEvidence) => Promise<string> {
  return async (evidence: StagedChangeEvidence) => {
    const report = input.reportPath ? await readFile(input.reportPath, "utf8").catch(() => undefined) : undefined
    const structured = input.reportPath ? await loadCommitSidecar(input.reportPath).catch(() => undefined) : undefined
    const description = composeStepCommitDescription(
      {
        runID: input.workspace.runID,
        step: input.step,
        mode: input.mode,
        ...(input.phaseName ? { phaseName: input.phaseName } : {}),
        ...(report !== undefined ? { report } : {}),
        ...(structured ? { structured } : {}),
      },
      evidence,
    )
    return renderStepCommitMessage({ runID: input.workspace.runID, step: input.step, description })
  }
}

export type RenderStepCommitInput = {
  runID: string
  step: string
  description: StepCommitDescription
}

/**
 * Renders the final commit message. The renderer owns the complete
 * 72-character subject budget (including `convoy(<step>): `), bounds every
 * detail, and appends exactly one authoritative `Convoy-Run` trailer from the
 * validated workspace ID after all untrusted text has been normalized.
 */
export function renderStepCommitMessage(input: RenderStepCommitInput): string {
  const runID = input.runID.trim()
  if (!isValidRunID(runID)) throw new Error(`invalid run id for the ${convoyRunTrailerKey} trailer: ${runID}`)

  const step = stripControlBytes(input.step).trim()
  const prefix = `convoy(${step}): `
  const subject = capSubjectWithin(prefix, normalizeCommitLine(input.description.subject)) || "update"
  const details = (input.description.details ?? []).map(normalizeDetailLine).filter(Boolean).slice(0, maxStepDetails)

  const lines = [`${prefix}${subject}`, ""]
  if (details.length > 0) {
    lines.push(...details.map((detail) => `- ${detail}`), "")
  }
  lines.push(`${convoyRunTrailerKey}: ${runID}`)
  return lines.join("\n")
}

// --- Report-bound sidecar (design D3) -------------------------------------
export const commitSidecarSchemaVersion = 1

export type CommitSidecarEnvelope = {
  schemaVersion: number
  reportSha256: string
  commit?: StepCommitDescription
}

/** The private sidecar sits beside the report inside the run directory; never staged in the target repo. */
export function sidecarPathFor(reportPath: string): string {
  return `${reportPath}.commit.json`
}

/**
 * Atomically records the envelope for a successful report write. Every
 * successful write records an envelope — even without a commit description —
 * so an older description can never silently survive a later report revision.
 */
export async function writeCommitSidecar(reportPath: string, commit?: StepCommitDescription): Promise<void> {
  const envelope: CommitSidecarEnvelope = {
    schemaVersion: commitSidecarSchemaVersion,
    reportSha256: await sha256File(reportPath),
    ...(commit ? { commit } : {}),
  }
  const sidecarPath = sidecarPathFor(reportPath)
  const tmpPath = `${sidecarPath}.${crypto.randomUUID()}.tmp`
  await writeFile(tmpPath, JSON.stringify(envelope, null, 2), { mode: 0o600 })
  await rename(tmpPath, sidecarPath)
}

/**
 * Loads the sidecar only when its schema and fields validate and its report
 * hash equals the current persisted report. A missing, stale, malformed, or
 * partially updated sidecar returns undefined and activates fallback
 * composition — a crash between the two atomic renames degrades message
 * quality rather than pairing the wrong description with a commit.
 */
export async function loadCommitSidecar(reportPath: string): Promise<StepCommitDescription | undefined> {
  let raw: string
  try {
    raw = await readFile(sidecarPathFor(reportPath), "utf8")
  } catch {
    return undefined
  }
  let envelope: unknown
  try {
    envelope = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return undefined
  const record = envelope as Record<string, unknown>
  if (record.schemaVersion !== commitSidecarSchemaVersion) return undefined
  if (typeof record.reportSha256 !== "string") return undefined
  if (record.commit === undefined) return undefined
  const validated = validateCommitDescription(record.commit)
  if (!("commit" in validated)) return undefined
  if ((await sha256File(reportPath)) !== record.reportSha256) return undefined
  return validated.commit
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex")
}
