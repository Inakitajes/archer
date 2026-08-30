import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { archiveChangeOnMain, closePreflight, resolveCloseTarget, runClose, type CloseEvent, type CloseInput } from "../src/feature-close"
import { templateCommitMessage, type CommitMessageProposal } from "../src/commit-message"

const dirs: string[] = []

/** A writer double that always fails, so close degrades to its deterministic
 * fallback exactly as it would during a model outage — fast and hermetically. */
const writerFails: CloseInput["writer"] = async () =>
  ({ message: templateCommitMessage({ targetDir: "", branch: "", commits: [] }), source: "template", error: "writer unavailable (test double)" }) satisfies CommitMessageProposal

/** Runs the close sequence with the failing writer double unless a test brings its own. */
const runTestClose = (fixture: Fixture, extra: Partial<CloseInput> = {}) => runClose({ ...closeInput(fixture), writer: writerFails, ...extra })

/** Collects the event stream of a close run. */
const collectEvents = async (fixture: Fixture, extra: Partial<CloseInput> = {}): Promise<CloseEvent[]> => {
  const events: CloseEvent[] = []
  await runTestClose(fixture, { ...extra, onEvent: (event) => events.push(event) })
  return events
}

/** git reports worktree paths through the kernel's canonical form
 * (`/private/var/...` on macOS); tests compare against the same form. */
async function realPath(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises")
  return realpath(path)
}

async function git(cwd: string, env: Record<string, string> | undefined, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return stdout.trim()
}

/**
 * A minimal OpenSpec CLI double: `list --json` counts task checkboxes like the
 * real tool; `archive <id> --yes` moves the change into the archive layout.
 * Everything else fails loudly so a surprise invocation surfaces in tests.
 */
async function writeOpenspecDouble(binDir: string): Promise<void> {
  const script = [
    "#!/usr/bin/env bun",
    "import { readdirSync, readFileSync, mkdirSync, renameSync, statSync } from 'node:fs'",
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
    "  if (process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL === '1') {",
    "    console.error('openspec archive failed (injected)')",
    "    process.exit(4)",
    "  }",
    "  const id = rest.find((a) => !a.startsWith('-'))",
    "  const from = join(root, 'openspec', 'changes', id)",
    "  const to = join(root, 'openspec', 'changes', 'archive', id)",
    "  statSync(from)",
    "  mkdirSync(join(root, 'openspec', 'changes', 'archive'), { recursive: true })",
    "  renameSync(from, to)",
    "  process.exit(0)",
    "}",
    "console.error('unexpected openspec invocation: ' + cmd)",
    "process.exit(3)",
  ].join("\n")
  const path = join(binDir, "openspec")
  await writeFile(path, script)
  await chmod(path, 0o755)
  // An `opencode` double that dies instantly: any code path that reaches for
  // the real commit-writer server fails fast instead of hanging a test on a
  // live model (the tests below bring their own writer doubles instead).
  await writeFile(join(binDir, "opencode"), "#!/bin/sh\nexit 1\n")
  await chmod(join(binDir, "opencode"), 0o755)
}

type Fixture = {
  root: string
  mainDir: string
  worktreeDir: string
}

/**
 * A repo with a completed feature worktree: `main` is the base, the feature
 * branch `feat/add-widget` carries one operator commit (the change proposal)
 * and one convoy-authored commit, and all tasks are complete.
 */
async function makeFixture(input: { tasksDone: boolean } = { tasksDone: true }): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "convoy-close-"))
  dirs.push(root)
  const mainDir = join(root, "main")
  const worktreeDir = join(root, "wt")
  await mkdir(mainDir, { recursive: true })

  const user = { GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.com", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.com" }
  const convoy = { GIT_AUTHOR_NAME: "convoy", GIT_AUTHOR_EMAIL: "convoy@local", GIT_COMMITTER_NAME: "convoy", GIT_COMMITTER_EMAIL: "convoy@local" }

  await git(mainDir, undefined, "init", "-b", "main")
  await git(mainDir, user, "config", "user.email", "operator@example.com")
  await git(mainDir, user, "config", "user.name", "Operator")
  await writeFile(join(mainDir, "README.md"), "# repo\n")
  await git(mainDir, user, "add", ".")
  await git(mainDir, user, "commit", "-m", "chore: init")

  await git(mainDir, undefined, "worktree", "add", "-b", "feat/add-widget", worktreeDir, "main")

  const changeDir = join(worktreeDir, "openspec", "changes", "add-widget")
  await mkdir(join(changeDir, "specs", "cli"), { recursive: true })
  await writeFile(join(changeDir, "proposal.md"), "# Add widget\n")
  await writeFile(join(changeDir, "tasks.md"), input.tasksDone ? "- [x] one\n- [x] two\n" : "- [x] one\n- [ ] two\n- [ ] three\n")
  await writeFile(join(changeDir, "specs", "cli", "spec.md"), "## ADDED Requirements\n### Requirement: Widget\n")
  await git(worktreeDir, user, "add", ".")
  await git(worktreeDir, user, "commit", "-m", "feat(openspec): propose add-widget")
  await writeFile(join(worktreeDir, "src.ts"), "export const widget = 1\n")
  await git(worktreeDir, convoy, "add", ".")
  await git(worktreeDir, convoy, "commit", "-m", "convoy(implement): implement add-widget")

  return { root, mainDir: await realPath(mainDir), worktreeDir: await realPath(worktreeDir) }
}

const closeInput = (fixture: Fixture) => ({
  targetDir: fixture.mainDir,
  worktreeDir: fixture.worktreeDir,
  branch: "feat/add-widget",
  changeID: "add-widget",
})

const originalPath = process.env.PATH

beforeAll(async () => {
  // The OpenSpec CLI double leads PATH so `runClose` never shells out to the
  // real tool (whose validation needs full OpenSpec-authoring rigor).
  const binDir = join(tmpdir(), `convoy-close-bin-${Math.random().toString(36).slice(2)}`)
  dirs.push(binDir)
  await mkdir(binDir, { recursive: true })
  await writeOpenspecDouble(binDir)
  process.env.PATH = `${binDir}:${process.env.PATH}`
  // listRuns reads ~/.convoy/runs; point it at scratch so live-run state
  // never leaks between the operator's machine and these tests.
  const home = await mkdtemp(join(tmpdir(), "convoy-close-home-"))
  dirs.push(home)
  process.env.CONVOY_HOME = home
})

afterAll(async () => {
  delete process.env.CONVOY_HOME
  // The fake bin dir must not leak into other test files sharing this process.
  if (originalPath !== undefined) process.env.PATH = originalPath
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("resolveCloseTarget", () => {
  test("explicit worktree and branch win; change id falls back to the branch's id", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget(closeInput(fixture))
    expect(target).toEqual({ worktreeDir: fixture.worktreeDir, branch: "feat/add-widget", changeID: "add-widget" })
  })

  test("a bare --branch resolves its worktree from the repo's worktree list", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget({ targetDir: fixture.mainDir, branch: "feat/add-widget" })
    expect(target.worktreeDir).toBe(fixture.worktreeDir)
    expect(target.changeID).toBe("add-widget")
  })
})

describe("closePreflight", () => {
  test("incomplete tasks stop the sequence with the missing count", async () => {
    const fixture = await makeFixture({ tasksDone: false })
    const target = await resolveCloseTarget(closeInput(fixture))
    const blockers = await closePreflight(closeInput(fixture), target)
    const tasks = blockers.find((blocker) => blocker.check === "tasks")
    expect(tasks?.message).toContain("2 of 3 tasks are incomplete")
  })

  test("a clean, complete feature passes preflight", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget(closeInput(fixture))
    expect(await closePreflight(closeInput(fixture), target)).toEqual([])
  })

  test("an unverifiable worktree status fails the preflight closed, not open (SC-6)", async () => {
    const fixture = await makeFixture()
    const target = await resolveCloseTarget(closeInput(fixture))
    const gitModule = await import("../src/git")
    const spy = spyOn(gitModule, "statusPorcelain")
    spy.mockRejectedValue(new Error("boom"))
    try {
      const blockers = await closePreflight(closeInput(fixture), target)
      const clean = blockers.find((blocker) => blocker.check === "clean-tree")
      expect(clean?.message).toContain("couldn't verify")
    } finally {
      spy.mockRestore()
    }
  })
})

describe("runClose", () => {
  // The deterministic fallback for this fixture: branch prefix `feat`, the
  // sole touched capability `cli` as scope, the proposal title behind the
  // type-appropriate verb, and the change id first in the body.
  const fallbackSubject = "feat(cli): improve add widget"

  test("the full sequence: archive via the CLI, one conventional commit, operator commit survives, merged", async () => {
    const fixture = await makeFixture()
    const result = await runTestClose(fixture)

    expect(result.merged).toBe(true)
    // The archive commit and the convoy implement commit collapse into one;
    // the operator's proposal commit survives the walk.
    expect(result.squashed?.replaced).toBe(2)
    // The change dir moved into the archive layout inside the worktree.
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).rejects.toThrow()
    expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget"))).isDirectory()).toBe(true)
    // The base branch gained the squashed conventional commit and the operator's proposal commit.
    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).toContain(fallbackSubject)
    expect(log).toContain("feat(openspec): propose add-widget")
    const body = await git(fixture.mainDir, undefined, "log", "--format=%B", "-n", "1", "main")
    expect(body).toContain("change add-widget")
    // The worktree still exists until the operator accepts its removal.
    expect((await stat(fixture.worktreeDir)).isDirectory()).toBe(true)
  })

  test("the sequence is resumable: completed steps are not redone", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture)
    // A resume finds nothing left to do: the change dir is gone (archive done)
    // and the branch is contained in the base (merge done).
    const result = await runTestClose(fixture, { resume: true })
    expect(result.merged).toBe(true)
    expect(result.squashed).toBeUndefined()
    expect(result.mergeShape).toBe("already-up-to-date")
  })

  test("a clean sync folds the sync merge and convoy commits into one conventional commit (SC-2)", async () => {
    const fixture = await makeFixture()
    // Advance main so the sync step creates an operator-identity merge commit
    // that the squash must fold — with the raw convoy/archive commits — instead
    // of letting them reach the base branch unsquashed.
    await writeFile(join(fixture.mainDir, "main-advance.txt"), "advance\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: advance main in parallel")

    const result = await runTestClose(fixture)
    expect(result.merged).toBe(true)

    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    // The operator's proposal commit survives, and the feature lands as the
    // one conventional commit — the base's own advance is also present.
    expect(log).toContain("feat(openspec): propose add-widget")
    expect(log).toContain(fallbackSubject)
    expect(log).toContain("chore: advance main in parallel")
    // ...and none of the raw convoy step commits or the archive commit leak
    // through the squash.
    expect(log).not.toContain("convoy(implement): implement add-widget")
    expect(log).not.toContain("chore(openspec): archive add-widget")
  })

  test("a conflicting sync stops with the conflict listed and nothing merged", async () => {
    const fixture = await makeFixture()
    // Advance main in a way the feature branch also touches.
    await writeFile(join(fixture.mainDir, "shared.txt"), "from main\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: main moves shared.txt")
    await writeFile(join(fixture.worktreeDir, "shared.txt"), "from feature\n")
    await git(fixture.worktreeDir, undefined, "add", ".")
    await git(fixture.worktreeDir, undefined, "commit", "-m", "feat: feature moves shared.txt")

    await expect(runTestClose(fixture)).rejects.toThrow(/sync.*conflicted[\s\S]*--resume/)
    // Nothing was archived or merged.
    expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).isDirectory()).toBe(true)
    const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(mainLog).not.toContain("add-widget")
  })

  test("preflight failure changes nothing on any branch", async () => {
    const fixture = await makeFixture({ tasksDone: false })
    const before = await git(fixture.mainDir, undefined, "rev-parse", "HEAD")
    await expect(runTestClose(fixture)).rejects.toThrow(/preflight failed/)
    expect(await git(fixture.mainDir, undefined, "rev-parse", "HEAD")).toBe(before)
  })

  test("an archive failure hard-stops before any squash or merge", async () => {
    const fixture = await makeFixture()
    process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL = "1"
    try {
      await expect(runTestClose(fixture)).rejects.toThrow(/archive.*failed[\s\S]*before any squash or merge/)
      // The change was not archived (the CLI failed before moving it)...
      expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).isDirectory()).toBe(true)
      await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget"))).rejects.toThrow()
      // ...and nothing landed on the base branch (no squash, no merge).
      const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
      expect(mainLog).not.toContain("add-widget")
    } finally {
      delete process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL
    }
  })

  // -- task 2.2: the one-way event stream -----------------------------------

  test("a clean close narrates preflight, skipped sync, and each step as it happens", async () => {
    const fixture = await makeFixture()
    const events = await collectEvents(fixture)

    expect(events[0]).toEqual({ type: "preflight", summary: "clean tree · 2/2 tasks · no live runs" })
    // The base hasn't moved, so the sync is a detected skip, not a merge.
    expect(events[1]).toMatchObject({ type: "step-skipped", step: "sync" })
    const steps = events.map((event) =>
      event.type === "step-started" || event.type === "step-completed" || event.type === "step-skipped" || event.type === "step-failed"
        ? `${event.type}:${event.step}`
        : event.type,
    )
    expect(steps).toEqual([
      "preflight",
      "step-skipped:sync",
      "step-started:archive",
      "step-completed:archive",
      "step-started:squash",
      "step-completed:squash",
      "step-started:merge",
      "merge-shape",
      "step-completed:merge",
      "result",
    ])
    // The base never moved, so the merge narrates its fast-forward shape.
    expect(events).toContainEqual({ type: "merge-shape", shape: "fast-forward" })
    const result = events.find((event) => event.type === "result")
    expect(result && result.type === "result" ? result.result.mergeShape : undefined).toBe("fast-forward")
  })

  test("a mid-sequence archive stop emits the failed step and its remediation", async () => {
    const fixture = await makeFixture()
    process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL = "1"
    try {
      const events: CloseEvent[] = []
      await expect(runTestClose(fixture, { onEvent: (event) => events.push(event) })).rejects.toThrow(/before any squash or merge/)
      expect(events[events.length - 1]).toMatchObject({ type: "step-failed", step: "archive" })
      expect(events.some((event) => event.type === "result")).toBe(false)
    } finally {
      delete process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL
    }
  })

  test("a resume shows the previously completed sequence as detected skips", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture)
    const events = await collectEvents(fixture, { resume: true })
    const skips = events.filter((event) => event.type === "step-skipped")
    expect(skips).toHaveLength(4)
    for (const skip of skips) {
      if (skip.type !== "step-skipped") continue
      expect(["sync", "archive", "squash", "merge"]).toContain(skip.step)
      expect(skip.reason.length).toBeGreaterThan(0)
    }
    expect(events).toContainEqual({ type: "merge-shape", shape: "already-up-to-date" })
  })

  // -- task 2.1: the message snapshot survives the archive's move ------------

  test("the writer receives the pre-archive snapshot even though archive moved the live change", async () => {
    const fixture = await makeFixture()
    const seen: Parameters<NonNullable<CloseInput["writer"]>>[0][] = []
    await runTestClose(fixture, {
      writer: async (input) => {
        seen.push(input)
        return writerFails(input)
      },
    })
    expect(seen).toHaveLength(1)
    // The change dir is long gone by composition time...
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget", "proposal.md"))).rejects.toThrow()
    // ...yet the writer was seeded with the captured proposal, capabilities, and commits.
    expect(seen[0]!.proposalExcerpt).toContain("Add widget")
    expect(seen[0]!.scopeCandidates).toEqual(["cli"])
    expect(seen[0]!.commits).toContain("convoy(implement): implement add-widget")
  })

  // -- task 2.3: the resolver gate -------------------------------------------

  test("a model proposal is normalized (scope enforced, change id in body) and lands after the resolver accepts", async () => {
    const fixture = await makeFixture()
    const seenProposals: Array<{ message: string; source: string; error?: string }> = []
    const result = await runTestClose(fixture, {
      writer: async () => ({
        message: { type: "feat", scope: "everything", subject: "improve the close flow", body: ["one change"] },
        source: "model",
      }),
      resolveMessage: async (proposal) => {
        seenProposals.push(proposal)
        return proposal.message
      },
    })
    expect(result.squashed).toBeDefined()
    // The writer's broad scope was corrected to the sole touched capability,
    // and the change id was injected into the body.
    expect(seenProposals).toHaveLength(1)
    expect(seenProposals[0]!.source).toBe("model")
    expect(seenProposals[0]!.message).toBe("feat(cli): improve the close flow\n\n- change add-widget\n- one change")
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): improve the close flow")
  })

  test("the fallback proposal names its writer failure and still closes", async () => {
    const fixture = await makeFixture()
    const seenProposals: Array<{ source: string; error?: string }> = []
    const result = await runTestClose(fixture, {
      resolveMessage: async (proposal) => {
        seenProposals.push(proposal)
        return proposal.message
      },
    })
    expect(result.squashed).toBeDefined()
    expect(seenProposals[0]!.source).toBe("fallback")
    expect(seenProposals[0]!.error).toContain("test double")
  })

  test("an edited message lands verbatim", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, {
      resolveMessage: async () => "feat(cli): hand polished subject\n\n- change add-widget",
    })
    const body = await git(fixture.mainDir, undefined, "log", "--format=%B", "-n", "1", "main")
    expect(body).toContain("hand polished subject")
    expect(body).toContain("change add-widget")
  })

  test("an explicit --message wins verbatim and bypasses writer and resolver entirely", async () => {
    const fixture = await makeFixture()
    await runTestClose(fixture, {
      message: "feat(cli): exact override",
      resolveMessage: async () => {
        throw new Error("the resolver must never be reached with an explicit --message")
      },
      writer: async () => {
        throw new Error("the writer must never run under an explicit --message")
      },
    })
    const subject = await git(fixture.mainDir, undefined, "log", "--format=%s", "-n", "1", "main")
    expect(subject).toBe("feat(cli): exact override")
  })

  test("a declined message stops before the squash and nothing lands", async () => {
    const fixture = await makeFixture()
    const branchBefore = await git(fixture.worktreeDir, undefined, "rev-parse", "HEAD")
    await expect(runTestClose(fixture, { resolveMessage: async () => undefined })).rejects.toThrow(/wasn't confirmed[\s\S]*--resume/)
    // The archive happened, but the squash didn't: the branch tip moved to the
    // archive commit, not to a squashed rewrite, and nothing reached the base.
    const branchAfter = await git(fixture.worktreeDir, undefined, "rev-parse", "HEAD")
    expect(branchAfter).not.toBe(branchBefore)
    const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(mainLog).not.toContain("improve add widget")
  })

  // -- task 2.4: merge shapes --------------------------------------------------

  test("a moved base narrates a merge-commit shape", async () => {
    const fixture = await makeFixture()
    await writeFile(join(fixture.mainDir, "main-advance.txt"), "advance\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: advance main in parallel")
    const result = await runTestClose(fixture)
    expect(result.mergeShape).toBe("merge-commit")
  })
})

describe("archiveChangeOnMain", () => {
  test("archives in the main checkout and commits on the base branch", async () => {
    const fixture = await makeFixture()
    // Simulate the probably-merged situation: the change sits on the base
    // checkout, unarchived, with nothing left to merge.
    const changeDir = join(fixture.mainDir, "openspec", "changes", "squashed-elsewhere")
    await mkdir(join(changeDir, "specs"), { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Squashed elsewhere\n")
    await writeFile(join(changeDir, "tasks.md"), "- [x] done\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "feat(openspec): propose squashed-elsewhere")

    const result = await archiveChangeOnMain({ targetDir: fixture.mainDir, changeID: "squashed-elsewhere" })
    expect(result.committed).toBe(true)
    await expect(stat(changeDir)).rejects.toThrow()
    expect((await stat(join(fixture.mainDir, "openspec", "changes", "archive", "squashed-elsewhere"))).isDirectory()).toBe(true)
    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).toContain("chore(openspec): archive squashed-elsewhere")
  })

  test("an absent change refuses", async () => {
    const fixture = await makeFixture()
    await expect(archiveChangeOnMain({ targetDir: fixture.mainDir, changeID: "ghost" })).rejects.toThrow(/ghost/)
  })

  test("archive-on-main lands on the main checkout even when invoked from a worktree (SC-4)", async () => {
    const fixture = await makeFixture()
    // An unarchived change sits on the base checkout.
    const changeDir = join(fixture.mainDir, "openspec", "changes", "squashed-elsewhere")
    await mkdir(join(changeDir, "specs"), { recursive: true })
    await writeFile(join(changeDir, "proposal.md"), "# Squashed elsewhere\n")
    await writeFile(join(changeDir, "tasks.md"), "- [x] done\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "feat(openspec): propose squashed-elsewhere")

    // Invoke as the board would when opened *inside* a feature worktree
    // (targetDir is the worktree, not main).
    const result = await archiveChangeOnMain({ targetDir: fixture.worktreeDir, changeID: "squashed-elsewhere" })
    expect(result.committed).toBe(true)
    // Archived on the main checkout, committed on the base branch...
    await expect(stat(changeDir)).rejects.toThrow()
    expect((await stat(join(fixture.mainDir, "openspec", "changes", "archive", "squashed-elsewhere"))).isDirectory()).toBe(true)
    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).toContain("chore(openspec): archive squashed-elsewhere")
    // ...and the feature worktree gained nothing.
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "squashed-elsewhere"))).rejects.toThrow()
  })
})
