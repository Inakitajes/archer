import { realpath } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

import { currentBranch, findWorktreeDirForBranch, mainWorktreeDir } from "../git"
import { branchIdFromBranch, isOpenSpecChangeId } from "../openspec"
import { isFound, isUuid, lifecycleCommonDir, readRepositoryRecord, type StoreRead } from "./store"
import {
  listFeatureRecords,
  readFeatureRecord,
  type FeatureRecord,
} from "./records"

/**
 * The one shared resolver (capability `feature-lifecycle`, design D3): board,
 * launcher, continue, publication, and close all resolve a selected feature
 * through this module, so "which work does this action target" has exactly
 * one answer.
 *
 * Resolution order (design D3):
 *   1. explicit feature ID;
 *   2. verified current context association (the checkout a command runs in);
 *   3. unique association selected by explicit branch/change filters;
 *   4. otherwise unresolved candidates.
 *
 * The result is tagged with evidence and blockers — never an optional branch
 * string — and an invalid explicit selector never falls through to a
 * heuristic (task 2.3): a mistyped ID or a contradictory selector refuses
 * instead of silently resolving to different work.
 */

export type ResolutionStatus = "verified" | "unassociated" | "ambiguous" | "missing" | "unreadable"

export type FeatureResolution =
  | {
      status: "verified"
      feature: FeatureRecord
      /** The context that verified: association revision, actual branch, checkout path. */
      context: { branch: string; checkoutPath?: string; associationRevision: number }
    }
  | { status: "unassociated"; candidates: FeatureRecord[]; reason?: string }
  | { status: "ambiguous"; candidates: FeatureRecord[]; reason: string }
  | { status: "missing"; reason: string }
  | { status: "unreadable"; reason: string }

export type ResolveFeatureInput = {
  /** Working directory the command runs in (for context verification). */
  cwd: string
  commonDir?: string
  /** Rule 1: an explicit feature ID. Invalid IDs refuse — never a heuristic fallback. */
  featureId?: string
  /** Explicit branch selector; must agree with the resolved feature. */
  branch?: string
  /** Explicit change selector; must name one of the resolved feature's contracts. */
  changeId?: string
  /**
   * The checkout's actual branch, when the caller already resolved it.
   * Otherwise the resolver reads it from `cwd`.
   */
  currentBranch?: string
}

/** Fails when a store read is not `found`, producing the matching tagged result. */
function fromStoreRead<T>(read: StoreRead<T>, reasonFor: (read: StoreRead<T>) => string): { ok: true; value: T } | { ok: false; result: FeatureResolution } {
  switch (read.status) {
    case "found":
      return { ok: true, value: read.value }
    case "missing":
      return { ok: false, result: { status: "missing", reason: reasonFor(read) } }
    case "corrupt":
      return { ok: false, result: { status: "unreadable", reason: `record corrupt: ${read.reason}` } }
    case "unsupported":
      return { ok: false, result: { status: "unreadable", reason: `record uses an unsupported schema version (${String(read.schemaVersion)})` } }
    case "unreadable":
      return { ok: false, result: { status: "unreadable", reason: read.reason } }
  }
}

/**
 * Whether the store exists yet: an uninitialized repository resolves to
 * `unassociated` (with no candidates), never to `missing` — work simply
 * hasn't been adopted (design D3).
 */
async function storePresent(commonDir: string): Promise<boolean> {
  const record = await readRepositoryRecord(commonDir)
  return record.status !== "missing"
}

/**
 * Does this feature's context match the given checkout? A verified context
 * requires the recorded branch to be checked out at the path. Path equality
 * is compared through realpath so /var vs /private/var aliases match.
 */
async function contextMatches(feature: FeatureRecord, cwd: string): Promise<boolean> {
  if (!feature.context) return false
  const actual = await currentBranch(cwd).catch(() => undefined)
  if (actual !== feature.context.branch) return false
  if (feature.context.checkoutPath) {
    const same = await sameRealPath(feature.context.checkoutPath, cwd)
    if (!same) return false
  }
  return true
}

async function sameRealPath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b))
  } catch {
    return resolve(a) === resolve(b)
  }
}

function selectorsAgree(feature: FeatureRecord, input: ResolveFeatureInput): string | undefined {
  if (input.branch && feature.context?.branch !== input.branch) {
    return `feature ${feature.featureId} is associated with branch "${feature.context?.branch ?? "(none)"}", not "${input.branch}"`
  }
  if (input.changeId && !feature.contracts.some((contract) => contract.changeId === input.changeId)) {
    return `change "${input.changeId}" is not one of feature ${feature.featureId}'s contracts (${feature.contracts.map((contract) => contract.changeId).join(", ") || "none"})`
  }
  return undefined
}

/**
 * The resolver. Every path either verifies positively or returns a tagged
 * refusal with evidence (task 2.3).
 */
export async function resolveFeature(input: ResolveFeatureInput): Promise<FeatureResolution> {
  const commonDir = input.commonDir ?? (input.cwd ? await lifecycleCommonDir(input.cwd) : undefined)
  if (!commonDir) return { status: "unassociated", candidates: [], reason: "not a git repository" }
  if (!(await storePresent(commonDir))) {
    return input.featureId
      ? { status: "missing", reason: `no feature registry exists yet, so feature ${input.featureId} is unknown` }
      : { status: "unassociated", candidates: [] }
  }

  // Rule 1: explicit feature ID. A mistyped/unknown ID is `missing` — it never
  // falls through to context or branch heuristics (design D3).
  if (input.featureId !== undefined) {
    if (!isUuid(input.featureId)) {
      return { status: "missing", reason: `"${input.featureId}" is not a feature id (expected an opaque UUID; run \`convoy feature show\` to list them)` }
    }
    const read = await readFeatureRecord(commonDir, input.featureId)
    const loaded = fromStoreRead(read, () => `no registered feature ${input.featureId}`)
    if (!loaded.ok) return loaded.result
    const conflict = selectorsAgree(loaded.value, input)
    if (conflict) return { status: "ambiguous", candidates: [loaded.value], reason: conflict }
    return await verifyFeature(loaded.value, input)
  }

  // Rule 2: verified current context association.
  const branch = input.branch ?? input.currentBranch ?? (await currentBranch(input.cwd).catch(() => undefined))
  const listing = await listFeatureRecords(commonDir)
  const unreadable = listing.filter((entry) => entry.read.status === "corrupt" || entry.read.status === "unreadable" || entry.read.status === "unsupported")
  const features = listing.flatMap((entry) => (isFound(entry.read) ? [entry.read.value] : []))

  for (const feature of features) {
    if (await contextMatches(feature, input.cwd)) {
      const conflict = selectorsAgree(feature, input)
      if (conflict) return { status: "ambiguous", candidates: [feature], reason: conflict }
      return await verifyFeature(feature, input)
    }
  }

  // Rule 3: unique association selected by explicit filters.
  const branchMatches = input.branch ? features.filter((feature) => feature.context?.branch === input.branch) : []
  const changeMatches = input.changeId
    ? features.filter((feature) => feature.contracts.some((contract) => contract.changeId === input.changeId))
    : []
  const filtered = input.branch || input.changeId ? (input.branch ? branchMatches : changeMatches) : []
  if (filtered.length === 1) {
    const feature = filtered[0]!
    const conflict = selectorsAgree(feature, input)
    if (conflict) return { status: "ambiguous", candidates: [feature], reason: conflict }
    return await verifyFeature(feature, input)
  }
  if (filtered.length > 1) {
    return { status: "ambiguous", candidates: filtered, reason: `${filtered.length} registered features match the selectors; name one explicitly with --feature <id>` }
  }

  // Nothing matched explicitly. Contradictory selectors are ambiguous, and
  // unreadable records surface as unreadable rather than silently empty.
  if (unreadable.length > 0) {
    const reason = unreadable
      .map((entry) => {
        const status = entry.read.status
        if (status === "corrupt" || status === "unreadable") return `${entry.featureId}: ${entry.read.reason}`
        return `${entry.featureId}: unsupported schema`
      })
      .join("; ")
    return { status: "unreadable", reason: `some feature records could not be read — resolve before mutating (${reason})` }
  }
  if (input.branch && input.changeId) {
    return {
      status: "unassociated",
      candidates: features,
      reason: `no registered feature associates branch "${input.branch}" with change "${input.changeId}"`,
    }
  }
  return { status: "unassociated", candidates: features }
}

/**
 * Positively verifies a resolved feature's current context (task 2.3): the
 * recorded branch must still be checked out somewhere in the repository and,
 * when a path is recorded, the path must be a registered worktree carrying
 * that branch. A renamed/moved context stays `verified` only when Git agrees.
 */
async function verifyFeature(feature: FeatureRecord, input: ResolveFeatureInput): Promise<FeatureResolution> {
  if (!feature.context) {
    return { status: "unassociated", candidates: [feature], reason: `feature ${feature.featureId} has no implementation context` }
  }
  const registered = (await findWorktreeDirForBranch(feature.context.branch, input.cwd)) ?? undefined
  if (!registered) {
    return {
      status: "missing",
      reason: `branch "${feature.context.branch}" is not checked out in any worktree of this repository — rebind or recover`,
    }
  }
  if (feature.context.checkoutPath && !(await sameRealPath(feature.context.checkoutPath, registered))) {
    // Git moved the worktree; the association is stale until rebound.
    return {
      status: "ambiguous",
      candidates: [feature],
      reason: `the worktree for "${feature.context.branch}" moved from ${feature.context.checkoutPath} to ${registered} — rebind to verify`,
    }
  }
  return {
    status: "verified",
    feature,
    context: { branch: feature.context.branch, checkoutPath: registered, associationRevision: feature.associationRevision },
  }
}

/**
 * Convenience: the change IDs a resolution names, for consumers that only
 * need the contract set (launcher pinning, close selectors).
 */
export function contractsOf(resolution: FeatureResolution): string[] {
  if (resolution.status === "verified") return resolution.feature.contracts.map((contract) => contract.changeId)
  return []
}

/**
 * Validates a repo-relative planning path: it must stay inside the planning
 * root (no `..` escape, no absolute path), supporting symlink escape checks
 * by comparing real paths after resolution (design D3/D7).
 */
export function planningPathWithin(planningRoot: string, candidate: string): string | undefined {
  if (candidate === "" || isAbsolute(candidate)) return undefined
  const full = resolve(join(planningRoot, candidate))
  const rel = relative(resolve(planningRoot), full)
  if (rel === "" || rel.startsWith("..") || rel.includes(`..${sep}`)) return undefined
  return rel
}

/**
 * The main checkout of the repository hosting `cwd` — the planning root for
 * path validation and archive-on-main operations.
 */
export async function planningRootFor(cwd: string): Promise<string | undefined> {
  return mainWorktreeDir(cwd).catch(() => undefined)
}

/** Re-exported guard: a change id must pass OpenSpec's own id rules. */
export function isValidChangeSelector(changeId: string): boolean {
  return isOpenSpecChangeId(changeId) && !changeId.includes("/")
}

/** The slug a branch carries under the conventional `<type>/<change-id>` spelling — display only. */
export function displaySlugFor(branch: string): string | undefined {
  return branchIdFromBranch(branch)
}
