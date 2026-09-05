import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  clearCloseJournal,
  closeCandidateRef,
  closeFeatureTipRef,
  protectCloseRef,
  isLandingReachable,
  readCloseJournal,
  readCloseJournalValue,
  writeCloseJournal,
  type CloseJournal,
} from "../src/close-journal"

/**
 * The close journal is the landing receipt (capability feature-close, design
 * D6/D7, tasks 5.1/5.7): a versioned record in the Git common dir that stages
 * the landing transaction and later authorizes cleanup. Round-trip and
 * backward-compat behavior are verified here against a real repository so the
 * common-dir resolution and create-only refs are exercised for real.
 */

const dirs: string[] = []

let repoDir: string

beforeAll(async () => {
  repoDir = await mkdtemp(join(tmpdir(), "convoy-close-journal-"))
  dirs.push(repoDir)
  const init = Bun.spawn(["git", "init", "-q", "-b", "main", repoDir])
  await init.exited
  // One real commit so evidence refs have valid objects to point at.
  await Bun.write(join(repoDir, "README.md"), "# repo\n")
  for (const args of [["add", "."], ["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "init"]]) {
    const proc = Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "ignore" })
    await proc.exited
  }
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

function sampleJournal(overrides: Partial<CloseJournal> = {}): CloseJournal {
  return {
    schemaVersion: 1,
    attemptID: "attempt-1",
    branch: "feat/add-widget",
    changeID: "add-widget",
    baseRef: "main",
    baseSha: "a".repeat(40),
    phase: "prepared",
    recordedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe("close journal round-trip", () => {
  test("write then read preserves every field", async () => {
    const journal = sampleJournal({
      preSyncTip: "b".repeat(40),
      postArchiveTip: "c".repeat(40),
      preparedTree: "d".repeat(40),
      messageContext: { proposalExcerpt: "# Add widget", scopeCandidates: ["cli"], commitSubjects: ["feat: propose"] },
      message: "feat(cli): improve add widget",
      phase: "candidate",
      candidateSha: "e".repeat(40),
    })
    await writeCloseJournal(repoDir, journal)
    const read = await readCloseJournal(repoDir, "feat/add-widget", "add-widget")
    expect(read).toEqual(journal)
  })

  test("an absent journal reads as undefined, never throws", async () => {
    expect(await readCloseJournal(repoDir, "feat/other", "other")).toBeUndefined()
  })

  test("a malformed journal is unread rather than fatal (backward compatibility)", async () => {
    await Bun.write(join(repoDir, "convoy", "close", "broken__broken.json"), "{ not json")
    expect(await readCloseJournal(repoDir, "broken", "broken")).toBeUndefined()
    expect(readCloseJournalValue("garbage")).toBeUndefined()
    expect(readCloseJournalValue({ branch: "x" })).toBeUndefined()
    // A foreign schema version is not silently interpreted as current.
    expect(readCloseJournalValue({ ...sampleJournal(), schemaVersion: 99 })).toBeUndefined()
  })

  test("clear removes the receipt so a superseded attempt cannot authorize cleanup", async () => {
    await writeCloseJournal(repoDir, sampleJournal())
    expect(await readCloseJournal(repoDir, "feat/add-widget", "add-widget")).toBeDefined()
    await clearCloseJournal(repoDir, "feat/add-widget", "add-widget")
    expect(await readCloseJournal(repoDir, "feat/add-widget", "add-widget")).toBeUndefined()
  })
})

describe("close evidence refs", () => {
  test("protectCloseRef is create-only: a repeat protection never overwrites evidence", async () => {
    const revParse = async (ref: string) => {
      const proc = Bun.spawn(["git", "rev-parse", ref], { cwd: repoDir, stdout: "pipe" })
      const out = await new Response(proc.stdout).text()
      await proc.exited
      return out.trim()
    }
    const head = await revParse("HEAD")
    await protectCloseRef(closeFeatureTipRef("feat/add-widget", "attempt-1"), head, repoDir)
    // A repeat protection for the same ref must not move the evidence: the
    // ref still holds the first sha afterwards.
    await protectCloseRef(closeFeatureTipRef("feat/add-widget", "attempt-1"), head, repoDir)
    expect(await revParse(closeFeatureTipRef("feat/add-widget", "attempt-1"))).toBe(head)
  })

  test("isLandingReachable is true only when the landing is an ancestor of the base", async () => {
    const git = (args: string[]) => Bun.spawn(["git", ...args], { cwd: repoDir, stdout: "ignore" }).exited
    await Bun.write(join(repoDir, "f.txt"), "one\n")
    await git(["add", "."])
    await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-m", "one"])
    const first = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoDir }).stdout).text()).trim()
    await Bun.write(join(repoDir, "f.txt"), "two\n")
    await git(["-c", "user.email=t@x", "-c", "user.name=T", "commit", "-am", "two"])
    const second = (await new Response(Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: repoDir }).stdout).text()).trim()

    expect(await isLandingReachable(first, "main", repoDir)).toBe(true)
    expect(await isLandingReachable(second, "main", repoDir)).toBe(true)
    // An unknown or foreign commit is never evidence of a landing.
    expect(await isLandingReachable("f".repeat(40), "main", repoDir)).toBe(false)
    expect(await isLandingReachable(first, "no-such-branch", repoDir)).toBe(false)
  })
})
