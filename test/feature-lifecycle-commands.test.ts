import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile } from "../src/git"
import { lifecycleCommonDir, readRepositoryRecord } from "../src/feature-lifecycle/store"
import { listFeatureIds } from "../src/feature-lifecycle/records"
import { featureAdopt, featureBind, featureNewWork, featureRevise, featureShow } from "../src/feature-lifecycle/commands"

/**
 * Tasks 3.1–3.6: the explicit identity operations. Adoption accepts an
 * arbitrary Git-valid branch name and never renames it; bind validates the
 * registered worktree and claims nothing twice; revise refuses while a run is
 * live; new-work creates a fresh identity on a retained context.
 */

const dirs: string[] = []

async function git(args: string[], cwd: string): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`)
}

async function makeRepoWithWorktree(branch: string): Promise<{ main: string; wt: string }> {
  const root = await mkdtemp(join(tmpdir(), "convoy-feature-cmd-"))
  dirs.push(root)
  const main = join(root, "main")
  const wt = join(root, "wt")
  await mkdir(main, { recursive: true })
  await git(["init", "-q", "-b", "main"], main)
  await writeFile(join(main, "README.md"), "# repo\n")
  await git(["add", "."], main)
  await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"], main)
  await git(["worktree", "add", "-b", branch, wt], main)
  return { main, wt }
}

async function proposeChange(checkout: string, id: string): Promise<void> {
  const dir = join(checkout, "openspec", "changes", id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, "proposal.md"), `# ${id}\n`)
  await writeFile(join(dir, "tasks.md"), "- [ ] one\n")
}

beforeAll(async () => {
  const home = await mkdtemp(join(tmpdir(), "convoy-feature-cmd-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("convoy feature operations (tasks 3.1–3.6)", () => {
  test("adopt associates an arbitrary branch name without renaming it", async () => {
    const { main, wt } = await makeRepoWithWorktree("team/alice/release-42")
    await proposeChange(wt, "add-widget")
    const { feature } = await featureAdopt({ cwd: main, branch: "team/alice/release-42", changeIds: ["add-widget"], base: "main" })
    expect(feature.context?.branch).toBe("team/alice/release-42")
    // The branch still exists under its own name.
    expect(await execFile("git", ["rev-parse", "--verify", "team/alice/release-42"], { cwd: main, allowFailure: true }).then((r) => r.exitCode)).toBe(0)
    // show is read-only and renders the feature.
    const shown = await featureShow({ cwd: main, featureId: feature.featureId })
    expect(shown.output.featureId).toBe(feature.featureId)
    expect(shown.output.assessment?.summary).toBeTruthy()
    // Store exists exactly once.
    const commonDir = (await lifecycleCommonDir(main))!
    expect((await readRepositoryRecord(commonDir)).status).toBe("found")
  })

  test("adopt validates the actual checked-out branch, worktree registration, and source", async () => {
    const { main, wt } = await makeRepoWithWorktree("feature/one")
    await proposeChange(wt, "add-widget")
    // A branch nobody checked out is refused.
    await expect(featureAdopt({ cwd: main, branch: "nowhere/checked-out", changeIds: ["add-widget"], base: "main" })).rejects.toThrow(/not checked out in any worktree/)
    // A change that doesn't exist is refused.
    await expect(featureAdopt({ cwd: main, branch: "feature/one", changeIds: ["missing-change"], base: "main" })).rejects.toThrow(/is not an active change/)
    // A bogus base ref is refused.
    await expect(featureAdopt({ cwd: main, branch: "feature/one", changeIds: ["add-widget"], base: "no/such/ref" })).rejects.toThrow(/does not resolve/)
  })

  test("bind rebinds a verified context and refuses a claimed one", async () => {
    const { main, wt } = await makeRepoWithWorktree("feature/move-me")
    await proposeChange(wt, "add-widget")
    const { feature } = await featureAdopt({ cwd: main, branch: "feature/move-me", changeIds: ["add-widget"], base: "main" })

    // A second worktree on a free branch is a valid rebind target.
    const wt2 = join(wt, "..", "wt2")
    await git(["worktree", "add", "-b", "feature/moved-here", wt2], main)
    const rebound = await featureBind({ cwd: main, featureId: feature.featureId, branch: "feature/moved-here", worktree: wt2 })
    expect(rebound.context?.branch).toBe("feature/moved-here")
    expect(rebound.associationRevision).toBe(2)

    // A third feature on a free branch; adopting it onto the change proposed
    // in ITS worktree, then binding it onto the first feature's claimed
    // branch is refused.
    const wt3 = join(wt, "..", "wt3")
    await git(["worktree", "add", "-b", "feature/other", wt3], main)
    await proposeChange(wt3, "other-change")
    const { feature: other } = await featureAdopt({ cwd: main, branch: "feature/other", changeIds: ["other-change"], base: "main" })
    await expect(featureBind({ cwd: main, featureId: other.featureId, branch: "feature/moved-here", worktree: wt2 })).rejects.toThrow(/already claimed by feature/)
  })

  test("bind refuses when the branch is not checked out at the named worktree", async () => {
    const { main, wt } = await makeRepoWithWorktree("feature/bind-check")
    await proposeChange(wt, "add-widget")
    const { feature } = await featureAdopt({ cwd: main, branch: "feature/bind-check", changeIds: ["add-widget"], base: "main" })
    const wt2 = join(wt, "..", "wt2")
    await git(["worktree", "add", "-b", "feature/elsewhere", wt2], main)
    // The worktree named is not where the branch is checked out.
    await expect(featureBind({ cwd: main, featureId: feature.featureId, branch: "feature/bind-check", worktree: wt2 })).rejects.toThrow(/checked out at/)
  })

  test("adopt refuses double-claiming a context (context uniqueness)", async () => {
    const { main, wt } = await makeRepoWithWorktree("feature/claim")
    await proposeChange(wt, "add-widget")
    await featureAdopt({ cwd: main, branch: "feature/claim", changeIds: ["add-widget"], base: "main" })
    // A second feature on the same branch is refused.
    await expect(featureAdopt({ cwd: main, branch: "feature/claim", changeIds: ["add-widget"], base: "main" })).rejects.toThrow(/already claimed|refuses/)
  })

  test("revise records the complete reviewed set and refuses while a run is live", async () => {
    const { main, wt } = await makeRepoWithWorktree("feature/revise")
    await proposeChange(wt, "one")
    await proposeChange(wt, "two")
    const { feature } = await featureAdopt({ cwd: main, branch: "feature/revise", changeIds: ["one"], base: "main" })
    const revised = await featureRevise({ cwd: main, featureId: feature.featureId, changeIds: ["one", "two"], base: "main" })
    expect(revised.associationRevision).toBe(2)
    expect(revised.contracts.map((contract) => contract.changeId)).toEqual(["one", "two"])

    // A live run on the context refuses the revision: a fake run whose
    // metadata names a reachable server and this worktree as its target.
    const runHome = process.env.CONVOY_HOME!
    const runsDir = join(runHome, ".convoy", "runs", "20260101-000000-live")
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") })
    const port = server.port
    try {
      await mkdir(join(runsDir), { recursive: true })
      await writeFile(
        join(runsDir, "metadata.json"),
        JSON.stringify({
          schemaVersion: 5,
          runID: "20260101-000000-live",
          targetDir: await realpath(wt),
          createdAt: 1,
          updatedAt: 1,
          control: { state: "running" },
          server: { url: `http://127.0.0.1:${port}`, pid: process.pid, startedAt: 1 },
          phases: {},
        }),
      )
      await expect(featureRevise({ cwd: main, featureId: revised.featureId, changeIds: ["one"], base: "main" })).rejects.toThrow(/run is live/)
    } finally {
      server.stop(true)
    }
  })

  test("new-work creates a fresh identity on a retained completed context", async () => {
    const { main, wt } = await makeRepoWithWorktree("feature/new-work")
    await proposeChange(wt, "next-thing")
    // No prior feature claims the branch: new-work creates one directly.
    const created = await featureNewWork({ cwd: main, branch: "feature/new-work", worktree: wt, changeIds: ["next-thing"], base: "main" })
    const commonDir = (await lifecycleCommonDir(main))!
    const ids = await listFeatureIds(commonDir)
    expect(ids).toContain(created.featureId)
    expect(created.history.at(-1)?.kind).toBe("new-work")
    // It does not inherit another feature's runs or receipt (fresh record).
    expect(created.runIds).toEqual([])
    expect(created.closeAttemptIds).toEqual([])
  })

  test("featureShow mutates nothing on an unassociated context (no store created)", async () => {
    const root = await mkdtemp(join(tmpdir(), "convoy-feature-cmd-show-"))
    dirs.push(root)
    await git(["init", "-q", "-b", "main"], root)
    await writeFile(join(root, "README.md"), "x\n")
    await git(["add", "."], root)
    await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"], root)
    const { output } = await featureShow({ cwd: root })
    expect(output.resolution?.status).toBe("unassociated")
    const commonDir = (await lifecycleCommonDir(root))!
    expect((await readRepositoryRecord(commonDir)).status).toBe("missing")
  })

  test("legacy adoption imports a landed legacy journal once and refuses reassignment (task 8.2)", async () => {
    const { main } = await makeRepoWithWorktree("feature/legacy")
    const { ensureRepositoryRecord } = await import("../src/feature-lifecycle/store")
    const { writeCloseJournal } = await import("../src/close-journal")
    const commonDir = (await lifecycleCommonDir(main))!
    const repoRecord = await ensureRepositoryRecord(commonDir)
    if (repoRecord.status !== "found") throw new Error("no repo record")

    // A landed legacy close journal with a landing reachable from main.
    await writeFile(join(main, "landed.txt"), "content\n")
    await git(["add", "."], main)
    await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "feat: land legacy"], main)
    const landing = (await execFile("git", ["rev-parse", "HEAD"], { cwd: main, allowFailure: true })).stdout.trim()
    const base = (await execFile("git", ["rev-parse", "main"], { cwd: main, allowFailure: true })).stdout.trim()
    await writeCloseJournal(commonDir, {
      schemaVersion: 1,
      attemptID: "legacy-attempt-1",
      branch: "feature/legacy",
      changeID: "old-change",
      baseRef: "main",
      baseSha: base,
      postArchiveTip: landing,
      preparedTree: "e".repeat(40),
      candidateSha: landing,
      landingSha: landing,
      phase: "landed",
      recordedAt: 1,
      updatedAt: 1,
    })
    const journalPath = join(commonDir, "convoy", "close", "feature_legacy__old-change.json")
    const originalBytes = await readFile(journalPath, "utf8")

    const { featureRecover } = await import("../src/feature-lifecycle/commands")
    const { listReceiptIds, readReceipt } = await import("../src/feature-lifecycle/records")
    const recovered = await featureRecover({ cwd: main, legacy: true, changeId: "old-change" })
    expect(recovered.displayName).toBe("old-change")
    expect(recovered.closeAttemptIds).toHaveLength(1)
    const receipts = await listReceiptIds(commonDir, recovered.featureId)
    expect(receipts).toHaveLength(1)
    const receipt = await readReceipt(commonDir, recovered.featureId, receipts[0]!)
    expect(receipt.status === "found" && receipt.value.landingSha).toBe(landing)
    // The original legacy journal bytes are preserved untouched.
    expect(await readFile(journalPath, "utf8")).toBe(originalBytes)

    // A second adoption of the same evidence refuses (already claimed).
    const { featureRecover: recoverAgain } = await import("../src/feature-lifecycle/commands")
    await expect(recoverAgain({ cwd: main, legacy: true, changeId: "old-change" })).rejects.toThrow(/collides with registered feature/)
  })

  test("recover grants receipt-verified follow-ups for a completed feature without a worktree (task 3.5)", async () => {
    const { main } = await makeRepoWithWorktree("feature/done")
    const { ensureRepositoryRecord } = await import("../src/feature-lifecycle/store")
    const { writeFeatureRecord, writeReceiptIfAbsent } = await import("../src/feature-lifecycle/records")
    const commonDir = (await lifecycleCommonDir(main))!
    const repoRecord = await ensureRepositoryRecord(commonDir)
    if (repoRecord.status !== "found") throw new Error("no repo record")

    // A completed feature: worktree gone, branch gone, receipt on disk with a
    // landing that is reachable from main (an ordinary commit).
    await writeFile(join(main, "landed.txt"), "content\n")
    await git(["add", "."], main)
    await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "feat: land widget"], main)
    const landing = (await execFile("git", ["rev-parse", "HEAD"], { cwd: main, allowFailure: true })).stdout.trim()
    const base = (await execFile("git", ["rev-parse", "main"], { cwd: main, allowFailure: true })).stdout.trim()
    const featureId = "cccccccc-0000-4000-8000-00000000abc2"
    await writeFeatureRecord(commonDir, {
      schemaVersion: 1,
      featureId,
      repositoryId: repoRecord.value.repositoryId,
      displayName: "feature/done",
      associationRevision: 3,
      contracts: [{ changeId: "add-widget", kind: "archive", sourcePath: "openspec/archive/add-widget", provenance: "close", selectedAtRevision: 3 }],
      intendedBaseRef: "main",
      runIds: [],
      closeAttemptIds: ["dddddddd-0000-4000-8000-00000000abc3"],
      history: [],
      createdAt: 1,
      updatedAt: 1,
    }, 0)
    await writeReceiptIfAbsent(commonDir, {
      schemaVersion: 1,
      attemptId: "dddddddd-0000-4000-8000-00000000abc3",
      featureId,
      repositoryId: repoRecord.value.repositoryId,
      associationRevision: 3,
      branch: "feature/removed-branch",
      baseRef: "main",
      baseSha: base,
      featureTip: "e".repeat(40),
      preparedTree: "f".repeat(40),
      candidateSha: landing,
      landingSha: landing,
      landingAt: 1,
    })
    const { featureRecover } = await import("../src/feature-lifecycle/commands")
    const recovered = await featureRecover({ cwd: main, featureId })
    expect(recovered.featureId).toBe(featureId)
    expect(recovered.closeAttemptIds.length).toBe(1)
    // show reports the verified receipt with reachability.
    const { output } = await featureShow({ cwd: main, featureId })
    expect(output.receipts?.[0]?.landingReachable).toBe(true)
    // New execution authority is not granted: the record has no live context.
    expect(recovered.context).toBeUndefined()
    // With exactly one receipt-bearing feature, recover without --feature
    // resolves it; ambiguity across several would refuse instead of guessing.
    const unique = await featureRecover({ cwd: main })
    expect(unique.featureId).toBe(featureId)
  })
})
