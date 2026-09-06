import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { currentHead, execFile, resolveCommit } from "../src/git"
import { runFinalization } from "../src/finalization/compact"
import { preCompactionRef, resolveRef } from "../src/finalization/refs"
import type { CommitLedgerEntry, RunBoundary } from "../src/finalization/types"
import { createPublishSeam, type PublishRunner, type RunResult } from "../src/publish"
import { runClose, type CloseInput } from "../src/feature-close"
import { templateCommitMessage, type CommitMessageProposal } from "../src/commit-message"

/**
 * Cross-flow acceptance fixtures (capabilities run-finalization and
 * feature-close, design D6/D7/D8, tasks 8.1/8.2/8.3): the flows Convoy's
 * separate unit suites prove in isolation, driven end-to-end against a real
 * local bare remote and a real worktree, with only the external tools a
 * hermetic test cannot run (the OpenSpec CLI, the commit-writer model, and
 * `gh`) standing in as doubles. The claims under test are the ones the
 * individual suites cannot make together:
 *
 * - 8.1: two successful runs each yield one operator commit, publishing is a
 *   deliberate normal push + PR, and close lands the whole feature as exactly
 *   one regular commit on the base, leaving the published feature ancestry and
 *   the retained intermediate diffs intact.
 * - 8.2: a run whose compaction is blocked by publication still closes, and an
 *   operator-only feature closes — close never depends on author-based
 *   eligibility or a manual finish.
 * - 8.3: an interrupted compaction reconciles on resume, headless close
 *   narrates the same steps, and the retired `convoy finish` command can never
 *   start an implementation run.
 */

const dirs: string[] = []
const runID1 = "20260905-090000-first"
const runID2 = "20260905-100000-second"
const convoyEnv = { GIT_AUTHOR_NAME: "convoy", GIT_AUTHOR_EMAIL: "convoy@local", GIT_COMMITTER_NAME: "convoy", GIT_COMMITTER_EMAIL: "convoy@local" }
const operatorEnv = { GIT_AUTHOR_NAME: "Test Operator", GIT_AUTHOR_EMAIL: "op@example.com", GIT_COMMITTER_NAME: "Test Operator", GIT_COMMITTER_EMAIL: "op@example.com" }

let savedHome: string | undefined
let originalPath: string | undefined

beforeAll(async () => {
  savedHome = process.env.CONVOY_HOME
  const home = await mkdtemp(join(tmpdir(), "convoy-cross-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home

  // An OpenSpec CLI double leads PATH so `runClose` never shells out to the
  // real tool, and an opencode double dies instantly so nothing reaches for a
  // live model or hangs.
  const binDir = join(tmpdir(), `convoy-cross-bin-${Math.random().toString(36).slice(2)}`)
  dirs.push(binDir)
  await mkdir(binDir, { recursive: true })
  await writeOpenspecDouble(binDir)
  originalPath = process.env.PATH
  process.env.PATH = `${binDir}:${process.env.PATH}`
})

afterAll(async () => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
  if (originalPath !== undefined) process.env.PATH = originalPath
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function git(cwd: string, env: Record<string, string> | undefined, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stdout}`)
  return stdout.trim()
}

/** One run-linked convoy commit, exactly the shape step-commit writes. */
async function runCommit(dir: string, file: string, content: string, step: string, id: string) {
  await writeFile(join(dir, file), content)
  await git(dir, convoyEnv, "add", "-A")
  await git(dir, convoyEnv, "commit", "-qm", `convoy(${step}): ${file}\n\nConvoy-Run: ${id}`)
}

function boundaryFor(dir: string, startHead: string, branch: string): RunBoundary {
  return { schemaVersion: 1, worktreeDir: dir, branch, startHead, commonDir: "", includeDirty: false, recordedAt: 1 }
}

/** Builds truthful ledger entries for every run-linked commit above startHead. */
async function ledgerFor(dir: string, startHead: string, id: string): Promise<CommitLedgerEntry[]> {
  const entries: CommitLedgerEntry[] = []
  const log = await git(dir, undefined, "log", "--reverse", "--format=%H%x1f%s%x1f%P", `${startHead}..HEAD`)
  for (const line of log.split("\n").filter(Boolean)) {
    const [sha = "", subject = "", parents = ""] = line.split("\x1f")
    const body = await git(dir, undefined, "log", "--format=%B", "-1", sha)
    if (!body.includes(`Convoy-Run: ${id}`)) continue
    const step = /convoy\(([^)]*)\)/.exec(subject)?.[1] ?? "step"
    const tree = await git(dir, undefined, "rev-parse", `${sha}^{tree}`)
    entries.push({ schemaVersion: 1, mode: "phase", step, beforeSha: parents.trim() || startHead, afterSha: sha, afterTree: tree, recordedAt: 1 })
  }
  return entries
}

/** A writer double that always fails, so close degrades to its deterministic fallback. */
const writerFails: CloseInput["writer"] = async () =>
  ({ message: templateCommitMessage({ targetDir: "", branch: "", commits: [] }), source: "template", error: "writer unavailable (test double)" }) satisfies CommitMessageProposal

/**
 * A repo with a real local bare remote (`origin`), a `main` checkout, and a
 * feature worktree `feat/add-widget` carrying a complete OpenSpec change. The
 * feature branch starts from `main` with one operator proposal commit; the
 * caller adds run work (or operator-only work) before closing.
 */
type Repo = { root: string; remote: string; mainDir: string; worktreeDir: string }

async function makeRepo(): Promise<Repo> {
  const root = await mkdtemp(join(tmpdir(), "convoy-cross-"))
  dirs.push(root)
  const remote = join(root, "remote.git")
  const mainDir = join(root, "main")
  const worktreeDir = join(root, "wt")
  await mkdir(mainDir, { recursive: true })

  await git(mainDir, operatorEnv, "init", "-q", "-b", "main")
  await git(mainDir, operatorEnv, "config", "user.email", "op@example.com")
  await git(mainDir, operatorEnv, "config", "user.name", "Test Operator")
  await writeFile(join(mainDir, "README.md"), "# repo\n")
  await git(mainDir, operatorEnv, "add", "-A")
  await git(mainDir, operatorEnv, "commit", "-qm", "chore: init")

  await git(mainDir, undefined, "init", "-q", "--bare", "-b", "main", remote)
  await git(mainDir, undefined, "remote", "add", "origin", remote)
  await git(mainDir, undefined, "push", "-q", "origin", "main:main")
  await git(mainDir, undefined, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main")

  await git(mainDir, undefined, "worktree", "add", "-b", "feat/add-widget", worktreeDir, "main")

  const changeDir = join(worktreeDir, "openspec", "changes", "add-widget")
  await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
  await writeFile(join(changeDir, "tasks.md"), "- [x] one\n- [x] two\n")
  await writeFile(join(changeDir, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: Widget\n")
  await git(worktreeDir, operatorEnv, "add", "-A")
  await git(worktreeDir, operatorEnv, "commit", "-qm", "feat(openspec): propose add-widget")

  // Register the feature as spin would have: close's adoption gate (task 7.1)
  // refuses unassociated work, so the cross-flow fixtures start associated.
  const { registerSpinFeature } = await import("../src/feature-lifecycle/commands")
  await registerSpinFeature({ cwd: mainDir, changeId: "add-widget", branch: "feat/add-widget", worktreeDir, baseRef: "main", phase: "intent" })

  return { root, remote, mainDir, worktreeDir }
}

const closeInput = (repo: Repo): CloseInput => ({
  targetDir: repo.mainDir,
  worktreeDir: repo.worktreeDir,
  branch: "feat/add-widget",
  changeID: "add-widget",
})

/** A publish runner that routes real Git to the worktree and fakes `gh`. */
function publishRunner(repo: Repo): { runner: PublishRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = []
  const ok = (stdout = ""): RunResult => ({ stdout, stderr: "", exitCode: 0 })
  const runner: PublishRunner = async (command, args, options) => {
    calls.push({ command, args })
    if (command === "gh") {
      if (args[0] === "--version") return ok("gh version 2.0.0\n")
      if (args[0] === "auth" && args[1] === "status") return ok("")
      if (args[0] === "pr" && args[1] === "list") return ok("[]")
      if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/acme/repo/pull/1\n")
      return { stdout: "", stderr: "unexpected gh call", exitCode: 1 }
    }
    // Real Git, driven against the feature worktree.
    const result = await execFile(command, args, { cwd: repo.worktreeDir, allowFailure: options?.allowFailure ?? false })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
  }
  return { runner, calls }
}

/** Compacts one run's commits on the feature branch and asserts success. */
async function compactRun(repo: Repo, runID: string, message: string, startHead: string): Promise<void> {
  const record = await runFinalization({
    runID,
    targetDir: repo.worktreeDir,
    boundary: boundaryFor(repo.worktreeDir, startHead, "feat/add-widget"),
    ledger: await ledgerFor(repo.worktreeDir, startHead, runID),
    branch: "feat/add-widget",
    composeMessage: async () => message,
  })
  expect(record.state).toBe("completed")
  expect(record.producedSha).toBeTruthy()
}

describe("cross-flow: two successful runs → Create PR → close (8.1)", () => {
  test("one commit per run, one landing, normal pushes only, published ancestry and diffs intact", async () => {
    const repo = await makeRepo()

    // Run 1 and run 2 each make two run-linked commits and compact to one operator commit.
    const startHead1 = (await currentHead(repo.worktreeDir))!
    await runCommit(repo.worktreeDir, "a.ts", "export const a = 1\n", "design", runID1)
    await runCommit(repo.worktreeDir, "b.ts", "export const b = 2\n", "implement", runID1)
    await compactRun(repo, runID1, "feat: add the thing", startHead1)

    const startHead2 = (await currentHead(repo.worktreeDir))!
    await runCommit(repo.worktreeDir, "c.ts", "export const c = 3\n", "design", runID2)
    await runCommit(repo.worktreeDir, "d.ts", "export const d = 4\n", "implement", runID2)
    await compactRun(repo, runID2, "feat: refine the thing", startHead2)

    // One commit per eligible run: the feature branch is base + proposal + run1 + run2.
    const featureCount = Number(await git(repo.mainDir, undefined, "rev-list", "--count", "feat/add-widget"))
    expect(featureCount).toBe(4)
    const subjects = await git(repo.mainDir, undefined, "log", "--format=%s", "feat/add-widget")
    expect(subjects).toContain("feat: add the thing")
    expect(subjects).toContain("feat: refine the thing")
    // Every compacted run commit is operator-authored (not `convoy@local`).
    const authors = await git(repo.mainDir, undefined, "log", "--format=%an", "feat/add-widget")
    expect(authors).not.toContain("convoy")

    // Retained intermediate diffs: each run's pre-compaction ref is inspectable.
    const pre1 = await resolveRef(preCompactionRef(runID1), repo.worktreeDir)
    const pre2 = await resolveRef(preCompactionRef(runID2), repo.worktreeDir)
    expect(pre1).toBeTruthy()
    expect(pre2).toBeTruthy()
    const preSubjects = await git(repo.mainDir, undefined, "log", "--format=%s", `${pre1}`)
    expect(preSubjects).toContain("convoy(implement): b.ts")
    expect(preSubjects).toContain("convoy(design): a.ts")

    // Create PR: deliberate normal push to the bare remote, then a located/created PR.
    const { runner, calls } = publishRunner(repo)
    const seam = createPublishSeam({ cwd: repo.worktreeDir, run: runner })
    const prepared = await seam.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    expect(prepared.plan).toEqual({ branch: "feat/add-widget", remote: "origin", base: "main" })
    const pushedTip = (await currentHead(repo.worktreeDir))!
    const published = await seam.apply(prepared.plan)
    expect(published.ok).toBe(true)
    if (!published.ok) return
    expect(published.outcome).toEqual({ pushed: true, url: "https://github.com/acme/repo/pull/1" })
    // Normal pushes only — never a force-push.
    expect(JSON.stringify(calls)).not.toContain("--force")

    // Close lands the whole feature as exactly one regular commit on main.
    const result = await runClose({ ...closeInput(repo), writer: writerFails })
    expect(result.disposition).toBe("landed")
    expect(result.landing).toBeDefined()
    expect(await git(repo.mainDir, undefined, "rev-list", "--count", "main")).toBe("2")
    const landing = await git(repo.mainDir, undefined, "log", "--format=%P%n%an%n%s", "-1", "main")
    const [parents = "", author = "", subject = ""] = landing.split("\n")
    expect(author).toBe("Test Operator")
    // One parent: the captured base, never a merge or a fast-forward to the feature tip.
    expect(parents.split(" ")).toHaveLength(1)
    // The feature worktree still exists until the operator accepts its removal.
    expect((await stat(repo.worktreeDir)).isDirectory()).toBe(true)

    // The published feature ancestry is unchanged: origin/feat/add-widget still
    // points at the commit that was pushed, and that commit is still reachable
    // from the (archive-extended) feature branch.
    const originTip = await git(repo.mainDir, undefined, "rev-parse", "origin/feat/add-widget")
    expect(originTip).toBe(pushedTip)
    const featureTip = (await currentHead(repo.worktreeDir))!
    expect(await git(repo.mainDir, undefined, "merge-base", "--is-ancestor", pushedTip, featureTip)).toBe("")
  })
})

describe("cross-flow: blocked compaction and operator-only feature close (8.2)", () => {
  test("a run whose compaction is blocked by publication still closes to one landing commit", async () => {
    const repo = await makeRepo()
    const startHead = (await currentHead(repo.worktreeDir))!

    // The run makes machine commits, which are then published to the remote
    // before compaction runs — so compaction must refuse (no force-push).
    await runCommit(repo.worktreeDir, "a.ts", "export const a = 1\n", "design", runID1)
    await runCommit(repo.worktreeDir, "b.ts", "export const b = 2\n", "implement", runID1)
    await git(repo.worktreeDir, undefined, "push", "-q", "origin", "feat/add-widget:feat/add-widget")

    const record = await runFinalization({
      runID: runID1,
      targetDir: repo.worktreeDir,
      boundary: boundaryFor(repo.worktreeDir, startHead, "feat/add-widget"),
      ledger: await ledgerFor(repo.worktreeDir, startHead, runID1),
      branch: "feat/add-widget",
      composeMessage: async () => "feat: add the thing",
    })
    expect(record.state).toBe("blocked")
    expect(record.reason).toMatch(/force-push/)

    // Close never depends on author-based eligibility or a manual finish: it
    // lands the whole (non-empty) feature as one commit on the base.
    const result = await runClose({ ...closeInput(repo), writer: writerFails })
    expect(result.disposition).toBe("landed")
    expect(await git(repo.mainDir, undefined, "rev-list", "--count", "main")).toBe("2")
  })

  test("an operator-only feature closes to one landing commit without any run compaction", async () => {
    const repo = await makeRepo()
    // Only operator-authored work, no run-linked (convoy) commits at all.
    await writeFile(join(repo.worktreeDir, "widget.ts"), "export const widget = 1\n")
    await git(repo.worktreeDir, operatorEnv, "add", "-A")
    await git(repo.worktreeDir, operatorEnv, "commit", "-qm", "feat: implement the widget")

    const result = await runClose({ ...closeInput(repo), writer: writerFails })
    expect(result.disposition).toBe("landed")
    expect(await git(repo.mainDir, undefined, "rev-list", "--count", "main")).toBe("2")
    // The feature branch is never rewritten by the landing (only the additive archive commit):
    // base + proposal + operator work + archive.
    expect(Number(await git(repo.mainDir, undefined, "rev-list", "--count", "feat/add-widget"))).toBe(4)
  })
})

describe("cross-flow: hermetic lifecycle and crash-resume (8.3)", () => {
  test("an interrupted compaction reconciles on resume instead of compacting twice", async () => {
    const repo = await makeRepo()
    const startHead = (await currentHead(repo.worktreeDir))!
    await runCommit(repo.worktreeDir, "a.ts", "export const a = 1\n", "design", runID1)
    await runCommit(repo.worktreeDir, "b.ts", "export const b = 2\n", "implement", runID1)

    // First attempt completes and produces the commit.
    const first = await runFinalization({
      runID: runID1,
      targetDir: repo.worktreeDir,
      boundary: boundaryFor(repo.worktreeDir, startHead, "feat/add-widget"),
      ledger: await ledgerFor(repo.worktreeDir, startHead, runID1),
      branch: "feat/add-widget",
      composeMessage: async () => "feat: add the thing",
    })
    expect(first.state).toBe("completed")
    const produced = first.producedSha!

    // A naive rerun (as a resume would trigger) must recognize the already-created
    // commit by its transaction evidence rather than squash a second time.
    const rerun = await runFinalization({
      runID: runID1,
      targetDir: repo.worktreeDir,
      boundary: boundaryFor(repo.worktreeDir, startHead, "feat/add-widget"),
      ledger: await ledgerFor(repo.worktreeDir, startHead, runID1),
      branch: "feat/add-widget",
      composeMessage: async () => "feat: add the thing",
    })
    expect(rerun.state).toBe("completed")
    expect(rerun.reason).toContain("already created this compaction commit")
    expect(await currentHead(repo.worktreeDir)).toBe(produced)
  })

  test("headless close narrates the same steps and no interactive input hangs", async () => {
    const repo = await makeRepo()
    const startHead = (await currentHead(repo.worktreeDir))!
    await runCommit(repo.worktreeDir, "a.ts", "export const a = 1\n", "design", runID1)
    await compactRun(repo, runID1, "feat: add the thing", startHead)

    const events: Array<{ type: string; step?: string }> = []
    const result = await runClose({ ...closeInput(repo), writer: writerFails, onEvent: (event) => events.push({ type: event.type, step: event.type === "step-started" || event.type === "step-completed" || event.type === "step-skipped" ? event.step : undefined }) })
    expect(result.disposition).toBe("landed")
    // Every step is either completed or skipped (with reason) — headless narration
    // reports the same operational facts an interactive TUI would.
    const reported = events.filter((event) => event.type === "step-completed" || event.type === "step-skipped").map((event) => event.step)
    expect(reported).toContain("sync")
    expect(reported).toContain("archive")
    expect(reported).toContain("squash-merge")
  })

  test("the retired finish command never starts an implementation run", async () => {
    const repo = await makeRepo()
    const { parseCommand } = await import("../src/cli")
    const command = await parseCommand(["finish", "--branch", "feat/add-widget"])
    expect(command.type).toBe("retired-finish")
    // No prompt, repository, or run side effect happens for a retired command.
    expect(await git(repo.mainDir, undefined, "rev-list", "--count", "main")).toBe("1")
    expect(await git(repo.mainDir, undefined, "rev-list", "--count", "feat/add-widget")).toBe("2")
  })
})

/** A minimal OpenSpec CLI double (list --json + archive), plus a dead opencode. */
async function writeOpenspecDouble(binDir: string): Promise<void> {
  const script = [
    "#!/usr/bin/env bun",
    "import { readdirSync, readFileSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "const [cmd, ...rest] = process.argv.slice(2)",
    "const root = process.cwd()",
    "if (cmd === 'list' && rest.includes('--json')) {",
    "  const dir = join(root, 'openspec', 'changes')",
    "  const changes = []",
    "  try {",
    "    for (const id of readdirSync(dir)) {",
    "      if (id === 'archive' || id.startsWith('.')) continue",
    "      const body = readFileSync(join(dir, id, 'tasks.md'), 'utf8')",
    "      const total = (body.match(/^\\s*[-*+]\\s+\\[[ xX]\\]/gm) ?? []).length",
    "      const done = (body.match(/^\\s*[-*+]\\s+\\[[xX]\\]/gm) ?? []).length",
    "      changes.push({ name: id, completedTasks: done, totalTasks: total })",
    "    }",
    "  } catch {}",
    "  console.log(JSON.stringify({ changes }))",
    "  process.exit(0)",
    "}",
    "if (cmd === 'archive') {",
    "  const id = rest.find((a) => !a.startsWith('-'))",
    "  const from = join(root, 'openspec', 'changes', id)",
    "  const to = join(root, 'openspec', 'changes', 'archive', id)",
    "  statSync(from)",
    "  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true })",
    "  renameSync(from, to)",
    "  // A real archive merges the deltas into the canonical specs; the double",
    "  // writes the fixture's expected canonical requirement so close's",
    "  // positive archive verification (task 7.2) sees a provable result.",
    "  mkdirSync(join(root, 'openspec', 'specs', 'cli'), { recursive: true })",
    "  writeFileSync(join(root, 'openspec', 'specs', 'cli', 'spec.md'), '## Requirements\\n\\n### Requirement: Widget\\n')",
    "  process.exit(0)",
    "}",
    "console.error('unexpected openspec invocation: ' + cmd)",
    "process.exit(3)",
  ].join("\n")
  await writeFile(join(binDir, "openspec"), script)
  await chmod(join(binDir, "openspec"), 0o755)
  await writeFile(join(binDir, "opencode"), "#!/bin/sh\nexit 1\n")
  await chmod(join(binDir, "opencode"), 0o755)
}
