import { execFile } from "../git"

/**
 * Per-run protected refs (design D3): every run gets a private namespace under
 * `refs/convoy/runs/<run-id>/` holding create-only copies of the original
 * phase/attempt tips and a pre-compaction tip. Convoy must never overwrite
 * these evidence refs, so creation uses an expected-absent old value — the
 * write fails if the ref already exists. New runs therefore never clobber old
 * runs' recovery evidence, and deleting a run workspace cannot invalidate it.
 */

const zeroSha = "0000000000000000000000000000000000000000"

/** The ref namespace holding one run's protected evidence. */
export function runRefPrefix(runID: string): string {
  return `refs/convoy/runs/${runID}`
}

/** The protected ref for the branch tip immediately before compaction. */
export function preCompactionRef(runID: string): string {
  return `${runRefPrefix(runID)}/pre-compaction`
}

/** The protected ref for one ledgered commit endpoint, numbered oldest-first. */
export function ledgerTipRef(runID: string, index: number): string {
  return `${runRefPrefix(runID)}/commits/${String(index).padStart(4, "0")}`
}

/**
 * Creates `<ref>` at `<sha>` only when the ref does not already exist. This is
 * the create-only guarantee: `git update-ref` with the all-zero expected old
 * value refuses to overwrite an existing ref, so a repeated finalization (or a
 * later run on the same branch) can never replace earlier evidence.
 */
export async function createRefIfAbsent(ref: string, sha: string, cwd: string): Promise<void> {
  await execFile("git", ["update-ref", "-m", "convoy: protect run evidence", ref, sha, zeroSha], { cwd })
}

/** Whether a ref currently exists in the repository. */
export async function refExists(ref: string, cwd: string): Promise<boolean> {
  const result = await execFile("git", ["show-ref", "--verify", "--quiet", ref], { cwd, allowFailure: true })
  return result.exitCode === 0
}

/** Resolves a ref to its commit SHA, or undefined when it does not exist. */
export async function resolveRef(ref: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}

/**
 * The repository's Git common dir (shared by every worktree), where recovery
 * manifests and journals live so they survive worktree removal.
 */
export async function gitCommonDir(cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}
