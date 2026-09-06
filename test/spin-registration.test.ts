import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { execFile as nodeExecFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { printSpinHandoff, runSpin } from "../src/spin"
import { isFound, lifecycleCommonDir, readRepositoryRecord } from "../src/feature-lifecycle/store"
import { listFeatureIds, readFeatureRecord } from "../src/feature-lifecycle/records"
import { resolveFeature } from "../src/feature-lifecycle/resolver"

/**
 * Task 4.1 (capability feature-spin): successful spin registers an explicit
 * feature association — intent before transfer, committed association before
 * success output — without changing conventional names or transfer behavior.
 */

const exec = promisify(nodeExecFile)
const dirs: string[] = []

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, { cwd })
  return stdout.trim()
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-spin-register-"))
  dirs.push(dir)
  await git(dir, "init", "-b", "main")
  await git(dir, "config", "user.email", "operator@example.com")
  await git(dir, "config", "user.name", "Operator")
  await writeFile(join(dir, "README.md"), "# repo\n")
  await git(dir, "add", ".")
  await git(dir, "commit", "-m", "chore: init")
  return dir
}

async function proposeUncommittedChange(repo: string, id: string): Promise<void> {
  const changeDir = join(repo, "openspec", "changes", id)
  await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), `# ${id}\n`)
  await writeFile(join(changeDir, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: It works\n")
}

async function freshEnv(): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "convoy-spin-reg-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

beforeEach(() => {
  void 0
})

describe("spin registration (task 4.1)", () => {
  test("successful spin registers the association and the handoff names it", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    const result = await runSpin({ targetDir: repo })
    expect(result.featureId).toMatch(/^[0-9a-f-]{36}$/)

    const commonDir = (await lifecycleCommonDir(repo))!
    const record = await readFeatureRecord(commonDir, result.featureId)
    expect(record.status).toBe("found")
    if (!isFound(record)) return
    expect(record.value.context?.branch).toBe(result.branch)
    expect(record.value.contracts.map((contract) => contract.changeId)).toEqual(["add-widget"])
    expect(record.value.intendedBaseRef).toBe("main")

    // All worktrees of the repo resolve the same association (spec scenario).
    const fromWorktree = await resolveFeature({ cwd: result.worktreeDir, commonDir })
    expect(fromWorktree.status).toBe("verified")
    if (fromWorktree.status === "verified") expect(fromWorktree.feature.featureId).toBe(result.featureId)

    // The handoff output identifies the feature.
    const chunks: string[] = []
    const originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      chunks.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      printSpinHandoff(result)
    } finally {
      process.stdout.write = originalWrite
    }
    expect(chunks.join("")).toContain(result.featureId)
    expect(chunks.join("")).toContain("/move")

    // Nothing was committed in the worktree (spin transfer unchanged).
    const status = await git(result.worktreeDir, "status", "--porcelain")
    expect(status).toContain("openspec/")
  })

  test("association persistence failure prevents the success handoff and exposes recovery context", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    // Make the store's parent unwritable so the committed-phase write fails
    // after the worktree and transfer succeeded: the first feature-store
    // write is the intent (allowed), later ones are blocked.
    const commonDir = (await lifecycleCommonDir(repo))!
    const originalWrite = Bun.write as (path: string, data?: unknown) => Promise<number | undefined>
    let writes = 0
    let blocked = 0
    ;(Bun as unknown as { write: unknown }).write = (path: string, data: unknown) => {
      if (typeof path === "string" && path.includes(join("convoy", "features"))) {
        writes += 1
        if (writes > 1) {
          blocked += 1
          return Promise.reject(new Error("disk full (simulated)"))
        }
      }
      return originalWrite(path, data)
    }
    try {
      await runSpin({ targetDir: repo })
      expect.unreachable("spin should have failed when the association could not be persisted")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).toMatch(/persisting the feature association failed/)
      expect(message).toMatch(/worktree:/)
      expect(message).toMatch(/transferred files:/)
      expect(message).toMatch(/convoy feature show/)
      expect(message).toMatch(/Nothing was committed/)
    } finally {
      ;(Bun as unknown as { write: unknown }).write = originalWrite as unknown as typeof Bun.write
    }
    expect(blocked).toBeGreaterThan(0)
  })

  test("retry after a partial result adopts the recorded intent instead of duplicating", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "add-widget")

    // Phase 1: fail at the committed phase (intent exists, transfer done):
    // allow the intent write, block every later feature-store write.
    const commonDir = (await lifecycleCommonDir(repo))!
    const originalWrite = Bun.write as (path: string, data?: unknown) => Promise<number | undefined>
    let writes = 0
    ;(Bun as unknown as { write: unknown }).write = (path: string, data: unknown) => {
      if (typeof path === "string" && path.includes(join("convoy", "features"))) {
        writes += 1
        if (writes > 1) return Promise.reject(new Error("disk full (simulated)"))
      }
      return originalWrite(path, data)
    }
    let firstError: string | undefined
    let worktreeDir: string | undefined
    try {
      await runSpin({ targetDir: repo })
    } catch (error) {
      firstError = error instanceof Error ? error.message : String(error)
      worktreeDir = firstError.match(/worktree: (\S+)/)?.[1]
    } finally {
      ;(Bun as unknown as { write: unknown }).write = originalWrite as unknown as typeof Bun.write
    }
    expect(firstError).toBeTruthy()
    expect(worktreeDir).toBeTruthy()

    // The intent record exists exactly once.
    const ids = await listFeatureIds(commonDir)
    expect(ids).toHaveLength(1)

    // Phase 2: a spin for the same change/branch now resumes the intent.
    const { registerSpinFeature } = await import("../src/feature-lifecycle/commands")
    const resumed = await registerSpinFeature({ cwd: repo, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: worktreeDir!, baseRef: "main", phase: "committed" })
    expect(resumed.resumed).toBe(true)
    expect(resumed.feature.featureId).toBe(ids[0])
  })

  test("refusal before creation persists no feature (store stays uninitialized)", async () => {
    await freshEnv()
    const repo = await makeRepo()
    await proposeUncommittedChange(repo, "one")
    await proposeUncommittedChange(repo, "two")
    try {
      await runSpin({ targetDir: repo })
      expect.unreachable("ambiguous changes must stop spin")
    } catch (error) {
      expect((error as Error).message).toMatch(/--change/)
    }
    const commonDir = (await lifecycleCommonDir(repo))!
    expect((await readRepositoryRecord(commonDir)).status).toBe("missing")
    expect(await listFeatureIds(commonDir)).toEqual([])
  })
})
