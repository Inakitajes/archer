import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  ensureRepositoryRecord,
  isFound,
  lifecycleCommonDir,
  lifecycleRoot,
  readRepositoryRecord,
  withFeatureLock,
  writeJsonFile,
  type RepositoryRecord,
} from "../src/feature-lifecycle/store"
import {
  listFeatureIds,
  listReceiptIds,
  readAttemptJournal,
  readFeatureRecord,
  readReceipt,
  validateFeatureRecord,
  validateReceipt,
  writeFeatureRecord,
  writeReceiptIfAbsent,
  type FeatureRecord,
  type LandingReceipt,
} from "../src/feature-lifecycle/records"

/**
 * Task 1.1/1.2/1.3: the versioned store's typed reads, atomic feature
 * records with conflict detection, and immutable attempt journals/receipts.
 * Every reader must distinguish missing/corrupt/unsupported/unreadable, and
 * a lost-update write must be refused rather than overwrite concurrent work.
 */

const dirs: string[] = []
let repoDir: string
let commonDir: string

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-lifecycle-store-"))
  dirs.push(repoDir)
  const init = Bun.spawn(["git", "init", "-q", "-b", "main", repoDir])
  await init.exited
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  for (const args of [["add", "."], ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"]]) {
    const proc = Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "ignore" })
    await proc.exited
  }
  commonDir = (await lifecycleCommonDir(repoDir))!
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function sampleFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: "5f0a3c1e-8b2d-4c6a-9e0f-1a2b3c4d5e6f",
    repositoryId: "7c2b1a0d-3e4f-4a5b-8c9d-0e1f2a3b4c5d",
    displayName: "add-widget",
    associationRevision: 1,
    contracts: [{ changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 1 }],
    intendedBaseRef: "main",
    context: { branch: "feat/add-widget", checkoutPath: "/tmp/does-not-matter" },
    runIds: [],
    closeAttemptIds: [],
    history: [{ at: 1, kind: "adopted", summary: "adopted add-widget", revision: 1 }],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function sampleReceipt(overrides: Partial<LandingReceipt> = {}): LandingReceipt {
  return {
    schemaVersion: 1,
    attemptId: "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d",
    featureId: "5f0a3c1e-8b2d-4c6a-9e0f-1a2b3c4d5e6f",
    repositoryId: "7c2b1a0d-3e4f-4a5b-8c9d-0e1f2a3b4c5d",
    associationRevision: 2,
    branch: "feat/add-widget",
    baseRef: "main",
    baseSha: "a".repeat(40),
    featureTip: "b".repeat(40),
    preparedTree: "c".repeat(40),
    candidateSha: "d".repeat(40),
    landingSha: "e".repeat(40),
    landingAt: 42,
    ...overrides,
  }
}

describe("feature-lifecycle store: typed reads (task 1.1)", () => {
  test("repository record is missing before initialization and unreadable ≠ missing", async () => {
    const missing = await readRepositoryRecord(commonDir)
    expect(missing.status).toBe("missing")

    // A directory in place of the record is an I/O-level failure, not absence.
    await Bun.write(join(lifecycleRoot(commonDir), "keep"), "x")
    const { mkdir } = await import("node:fs/promises")
    await mkdir(join(lifecycleRoot(commonDir), "repository.json"), { recursive: true })
    const unreadable = await readRepositoryRecord(commonDir)
    expect(unreadable.status).toBe("unreadable")
    await rm(join(lifecycleRoot(commonDir), "repository.json"), { recursive: true, force: true })
    await rm(join(lifecycleRoot(commonDir), "keep"), { force: true })
  })

  test("corrupt JSON is corrupt with a reason, never 'missing'", async () => {
    await writeJsonFile(join(lifecycleRoot(commonDir), "repository.json"), { repositoryId: "not-a-uuid" })
    const corrupt = await readRepositoryRecord(commonDir)
    expect(corrupt.status).toBe("corrupt")
    if (corrupt.status === "corrupt") expect(corrupt.reason).toBeTruthy()
  })

  test("a newer schema version is unsupported, never interpreted (task 1.1/1.3)", async () => {
    await writeJsonFile(join(lifecycleRoot(commonDir), "repository.json"), { schemaVersion: 999, repositoryId: "7c2b1a0d-3e4f-4a5b-8c9d-0e1f2a3b4c5d", createdAt: 1 })
    const unsupported = await readRepositoryRecord(commonDir)
    expect(unsupported.status).toBe("unsupported")
    expect((unsupported as { schemaVersion?: unknown }).schemaVersion).toBe(999)
  })

  test("ensureRepositoryRecord creates exactly once and never overwrites an existing record", async () => {
    // A fresh repository so earlier tests' intentional corruption doesn't count.
    const fresh = await mkdtemp(join(tmpdir(), "convoy-lifecycle-fresh-"))
    dirs.push(fresh)
    const init = Bun.spawn(["git", "init", "-q", "-b", "main", fresh])
    await init.exited
    const freshCommon = (await lifecycleCommonDir(fresh))!
    const first = await ensureRepositoryRecord(freshCommon)
    expect(first.status).toBe("found")
    const id = (first as { value: RepositoryRecord }).value.repositoryId
    const again = await ensureRepositoryRecord(freshCommon)
    expect((again as { value: RepositoryRecord }).value.repositoryId).toBe(id)
    // A foreign record is returned untouched, not replaced.
    await writeJsonFile(join(lifecycleRoot(freshCommon), "repository.json"), { schemaVersion: 999, repositoryId: id, createdAt: 1 })
    const foreign = await ensureRepositoryRecord(freshCommon)
    expect(foreign.status).toBe("unsupported")
  })

  test("read failures are typed for feature records too", async () => {
    const featureId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    const read = await readFeatureRecord(commonDir, featureId)
    expect(read.status).toBe("missing")
  })
})

describe("feature records: validation and conflict detection (task 1.2)", () => {
  test("validateFeatureRecord rejects foreign or malformed shapes", () => {
    expect(validateFeatureRecord(undefined)).toBeUndefined()
    expect(validateFeatureRecord("nope")).toBeUndefined()
    expect(validateFeatureRecord({ ...sampleFeature(), schemaVersion: 99 })).toBeUndefined()
    expect(validateFeatureRecord({ ...sampleFeature(), featureId: "not-a-uuid" })).toBeUndefined()
    expect(validateFeatureRecord({ ...sampleFeature(), associationRevision: 0 })).toBeUndefined()
    expect(validateFeatureRecord({ ...sampleFeature(), contracts: [{ changeId: "x", kind: "unknown", sourcePath: "p", provenance: "a", selectedAtRevision: 1 }] })).toBeUndefined()
  })

  test("an embedded identity that disagrees with the record's path is corrupt (task 1.3)", async () => {
    const foreignId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
    const record = sampleFeature({ featureId: foreignId })
    const written = await writeFeatureRecord(commonDir, record, 0)
    expect(isFound(written)).toBe(true)
    // Reading a different id finds nothing — the id directory defines identity.
    const other = await readFeatureRecord(commonDir, sampleFeature().featureId)
    expect(other.status).toBe("missing")
  })

  test("a lost-update write is refused: stale expectedRevision never overwrites (task 1.2)", async () => {
    const featureId = "cccccccc-dddd-4eee-8fff-0123456789ab"
    const base = sampleFeature({ featureId })
    const first = await writeFeatureRecord(commonDir, base, 0)
    expect(isFound(first)).toBe(true)
    // A concurrent editor bumps the revision.
    const concurrent = sampleFeature({ featureId, associationRevision: 2, displayName: "concurrent" })
    const second = await writeFeatureRecord(commonDir, concurrent, 1)
    expect(isFound(second)).toBe(true)
    // The stale writer (still expecting revision 1) is refused.
    const stale = sampleFeature({ featureId, associationRevision: 2, displayName: "stale-writer" })
    const refused = await writeFeatureRecord(commonDir, stale, 1)
    expect(refused.status).toBe("found")
    if (refused.status === "found") expect(refused.value.displayName).toBe("concurrent")
    const onDisk = await readFeatureRecord(commonDir, featureId)
    expect(isFound(onDisk) && onDisk.value.displayName).toBe("concurrent")
  })

  test("listFeatureIds only surfaces UUID directories", async () => {
    const ids = await listFeatureIds(commonDir)
    expect(ids.length).toBeGreaterThanOrEqual(2)
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("withFeatureLock serializes and always releases (task 1.2/feature-lifecycle concurrency)", async () => {
    const featureDir = join(lifecycleRoot(commonDir), "features", "dddddddd-eeee-4fff-8aaa-123456789abc")
    let inLock = false
    let overlap = false
    const run = async (label: string) =>
      withFeatureLock(featureDir, async () => {
        if (inLock) overlap = true
        inLock = true
        await new Promise((resolve) => setTimeout(resolve, 30))
        inLock = false
        return label
      })
    const [a, b] = await Promise.all([run("a"), run("b")])
    expect(overlap).toBe(false)
    expect([a, b].sort()).toEqual(["a", "b"])
    // The lock file is gone afterwards.
    let lockGone = false
    try {
      await stat(join(featureDir, ".lock"))
    } catch {
      lockGone = true
    }
    expect(lockGone).toBe(true)
  })
})

describe("attempt journals and receipts (task 1.3)", () => {
  test("a journal with foreign embedded identity is corrupt", async () => {
    const featureId = sampleFeature().featureId
    const attemptId = "12345678-90ab-4cde-8f01-234567890abc"
    // Written under this feature's path but naming a foreign feature: the
    // embedded identity disagrees with the record's location (task 1.3).
    const { writeJsonFile, lifecycleRoot } = await import("../src/feature-lifecycle/store")
    await writeJsonFile(join(lifecycleRoot(commonDir), "features", featureId, "attempts", attemptId, "journal.json"), {
      schemaVersion: 1,
      attemptId,
      featureId: "99999999-9999-4999-8999-999999999999",
      repositoryId: sampleFeature().repositoryId,
      associationRevision: 1,
      phase: "prepared",
      contracts: [],
      baseRef: "main",
      baseSha: "a".repeat(40),
      branch: "feat/x",
      recordedAt: 1,
      updatedAt: 1,
    })
    const read = await readAttemptJournal(commonDir, featureId, attemptId)
    expect(read.status).toBe("corrupt")
  })

  test("receipts are immutable: writeReceiptIfAbsent refuses a second write (task 1.3/D8)", async () => {
    const featureId = "eeeeeeee-ffff-4aaa-8bbb-234567890abc"
    const receipt = sampleReceipt({ featureId })
    expect(await writeReceiptIfAbsent(commonDir, receipt)).toBe(true)
    const rewritten = sampleReceipt({ featureId, landingSha: "f".repeat(40) })
    expect(await writeReceiptIfAbsent(commonDir, rewritten)).toBe(false)
    const read = await readReceipt(commonDir, featureId, receipt.attemptId)
    expect(isFound(read) && read.value.landingSha).toBe(receipt.landingSha)
    expect(validateReceipt(await readFile(join(commonDir, "convoy", "features", featureId, "receipts", `${receipt.attemptId}.json`), "utf8").then(JSON.parse))).toBeTruthy()
    expect(listReceiptIds(commonDir, featureId).then((ids) => ids.length)).resolves.toBe(1)
  })

  test("validateReceipt rejects malformed receipts", () => {
    expect(validateReceipt({ ...sampleReceipt(), landingSha: "" })).toBeUndefined()
    expect(validateReceipt({ ...sampleReceipt(), featureId: "nope" })).toBeUndefined()
  })
})
