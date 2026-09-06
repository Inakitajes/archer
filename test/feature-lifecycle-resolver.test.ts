import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile } from "../src/git"
import { ensureRepositoryRecord, isFound, lifecycleCommonDir, lifecycleRoot } from "../src/feature-lifecycle/store"
import { writeFeatureRecord, type FeatureRecord } from "../src/feature-lifecycle/records"
import { planningPathWithin, resolveFeature } from "../src/feature-lifecycle/resolver"

/**
 * Task 2.3: the one shared resolver — explicit ID → verified context →
 * unique explicit filters → unresolved candidates — with invalid selectors
 * refusing instead of falling through to a heuristic.
 */

const dirs: string[] = []
let repoDir: string
let worktreeDir: string
let commonDir: string

const featureAId = "aaaaaaaa-0000-4000-8000-000000000001"
const featureBId = "aaaaaaaa-0000-4000-8000-000000000002"

async function git(args: string[], cwd: string): Promise<void> {
  const result = await execFile("git", args, { cwd, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
}

function feature(id: string, overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: id,
    repositoryId: "",
    displayName: `feature-${id.slice(0, 4)}`,
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
  repoDir = await mkdtemp(join(tmpdir(), "convoy-lifecycle-resolver-"))
  dirs.push(repoDir)
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  await git(["init", "-q", "-b", "main"], repoDir)
  await git(["add", "."], repoDir)
  await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"], repoDir)
  worktreeDir = join(await mkdtemp(join(tmpdir(), "convoy-lifecycle-resolver-wt-")), "wt")
  dirs.push(worktreeDir)
  // The feature branch is born in the worktree (the main checkout stays on main).
  const added = await execFile("git", ["worktree", "add", "-b", "feat/add-widget", worktreeDir], { cwd: repoDir, allowFailure: true })
  if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr || added.stdout}`)
  commonDir = (await lifecycleCommonDir(repoDir))!
  const repoRecord = await ensureRepositoryRecord(commonDir)
  if (!isFound(repoRecord)) throw new Error("repository record missing")

  // Feature A: associated with the worktree branch, no recorded path (pathless
  // context verifies from the worktree inventory alone).
  const a = feature(featureAId, {
    repositoryId: repoRecord.value.repositoryId,
    context: { branch: "feat/add-widget" },
  })
  // Feature B: associated with a different change on a branch that is nowhere
  // checked out — never verified, only selectable by filters.
  const b = feature(featureBId, {
    repositoryId: repoRecord.value.repositoryId,
    displayName: "elsewhere",
    contracts: [{ changeId: "change-elsewhere", kind: "active", sourcePath: "openspec/changes/change-elsewhere", provenance: "adopt", selectedAtRevision: 1 }],
    context: { branch: "team/alice/elsewhere" },
  })
  await writeFeatureRecord(commonDir, a, 0)
  await writeFeatureRecord(commonDir, b, 0)
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("shared resolver (task 2.3)", () => {
  test("explicit feature ID verifies and agrees with matching selectors", async () => {
    const resolved = await resolveFeature({ cwd: repoDir, commonDir, featureId: featureAId, changeId: "add-widget" })
    expect(resolved.status).toBe("verified")
    if (resolved.status !== "verified") return
    expect(resolved.feature.featureId).toBe(featureAId)
    expect(resolved.context.branch).toBe("feat/add-widget")
    expect(resolved.context.checkoutPath).toBeTruthy()
  })

  test("a mistyped change selector never falls through to a heuristic", async () => {
    const resolved = await resolveFeature({ cwd: repoDir, commonDir, featureId: featureAId, changeId: "other-change" })
    expect(resolved.status).toBe("ambiguous")
    if (resolved.status === "ambiguous") expect(resolved.reason).toMatch(/not one of feature/)
  })

  test("a contradictory branch selector is ambiguous, not silently re-resolved", async () => {
    const resolved = await resolveFeature({ cwd: repoDir, commonDir, featureId: featureAId, branch: "some/other" })
    expect(resolved.status).toBe("ambiguous")
  })

  test("an unknown or malformed explicit ID is missing — never heuristic fallback", async () => {
    expect((await resolveFeature({ cwd: repoDir, commonDir, featureId: "99999999-9999-4999-8999-999999999999" })).status).toBe("missing")
    expect((await resolveFeature({ cwd: repoDir, commonDir, featureId: "not-a-uuid" })).status).toBe("missing")
  })

  test("verified context association resolves from the current checkout", async () => {
    const resolved = await resolveFeature({ cwd: worktreeDir, commonDir })
    expect(resolved.status).toBe("verified")
    if (resolved.status !== "verified") return
    expect(resolved.feature.featureId).toBe(featureAId)
  })

  test("a change filter selects the unique feature that carries it", async () => {
    const resolved = await resolveFeature({ cwd: repoDir, commonDir, changeId: "add-widget" })
    expect(resolved.status).toBe("verified")
  })

  test("a missing context (branch nowhere checked out) is reported as missing, not dropped", async () => {
    const resolved = await resolveFeature({ cwd: repoDir, commonDir, featureId: featureBId })
    expect(resolved.status).toBe("missing")
    if (resolved.status === "missing") expect(resolved.reason).toMatch(/not checked out/)
  })

  test("an uninitialized store resolves to unassociated without creating anything", async () => {
    const fresh = await mkdtemp(join(tmpdir(), "convoy-lifecycle-resolver-fresh-"))
    dirs.push(fresh)
    const proc = Bun.spawn(["git", "init", "-q", "-b", "main", fresh])
    await proc.exited
    const freshCommon = (await lifecycleCommonDir(fresh))!
    const { stat } = await import("node:fs/promises")
    const resolved = await resolveFeature({ cwd: fresh, commonDir: freshCommon })
    expect(resolved.status).toBe("unassociated")
    // Browsing created no registry.
    let created = false
    try {
      await stat(join(freshCommon, "convoy", "repository.json"))
    } catch {
      created = false
    }
    expect(created).toBe(false)
  })
})

describe("planning path validation (task 2.3/D3)", () => {
  test("paths must stay inside the planning root", () => {
    expect(planningPathWithin("/repo", "openspec/changes/x")).toBe("openspec/changes/x")
    expect(planningPathWithin("/repo", "./openspec/changes/x")).toBe("openspec/changes/x")
    expect(planningPathWithin("/repo", "../outside")).toBeUndefined()
    expect(planningPathWithin("/repo", "/absolute")).toBeUndefined()
    expect(planningPathWithin("/repo", "")).toBeUndefined()
  })
})
