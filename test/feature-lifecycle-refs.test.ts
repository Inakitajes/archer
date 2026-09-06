import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { execFile, resolveCommit } from "../src/git"
import {
  featureCandidateRef,
  featureTipRef,
  isLandingReachableFrom,
  protectFeatureRef,
  readProtectedRef,
  zeroRefOldValue,
} from "../src/feature-lifecycle/refs"

/**
 * Task 1.4: protected feature/attempt refs are create-only, a pre-existing
 * mismatched ref is refused (never overwritten), and idempotent replays of
 * the same evidence succeed.
 */

const dirs: string[] = []
let repoDir: string
const featureId = "5f0a3c1e-8b2d-4c6a-9e0f-1a2b3c4d5e6f"
const attemptId = "9a8b7c6d-5e4f-4a3b-2c1d-0e9f8a7b6c5d"

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-lifecycle-refs-"))
  dirs.push(repoDir)
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  const init = Bun.spawn(["git", "init", "-q", "-b", "main", repoDir], { stderr: "pipe" })
  const initErr = await new Response(init.stderr).text()
  if ((await init.exited) !== 0) throw new Error(`git init failed: ${initErr}`)
  for (const args of [["add", "."], ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"]]) {
    const proc = Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "ignore", stderr: "pipe" })
    const err = await new Response(proc.stderr).text()
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")} failed: ${err}`)
  }
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function commitFile(message: string): Promise<string> {
  const name = `file-${Math.random().toString(36).slice(2)}.txt`
  await Bun.write(join(repoDir, name), message)
  await execFile("git", ["add", "."], { cwd: repoDir })
  await execFile("git", ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", message], { cwd: repoDir })
  return (await resolveCommit("HEAD", repoDir))!
}

describe("protected feature refs (task 1.4)", () => {
  test("ref layout uses the opaque feature/attempt UUIDs", () => {
    expect(featureTipRef(featureId, attemptId)).toBe(`refs/convoy/features/${featureId}/${attemptId}/feature-tip`)
    expect(featureCandidateRef(featureId, attemptId)).toBe(`refs/convoy/features/${featureId}/${attemptId}/candidate`)
  })

  test("create-only: the first protect lands, the same evidence replays, a mismatch refuses", async () => {
    const tip1 = await commitFile("evidence-1")
    await protectFeatureRef(featureTipRef(featureId, attemptId), tip1, repoDir)
    expect(await readProtectedRef(featureTipRef(featureId, attemptId), repoDir)).toBe(tip1)

    // Idempotent replay of the same evidence is a no-op success.
    await protectFeatureRef(featureTipRef(featureId, attemptId), tip1, repoDir)

    // Different evidence at the same ref: refused, original value preserved.
    const tip2 = await commitFile("evidence-2")
    await expect(protectFeatureRef(featureTipRef(featureId, attemptId), tip2, repoDir)).rejects.toThrow(/refusing to overwrite/)
    expect(await readProtectedRef(featureTipRef(featureId, attemptId), repoDir)).toBe(tip1)

    // The candidate namespace is independent.
    await protectFeatureRef(featureCandidateRef(featureId, attemptId), tip2, repoDir)
    expect(await readProtectedRef(featureCandidateRef(featureId, attemptId), repoDir)).toBe(tip2)
  })

  test("the create-only write goes through an all-zero expected old value", () => {
    expect(zeroRefOldValue).toBe("0000000000000000000000000000000000000000")
  })

  test("landing reachability: ancestor true, unrelated/missing false", async () => {
    const landing = await commitFile("landing")
    expect(await isLandingReachableFrom(landing, "main", repoDir)).toBe(true)
    expect(await isLandingReachableFrom("f".repeat(40), "main", repoDir)).toBe(false)
    // An orphan branch is not reachable from main.
    const orphan = Bun.spawn(["git", "checkout", "--orphan", "orphan-branch"], { cwd: repoDir, stdout: "ignore" })
    await orphan.exited
    await Bun.write(join(repoDir, "orphan.txt"), "orphan")
    await execFile("git", ["add", "."], { cwd: repoDir })
    await execFile("git", ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "orphan root"], { cwd: repoDir })
    const orphanTip = (await resolveCommit("HEAD", repoDir))!
    expect(await isLandingReachableFrom(orphanTip, "main", repoDir)).toBe(false)
    await Bun.spawn(["git", "checkout", "-q", "main"], { cwd: repoDir }).exited
  })
})
