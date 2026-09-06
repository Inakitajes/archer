import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { currentBranch, execFile, mainWorktreeDir } from "../git"
import { collectDirRelativeMarkdown, isOpenSpecChangeId, listChangeIds, openspecDirName } from "../openspec"
import { listRuns } from "../runs"
import { isFound, lifecycleCommonDir, type StoreRead } from "./store"
import {
  listAttemptIds,
  listFeatureIds,
  listReceiptIds,
  readAttemptJournal,
  readFeatureRecord,
  readReceipt,
  type CloseAttemptJournal,
  type FeatureRecord,
  type LandingReceipt,
} from "./records"

/**
 * Read-only lifecycle discovery (capability `feature-lifecycle`, design D6,
 * task 1.5): combines registered features, active change candidates,
 * referenced archive sources, legacy run/close evidence, and actual Git
 * worktrees into one observation snapshot — without writing, adopting, or
 * migrating anything. Browsing is never a mutation: the callers that change
 * the world are the explicit operations (`adopt`, `bind`, close, spin), and
 * this module has no write path by construction.
 */

export type DiscoveredWorktree = {
  dir: string
  branch?: string
  main: boolean
}

export type DiscoveredCandidate = {
  changeId: string
  /** The checkout that lists the change. */
  dir: string
  branch?: string
  main: boolean
  /** Whether the change tree carries any markdown (a husk carries none). */
  hasMarkdown: boolean
}

export type DiscoveredFeature = {
  featureId: string
  record: FeatureRecord
  attempts: Array<{ attemptId: string; journal: CloseAttemptJournal | undefined; journalStatus: StoreRead<CloseAttemptJournal>["status"] }>
  receipts: Array<{ attemptId: string; receipt: LandingReceipt | undefined }>
}

export type LegacyCloseEvidence = {
  branch: string
  changeId: string
  phase: string
}

export type Discovery = {
  /** True when the record set exists; false means nothing has ever been registered. */
  storePresent: boolean
  features: DiscoveredFeature[]
  /** Feature records that exist but could not be validated — surfaced, never dropped. */
  unreadableFeatures: Array<{ featureId: string; status: string; reason: string }>
  candidates: DiscoveredCandidate[]
  worktrees: DiscoveredWorktree[]
  legacyCloseEvidence: LegacyCloseEvidence[]
  /** Unknown when run history could not be read (design D5: failure ≠ empty). */
  runs: Array<{ runID: string; targetDir?: string; live: boolean }> | "unknown"
  runsError?: string
}

/** `git worktree list --porcelain`, parsed. */
export async function listWorktrees(cwd: string): Promise<DiscoveredWorktree[]> {
  const result = await execFile("git", ["worktree", "list", "--porcelain"], { cwd, allowFailure: true })
  if (result.exitCode !== 0) return []
  const out: DiscoveredWorktree[] = []
  let dir: string | undefined
  let branch: string | undefined
  const flush = () => {
    if (dir) out.push({ dir, ...(branch ? { branch } : {}), main: out.length === 0 })
    dir = undefined
    branch = undefined
  }
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length)
    else if (line.startsWith("branch refs/heads/")) branch = line.slice("branch refs/heads/".length)
    else if (line === "") flush()
  }
  flush()
  return out
}

/** Whether a change tree carries any markdown (shared husk rule). */
export async function changeHasMarkdown(checkoutDir: string, changeId: string): Promise<boolean> {
  const files = await collectDirRelativeMarkdown(join(checkoutDir, openspecDirName, "changes", changeId), ".")
  return files.length > 0
}

/**
 * One full discovery pass. Every read failure is represented (unknown runs,
 * unreadable features) instead of silently producing emptiness (design D5:
 * adapters surface unreadable evidence — task 2.2).
 */
export async function discoverLifecycle(input: { cwd: string; commonDir?: string }): Promise<Discovery> {
  const commonDir = input.commonDir ?? (await lifecycleCommonDir(input.cwd))
  const worktrees = await listWorktrees(input.cwd)
  const mainDir = (await mainWorktreeDir(input.cwd).catch(() => undefined)) ?? worktrees.find((worktree) => worktree.main)?.dir ?? input.cwd

  if (!commonDir) {
    return {
      storePresent: false,
      features: [],
      unreadableFeatures: [],
      candidates: [],
      worktrees,
      legacyCloseEvidence: [],
      runs: "unknown",
      runsError: "not a git repository",
    }
  }

  // Registered features first (design D6: discover registered features
  // before unassociated candidates).
  const ids = await listFeatureIds(commonDir)
  const features: DiscoveredFeature[] = []
  const unreadableFeatures: Discovery["unreadableFeatures"] = []
  for (const featureId of ids) {
    const read = await readFeatureRecord(commonDir, featureId)
    if (isFound(read)) {
      const attemptIds = await listAttemptIds(commonDir, featureId)
      const attempts = await Promise.all(
        attemptIds.map(async (attemptId) => {
          const journal = await readAttemptJournal(commonDir, featureId, attemptId)
          return { attemptId, journal: journal.status === "found" ? journal.value : undefined, journalStatus: journal.status }
        }),
      )
      const receiptIds = await listReceiptIds(commonDir, featureId)
      const receipts = await Promise.all(
        receiptIds.map(async (attemptId) => {
          const receipt = await readReceipt(commonDir, featureId, attemptId)
          return { attemptId, receipt: receipt.status === "found" ? receipt.value : undefined }
        }),
      )
      features.push({ featureId, record: read.value, attempts, receipts })
    } else {
      unreadableFeatures.push({
        featureId,
        status: read.status,
        reason: read.status === "corrupt" || read.status === "unreadable" ? read.reason : "unsupported schema version",
      })
    }
  }

  // Active candidates: every worktree listing active change directories.
  const candidates: DiscoveredCandidate[] = []
  const seen = new Set<string>()
  for (const worktree of worktrees) {
    const idsHere = await listChangeIds(join(worktree.dir, openspecDirName, "changes"))
    for (const changeId of idsHere) {
      const key = `${worktree.dir}\0${changeId}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({
        changeId,
        dir: worktree.dir,
        ...(worktree.branch ? { branch: worktree.branch } : {}),
        main: worktree.main,
        hasMarkdown: await changeHasMarkdown(worktree.dir, changeId),
      })
    }
  }

  // Legacy close journals (the pre-identity branch/change-keyed records):
  // listed as evidence only; adoption validates them explicitly (design D10).
  const legacyCloseEvidence = await listLegacyCloseEvidence(commonDir)

  // Run history: unknown on failure, never an empty set (design D5).
  let runs: Discovery["runs"]
  let runsError: string | undefined
  try {
    const entries = await listRuns()
    runs = entries.map((entry) => ({
      runID: entry.runID,
      ...(entry.targetDir ? { targetDir: entry.targetDir } : {}),
      live: entry.live,
    }))
  } catch (error) {
    runs = "unknown"
    runsError = error instanceof Error ? error.message : String(error)
  }

  return {
    storePresent: true,
    features,
    unreadableFeatures,
    candidates,
    worktrees,
    legacyCloseEvidence,
    runs,
    ...(runsError ? { runsError } : {}),
  }
}

/** Reads the legacy branch/change-keyed close journals, if any. */
async function listLegacyCloseEvidence(commonDir: string): Promise<LegacyCloseEvidence[]> {
  const legacyDir = join(commonDir, "convoy", "close")
  let entries
  try {
    entries = await readdir(legacyDir, { withFileTypes: true })
  } catch {
    return []
  }
  const { readCloseJournal } = await import("../close-journal")
  const out: LegacyCloseEvidence[] = []
  for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".json"))) {
    const match = entry.name.match(/^(.+)__(.+)\.json$/)
    if (!match) continue
    const journal = await readCloseJournal(commonDir, match[1]!, match[2]!)
    if (!journal) continue
    out.push({ branch: journal.branch, changeId: journal.changeID, phase: journal.phase })
  }
  return out
}

/** The current checkout's branch, typed for adapter reuse. */
export async function branchAt(dir: string): Promise<string | undefined> {
  return currentBranch(dir).catch(() => undefined)
}

/** True when a change id is a plausible OpenSpec change id (display filter). */
export function plausibleChangeId(changeId: string): boolean {
  return isOpenSpecChangeId(changeId)
}
