import { describe, expect, spyOn, test } from "bun:test"
import { rm } from "node:fs/promises"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runFinishCommand } from "../src/finish-command"
import { resolveSquashRange, type FinishContext, type FinishPreparation } from "../src/finish"

function git(args: string[], cwd: string): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim()
}

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "convoy-finish-cmd-"))
  mkdirSync(join(dir, ".convoy"), { recursive: true })
  writeFileSync(join(dir, ".convoy/config.yaml"), "defaults:\n  baseRef: main\n")

  git(["init", "-q", "-b", "main"], dir)
  git(["config", "user.email", "test@test.com"], dir)
  git(["config", "user.name", "Tester"], dir)
  git(["add", "-A"], dir)
  git(["commit", "-q", "-m", "chore: initial", "--author=User <user@test.com>"], dir)
  git(["checkout", "-q", "-b", "feat/test-login"], dir)
  git(["commit", "-q", "--allow-empty", "-m", "feat: add login (1/2)", "--author=Convoy <convoy@local>"], dir)
  git(["commit", "-q", "--allow-empty", "-m", "fix: typo (2/2)", "--author=Convoy <convoy@local>"], dir)
  return dir
}

async function prepareTestFinish(context: FinishContext): Promise<FinishPreparation> {
  const range = await resolveSquashRange(context.cwd, context.baseRef)
  if (!range.ok) return range
  const { ok: _ok, ...plan } = range
  return {
    ok: true,
    plan,
    message: { type: "feat", subject: "add login", body: ["Convoy commit message"] },
    messageSource: "template",
  }
}

const deps = { prepareFinish: prepareTestFinish }

describe("runFinishCommand integration with git", () => {
  test("reports an already-finished branch as a successful no-op", async () => {
    const dir = setupRepo()
    const beforeHead = git(["rev-parse", "HEAD"], dir)
    const writes: string[] = []
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })

    try {
      await runFinishCommand({ targetDir: dir, baseRef: "main" }, {
        prepareFinish: async () => ({ ok: false, reason: "no-commits", message: "nothing to finish" }),
      })

      expect(writes.join("")).toContain("nothing to finish")
      expect(git(["rev-parse", "HEAD"], dir)).toBe(beforeHead)
    } finally {
      stdout.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("--dry-run prints the plan without changing HEAD or status", async () => {
    const dir = setupRepo()
    const beforeHead = git(["rev-parse", "HEAD"], dir)
    const beforeStatus = git(["status", "--porcelain=v1", "--untracked-files=all"], dir)
    const writes: string[] = []
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })

    try {
      await runFinishCommand({ targetDir: dir, dryRun: true, baseRef: "main" }, deps)

      expect(writes.join("")).toContain("--dry-run: nothing was changed")
      expect(writes.join("")).toContain("feat: add login")
      expect(writes.join("")).toContain("2 convoy commits")
      expect(git(["rev-parse", "HEAD"], dir)).toBe(beforeHead)
      expect(git(["status", "--porcelain=v1", "--untracked-files=all"], dir)).toBe(beforeStatus)
    } finally {
      stdout.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("non-interactive execution without --yes leaves the repository unchanged", async () => {
    const dir = setupRepo()
    const beforeHead = git(["rev-parse", "HEAD"], dir)
    const beforeStatus = git(["status", "--porcelain=v1", "--untracked-files=all"], dir)
    const writes: string[] = []
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })

    try {
      await runFinishCommand({ targetDir: dir, baseRef: "main" }, deps)

      expect(writes.join("")).toContain("not an interactive terminal")
      expect(git(["rev-parse", "HEAD"], dir)).toBe(beforeHead)
      expect(git(["status", "--porcelain=v1", "--untracked-files=all"], dir)).toBe(beforeStatus)
    } finally {
      stdout.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("--branch locates a worktree at a non-default location via git worktree list", async () => {
    const dir = setupRepo()
    const wtRoot = mkdtempSync(join(tmpdir(), "convoy-finish-wt-"))
    const wt = join(wtRoot, "custom-located")
    git(["worktree", "add", "-b", "feat/elsewhere", "--", wt, "main"], dir)
    git(["commit", "-q", "--allow-empty", "-m", "feat: add login (1/2)", "--author=Convoy <convoy@local>"], wt)
    git(["commit", "-q", "--allow-empty", "-m", "fix: typo (2/2)", "--author=Convoy <convoy@local>"], wt)
    const writes: string[] = []
    const stdout = spyOn(process.stdout, "write").mockImplementation((chunk: string) => {
      writes.push(chunk)
      return true
    })

    try {
      await runFinishCommand({ targetDir: dir, branch: "feat/elsewhere", dryRun: true, baseRef: "main" }, deps)

      expect(writes.join("")).toContain("--dry-run: nothing was changed")
      expect(writes.join("")).toContain("feat: add login")
      expect(writes.join("")).toContain("2 convoy commits")
    } finally {
      stdout.mockRestore()
      await rm(dir, { recursive: true, force: true })
      await rm(wtRoot, { recursive: true, force: true })
    }
  })

  test("--branch throws a clear error when no worktree holds the branch", async () => {
    const dir = setupRepo()
    try {
      await expect(
        runFinishCommand({ targetDir: dir, branch: "feat/never-created", dryRun: true, baseRef: "main" }, deps),
      ).rejects.toThrow("no worktree for branch \"feat/never-created\"")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
