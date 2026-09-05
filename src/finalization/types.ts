/**
 * Durable types for automatic run finalization (capability `run-finalization`,
 * design D2/D3): the run boundary persisted before any run-owned mutation, the
 * ordered phase/attempt commit ledger, the finalization outcome record, and the
 * recovery manifest written into the repository's Git common dir.
 *
 * Everything here is versioned and read backward-compatibly: a reader never
 * guesses a field it did not find, so legacy runs (no boundary, no ledger) stay
 * readable and finalization reports unavailable evidence instead of inventing
 * one. Pipeline results and compaction results are deliberately separate types —
 * a blocked or failed compaction must never masquerade as a pipeline failure.
 */

export const runBoundarySchemaVersion = 1
export const ledgerEntrySchemaVersion = 1
export const finalizationRecordSchemaVersion = 1
export const recoveryManifestSchemaVersion = 1

/** Where the run executed. Frozen at run start; a resume must find the same repository. */
export type RunBoundary = {
  schemaVersion: number
  /** Absolute path of the worktree the run executes in. */
  worktreeDir: string
  /** The checked-out branch at run start, or undefined when HEAD was detached. */
  branch?: string
  /** The commit HEAD pointed at when the run started; the run's exclusive lower bound. */
  startHead: string
  /** The repository's Git common dir, so evidence refs and manifests resolve across worktrees. */
  commonDir: string
  /** Whether the operator accepted including a dirty tree in the run's first commit. */
  includeDirty: boolean
  /** When the boundary was persisted. */
  recordedAt: number
}

/** How a recorded commit came to be; mirrors the step-commit modes. */
export type LedgerCommitMode = "phase" | "recovery" | "human"

/**
 * One Convoy-created intermediate commit, recorded before any rewrite can
 * consider it run-owned. `beforeSha`/`afterSha` chain across entries so the
 * ledger alone reconstructs the run's commit interval.
 */
export type CommitLedgerEntry = {
  schemaVersion: number
  mode: LedgerCommitMode
  /** The pipeline step (or human step) that produced the commit. */
  step: string
  /** HEAD immediately before the commit was created. */
  beforeSha: string
  /** The created commit; undefined for a no-change step that committed nothing. */
  afterSha?: string
  /** The tree of `afterSha`, so a net-zero interval is provable without walking commits. */
  afterTree?: string
  /** Set for a writable step that staged nothing (no commit, no entry gap). */
  noChange?: boolean
  recordedAt: number
}

/** The persisted outcome of one finalization attempt, independent of the pipeline result. */
export type FinalizationState = "pending" | "running" | "completed" | "skipped" | "blocked" | "failed"

/**
 * Why finalization ended where it did. `blocked` covers safety refusals that
 * preserved history (published commits, dirty tree, unsafe interval); `failed`
 * covers a transaction that could not be completed or reconciled.
 */
export type FinalizationRecord = {
  schemaVersion: number
  state: FinalizationState
  reason?: string
  /** The single operator-authored commit compaction produced, when completed with net content. */
  producedSha?: string
  producedMessage?: string
  /** Refs and manifest locations preserving the replaced history. */
  recoveryRef?: string
  manifestPath?: string
  /** Set when a transaction's safety could not be reconciled; publication must stay disabled. */
  recoveryRequired?: boolean
  updatedAt: number
}

/**
 * The per-run recovery evidence written into the Git common dir (design D3).
 * Deliberately compact: refs keep trees/blobs reachable through ordinary GC, so
 * the manifest only needs endpoints and pointers.
 */
export type RecoveryManifest = {
  schemaVersion: number
  runID: string
  /** Repository identity the manifest belongs to. */
  commonDir: string
  worktreeDir: string
  branch?: string
  /** HEAD at run start. */
  startHead: string
  /** HEAD immediately before compaction. */
  preCompactionHead: string
  /** The replaced current-run commits, oldest first. */
  replacedCommits: Array<{ sha: string; subject: string; step: string; mode: LedgerCommitMode }>
  /** Protected refs holding the original tips. */
  protectedRefs: string[]
  producedSha?: string
  /** How the interval ended relative to content: normal compaction or net-zero removal. */
  disposition: "compacted" | "no-net-change"
  recordedAt: number
}

/**
 * The cleanup-surviving run index entry under `<convoy-home>/run-records/`
 * (design D3): enough to rediscover a run's evidence after its disposable
 * workspace metadata is deleted.
 */
export type RunIndexEntry = {
  schemaVersion: number
  runID: string
  commonDir: string
  worktreeDir: string
  branch?: string
  manifestPath: string
  preCompactionHead?: string
  producedSha?: string
  finalization?: FinalizationRecord
  summary?: string
  recordedAt: number
  updatedAt: number
}

// --- Backward-compatible readers -------------------------------------------
// Every reader tolerates missing fields: a partial or legacy object yields a
// best-effort typed value, and garbage shapes yield undefined instead of
// throwing, so reading old metadata never breaks run discovery.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined
}

/** Reads a persisted boundary; undefined when the record predates boundaries or is malformed. */
export function readRunBoundary(value: unknown): RunBoundary | undefined {
  if (!isRecord(value)) return undefined
  const startHead = optionalString(value.startHead)
  if (!startHead) return undefined
  return {
    schemaVersion: runBoundarySchemaVersion,
    worktreeDir: optionalString(value.worktreeDir) ?? "",
    branch: optionalString(value.branch),
    startHead,
    commonDir: optionalString(value.commonDir) ?? "",
    includeDirty: value.includeDirty === true,
    recordedAt: typeof value.recordedAt === "number" ? value.recordedAt : 0,
  }
}

const ledgerModes: readonly LedgerCommitMode[] = ["phase", "recovery", "human"]

/** Reads one ledger entry; undefined for shapes the current code cannot interpret. */
export function readLedgerEntry(value: unknown): CommitLedgerEntry | undefined {
  if (!isRecord(value)) return undefined
  const mode = value.mode
  const beforeSha = optionalString(value.beforeSha)
  if (typeof mode !== "string" || !ledgerModes.includes(mode as LedgerCommitMode) || !beforeSha) return undefined
  const afterSha = optionalString(value.afterSha)
  const afterTree = optionalString(value.afterTree)
  return {
    schemaVersion: ledgerEntrySchemaVersion,
    mode: mode as LedgerCommitMode,
    step: optionalString(value.step) ?? "",
    beforeSha,
    ...(afterSha ? { afterSha } : {}),
    ...(afterTree ? { afterTree } : {}),
    ...(value.noChange === true ? { noChange: true } : {}),
    recordedAt: typeof value.recordedAt === "number" ? value.recordedAt : 0,
  }
}

/** Reads an ordered ledger, dropping malformed entries so one bad record cannot block finalization evidence wholesale. */
export function readCommitLedger(value: unknown): CommitLedgerEntry[] {
  if (!Array.isArray(value)) return []
  return value.map(readLedgerEntry).filter((entry): entry is CommitLedgerEntry => entry !== undefined)
}

const finalizationStates: readonly FinalizationState[] = ["pending", "running", "completed", "skipped", "blocked", "failed"]

/** Reads a finalization record; undefined when absent (legacy runs simply have no compaction outcome). */
export function readFinalizationRecord(value: unknown): FinalizationRecord | undefined {
  if (!isRecord(value)) return undefined
  const state = value.state
  if (typeof state !== "string" || !finalizationStates.includes(state as FinalizationState)) return undefined
  return {
    schemaVersion: finalizationRecordSchemaVersion,
    state: state as FinalizationState,
    reason: optionalString(value.reason),
    producedSha: optionalString(value.producedSha),
    producedMessage: optionalString(value.producedMessage),
    recoveryRef: optionalString(value.recoveryRef),
    manifestPath: optionalString(value.manifestPath),
    recoveryRequired: value.recoveryRequired === true,
    updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
  }
}
