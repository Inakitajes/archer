import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { archiveChangeOnMain, closePreflight, resolveCloseTarget, runClose } from "../src/feature-close"

const dirs: string[] = []

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
  test("the full sequence: archive via the CLI, one conventional commit, operator commit survives, merged", async () => {
    const fixture = await makeFixture()
    const result = await runClose(closeInput(fixture))

    expect(result.merged).toBe(true)
    // The archive commit and the convoy implement commit collapse into one;
    // the operator's proposal commit survives the walk.
    expect(result.squashed?.replaced).toBe(2)
    // The change dir moved into the archive layout inside the worktree.
    await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).rejects.toThrow()
    expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget"))).isDirectory()).toBe(true)
    // The base branch gained the squashed conventional commit and the operator's proposal commit.
    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(log).toContain("feat: add-widget")
    expect(log).toContain("feat(openspec): propose add-widget")
    // The worktree still exists until the operator accepts its removal.
    expect((await stat(fixture.worktreeDir)).isDirectory()).toBe(true)
  })

  test("the sequence is resumable: completed steps are not redone", async () => {
    const fixture = await makeFixture()
    await runClose(closeInput(fixture))
    // A resume finds nothing left to do: the change dir is gone (archive done)
    // and the branch is contained in the base (merge done).
    const result = await runClose({ ...closeInput(fixture), resume: true })
    expect(result.merged).toBe(true)
    expect(result.squashed).toBeUndefined()
  })

  test("a clean sync folds the sync merge and convoy commits into one conventional commit (SC-2)", async () => {
    const fixture = await makeFixture()
    // Advance main so the sync step creates an operator-identity merge commit
    // that the squash must fold — with the raw convoy/archive commits — instead
    // of letting them reach the base branch unsquashed.
    await writeFile(join(fixture.mainDir, "main-advance.txt"), "advance\n")
    await git(fixture.mainDir, undefined, "add", ".")
    await git(fixture.mainDir, undefined, "commit", "-m", "chore: advance main in parallel")

    const result = await runClose(closeInput(fixture))
    expect(result.merged).toBe(true)

    const log = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    // The operator's proposal commit survives, and the feature lands as the
    // one conventional commit — the base's own advance is also present.
    expect(log).toContain("feat(openspec): propose add-widget")
    expect(log).toContain("feat: add-widget")
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
    await git(fixture.worktreeDir, { GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.com", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.com" }, "commit", "-m", "feat: feature moves shared.txt")

    await expect(runClose(closeInput(fixture))).rejects.toThrow(/sync.*conflicted[\s\S]*--resume/)
    // Nothing was archived or merged.
    expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).isDirectory()).toBe(true)
    const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
    expect(mainLog).not.toContain("feat: add-widget")
  })

  test("preflight failure changes nothing on any branch", async () => {
    const fixture = await makeFixture({ tasksDone: false })
    const before = await git(fixture.mainDir, undefined, "rev-parse", "HEAD")
    await expect(runClose(closeInput(fixture))).rejects.toThrow(/preflight failed/)
    expect(await git(fixture.mainDir, undefined, "rev-parse", "HEAD")).toBe(before)
  })

  test("an archive failure hard-stops before any squash or merge", async () => {
    const fixture = await makeFixture()
    process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL = "1"
    try {
      await expect(runClose(closeInput(fixture))).rejects.toThrow(/archive.*failed[\s\S]*before any squash or merge/)
      // The change was not archived (the CLI failed before moving it)...
      expect((await stat(join(fixture.worktreeDir, "openspec", "changes", "add-widget"))).isDirectory()).toBe(true)
      await expect(stat(join(fixture.worktreeDir, "openspec", "changes", "archive", "add-widget"))).rejects.toThrow()
      // ...and nothing landed on the base branch (no squash, no merge).
      const mainLog = await git(fixture.mainDir, undefined, "log", "--format=%s", "main")
      expect(mainLog).not.toContain("feat: add-widget")
    } finally {
      delete process.env.CONVOY_OPENSPEC_ARCHIVE_FAIL
    }
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
