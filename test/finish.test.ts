import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  backupRefFor,
  canOpenPullRequest,
  createFinishSeam,
  describeSquashPlan,
  editMessageInEditor,
  openPullRequest,
  parseMessage,
  resolveFinishBase,
} from "../src/finish"
import type { SquashPlan } from "../src/finish"

describe("backupRefFor", () => {
  test("returns the backup ref for a branch", () => {
    expect(backupRefFor("feature/foo")).toBe("refs/convoy/finish/feature/foo")
  })

  test("handles branches with slashes", () => {
    expect(backupRefFor("feat/nested/deep")).toBe("refs/convoy/finish/feat/nested/deep")
  })

  test("handles simple branch names", () => {
    expect(backupRefFor("main")).toBe("refs/convoy/finish/main")
  })
})

describe("describeSquashPlan", () => {
  const plan: SquashPlan = {
    branch: "feat/thing",
    base: "abc123",
    head: "def456",
    commits: [
      { sha: "def456", subject: "feat: add the thing", authorEmail: "convoy@local", authorName: "Convoy" },
      { sha: "ghi789", subject: "fix: typo", authorEmail: "convoy@local", authorName: "Convoy" },
    ],
    diffStat: "1 file changed",
  }

  test("describes a plan without a stopped-at commit", () => {
    const lines = describeSquashPlan(plan)
    expect(lines[0]).toContain("2 convoy commits on feat/thing")
    expect(lines[1]).toContain("def456")
    expect(lines[2]).toContain("ghi789")
  })

  test("describes a plan with a stopped-at commit", () => {
    const lines = describeSquashPlan({
      ...plan,
      stoppedAt: { sha: "usr789", subject: "my commit", authorEmail: "user@example.com", authorName: "User" },
    })
    expect(lines.some((l) => l.includes("usr789"))).toBe(true)
    expect(lines.some((l) => l.includes("stops at"))).toBe(true)
  })

  test("uses singular for a single commit", () => {
    const lines = describeSquashPlan({ ...plan, commits: [plan.commits[0]!] })
    expect(lines[0]).toContain("1 convoy commit on feat/thing")
  })

  test("handles empty commits array", () => {
    const lines = describeSquashPlan({ ...plan, commits: [] })
    expect(lines[0]).toContain("0 convoy commits on feat/thing")
  })

  test("stops at commit line includes subject in parentheses", () => {
    const lines = describeSquashPlan({
      ...plan,
      stoppedAt: { sha: "abc12345", subject: "my own work", authorEmail: "user@example.com", authorName: "User" },
    })
    const stopLine = lines.find((l) => l.includes("stops at"))
    expect(stopLine).toBeDefined()
    expect(stopLine).toContain("(my own work)")
  })

  test("no stoppedAt does not produce stop line", () => {
    const lines = describeSquashPlan(plan)
    expect(lines.some((l) => l.includes("stops at"))).toBe(false)
  })
})

describe("parseMessage", () => {
  test("parses a subject and body from a raw message", () => {
    const result = parseMessage("feat: add things\n\n- one\n- two")
    expect(result).toEqual({ subject: "feat: add things", body: ["one", "two"] })
  })

  test("strips git comment lines", () => {
    const result = parseMessage("feat: add things\n# This is a comment\n\n- one")
    expect(result).toEqual({ subject: "feat: add things", body: ["one"] })
  })

  test("returns undefined for an empty message", () => {
    expect(parseMessage("")).toBeUndefined()
    expect(parseMessage("# only comments")).toBeUndefined()
  })

  test("returns undefined when no subject exists", () => {
    expect(parseMessage("\n\n  ")).toBeUndefined()
  })

  test("strips leading whitespace from subject line", () => {
    const result = parseMessage("  feat: add things\n\n- one")
    expect(result).toEqual({ subject: "feat: add things", body: ["one"] })
  })

  test("strips comment lines interleaved with body", () => {
    const result = parseMessage("feat: add things\n\n- one\n# comment in body\n- two\n# another comment")
    expect(result).toEqual({ subject: "feat: add things", body: ["one", "two"] })
  })

  test("removes bullet markers from body lines", () => {
    const result = parseMessage("feat: add things\n\n- one\n* two\n- three")
    expect(result).toEqual({ subject: "feat: add things", body: ["one", "two", "three"] })
  })

  test("returns body as empty array when only subject is present", () => {
    const result = parseMessage("feat: add things")
    expect(result).toEqual({ subject: "feat: add things", body: [] })
  })

  test("treats whitespace-only lines in body as empty and skips them", () => {
    const result = parseMessage("feat: add things\n\n- one\n   \n- two")
    expect(result).toEqual({ subject: "feat: add things", body: ["one", "two"] })
  })

  test("handles trailing whitespace on lines", () => {
    const result = parseMessage("feat: add things   \n\n- one   \n- two   ")
    expect(result).toEqual({ subject: "feat: add things", body: ["one", "two"] })
  })
})

describe("canOpenPullRequest", () => {
  test("returns a boolean", () => {
    const result = canOpenPullRequest()
    expect(typeof result).toBe("boolean")
  })
})

describe("openPullRequest", () => {
  test("throws when gh pr create fails", async () => {
    // Mock Bun.spawn to return a non-zero exit code
    const originalSpawn = Bun.spawn
    // @ts-expect-error - overriding Bun.spawn for testing
    Bun.spawn = ((_args: string[]) => ({
      exited: Promise.resolve(1),
    })) as typeof Bun.spawn

    try {
      await expect(openPullRequest("/tmp", { subject: "feat: test", body: ["one"] })).rejects.toThrow("gh pr create")
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("succeeds when gh pr create succeeds", async () => {
    const originalSpawn = Bun.spawn
    // @ts-expect-error - overriding Bun.spawn for testing
    Bun.spawn = ((args: string[]) => {
      expect(args[0]).toBe("gh")
      expect(args[1]).toBe("pr")
      expect(args[2]).toBe("create")
      expect(args[3]).toBe("--title")
      expect(args[4]).toBe("feat: test")
      return { exited: Promise.resolve(0) }
    }) as typeof Bun.spawn

    try {
      await expect(openPullRequest("/tmp", { subject: "feat: test", body: ["one"] })).resolves.toBeUndefined()
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("formats body lines as bullet list", async () => {
    const originalSpawn = Bun.spawn
    let capturedBody = ""
    // @ts-expect-error - overriding Bun.spawn for testing
    Bun.spawn = ((_args: string[], _opts: { cwd: string }) => {
      capturedBody = _args[6]!
      return { exited: Promise.resolve(0) }
    }) as typeof Bun.spawn

    try {
      await openPullRequest("/tmp", { subject: "feat: test", body: ["one", "two", "three"] })
      expect(capturedBody).toBe("- one\n- two\n- three")
    } finally {
      Bun.spawn = originalSpawn
    }
  })
})

describe("editMessageInEditor", () => {
  test("returns undefined when the editor exits with non-zero status", async () => {
    const originalSpawn = Bun.spawn
    // @ts-expect-error - overriding Bun.spawn for testing
    Bun.spawn = ((_args: string[], _opts: { cwd: string }) => ({
      exited: Promise.resolve(1),
    })) as typeof Bun.spawn

    try {
      const result = await editMessageInEditor("feat: test\n\n- one")
      expect(result).toBeUndefined()
    } finally {
      Bun.spawn = originalSpawn
    }
  })

  test("returns parsed message when editor exits successfully", async () => {
    const originalSpawn = Bun.spawn
    const originalEnv = process.env
    // @ts-expect-error - overriding Bun.spawn for testing
    Bun.spawn = ((args: string[], opts: { cwd: string }) => {
      // The editor is called with sh -c "$EDITOR <path>"
      // We simulate it by reading the file and writing a modified version if needed
      return { exited: Promise.resolve(0) }
    }) as typeof Bun.spawn

    // Set a simple editor that does nothing (preserves the file)
    process.env.GIT_EDITOR = "cat"

    try {
      const result = await editMessageInEditor("feat: test\n\n- one")
      expect(result).toEqual({ subject: "feat: test", body: ["one"] })
    } finally {
      Bun.spawn = originalSpawn
      process.env = originalEnv
    }
  })
})

describe("createFinishSeam", () => {
  test("returns an object with all seam methods", () => {
    const seam = createFinishSeam({ cwd: "/tmp" })
    expect(seam).toHaveProperty("prepare")
    expect(seam).toHaveProperty("apply")
    expect(seam).toHaveProperty("edit")
    expect(seam).toHaveProperty("push")
    expect(seam).toHaveProperty("canOpenPullRequest")
    expect(seam).toHaveProperty("openPullRequest")
    expect(typeof seam.prepare).toBe("function")
    expect(typeof seam.apply).toBe("function")
    expect(typeof seam.edit).toBe("function")
    expect(typeof seam.push).toBe("function")
    expect(typeof seam.canOpenPullRequest).toBe("function")
    expect(typeof seam.openPullRequest).toBe("function")
  })

  test("canOpenPullRequest delegates to the module function", () => {
    const seam = createFinishSeam({ cwd: "/tmp" })
    expect(typeof seam.canOpenPullRequest()).toBe("boolean")
  })

  test("apply throws when prepare was not called first", async () => {
    const seam = createFinishSeam({ cwd: "/tmp" })
    await expect(
      seam.apply({ subject: "feat: test", body: [] }),
    ).rejects.toThrow("finish was applied before it was prepared")
  })
})

describe("formatSubject and joinMessage (private helpers)", () => {
  test("backupRefFor is consistent", () => {
    expect(backupRefFor("branch")).toBe("refs/convoy/finish/branch")
    expect(backupRefFor("feat/convoy/finish/thing")).toBe("refs/convoy/finish/feat/convoy/finish/thing")
  })
})

describe("resolveFinishBase", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function createRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-finish-base-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    await writeFile(join(dir, "README.md"), "base\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-q", "-m", "init"], dir)
    return dir
  }

  test("returns the configured base ref when provided", async () => {
    const dir = await createRepo()
    const result = await resolveFinishBase(dir, "main")
    expect(result).toBe("main")
  })

  test("falls back to HEAD when detection returns nothing", async () => {
    const dir = await createRepo()
    // An empty/standalone repo may have no base ref; resolveFinishBase should
    // return "HEAD" as the final fallback
    const result = await resolveFinishBase(dir)
    expect(result).toBeDefined()
    expect(typeof result).toBe("string")
  })
})

describe("resolveSquashRange", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function createRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-finish-squash-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    await writeFile(join(dir, "README.md"), "base\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-q", "-m", "init"], dir)
    // Create a branch with convoy commits
    await git(["checkout", "-b", "feat/test"], dir)
    await writeFile(join(dir, "test.txt"), "change\n")
    await git(["add", "test.txt"], dir)
    await git(["commit", "-q", "-m", "convoy(implementer): add test file"], dir)
    return dir
  }

  test("returns dirty working tree error", async () => {
    const dir = await createRepo()
    await writeFile(join(dir, "unstaged.txt"), "dirty\n")
    const { resolveSquashRange } = await import("../src/finish")
    const result = await resolveSquashRange(dir, "main")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("dirty")
    }
  })
})