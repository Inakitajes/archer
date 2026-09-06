import { resolveFeature } from "./resolver"
import { lifecycleCommonDir } from "./store"
import { operationError } from "./commands"
import type { FeaturePlanLink } from "../types"

/**
 * Launch-side lifecycle wiring (capability feature-lifecycle, capability
 * run-launcher, tasks 4.3/4.4): resolve the reviewed feature/contract/context
 * link for a launch, and revalidate it at execution time. A changed or
 * unverifiable target stops with remediation rather than silently selecting
 * another contract or branch (task 4.4). This check is additional to, not a
 * replacement for, the existing dirty-tree consent and execution-time gate.
 */

export type ResolveLaunchFeatureInput = {
  cwd: string
  /** Explicit `--feature <id>`; invalid IDs refuse — no heuristic fallback. */
  featureId?: string
  /** The run's pinned change (`--change` or the Apply handoff), cross-checked against the feature's contracts. */
  changeId?: string
  /** A continue handoff's verified worktree/branch, cross-checked against the feature's context. */
  branch?: string
  worktreeDir?: string
}

/**
 * Resolves the feature link a feature-backed launch freezes into its plan.
 * `undefined` (no feature link) is valid: no-spec runs keep their existing
 * flow without inventing a feature. When `--feature` does not resolve to a
 * verified association, the error carries the explicit adoption/rebind
 * command — unresolved headless requests never guess (design D3).
 */
export async function resolveFeatureForLaunch(input: ResolveLaunchFeatureInput): Promise<FeaturePlanLink | undefined> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) {
    if (input.featureId) throw operationError("not a git repository", "missing")
    return undefined
  }
  const resolution = await resolveFeature({
    cwd: input.cwd,
    commonDir,
    ...(input.featureId ? { featureId: input.featureId } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.changeId ? { changeId: input.changeId } : {}),
  })
  if (resolution.status === "verified") {
    return {
      featureId: resolution.feature.featureId,
      repositoryId: resolution.feature.repositoryId,
      associationRevision: resolution.context.associationRevision,
      contracts: resolution.feature.contracts.map((contract) => contract.changeId),
      baseRef: resolution.feature.intendedBaseRef,
      branch: resolution.context.branch,
      ...(resolution.context.checkoutPath ? { worktreeDir: resolution.context.checkoutPath } : {}),
    }
  }
  if (!input.featureId) {
    // No explicit feature request: an unassociated context launches without a
    // link (the ordinary flow; review shows the proposed association).
    return undefined
  }
  // An explicit --feature that does not verify refuses with the exact remediation.
  const detail = "reason" in resolution ? resolution.reason : resolution.status
  if (resolution.status === "unassociated") {
    const branch = input.branch ?? resolution.candidates.find((candidate) => candidate.context)?.context?.branch
    throw operationError(
      `feature ${input.featureId} is not a verified association for this context` +
        (detail ? ` (${detail})` : "") +
        (branch ? ` — adopt it explicitly with \`convoy feature adopt --branch ${branch} --change <id> --base <local-ref>\`` : " — run `convoy feature show` to inspect it"),
      "missing",
    )
  }
  throw operationError(
    `feature ${input.featureId}: ${detail} — run \`convoy feature show\` to list registered features, or adopt the work explicitly`,
    resolution.status === "ambiguous" ? "ambiguous" : "missing",
  )
}

/**
 * Execution-time revalidation (task 4.4): the reviewed plan's feature link
 * must still verify — same repository, same association revision, same
 * branch/worktree/base. A changed target refuses; it never attaches the
 * replacement context to the reviewed feature.
 */
export async function revalidateFeatureLink(input: { cwd: string; link: FeaturePlanLink }): Promise<void> {
  const commonDir = await lifecycleCommonDir(input.cwd)
  if (!commonDir) throw operationError(`the repository no longer resolves (feature ${input.link.featureId} cannot revalidate)`, "missing")
  const resolution = await resolveFeature({ cwd: input.cwd, commonDir, featureId: input.link.featureId })
  if (resolution.status !== "verified") {
    const reason = "reason" in resolution ? resolution.reason : resolution.status
    throw operationError(
      `the reviewed feature context changed since review — the run refuses to start and attaches nothing to the new context (${reason}); ` +
        "re-run the launcher for a fresh review, or rebind with `convoy feature bind` if the worktree moved",
      "conflict" as never,
    )
  }
  if (resolution.context.associationRevision !== input.link.associationRevision) {
    throw operationError(
      `the feature's association advanced (review ${input.link.associationRevision} → current ${resolution.context.associationRevision}) — ` +
        "the run refuses to start with a stale reviewed contract set; re-run the launcher",
      "conflict",
    )
  }
  if (resolution.context.branch !== input.link.branch) {
    throw operationError(
      `the feature's branch changed since review (${input.link.branch} → ${resolution.context.branch}) — the run refuses to start and attaches nothing to the new branch`,
      "conflict",
    )
  }
  if (resolution.feature.intendedBaseRef !== input.link.baseRef) {
    throw operationError(
      `the feature's intended base changed since review (${input.link.baseRef} → ${resolution.feature.intendedBaseRef}) — re-run the launcher for a fresh review`,
      "conflict",
    )
  }
}
