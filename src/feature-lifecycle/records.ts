import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import {
  isSafePathSegment,
  isSafeRelativePath,
  isUuid,
  lifecycleSchemaVersion,
  readJsonFile,
  writeJsonFile,
  type StoreRead,
} from "./store"

/**
 * The feature record (capability `feature-lifecycle`, design D1/D2): the
 * durable association between one stable feature identity and its explicit
 * change-contract set, intended base, and current implementation context —
 * plus the history pointers that let discovery, close, and run history join
 * on identity instead of branch spelling.
 *
 * The record stores associations and evidence references only. It never
 * stores `ready`, `integrated`, or `clean` as authoritative facts: those are
 * derived at read time from Git/OpenSpec/run evidence (design D5), so an
 * external Git action can never be contradicted by a cached status.
 */

export type ContractSourceKind = "active" | "archive"

/** One selected change contract within a feature's reviewed set (design D2). */
export type FeatureContract = {
  changeId: string
  /** `active`: a live `openspec/changes/<id>/` tree; `archive`: an archived source. */
  kind: ContractSourceKind
  /**
   * The repo-relative planning path the contract was selected from —
   * `openspec/changes/<id>` for active sources, `openspec/archive/...` for
   * archived ones. Paths are stored as given, resolved and validated
   * (within the planning root) before use (design D7: never interpolate
   * unchecked branch spelling into paths).
   */
  sourcePath: string
  /** Where the selection came from (spin, adopt, revise, launch review). */
  provenance: string
  /** Association revision that selected this contract. */
  selectedAtRevision: number
}

/** The current implementation context: one branch checked out in one worktree (design D2). */
export type FeatureContext = {
  branch: string
  /** Absolute canonical checkout path, when known. */
  checkoutPath?: string
  /** Git's worktree administrative identity, when exposed. */
  worktreeIdentity?: string
}

/** One historical association observation (rebinding, rename, move). */
export type AssociationEvent = {
  at: number
  kind: "created" | "adopted" | "bound" | "revised" | "new-work" | "recovered"
  summary: string
  revision: number
}

/** The durable feature record (design D1). */
export type FeatureRecord = {
  schemaVersion: number
  featureId: string
  repositoryId: string
  /** Operator-facing display name; never an identity key. */
  displayName: string
  /** Monotonically increasing; optimistic-concurrency token for association edits. */
  associationRevision: number
  contracts: FeatureContract[]
  /** The intended local base ref (branch name), not a permanently frozen SHA (design D1). */
  intendedBaseRef: string
  /** The current context, when one is associated. */
  context?: FeatureContext
  /** Durable run IDs linked to this feature (written before execution). */
  runIds: string[]
  /** Close attempt IDs ever opened for this feature (completed or pending). */
  closeAttemptIds: string[]
  history: AssociationEvent[]
  createdAt: number
  updatedAt: number
}

export function validateFeatureRecord(value: unknown): FeatureRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== lifecycleSchemaVersion) return undefined
  if (typeof record.featureId !== "string" || !isUuid(record.featureId)) return undefined
  if (typeof record.repositoryId !== "string" || !isUuid(record.repositoryId)) return undefined
  if (typeof record.displayName !== "string" || record.displayName === "") return undefined
  if (typeof record.associationRevision !== "number" || !Number.isInteger(record.associationRevision) || record.associationRevision < 1) return undefined
  if (typeof record.intendedBaseRef !== "string" || record.intendedBaseRef === "") return undefined
  if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return undefined
  if (!Array.isArray(record.contracts) || !Array.isArray(record.runIds) || !Array.isArray(record.closeAttemptIds) || !Array.isArray(record.history)) return undefined
  const contracts: FeatureContract[] = []
  for (const entry of record.contracts) {
    if (typeof entry !== "object" || entry === null) return undefined
    const contract = entry as Record<string, unknown>
    if (typeof contract.changeId !== "string" || contract.changeId === "" || !isSafePathSegment(contract.changeId)) return undefined
    if (contract.kind !== "active" && contract.kind !== "archive") return undefined
    if (typeof contract.sourcePath !== "string" || contract.sourcePath === "" || !isSafeRelativePath(contract.sourcePath)) return undefined
    if (typeof contract.provenance !== "string" || typeof contract.selectedAtRevision !== "number") return undefined
    contracts.push({
      changeId: contract.changeId,
      kind: contract.kind,
      sourcePath: contract.sourcePath,
      provenance: contract.provenance,
      selectedAtRevision: contract.selectedAtRevision,
    })
  }
  const events: AssociationEvent[] = []
  for (const entry of record.history) {
    if (typeof entry !== "object" || entry === null) return undefined
    const event = entry as Record<string, unknown>
    if (typeof event.at !== "number" || typeof event.kind !== "string" || typeof event.summary !== "string" || typeof event.revision !== "number") return undefined
    events.push({ at: event.at, kind: event.kind as AssociationEvent["kind"], summary: event.summary, revision: event.revision })
  }
  let context: FeatureContext | undefined
  if (record.context !== undefined) {
    if (typeof record.context !== "object" || record.context === null) return undefined
    const raw = record.context as Record<string, unknown>
    if (typeof raw.branch !== "string" || raw.branch === "") return undefined
    context = {
      branch: raw.branch,
      ...(typeof raw.checkoutPath === "string" ? { checkoutPath: raw.checkoutPath } : {}),
      ...(typeof raw.worktreeIdentity === "string" ? { worktreeIdentity: raw.worktreeIdentity } : {}),
    }
  }
  return {
    schemaVersion: lifecycleSchemaVersion,
    featureId: record.featureId,
    repositoryId: record.repositoryId,
    displayName: record.displayName,
    associationRevision: record.associationRevision,
    contracts,
    intendedBaseRef: record.intendedBaseRef,
    ...(context ? { context } : {}),
    runIds: record.runIds.filter((entry): entry is string => typeof entry === "string"),
    closeAttemptIds: record.closeAttemptIds.filter((entry): entry is string => typeof entry === "string"),
    history: events,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }
}

export function featureDir(commonDir: string, featureId: string): string {
  return join(commonDir, "convoy", "features", featureId)
}

function featureRecordPath(commonDir: string, featureId: string): string {
  return join(featureDir(commonDir, featureId), "feature.json")
}

/** Reads one feature record; a foreign record (embedded IDs that disagree with its path) is corrupt. */
export async function readFeatureRecord(commonDir: string, featureId: string): Promise<StoreRead<FeatureRecord>> {
  const read = await readJsonFile(featureRecordPath(commonDir, featureId), validateFeatureRecord, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
  if (read.status === "found" && (read.value.featureId !== featureId || !isUuid(featureId))) {
    return { status: "corrupt", reason: "embedded identity disagrees with the record's location" }
  }
  return read
}

/**
 * Lists every feature ID present in the store. A directory whose name is not
 * a UUID is skipped — that is not a feature, and guessing otherwise would
 * alias foreign data (design D10). Read-only: never creates anything.
 */
export async function listFeatureIds(commonDir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(join(commonDir, "convoy", "features"), { withFileTypes: true })
  } catch {
    return []
  }
  return entries.filter((entry) => entry.isDirectory() && isUuid(entry.name)).map((entry) => entry.name).sort()
}

/** Reads every feature record; unreadable/corrupt records are surfaced as typed failures, not dropped. */
export async function listFeatureRecords(commonDir: string): Promise<Array<{ featureId: string; read: StoreRead<FeatureRecord> }>> {
  const ids = await listFeatureIds(commonDir)
  return Promise.all(ids.map(async (featureId) => ({ featureId, read: await readFeatureRecord(commonDir, featureId) })))
}

/**
 * Persists a feature record, refusing a lost update: the caller names the
 * revision it based its edit on, and a record already past that revision is
 * left untouched (capability feature-lifecycle: concurrent association edits).
 * `expectedRevision: 0` means "create new".
 */
export async function writeFeatureRecord(
  commonDir: string,
  record: FeatureRecord,
  expectedRevision: number,
): Promise<StoreRead<FeatureRecord>> {
  const current = await readFeatureRecord(commonDir, record.featureId)
  const onDisk = current.status === "found" ? current.value.associationRevision : 0
  if (onDisk !== expectedRevision) return current.status === "found" ? current : { status: "corrupt", reason: "unexpected on-disk state" }
  await writeJsonFile(featureRecordPath(commonDir, record.featureId), record)
  return { status: "found", value: record }
}

// ── close attempts (journals) and receipts ───────────────────────────────

/**
 * The identity-keyed close attempt journal (design D8): a versioned record
 * naming feature/attempt explicitly, capturing intent before each mutation
 * and verified outcomes after it. Unlike the legacy branch/change-keyed
 * journal (`close-journal.ts`), filenames are opaque attempt UUIDs, so
 * renames, reused branch names, and multi-contract closes cannot collide or
 * overwrite one another.
 */
/**
 * One canonical-spec effect the archive must prove, snapshotted from the
 * change's own delta specs BEFORE the OpenSpec CLI runs. Resume validates
 * against this persisted snapshot — never against the archived copy, which
 * the operator could edit after the fact (task 7.2).
 */
export type RequiredEffect = {
  kind: "present" | "absent"
  capability: string
  name: string
  scenarios: string[]
}

export type CloseAttemptPhase =
  | "resolved"
  | "sync-intent"
  | "sync-verified"
  | "archive-intent"
  | "archive-verified"
  | "prepared"
  | "candidate"
  | "landed"

export type CloseAttemptJournal = {
  schemaVersion: number
  attemptId: string
  featureId: string
  repositoryId: string
  /** The association revision the attempt validated against. */
  associationRevision: number
  phase: CloseAttemptPhase
  contracts: Array<{ changeId: string; sourcePath: string; archiveCommitted: boolean; requiredEffects?: RequiredEffect[] }>
  baseRef: string
  baseSha: string
  branch: string
  worktreeDir?: string
  preSyncTip?: string
  postArchiveTip?: string
  preparedTree?: string
  messageContext?: { proposalExcerpt?: string; scopeCandidates: string[]; commitSubjects: string[] }
  message?: string
  candidateSha?: string
  landingSha?: string
  /** Whether the base checkout has been materialized onto the landed ref (task 7.5). */
  checkoutMaterialized?: boolean
  recordedAt: number
  updatedAt: number
}

function attemptJournalPath(commonDir: string, featureId: string, attemptId: string): string {
  return join(featureDir(commonDir, featureId), "attempts", attemptId, "journal.json")
}

export function validateAttemptJournal(value: unknown): CloseAttemptJournal | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const journal = value as Record<string, unknown>
  if (journal.schemaVersion !== lifecycleSchemaVersion) return undefined
  if (typeof journal.attemptId !== "string" || !isUuid(journal.attemptId)) return undefined
  if (typeof journal.featureId !== "string" || !isUuid(journal.featureId)) return undefined
  if (typeof journal.repositoryId !== "string" || !isUuid(journal.repositoryId)) return undefined
  if (typeof journal.associationRevision !== "number") return undefined
  const phase = journal.phase
  const phases: readonly string[] = ["resolved", "sync-intent", "sync-verified", "archive-intent", "archive-verified", "prepared", "candidate", "landed"]
  if (typeof phase !== "string" || !phases.includes(phase)) return undefined
  if (typeof journal.baseRef !== "string" || typeof journal.baseSha !== "string" || typeof journal.branch !== "string") return undefined
  if (!Array.isArray(journal.contracts)) return undefined
  if (typeof journal.recordedAt !== "number" || typeof journal.updatedAt !== "number") return undefined
  let messageContext: CloseAttemptJournal["messageContext"]
  if (journal.messageContext !== undefined) {
    if (typeof journal.messageContext !== "object" || journal.messageContext === null) return undefined
    const raw = journal.messageContext as Record<string, unknown>
    messageContext = {
      ...(typeof raw.proposalExcerpt === "string" ? { proposalExcerpt: raw.proposalExcerpt } : {}),
      scopeCandidates: Array.isArray(raw.scopeCandidates) ? raw.scopeCandidates.filter((entry): entry is string => typeof entry === "string") : [],
      commitSubjects: Array.isArray(raw.commitSubjects) ? raw.commitSubjects.filter((entry): entry is string => typeof entry === "string") : [],
    }
  }
  const optional = (key: keyof typeof journal): string | undefined => {
    const value = journal[key]
    return typeof value === "string" && value !== "" ? value : undefined
  }
  return {
    schemaVersion: lifecycleSchemaVersion,
    attemptId: journal.attemptId,
    featureId: journal.featureId,
    repositoryId: journal.repositoryId,
    associationRevision: journal.associationRevision,
    phase: phase as CloseAttemptPhase,
    contracts: (journal.contracts as unknown[]).flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return []
      const contract = entry as Record<string, unknown>
      if (typeof contract.changeId !== "string" || !isSafePathSegment(contract.changeId)) return []
      if (typeof contract.sourcePath !== "string" || !isSafeRelativePath(contract.sourcePath)) return []
      let requiredEffects: RequiredEffect[] | undefined
      if (Array.isArray(contract.requiredEffects)) {
        const parsed: RequiredEffect[] = []
        for (const effect of contract.requiredEffects) {
          if (typeof effect !== "object" || effect === null) continue
          const raw = effect as Record<string, unknown>
          if ((raw.kind !== "present" && raw.kind !== "absent") || typeof raw.capability !== "string" || !isSafePathSegment(raw.capability) || typeof raw.name !== "string") continue
          parsed.push({
            kind: raw.kind,
            capability: raw.capability,
            name: raw.name,
            scenarios: Array.isArray(raw.scenarios) ? raw.scenarios.filter((scenario): scenario is string => typeof scenario === "string") : [],
          })
        }
        requiredEffects = parsed
      }
      return [{
        changeId: contract.changeId,
        sourcePath: contract.sourcePath,
        archiveCommitted: contract.archiveCommitted === true,
        ...(requiredEffects ? { requiredEffects } : {}),
      }]
    }),
    baseRef: journal.baseRef,
    baseSha: journal.baseSha,
    branch: journal.branch,
    ...(optional("worktreeDir") ? { worktreeDir: optional("worktreeDir") } : {}),
    ...(optional("preSyncTip") ? { preSyncTip: optional("preSyncTip") } : {}),
    ...(optional("postArchiveTip") ? { postArchiveTip: optional("postArchiveTip") } : {}),
    ...(optional("preparedTree") ? { preparedTree: optional("preparedTree") } : {}),
    ...(messageContext ? { messageContext } : {}),
    ...(optional("message") ? { message: optional("message") } : {}),
    ...(optional("candidateSha") ? { candidateSha: optional("candidateSha") } : {}),
    ...(optional("landingSha") ? { landingSha: optional("landingSha") } : {}),
    ...(typeof journal.checkoutMaterialized === "boolean" ? { checkoutMaterialized: journal.checkoutMaterialized } : {}),
    recordedAt: journal.recordedAt,
    updatedAt: journal.updatedAt,
  }
}

export async function readAttemptJournal(
  commonDir: string,
  featureId: string,
  attemptId: string,
): Promise<StoreRead<CloseAttemptJournal>> {
  const read = await readJsonFile(attemptJournalPath(commonDir, featureId, attemptId), validateAttemptJournal, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
  if (read.status === "found" && (read.value.featureId !== featureId || read.value.attemptId !== attemptId)) {
    return { status: "corrupt", reason: "embedded identity disagrees with the record's location" }
  }
  return read
}

export async function writeAttemptJournal(commonDir: string, journal: CloseAttemptJournal): Promise<void> {
  await writeJsonFile(attemptJournalPath(commonDir, journal.featureId, journal.attemptId), journal)
}

/** Lists a feature's attempt IDs (read-only). */
export async function listAttemptIds(commonDir: string, featureId: string): Promise<string[]> {
  try {
    const entries = await readdir(join(featureDir(commonDir, featureId), "attempts"), { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() && isUuid(entry.name)).map((entry) => entry.name).sort()
  } catch {
    return []
  }
}

// ── receipts ──────────────────────────────────────────────────────────────

/**
 * The immutable verified landing receipt (design D8/D9): written once, after
 * the landing is verified, and never overwritten — later attempts and
 * no-change outcomes must not clobber it (capability feature-lifecycle:
 * completed landing receipts are durable).
 */
export type LandingReceipt = {
  schemaVersion: number
  attemptId: string
  featureId: string
  repositoryId: string
  associationRevision: number
  branch: string
  baseRef: string
  baseSha: string
  /** The exact prepared feature tip the landing was built from. */
  featureTip: string
  preparedTree: string
  candidateSha: string
  landingSha: string
  landingAt: number
}

function receiptPath(commonDir: string, featureId: string, attemptId: string): string {
  return join(featureDir(commonDir, featureId), "receipts", `${attemptId}.json`)
}

export function validateReceipt(value: unknown): LandingReceipt | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const receipt = value as Record<string, unknown>
  if (receipt.schemaVersion !== lifecycleSchemaVersion) return undefined
  for (const key of ["attemptId", "featureId", "repositoryId", "branch", "baseRef", "baseSha", "featureTip", "preparedTree", "candidateSha", "landingSha"] as const) {
    if (typeof receipt[key] !== "string" || receipt[key] === "") return undefined
  }
  if (!isUuid(receipt.attemptId as string) || !isUuid(receipt.featureId as string) || !isUuid(receipt.repositoryId as string)) return undefined
  if (typeof receipt.associationRevision !== "number" || typeof receipt.landingAt !== "number") return undefined
  return {
    schemaVersion: lifecycleSchemaVersion,
    attemptId: receipt.attemptId as string,
    featureId: receipt.featureId as string,
    repositoryId: receipt.repositoryId as string,
    associationRevision: receipt.associationRevision,
    branch: receipt.branch as string,
    baseRef: receipt.baseRef as string,
    baseSha: receipt.baseSha as string,
    featureTip: receipt.featureTip as string,
    preparedTree: receipt.preparedTree as string,
    candidateSha: receipt.candidateSha as string,
    landingSha: receipt.landingSha as string,
    landingAt: receipt.landingAt,
  }
}

export async function readReceipt(commonDir: string, featureId: string, attemptId: string): Promise<StoreRead<LandingReceipt>> {
  const read = await readJsonFile(receiptPath(commonDir, featureId, attemptId), validateReceipt, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
  if (read.status === "found" && (read.value.featureId !== featureId || read.value.attemptId !== attemptId)) {
    return { status: "corrupt", reason: "embedded identity disagrees with the record's location" }
  }
  return read
}

/**
 * Writes a receipt create-only: an existing receipt file for the same
 * attempt is never overwritten (immutability). The write lands through a
 * rename, so a torn file can never exist at the final path.
 */
export async function writeReceiptIfAbsent(commonDir: string, receipt: LandingReceipt): Promise<boolean> {
  const path = receiptPath(commonDir, receipt.featureId, receipt.attemptId)
  try {
    await stat(path)
    return false
  } catch {
    // Absent: proceed with the create.
  }
  await writeJsonFile(path, receipt)
  return true
}

/** Lists a feature's receipt IDs (read-only). */
export async function listReceiptIds(commonDir: string, featureId: string): Promise<string[]> {
  try {
    const entries = await readdir(join(featureDir(commonDir, featureId), "receipts"), { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name.replace(/\.json$/, "")).sort()
  } catch {
    return []
  }
}

/**
 * Whether a feature has completed: a verified landing receipt exists naming
 * the feature (task 8.2/D2). Completion releases the feature's context
 * claim, so a new feature may reuse the branch through the explicit
 * new-work decision.
 */
export async function isCompletedFeature(commonDir: string, feature: Pick<FeatureRecord, "featureId">): Promise<boolean> {
  const receiptIds = await listReceiptIds(commonDir, feature.featureId)
  return receiptIds.length > 0
}
