import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { resolveFeature } from "../src/feature-lifecycle/resolver"
import { featureAdopt, featureBind, featureNewWork } from "../src/feature-lifecycle/commands"
import { loadLifecycleFeatureRows } from "../src/specs"
import { runClose } from "../src/feature-close"
import { execFile } from "../src/git"
import { templateCommitMessage, type CommitMessageProposal } from "../src/commit-message"

/**
 * Task 9.3: end-to-end ownership regression — a completed feature stays
 * discoverable after cleanup, and a renamed/unassociated feature is never
 * silently closed or claimed by the work that reused its name.
 */

const exec = promisify(nodeExecFile)
const dirs: string[] = []
const originalConvoyHome = process.env.CONVOY_HOME

async function git(cwd: string, ...args: string[]): Promise<void> {
  const { stdout } = await exec("git", args, { cwd })
  void stdout
}

async function makeRepo(): Promise<{ main: string; wt: string }> {
  const root = await mkdtemp(join(tmpdir(), "convoy-e2e-own-"))
  dirs.push(root)
  const main = join(root, "main")
  const wt = join(root, "wt")
  await mkdir(main, { recursive: true })
  await git(main, "init", "-b", "main")
  // The close pipeline commits the archive result with the operator's ambient
  // git identity (`commitAsUser` runs plain `git commit`). A runner image has
  // no identity at all — configure one locally so the fixture does not depend
  // on the machine's global git config.
  await git(main, "config", "user.email", "t@x")
  await git(main, "config", "user.name", "T")
  await writeFile(join(main, "README.md"), "# repo\n")
  await git(main, "add", ".")
  await git(main, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init")
  await git(main, "worktree", "add", "-b", "feat/one", wt)
  const changeDir = join(wt, "openspec", "changes", "one")
  await mkdir(changeDir, { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), "# One\n")
  await writeFile(join(changeDir, "tasks.md"), "- [x] a\n- [x] b\n")
  await writeFile(join(wt, "src.ts"), "export const one = 1\n")
  await git(wt, "add", ".")
  await git(wt, "-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "feat(openspec): propose one")
  return { main, wt }
}

const closeInput = (fixture: { mainDir: string; worktreeDir: string }) => ({
  targetDir: fixture.mainDir,
  worktreeDir: fixture.worktreeDir,
  branch: "feat/one",
  changeID: "one",
})

const writerFails: Parameters<typeof runClose>[0]["writer"] = async () =>
  ({ message: templateCommitMessage({ targetDir: "", branch: "", commits: [] }), source: "template", error: "test double" }) satisfies CommitMessageProposal

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "convoy-e2e-own-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  if (originalConvoyHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = originalConvoyHome
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("ownership end-to-end (task 9.3)", () => {
  test("a completed feature stays discoverable after cleanup; new work on the reused name is a different identity", async () => {
    const { main, wt } = await makeRepo()
    // Adopt, close, and clean up.
    const { feature } = await featureAdopt({ cwd: main, branch: "feat/one", changeIds: ["one"], base: "main" })
    const result = await runClose({ ...closeInput({ mainDir: main, worktreeDir: wt }), writer: writerFails })
    expect(result.disposition).toBe("landed")
    // Cleanup: worktree removal, then the guarded branch deletion.
    await git(main, "worktree", "remove", wt)
    const tip = (await execFile("git", ["rev-parse", "refs/heads/feat/one"], { cwd: main, allowFailure: true })).stdout.trim()
    await git(main, "update-ref", "-d", "refs/heads/feat/one", tip)
    // The feature record stays discoverable with its evidence.
    const { isFound, lifecycleCommonDir } = await import("../src/feature-lifecycle/store")
    const { readFeatureRecord, listReceiptIds, readReceipt } = await import("../src/feature-lifecycle/records")
    const commonDir = (await lifecycleCommonDir(main))!
    const record = await readFeatureRecord(commonDir, feature.featureId)
    expect(isFound(record)).toBe(true)
    const receiptIds = await listReceiptIds(commonDir, feature.featureId)
    expect(receiptIds.length).toBe(1)
    const receipt = await readReceipt(commonDir, feature.featureId, receiptIds[0]!)
    expect(isFound(receipt) && receipt.value.landingSha).toBe(result.landing!.sha)
    // The branch is gone (guard executed with the exact tip).
    expect((await execFile("git", ["rev-parse", "--verify", "refs/heads/feat/one"], { cwd: main, allowFailure: true })).exitCode).not.toBe(0)

    // New work reusing the branch name is a NEW identity through the explicit
    // new-work decision: never the old feature's record, runs, or receipts.
    const wt2 = join(root2(wt), "wt2")
    await git(main, "worktree", "add", "-b", "feat/one", wt2)
    const newChange = join(wt2, "openspec", "changes", "one")
    await mkdir(newChange, { recursive: true })
    await writeFile(join(newChange, "proposal.md"), "# One (again)\n")
    await writeFile(join(newChange, "tasks.md"), "- [ ] a\n")
    const second = await featureNewWork({ cwd: main, branch: "feat/one", worktree: wt2, changeIds: ["one"], base: "main" })
    expect(second.featureId).not.toBe(feature.featureId)
    expect(second.runIds).toEqual([])
    expect(second.closeAttemptIds).toEqual([])
    // Plain adoption of the reused name is still refused (new-work is the
    // decision; the live new feature holds the claim).
    await expect(featureAdopt({ cwd: main, branch: "feat/one", changeIds: ["one"], base: "main" })).rejects.toThrow(/already claimed/)
  })

  test("a renamed/unassociated context is not silently closed or claimed", async () => {
    const { main, wt } = await makeRepo()
    const { feature } = await featureAdopt({ cwd: main, branch: "feat/one", changeIds: ["one"], base: "main" })
    // External rename.
    await git(wt, "branch", "-m", "feat/one", "feat/renamed")
    // The old spelling no longer resolves; the close through the old branch
    // name must refuse rather than guess, and the feature stays visible.
    await expect(runClose({ targetDir: main, branch: "feat/one", changeID: "one", writer: writerFails })).rejects.toThrow()
    const rows = await loadLifecycleFeatureRows(main)
    expect(rows!.some((row) => row.featureId === feature.featureId)).toBe(true)
    // Explicit rebinding of the verified renamed context resolves everything.
    const bound = await featureBind({ cwd: main, featureId: feature.featureId, branch: "feat/renamed", worktree: wt })
    expect(bound.context?.branch).toBe("feat/renamed")
    const resolution = await resolveFeature({ cwd: main, featureId: feature.featureId })
    expect(resolution.status).toBe("verified")
    // Another feature cannot silently claim the renamed branch.
    await expect(featureAdopt({ cwd: main, branch: "feat/renamed", changeIds: ["one"], base: "main" })).rejects.toThrow(/already claimed/)
  })
})

function root2(path: string): string {
  return join(path, "..")
}
