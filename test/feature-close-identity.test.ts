import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath as realPath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runClose, verifiedCloseReceipt, readCloseJournal, type CloseInput } from "../src/feature-close"
import { templateCommitMessage, type CommitMessageProposal } from "../src/commit-message"
import { writeCloseJournal } from "../src/close-journal"
import { listFeatureIds } from "../src/feature-lifecycle/records"
import { lifecycleCommonDir } from "../src/feature-lifecycle/store"
import { listAttemptIds, listReceiptIds, readAttemptJournal, readReceipt, readFeatureRecord } from "../src/feature-lifecycle/records"
import { registerSpinFeature } from "../src/feature-lifecycle/commands"
import { isFound } from "../src/feature-lifecycle/store"
import { resolveCommit, execFile } from "../src/git"

/**
 * Tasks 7.1/7.3/7.4: close resolves through stable feature identity, persists
 * the attempt before the first mutation, writes an immutable identity-keyed
 * receipt at landing, and a repeated close (with or without --resume) performs
 * no second landing.
 */

const dirs: string[] = []
const originalPath = process.env.PATH
const originalConvoyHome = process.env.CONVOY_HOME

async function git(dir: string, env: Record<string, string>, ...args: string[]): Promise<void> {
  const result = await execFile("git", args, { cwd: dir, env: { ...process.env, ...env } as Record<string, string>, allowFailure: true })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr || result.stdout}`)
}

const user = { GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.com", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.com" }
const convoy = { GIT_AUTHOR_NAME: "convoy", GIT_AUTHOR_EMAIL: "convoy@local", GIT_COMMITTER_NAME: "convoy", GIT_COMMITTER_EMAIL: "convoy@local" }

/** The injected OpenSpec double (same shape feature-close.test.ts uses). */
async function writeOpenspecDouble(binDir: string): Promise<void> {
  const script = `#!/bin/sh
cmd="$1"; shift
root="$(pwd)"
if [ "$cmd" = "list" ] && [ "$1" = "--json" ]; then
  # Count checkboxes the way the real CLI would, for every active change.
  changes=""
  for d in "$root"/openspec/changes/*/; do
    id="$(basename "$d")"
    [ "$id" = "archive" ] && continue
    [ -f "$d/tasks.md" ] || continue
    total="$(grep -cE '^\\s*[-*+]\\s+\\[[xX ]\\]' "$d/tasks.md" || true)"
    done_n="$(grep -cE '^\\s*[-*+]\\s+\\[[xX]\\]' "$d/tasks.md" || true)"
    entry="{\\"name\\":\\"$id\\",\\"completedTasks\\":$done_n,\\"totalTasks\\":$total}"
    if [ -z "$changes" ]; then changes="$entry"; else changes="$changes,$entry"; fi
  done
  echo "{\\"changes\\":[$changes]}"
  exit 0
fi
if [ "$cmd" = "archive" ]; then
  id="$1"
  dir="$root/openspec/changes"
  if [ ! -d "$dir/$id" ]; then
    echo "no such change: $id" >&2
    exit 1
  fi
  mkdir -p "$root/openspec/changes/archive"
  mv "$dir/$id" "$root/openspec/changes/archive/$id"
  if [ -z "$CONVOY_OPENSPEC_NO_CANONICAL" ]; then
    mkdir -p "$root/openspec/specs/cli"
    printf '# cli\\n\\n## Requirements\\n\\n### Requirement: Widget\\n' > "$root/openspec/specs/cli/spec.md"
  fi
  exit 0
fi
echo "unexpected openspec invocation: $cmd" >&2
exit 1
`
  const path = join(binDir, "openspec")
  await writeFile(path, script)
  await chmod(path, 0o755)
}

async function makeFixture(): Promise<{ root: string; mainDir: string; worktreeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "convoy-close-identity-"))
  dirs.push(root)
  const mainDir = join(root, "main")
  const worktreeDir = join(root, "wt")
  await mkdir(mainDir, { recursive: true })
  await git(mainDir, {}, "init", "-b", "main")
  await git(mainDir, user, "config", "user.email", "operator@example.com")
  await git(mainDir, user, "config", "user.name", "Operator")
  await writeFile(join(mainDir, "README.md"), "# repo\n")
  await git(mainDir, user, "add", ".")
  await git(mainDir, user, "commit", "-m", "chore: init")
  await git(mainDir, {}, "worktree", "add", "-b", "feat/add-widget", worktreeDir, "main")

  const changeDir = join(worktreeDir, "openspec", "changes", "add-widget")
  await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
  await writeFile(join(changeDir, "tasks.md"), "- [x] one\n- [x] two\n")
  await writeFile(join(changeDir, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: Widget\n")
  await git(worktreeDir, user, "add", ".")
  await git(worktreeDir, user, "commit", "-m", "feat(openspec): propose add-widget")
  await writeFile(join(worktreeDir, "src.ts"), "export const widget = 1\n")
  await git(worktreeDir, convoy, "add", ".")
  await git(worktreeDir, convoy, "commit", "-m", "convoy(implement): implement add-widget")

  return { root, mainDir: await realPath(mainDir), worktreeDir: await realPath(worktreeDir) }
}

const closeInput = (fixture: { mainDir: string; worktreeDir: string }, extra: Partial<CloseInput> = {}): CloseInput => ({
  targetDir: fixture.mainDir,
  worktreeDir: fixture.worktreeDir,
  branch: "feat/add-widget",
  changeID: "add-widget",
  ...extra,
})

const writerFails: CloseInput["writer"] = async () =>
  ({ message: templateCommitMessage({ targetDir: "", branch: "", commits: [] }), source: "template", error: "writer unavailable (test double)" }) satisfies CommitMessageProposal

beforeAll(async () => {
  const binDir = join(tmpdir(), `convoy-close-identity-bin-${Math.random().toString(36).slice(2)}`)
  dirs.push(binDir)
  await mkdir(binDir, { recursive: true })
  await writeOpenspecDouble(binDir)
  process.env.PATH = `${binDir}:${process.env.PATH}`
  const home = await mkdtemp(join(tmpdir(), "convoy-close-identity-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  if (originalConvoyHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = originalConvoyHome
  if (originalPath !== undefined) process.env.PATH = originalPath
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("identity-keyed close (tasks 7.1/7.3/7.4)", () => {
  test("close on a registered feature writes the attempt and an immutable receipt; repeated close performs nothing", async () => {
    const fixture = await makeFixture()

    // Register the feature first (as spin would have).
    const registration = await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const featureId = registration.feature.featureId

    const result = await runClose({ ...closeInput(fixture), writer: writerFails })
    expect(result.disposition).toBe("landed")
    expect(result.landing).toBeDefined()

    const commonDir = (await lifecycleCommonDir(fixture.mainDir))!
    // The attempt journal persisted under the stable identity.
    const attemptIds = await listAttemptIds(commonDir, featureId)
    expect(attemptIds).toHaveLength(1)
    const journal = await readAttemptJournal(commonDir, featureId, attemptIds[0]!)
    expect(journal.status).toBe("found")
    if (isFound(journal)) {
      expect(journal.value.phase).toBe("landed")
      expect(journal.value.landingSha).toBe(result.landing!.sha)
    }
    // The immutable receipt exists and names the exact tip and landing.
    const receiptIds = await listReceiptIds(commonDir, featureId)
    expect(receiptIds).toHaveLength(1)
    const receipt = await readReceipt(commonDir, featureId, receiptIds[0]!)
    expect(receipt.status).toBe("found")
    if (isFound(receipt)) {
      expect(receipt.value.landingSha).toBe(result.landing!.sha)
      expect(receipt.value.branch).toBe("feat/add-widget")
      expect(receipt.value.featureTip).toBeTruthy()
    }
    // The feature record carries the attempt pointer.
    const feature = await readFeatureRecord(commonDir, featureId)
    expect(isFound(feature) && feature.value.closeAttemptIds).toEqual([attemptIds[0]])

    // A repeated close (no --resume) reports the existing landing: no sync,
    // no archive, no second commit.
    const baseBefore = await resolveCommit("main", fixture.mainDir)
    const again = await runClose({ ...closeInput(fixture), writer: writerFails })
    expect(again.disposition).toBe("already-landed")
    expect(again.landing!.sha).toBe(result.landing!.sha)
    expect(await resolveCommit("main", fixture.mainDir)).toBe(baseBefore)
    // The receipt count is still exactly one.
    expect(await listReceiptIds(commonDir, featureId).then((ids) => ids.length)).toBe(1)
  })

  test("verifiedCloseReceipt resolves the identity-keyed receipt for the board", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const result = await runClose({ ...closeInput(fixture), writer: writerFails })
    const receipt = await verifiedCloseReceipt(fixture.mainDir, "feat/add-widget", "add-widget")
    expect(receipt).toBeDefined()
    expect(receipt!.landingSha).toBe(result.landing!.sha)
  })

  test("the checklist's preflight names the verified feature (task 7.8)", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const events: Array<{ type: string; summary?: string }> = []
    await runClose({ ...closeInput(fixture), writer: writerFails, onEvent: (event) => events.push(event) })
    const preflight = events.find((event) => event.type === "preflight")
    expect(preflight?.summary).toContain("feature add-widget")
    // The result names the landing (integration) — never a merge shape.
    const result = events.find((event) => event.type === "result")
    expect(result).toBeTruthy()
  })

  test("archive-on-main verifies the base copy and records the archive source (task 7.9)", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })

    // The probably-merged scenario: the same change also sits on the base
    // checkout (committed, so the checkout is clean). Archive-on-main
    // verifies that base copy (markdown present, effects provable) and
    // records the archive source on the feature's contract.
    const baseChange = join(fixture.mainDir, "openspec", "changes", "add-widget")
    await mkdir(baseChange, { recursive: true })
    await writeFile(join(baseChange, "proposal.md"), "# Add widget\n")
    await writeFile(join(baseChange, "tasks.md"), "- [x] one\n- [x] two\n")
    await git(fixture.mainDir, user, "add", ".")
    await git(fixture.mainDir, user, "commit", "-m", "feat(openspec): copy of add-widget proposal on main")

    const { archiveChangeOnMain } = await import("../src/feature-close")
    const result = await archiveChangeOnMain({ targetDir: fixture.mainDir, changeID: "add-widget" })
    expect(result.committed).toBe(true)
    expect(result.archiveSource).toBe(join("openspec", "changes", "archive", "add-widget"))

    const commonDir = (await lifecycleCommonDir(fixture.mainDir))!
    const { listFeatureIds } = await import("../src/feature-lifecycle/records")
    const featureIds = await listFeatureIds(commonDir)
    const feature = await readFeatureRecord(commonDir, featureIds[0]!)
    if (!isFound(feature)) throw new Error("feature record missing")
    const contract = feature.value.contracts.find((entry) => entry.changeId === "add-widget")
    expect(contract?.kind).toBe("archive")
    expect(contract?.sourcePath).toBe(join("openspec", "changes", "archive", "add-widget"))

    // A husk copy on the base checkout is refused, never archived as work.
    const husk = join(fixture.mainDir, "openspec", "changes", "husk-change")
    await mkdir(husk, { recursive: true })
    await expect(archiveChangeOnMain({ targetDir: fixture.mainDir, changeID: "husk-change" })).rejects.toThrow(/husk/)
  })

  test("a selector that contradicts the registered association refuses before mutation", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const baseBefore = await resolveCommit("main", fixture.mainDir)
    const branchBefore = await resolveCommit("feat/add-widget", fixture.worktreeDir)
    await expect(
      runClose({ ...closeInput(fixture), changeID: "not-a-contract", writer: writerFails }),
    ).rejects.toThrow(/disagree with the registered association/)
    // Nothing changed on any branch.
    expect(await resolveCommit("main", fixture.mainDir)).toBe(baseBefore)
    expect(await resolveCommit("feat/add-widget", fixture.worktreeDir)).toBe(branchBefore)
    // The worktree's change directory is untouched (no archive ran).
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).resolves.toBeTruthy()
  })

  test("unverifiable archive output stops before committing or landing (task 7.2)", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const baseBefore = await resolveCommit("main", fixture.mainDir)
    // The double archives the change but writes no canonical spec — the
    // ADDED delta effect cannot be proven, so close must refuse.
    process.env.CONVOY_OPENSPEC_NO_CANONICAL = "1"
    let message: string | undefined
    try {
      await runClose({ ...closeInput(fixture), writer: writerFails })
      expect.unreachable("close must refuse an unprovable archive result")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    } finally {
      delete process.env.CONVOY_OPENSPEC_NO_CANONICAL
    }
    expect(message).toMatch(/does not prove every delta effect/)
    expect(message).toMatch(/canonical specs/)
    // The base is unadvanced and no archive commit landed on the feature branch.
    expect(await resolveCommit("main", fixture.mainDir)).toBe(baseBefore)
    const log = await execFile("git", ["log", "--format=%s", "main..feat/add-widget"], { cwd: fixture.worktreeDir, allowFailure: true })
    expect(log.stdout).not.toMatch(/chore\(openspec\): archive/)
    // Resume guidance names the remediation.
    expect(message).toMatch(/convoy close --resume/)
  })

  test("resume after the operator commits an incomplete archive still refuses (task 7.2)", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const baseBefore = await resolveCommit("main", fixture.mainDir)

    // First attempt: the archive runs but its canonical effect is unprovable;
    // the operator then commits that incomplete archive state themselves.
    process.env.CONVOY_OPENSPEC_NO_CANONICAL = "1"
    try {
      await runClose({ ...closeInput(fixture), writer: writerFails })
      expect.unreachable("close must refuse an unprovable archive result")
    } catch {
      // Expected stop.
    } finally {
      delete process.env.CONVOY_OPENSPEC_NO_CANONICAL
    }
    await git(fixture.worktreeDir, user, "add", ".")
    await git(fixture.worktreeDir, user, "commit", "-m", "chore(openspec): archive add-widget (operator, incomplete)")
    // The change is now absent from openspec/changes/ and present in the
    // archive layout, with its incomplete state committed.
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).rejects.toThrow()

    // A resumed close revalidates the original contract's delta effects
    // against the canonical specs and refuses — the base stays unadvanced.
    const branchBefore = await resolveCommit("feat/add-widget", fixture.worktreeDir)
    await expect(runClose({ ...closeInput(fixture), resume: true, writer: writerFails })).rejects.toThrow(/does not prove every delta effect/)
    expect(await resolveCommit("main", fixture.mainDir)).toBe(baseBefore)
    expect(await resolveCommit("feat/add-widget", fixture.worktreeDir)).toBe(branchBefore)
  })

  test("an unassociated close refuses before any mutation and names the explicit adoption command (task 7.1)", async () => {
    const fixture = await makeFixture()
    // No registration: the close must not act on a branch-name guess.
    const baseBefore = await resolveCommit("main", fixture.mainDir)
    const branchBefore = await resolveCommit("feat/add-widget", fixture.worktreeDir)

    let message: string | undefined
    try {
      await runClose({ ...closeInput(fixture), writer: writerFails })
      expect.unreachable("close must refuse an unassociated context")
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The refusal names the exact explicit adoption command (design D3).
    expect(message).toMatch(/no verified feature association/)
    expect(message).toContain("convoy feature adopt --branch feat/add-widget --change add-widget --base main")
    // Nothing was archived, committed, or landed: no mutation happened.
    expect(await resolveCommit("main", fixture.mainDir)).toBe(baseBefore)
    expect(await resolveCommit("feat/add-widget", fixture.worktreeDir)).toBe(branchBefore)
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).resolves.toBeTruthy()
    // No journal or registry files were created by the refused close.
    const commonDir = (await lifecycleCommonDir(fixture.mainDir))!
    await expect(stat(join(commonDir, "convoy", "close"))).rejects.toThrow()
    await expect(stat(join(commonDir, "convoy", "features"))).rejects.toThrow()

    // After explicit adoption the same close proceeds: identity, not branch
    // spelling, authorized the mutation.
    const { featureAdopt } = await import("../src/feature-lifecycle/commands")
    const { feature } = await featureAdopt({ cwd: fixture.mainDir, branch: "feat/add-widget", changeIds: ["add-widget"], base: "main" })
    expect(feature.featureId).toBeTruthy()
    const result = await runClose({ ...closeInput(fixture), writer: writerFails })
    expect(result.disposition).toBe("landed")
  })

  test("legacy effect snapshots are still written for adopted features (task 7.2)", async () => {
    const fixture = await makeFixture()
    const registration = await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const featureIdsOf = (commonDir: string) => registration.feature.featureId
    const baseBefore = await resolveCommit("main", fixture.mainDir)

    process.env.CONVOY_OPENSPEC_NO_CANONICAL = "1"
    try {
      await runClose({ ...closeInput(fixture), writer: writerFails })
      expect.unreachable("close must refuse an unprovable archive result")
    } catch {
      // Expected stop.
    } finally {
      delete process.env.CONVOY_OPENSPEC_NO_CANONICAL
    }
    // The identity attempt journal carries the effect snapshot from before
    // the archive — the durable intent resume validates against.
    const commonDir = (await lifecycleCommonDir(fixture.mainDir))!
    const attemptIds = await listAttemptIds(commonDir, featureIdsOf(commonDir))
    const attempt = await readAttemptJournal(commonDir, featureIdsOf(commonDir), attemptIds[0]!)
    expect(isFound(attempt)).toBe(true)
    if (isFound(attempt)) {
      expect(attempt.value.contracts[0]?.requiredEffects).toHaveLength(1)
    }

    // The operator deletes the archived delta and commits the residue; the
    // resumed close must still refuse from the snapshot.
    await rm(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget", "specs", "cli", "spec.md"), { force: true })
    await git(fixture.worktreeDir, user, "add", ".")
    await git(fixture.worktreeDir, user, "commit", "-m", "chore(openspec): archive add-widget (operator, delta removed)")

    const branchBefore = await resolveCommit("feat/add-widget", fixture.worktreeDir)
    await expect(runClose({ ...closeInput(fixture), resume: true, writer: writerFails })).rejects.toThrow(/does not prove every delta effect/)
    expect(await resolveCommit("main", fixture.mainDir)).toBe(baseBefore)
    expect(await resolveCommit("feat/add-widget", fixture.worktreeDir)).toBe(branchBefore)
  })

  test("an interrupted landing after ref success is reconciled without a second commit (task 7.5)", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const first = await runClose({ ...closeInput(fixture), writer: writerFails })
    expect(first.disposition).toBe("landed")
    const commitCount = await execFile("git", ["rev-list", "--count", "main"], { cwd: fixture.mainDir, allowFailure: true })

    // Simulate the crash window: the ref landed and the journal recorded the
    // landing, but materialization was never acknowledged and the receipt
    // was never written.
    const commonDir = (await lifecycleCommonDir(fixture.mainDir))!
    const journal = await readCloseJournal(commonDir, "feat/add-widget", "add-widget")
    expect(journal?.checkoutMaterialized).toBe(true)
    await writeCloseJournal(commonDir, { ...journal!, checkoutMaterialized: false })
    // Remove every identity receipt under the registered feature.
    const { listReceiptIds } = await import("../src/feature-lifecycle/records")
    for (const featureId of await listFeatureIds(commonDir)) {
      for (const receiptId of await listReceiptIds(commonDir, featureId)) {
        await rm(join(commonDir, "convoy", "features", featureId, "receipts", `${receiptId}.json`), { force: true })
      }
    }

    // Resume: close reconciles the checkout and rewrites the receipt without
    // creating another commit.
    const resumed = await runClose({ ...closeInput(fixture), resume: true, writer: writerFails })
    expect(resumed.disposition).toBe("landed")
    expect(resumed.landing!.sha).toBe(first.landing!.sha)
    expect(await execFile("git", ["rev-list", "--count", "main"], { cwd: fixture.mainDir, allowFailure: true }).then((r) => r.stdout.trim())).toBe(commitCount.stdout.trim())
    // The receipt was rewritten (recovery evidence is durable again).
    const rewritten = await verifiedCloseReceipt(fixture.mainDir, "feat/add-widget", "add-widget")
    expect(rewritten?.landingSha).toBe(first.landing!.sha)
  })

  test("a moved base refuses the stale attempt instead of landing across it (task 7.5)", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const baseBefore = await resolveCommit("main", fixture.mainDir)
    // First attempt: declined message stops the sequence at the squash gate.
    await expect(runClose({ ...closeInput(fixture), resolveMessage: async () => undefined, writer: writerFails })).rejects.toThrow(/wasn't confirmed/)
    // The base advances independently.
    await writeFile(join(fixture.mainDir, "parallel.txt"), "parallel work\n")
    await git(fixture.mainDir, user, "add", ".")
    await git(fixture.mainDir, user, "commit", "-m", "chore: parallel advance")
    // The resume refuses the stale attempt; the base is unchanged.
    await expect(runClose({ ...closeInput(fixture), resume: true, writer: writerFails })).rejects.toThrow(/the base moved since this attempt was recorded/)
    expect(await resolveCommit("main", fixture.mainDir)).not.toBe(baseBefore)
  })

  test("resume verifies against the persisted effect snapshot, not the archived copy (task 7.2)", async () => {
    const fixture = await makeFixture()
    await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const baseBefore = await resolveCommit("main", fixture.mainDir)

    // First attempt: the archive runs unprovably; the operator then deletes
    // the unsatisfied delta from the archived copy and commits the residue.
    process.env.CONVOY_OPENSPEC_NO_CANONICAL = "1"
    try {
      await runClose({ ...closeInput(fixture), writer: writerFails })
      expect.unreachable("close must refuse an unprovable archive result")
    } catch {
      // Expected stop.
    } finally {
      delete process.env.CONVOY_OPENSPEC_NO_CANONICAL
    }
    // Deleting the delta from the archived copy must not make resume's
    // verification vacuous: the snapshot persisted before the archive still
    // demands the ADDED effect.
    await rm(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget", "specs", "cli", "spec.md"), { force: true })
    await git(fixture.worktreeDir, user, "add", ".")
    await git(fixture.worktreeDir, user, "commit", "-m", "chore(openspec): archive add-widget (operator, delta removed)")

    const branchBefore = await resolveCommit("feat/add-widget", fixture.worktreeDir)
    await expect(runClose({ ...closeInput(fixture), resume: true, writer: writerFails })).rejects.toThrow(/does not prove every delta effect/)
    expect(await resolveCommit("main", fixture.mainDir)).toBe(baseBefore)
    expect(await resolveCommit("feat/add-widget", fixture.worktreeDir)).toBe(branchBefore)
  })
})

describe("feature-keyed cleanup and worktree-less resume (tasks 7.5/7.7, SC-2)", () => {
  test("--feature --resume resolves the recorded landing after the worktree was removed, with no branch spelling", async () => {
    const fixture = await makeFixture()
    const registration = await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const featureId = registration.feature.featureId
    const result = await runClose({ ...closeInput(fixture), writer: writerFails })
    expect(result.disposition).toBe("landed")

    // The worktree is removed outside any close flow.
    await git(fixture.mainDir, {}, "worktree", "remove", fixture.worktreeDir)

    // Identity-keyed resume: no --branch, no --change, no worktree — the
    // feature's receipt supplies the branch, landing, and base. The old
    // branch-keyed surface would have refused here.
    const resumed = await runClose({ targetDir: fixture.mainDir, featureId, resume: true, writer: writerFails })
    expect(resumed.disposition).toBe("already-landed")
    expect(resumed.landing!.sha).toBe(result.landing!.sha)
    expect(resumed.branch).toBe("feat/add-widget")
  })

  test("--cleanup worktree removes the verified worktree; --cleanup branch then deletes the branch at its landed tip", async () => {
    const fixture = await makeFixture()
    const registration = await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const featureId = registration.feature.featureId
    await runClose({ ...closeInput(fixture), writer: writerFails })

    const { runCloseCleanup } = await import("../src/feature-close")
    const removed = await runCloseCleanup({ targetDir: fixture.mainDir, featureId, cleanup: "worktree" })
    expect(removed).toMatch(/removed the feature worktree/)
    await expect(stat(fixture.worktreeDir)).rejects.toThrow()

    const deleted = await runCloseCleanup({ targetDir: fixture.mainDir, featureId, cleanup: "branch" })
    expect(deleted).toMatch(/deleted the local feat\/add-widget branch/)
    expect((await execFile("git", ["rev-parse", "--verify", "refs/heads/feat/add-widget"], { cwd: fixture.mainDir, allowFailure: true })).exitCode).not.toBe(0)
    // The landing evidence survives cleanup.
    const commonDir = (await lifecycleCommonDir(fixture.mainDir))!
    expect(await listReceiptIds(commonDir, featureId).then((ids) => ids.length)).toBe(1)
  })

  test("--cleanup branch refuses when the tip moved past the landed state", async () => {
    const fixture = await makeFixture()
    const registration = await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const featureId = registration.feature.featureId
    await runClose({ ...closeInput(fixture), writer: writerFails })

    // New work lands on the branch after the receipt — the old receipt must
    // never delete it.
    await git(fixture.worktreeDir, user, "commit", "--allow-empty", "-m", "feat: new work after the landing")

    const { runCloseCleanup } = await import("../src/feature-close")
    await expect(runCloseCleanup({ targetDir: fixture.mainDir, featureId, cleanup: "branch" })).rejects.toThrow(/tip moved past the landed state/)
    // The branch still exists — nothing was deleted.
    expect((await execFile("git", ["rev-parse", "--verify", "refs/heads/feat/add-widget"], { cwd: fixture.mainDir, allowFailure: true })).exitCode).toBe(0)
  })

  test("--cleanup refuses without a verified landing receipt and without a feature id", async () => {
    const fixture = await makeFixture()
    const registration = await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const featureId = registration.feature.featureId

    const { runCloseCleanup } = await import("../src/feature-close")
    // No close ran: no receipt exists, so cleanup is unauthorized.
    await expect(runCloseCleanup({ targetDir: fixture.mainDir, featureId, cleanup: "branch" })).rejects.toThrow(/no verified landing receipt/)
    // Cleanup without identity is refused outright (feature-keyed, never branch-keyed).
    await expect(runCloseCleanup({ targetDir: fixture.mainDir, cleanup: "worktree" })).rejects.toThrow(/requires --feature/)
  })

  test("a landed close's result feeds the feature-keyed follow-up surface (design D9)", async () => {
    const fixture = await makeFixture()
    const registration = await registerSpinFeature({ cwd: fixture.mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir, baseRef: "main", phase: "intent" })
    const featureId = registration.feature.featureId
    const result = await runClose({ ...closeInput(fixture), writer: writerFails })
    expect(result.disposition).toBe("landed")
    // The result carries the resolved feature so every follow-up surface can
    // print the feature-keyed guarded commands.
    expect(result.featureId).toBe(featureId)

    const { resolveCloseFollowUps } = await import("../src/feature-close-command")
    const receipt = await verifiedCloseReceipt(fixture.mainDir, result.branch, result.changeID)
    const followUps = await resolveCloseFollowUps({
      targetDir: fixture.mainDir,
      baseRef: result.baseRef,
      branch: result.branch,
      worktreeDir: result.worktreeDir,
      featureId: result.featureId,
      ...(receipt ? { evidence: { landingSha: receipt.landingSha, featureTip: receipt.postArchiveTip } } : {}),
    })
    expect(followUps.worktreeRemoval).toBe(`convoy close --feature ${featureId} --cleanup worktree`)
    expect(followUps.branchDelete).toBe(`convoy close --feature ${featureId} --cleanup branch`)

    // The deferred (launched-inside) guidance carries the same commands.
    const { buildCloseFollowUpsView } = await import("../src/feature-close-command")
    const view = await buildCloseFollowUpsView({
      followUps: { ...followUps, baseRef: result.baseRef, branch: result.branch, worktreeDir: result.worktreeDir, targetDir: fixture.mainDir, featureId },
      cwdInside: true,
    })
    expect(view.deferred!.steps.map((step) => step.command)).toEqual([
      `convoy close --feature ${featureId} --cleanup worktree`,
      `convoy close --feature ${featureId} --cleanup branch`,
    ])

    // And an accepted deferred-style action executes the same guarded
    // operation: the worktree removal routes through runCloseCleanup.
    const { offerCloseFollowUps } = await import("../src/feature-close-command")
    const { PassThrough } = await import("node:stream")
    const input = new PassThrough()
    const chunks: string[] = []
    let answered = false
    const output = {
      write: (text: string) => {
        chunks.push(text)
        if (!answered && text.includes("[y")) {
          answered = true
          input.write("y\n")
          // Only one acceptance is buffered; EOF afterwards declines the
          // branch-deletion prompt the same way a closed terminal would.
          setImmediate(() => input.end())
        }
        return true
      },
    }
    await offerCloseFollowUps(
      { ...followUps, baseRef: result.baseRef, branch: result.branch, worktreeDir: result.worktreeDir, targetDir: fixture.mainDir, featureId },
      { output, input } as never,
    )
    await expect(stat(fixture.worktreeDir)).rejects.toThrow()
  })
})
