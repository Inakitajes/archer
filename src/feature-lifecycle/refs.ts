import { execFile } from "../git"
import { createRefIfAbsent, refExists, resolveRef } from "../finalization/refs"

/**
 * Protected feature/attempt refs (design D1, task 1.4): every close attempt
 * gets a private, create-only namespace under
 * `refs/convoy/features/<feature-id>/<attempt-id>/` holding the prepared
 * feature tip and the landing candidate. Identities are opaque UUIDs, so a
 * renamed branch or a reused branch name can never collide with old
 * evidence — unlike the legacy branch-spelled namespace.
 *
 * Creation is create-only (`git update-ref` with the all-zero expected old
 * value), and a pre-existing ref whose value disagrees with the evidence
 * being recorded is refused, never silently overwritten.
 */

const zeroSha = "0000000000000000000000000000000000000000"

export function featureRefPrefix(featureId: string, attemptId: string): string {
  return `refs/convoy/features/${featureId}/${attemptId}`
}

/** The prepared (post-archive) feature tip for one attempt. */
export function featureTipRef(featureId: string, attemptId: string): string {
  return `${featureRefPrefix(featureId, attemptId)}/feature-tip`
}

/** The one-parent landing candidate for one attempt. */
export function featureCandidateRef(featureId: string, attemptId: string): string {
  return `${featureRefPrefix(featureId, attemptId)}/candidate`
}

/**
 * Protects `ref` at `sha` create-only. When the ref already exists the
 * existing value is verified: a match is a no-op (idempotent replay),
 * a mismatch throws — a pre-existing ref at a different object is evidence
 * Convoy must not overwrite (task 1.4).
 */
export async function protectFeatureRef(ref: string, sha: string, cwd: string): Promise<void> {
  if (await refExists(ref, cwd)) {
    const existing = await resolveRef(ref, cwd)
    if (existing === sha) return
    throw new Error(
      `ref ${ref} already exists at ${(existing ?? "?").slice(0, 8)} but the evidence names ${sha.slice(0, 8)} — refusing to overwrite protected evidence`,
    )
  }
  await createRefIfAbsent(ref, sha, cwd)
}

/** Reads a protected ref's object, or undefined when absent/unresolvable. */
export async function readProtectedRef(ref: string, cwd: string): Promise<string | undefined> {
  return resolveRef(ref, cwd)
}

/** True when `landing` is reachable from `baseRef` — the receipt's reachability half. */
export async function isLandingReachableFrom(landing: string, baseRef: string, cwd: string): Promise<boolean> {
  const base = await execFile("git", ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`], { cwd, allowFailure: true })
  if (base.exitCode !== 0) return false
  const commit = await execFile("git", ["rev-parse", "--verify", "--quiet", `${landing}^{commit}`], { cwd, allowFailure: true })
  if (commit.exitCode !== 0) return false
  const ancestor = await execFile("git", ["merge-base", "--is-ancestor", landing, baseRef], { cwd, allowFailure: true })
  return ancestor.exitCode === 0
}

/** The expected-absent old value used for create-only ref writes (exported for tests). */
export const zeroRefOldValue = zeroSha
