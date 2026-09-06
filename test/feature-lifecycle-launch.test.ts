import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile, currentBranch, findWorktreeDirForBranch } from "../src/git"
import { ensureRepositoryRecord, isFound, lifecycleCommonDir } from "../src/feature-lifecycle/store"
import { writeFeatureRecord, type FeatureRecord } from "../src/feature-lifecycle/records"
import { revalidateFeatureLink, resolveFeatureForLaunch } from "../src/feature-lifecycle/launch"
import type { FeaturePlanLink } from "../src/types"

/**
 * Tasks 4.3/4.4: feature-aware launches resolve the reviewed link through the
 * shared resolver (from any checkout), and execution revalidates it — a
 * branch switch or association change after review refuses and attaches
 * nothing to the replacement context.
 */

const dirs: string[] = []
let repoDir: string
let worktreeDir: string
let commonDir: string
let featureId: string
let repositoryId: string

async function git(args: string[], cwd: string): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

function record(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId,
    repositoryId,
    displayName: "add-widget",
    associationRevision: 1,
    contracts: [{ changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 1 }],
    intendedBaseRef: "main",
    runIds: [],
    closeAttemptIds: [],
    history: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-lifecycle-launch-"))
  dirs.push(repoDir)
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  await git(["init", "-q", "-b", "main"], repoDir)
  await git(["add", "."], repoDir)
  await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"], repoDir)
  worktreeDir = join(await mkdtemp(join(tmpdir(), "convoy-lifecycle-launch-wt-")), "wt")
  dirs.push(worktreeDir)
  const added = await execFile("git", ["worktree", "add", "-b", "feat/add-widget", worktreeDir], { cwd: repoDir, allowFailure: true })
  if (added.exitCode !== 0) throw new Error(`worktree add failed: ${added.stderr}`)
  commonDir = (await lifecycleCommonDir(repoDir))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("no repository record")
  repositoryId = repoRecord.value.repositoryId
  featureId = "aaaaaaaa-0000-4000-8000-00000000abc1"
  await writeFeatureRecord(commonDir, record({ context: { branch: "feat/add-widget" } }), 0)
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("resolveFeatureForLaunch (task 4.3)", () => {
  test("a verified association resolves from any checkout of the repository", async () => {
    // From the main checkout…
    const fromMain = await resolveFeatureForLaunch({ cwd: repoDir, featureId })
    expect(fromMain).toBeDefined()
    expect(fromMain!.branch).toBe("feat/add-widget")
    expect(fromMain!.baseRef).toBe("main")
    // …and from the worktree itself (cross-checkout Apply/Continue).
    const fromWorktree = await resolveFeatureForLaunch({ cwd: worktreeDir, featureId })
    expect(fromWorktree).toBeDefined()
    expect(fromWorktree!.featureId).toBe(fromMain!.featureId)
    expect(fromWorktree!.worktreeDir).toBeTruthy()
  })

  test("a run without --feature and an unassociated context resolves no link (no-spec flow intact)", async () => {
    const resolved = await resolveFeatureForLaunch({ cwd: repoDir })
    expect(resolved).toBeUndefined()
  })

  test("an explicit --feature that is not verified refuses with remediation guidance", async () => {
    await expect(resolveFeatureForLaunch({ cwd: repoDir, featureId: "99999999-9999-4999-8999-999999999999" })).rejects.toThrow(/convoy feature (adopt|show)/)
    await expect(resolveFeatureForLaunch({ cwd: repoDir, featureId: "garbage" })).rejects.toThrow(/not a feature id/)
  })

  test("a mistyped change selector refuses instead of resolving to other work", async () => {
    await expect(resolveFeatureForLaunch({ cwd: repoDir, featureId, changeId: "other-change" })).rejects.toThrow(/not one of feature/)
  })
})

describe("revalidateFeatureLink (task 4.4)", () => {
  test("an unchanged verified target revalidates", async () => {
    const link = await resolveFeatureForLaunch({ cwd: repoDir, featureId })
    expect(link).toBeDefined()
    await revalidateFeatureLink({ cwd: repoDir, link: link! })
  })

  test("the reviewed feature link persists in run metadata before execution (task 4.2)", async () => {
    const link = await resolveFeatureForLaunch({ cwd: repoDir, featureId })
    expect(link).toBeDefined()
    const { mkdtempSync } = await import("node:fs")
    const workspaceDir = mkdtempSync(join(tmpdir(), "convoy-lifecycle-meta-"))
    dirs.push(workspaceDir)
    const { openRunMetadata } = await import("../src/metadata")
    const store = await openRunMetadata(
      { dir: workspaceDir, runID: "20260101-000000-feat" } as never,
      repoDir,
      { name: "full-cycle", steps: [] } as never,
      { feature: link },
    )
    await store.flush()
    const persisted = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(workspaceDir, "metadata.json"), "utf8")))
    expect(persisted.feature.featureId).toBe(link!.featureId)
    expect(persisted.feature.associationRevision).toBe(link!.associationRevision)
    expect(persisted.feature.branch).toBe("feat/add-widget")
    // A resume never replaces the recorded link.
    const store2 = await openRunMetadata(
      { dir: workspaceDir, runID: "20260101-000000-feat" } as never,
      repoDir,
      { name: "full-cycle", steps: [] } as never,
      { feature: { ...link!, associationRevision: link!.associationRevision + 5 } },
    )
    void store2
    await store2.flush()
    expect(JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(join(workspaceDir, "metadata.json"), "utf8"))).feature.associationRevision).toBe(link!.associationRevision)
    void store
  })

  test("a branch switch after review refuses and attaches nothing to the new branch", async () => {
    const link = await resolveFeatureForLaunch({ cwd: repoDir, featureId })
    expect(link).toBeDefined()
    // Switch the worktree's branch out from under the association.
    await git(["checkout", "-q", "-b", "other-branch"], worktreeDir)
    try {
      await expect(revalidateFeatureLink({ cwd: repoDir, link: link! })).rejects.toThrow(/refuses to start/)
    } finally {
      await git(["checkout", "-q", "feat/add-widget"], worktreeDir)
    }
  })

  test("a stale association revision refuses the reviewed contract set", async () => {
    const link = await resolveFeatureForLaunch({ cwd: repoDir, featureId })
    expect(link).toBeDefined()
    const stale: FeaturePlanLink = { ...link!, associationRevision: link!.associationRevision - 1 }
    await expect(revalidateFeatureLink({ cwd: repoDir, link: stale })).rejects.toThrow(/association advanced/)
  })

  test("a changed intended base refuses", async () => {
    const link = await resolveFeatureForLaunch({ cwd: repoDir, featureId })
    expect(link).toBeDefined()
    const stale: FeaturePlanLink = { ...link!, baseRef: "some/other-base" }
    await expect(revalidateFeatureLink({ cwd: repoDir, link: stale })).rejects.toThrow(/intended base changed/)
  })

  test("a removed worktree refuses as a missing context", async () => {
    const link = await resolveFeatureForLaunch({ cwd: repoDir, featureId })
    expect(link).toBeDefined()
    const removed = await findWorktreeDirForBranch("feat/add-widget", repoDir)
    expect(removed?.endsWith("/wt")).toBe(true)
    await git(["checkout", "-q", "--detach"], worktreeDir)
    const result = await execFile("git", ["worktree", "remove", worktreeDir], { cwd: repoDir, allowFailure: true })
    if (result.exitCode !== 0) {
      await git(["checkout", "-q", "feat/add-widget"], worktreeDir)
      throw new Error(`worktree remove failed: ${result.stderr}`)
    }
    try {
      await expect(revalidateFeatureLink({ cwd: repoDir, link: link! })).rejects.toThrow(/context changed since review/)
    } finally {
      // Recreate the worktree for the remaining expectations.
      const reAdd = await execFile("git", ["worktree", "add", worktreeDir, "feat/add-widget"], { cwd: repoDir, allowFailure: true })
      if (reAdd.exitCode !== 0) throw new Error(`re-add failed: ${reAdd.stderr}`)
    }
    expect(await currentBranch(worktreeDir)).toBe("feat/add-widget")
  })
})
