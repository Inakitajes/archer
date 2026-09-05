import { currentHead, execFile } from "../git"
import type { CommitLedgerEntry, LedgerCommitMode } from "./types"

/**
 * Records one Convoy-created commit into the run's durable ledger (design D2,
 * task 1.3). The before/after endpoints are read around the action so the
 * ledger chains across entries and reconstructs the run's commit interval
 * without trusting authorship later. A no-change step is recorded explicitly
 * rather than left as a gap, so a missing entry always means evidence of a
 * commit the ledger cannot account for.
 */
export async function recordLedgeredCommit<T>(
  record: (entry: CommitLedgerEntry) => Promise<void>,
  input: { mode: LedgerCommitMode; step: string; cwd: string },
  action: () => Promise<T>,
): Promise<T> {
  const beforeSha = (await currentHead(input.cwd)) ?? ""
  const result = await action()
  const afterSha = await currentHead(input.cwd)

  const now = Date.now()
  if (!afterSha || afterSha === beforeSha) {
    await record({
      schemaVersion: 1,
      mode: input.mode,
      step: input.step,
      beforeSha,
      noChange: true,
      recordedAt: now,
    })
    return result
  }

  const treeResult = await treeOfCommit(afterSha, input.cwd)
  await record({
    schemaVersion: 1,
    mode: input.mode,
    step: input.step,
    beforeSha,
    afterSha,
    ...(treeResult ? { afterTree: treeResult } : {}),
    recordedAt: now,
  })
  return result
}

async function treeOfCommit(sha: string, cwd: string): Promise<string | undefined> {
  const result = await execFile("git", ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`], { cwd, allowFailure: true })
  return result.exitCode === 0 ? result.stdout.trim() || undefined : undefined
}
