import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { applySquash, backupRefFor, describeSquashPlan, parseMessage, resolveSquashRange } from "../src/finish"
import { addAllAndCommit } from "../src/git"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Runs git as the test user and disables ambient signing for setup commits. */
async function git(args: string[], cwd: string): Promise<string> {
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
  const stdout = await new Response(proc.stdout).text()
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  return stdout.trim()
}

async function initRepo(dir: string): Promise<string> {
  await git(["init", "-q", "-b", "main"], dir)
  await git(["config", "user.name", "convoy-test"], dir)
  await git(["config", "user.email", "convoy-test@example.invalid"], dir)
  await git(["config", "commit.gpgsign", "false"], dir)
  await writeFile(join(dir, "README.md"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-q", "-m", "chore: base"], dir)
  return dir
}

async function repoWithBranch(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), "convoy-finish-"))
  dirs.push(raw)
  const dir = await git(["rev-parse", "--show-toplevel"], await initRepo(raw))
  await git(["checkout", "-q", "-b", "feat/thing"], dir)
  return dir
}

/** Creates a step commit with the same identity as the runner. */
async function convoyCommit(dir: string, file: string, message: string) {
  await writeFile(join(dir, file), `${message}\n`)
  await addAllAndCommit(message, dir)
}

async function userCommit(dir: string, file: string, message: string) {
  await writeFile(join(dir, file), `${message}\n`)
  await git(["add", "-A"], dir)
  await git(["commit", "-q", "-m", message], dir)
}

async function subjects(dir: string): Promise<string[]> {
  return (await git(["log", "--format=%s"], dir)).split("\n").filter(Boolean)
}

describe("resolveSquashRange", () => {
  test("collects every consecutive convoy commit above the base", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): Implementer report")
    await convoyCommit(dir, "b.txt", "convoy(patterns): Pattern audit")
    await convoyCommit(dir, "c.txt", "convoy(security): Security audit")

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error(`expected a squashable range, got ${range.reason}: ${range.message}`)

    expect(range.branch).toBe("feat/thing")
    expect(range.commits.map((commit) => commit.subject)).toEqual([
      "convoy(security): Security audit",
      "convoy(patterns): Pattern audit",
      "convoy(implementer): Implementer report",
    ])
    expect(range.base).toBe(await git(["rev-parse", "main"], dir))
    expect(range.stoppedAt).toBeUndefined()
  })

  test("stops at the user's own commit and never proposes rewriting it", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): first pass")
    await userCommit(dir, "manual.txt", "fix: my own hotfix")
    await convoyCommit(dir, "b.txt", "convoy(tests): add tests")

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error(`expected a squashable range, got ${range.reason}`)

    expect(range.commits.map((commit) => commit.subject)).toEqual(["convoy(tests): add tests"])
    expect(range.stoppedAt?.subject).toBe("fix: my own hotfix")
    expect(range.base).toBe(await git(["rev-parse", "HEAD~1"], dir))
  })

  test("refuses a branch with no convoy commits", async () => {
    const dir = await repoWithBranch()
    await userCommit(dir, "manual.txt", "fix: only mine")

    const range = await resolveSquashRange(dir, "main")
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toBe("no-commits")
  })

  test("refuses a dirty working tree and names the files", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): first pass")
    await writeFile(join(dir, "scratch.txt"), "uncommitted\n")

    const range = await resolveSquashRange(dir, "main")
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toBe("dirty")
    expect(range.message).toContain("scratch.txt")
  })

  test("refuses a detached HEAD", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): first pass")
    await git(["checkout", "-q", "--detach"], dir)

    const range = await resolveSquashRange(dir, "main")
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toBe("detached")
  })

  test("refuses commits already published to the upstream", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): first pass")
    await git(["remote", "add", "origin", "https://example.invalid/repo.git"], dir)
    await git(["update-ref", "refs/remotes/origin/feat/thing", "HEAD"], dir)
    await git(["branch", "--set-upstream-to=origin/feat/thing", "feat/thing"], dir)

    const range = await resolveSquashRange(dir, "main")
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toBe("already-pushed")
  })

  test("never consumes a convoy-authored root commit", async () => {
    const raw = await mkdtemp(join(tmpdir(), "convoy-finish-root-"))
    dirs.push(raw)
    await git(["init", "-q", "-b", "main"], raw)
    const dir = await git(["rev-parse", "--show-toplevel"], raw)
    await convoyCommit(dir, "a.txt", "convoy: initial commit")
    await convoyCommit(dir, "b.txt", "convoy(implementer): first pass")

    const range = await resolveSquashRange(dir, "main")
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toBe("no-commits")
    expect(await git(["rev-list", "--max-parents=0", "HEAD"], dir)).not.toBe("")
  })
})

describe("applySquash", () => {
  test("replaces convoy commits with one commit authored by the user", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): Implementer report")
    await convoyCommit(dir, "b.txt", "convoy(patterns): Pattern audit")
    const before = await git(["rev-parse", "HEAD"], dir)

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error("expected a squashable range")
    const { ok: _ok, ...plan } = range
    const result = await applySquash({ cwd: dir, plan, message: "feat(thing): add the thing\n\n- one\n- two", noVerify: true })

    expect(await subjects(dir)).toEqual(["feat(thing): add the thing", "chore: base"])
    expect(await git(["log", "-1", "--format=%an <%ae>"], dir)).toBe("convoy-test <convoy-test@example.invalid>")
    expect(await git(["log", "-1", "--format=%b"], dir)).toContain("- one")
    expect((await git(["ls-tree", "-r", "--name-only", "HEAD"], dir)).split("\n").sort()).toEqual(["README.md", "a.txt", "b.txt"])
    expect(result.replaced).toBe(2)
    expect(await git(["rev-parse", backupRefFor("feat/thing")], dir)).toBe(before)
  })

  test("keeps the pre-squash history reachable through the backup ref", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): Implementer report")
    await convoyCommit(dir, "b.txt", "convoy(patterns): Pattern audit")

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error("expected a squashable range")
    const { ok: _ok, ...plan } = range
    const result = await applySquash({ cwd: dir, plan, message: "feat: squashed", noVerify: true })

    await git(["reset", "--hard", result.backupRef], dir)
    expect(await subjects(dir)).toEqual(["convoy(patterns): Pattern audit", "convoy(implementer): Implementer report", "chore: base"])
  })

  test("signs with the user's key while the replaced step commits remain unsigned", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): Implementer report")
    await git(["config", "commit.gpgsign", "true"], dir)
    expect(await git(["log", "-1", "--format=%G?"], dir)).toBe("N")

    const keyDir = await mkdtemp(join(tmpdir(), "convoy-finish-key-"))
    dirs.push(keyDir)
    const key = join(keyDir, "signing-key")
    const keygen = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "convoy-test", "-f", key], {
      stdout: "pipe",
      stderr: "pipe",
    })
    if ((await keygen.exited) !== 0) throw new Error(`ssh-keygen: ${await new Response(keygen.stderr).text()}`)
    const publicKey = (await Bun.file(`${key}.pub`).text()).trim()
    const allowedSigners = join(keyDir, "allowed_signers")
    await writeFile(allowedSigners, `convoy-test@example.invalid ${publicKey}\n`)
    await git(["config", "gpg.format", "ssh"], dir)
    await git(["config", "user.signingkey", `${key}.pub`], dir)
    await git(["config", "gpg.ssh.allowedSignersFile", allowedSigners], dir)
    await git(["config", "gpg.ssh.program", "ssh-keygen"], dir)

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error("expected a squashable range")
    const { ok: _ok, ...plan } = range
    await applySquash({ cwd: dir, plan, message: "feat: signed by the user", noVerify: true })

    expect(await git(["log", "-1", "--format=%G?"], dir)).toBe("G")
    expect(await git(["log", "-1", "--format=%GS"], dir)).toBe("convoy-test@example.invalid")
    expect(await git(["log", "-1", "--format=%s"], dir)).toBe("feat: signed by the user")
  })

  test("rolls the branch and index back when the user commit fails", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): Implementer report")
    await convoyCommit(dir, "b.txt", "convoy(patterns): Pattern audit")
    const before = await git(["rev-parse", "HEAD"], dir)
    await git(["config", "commit.gpgsign", "true"], dir)
    await git(["config", "gpg.format", "ssh"], dir)
    await git(["config", "gpg.ssh.program", "/usr/bin/false"], dir)
    await git(["config", "user.signingkey", "/dev/null"], dir)

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error("expected a squashable range")
    const { ok: _ok, ...plan } = range

    await expect(applySquash({ cwd: dir, plan, message: "feat: squashed", noVerify: true })).rejects.toThrow(/git commit exited/)
    expect(await git(["rev-parse", "HEAD"], dir)).toBe(before)
    expect(await subjects(dir)).toEqual(["convoy(patterns): Pattern audit", "convoy(implementer): Implementer report", "chore: base"])
    expect(await git(["status", "--porcelain"], dir)).toBe("")
  })
})

describe("finish presentation", () => {
  test("parses an edited message and drops git comments", () => {
    const raw = ["feat(advisor): add per-step model", "", "- route calls through the bridge", "- cap consultations", "", "# ignored"].join("\n")
    expect(parseMessage(raw)).toEqual({
      subject: "feat(advisor): add per-step model",
      body: ["route calls through the bridge", "cap consultations"],
    })
    expect(parseMessage("\n\n# only comments\n")).toBeUndefined()
  })

  test("describes the user commit where the squash stops", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): first pass")
    await userCommit(dir, "manual.txt", "fix: my own hotfix")
    await convoyCommit(dir, "b.txt", "convoy(tests): add tests")

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error("expected a squashable range")
    const { ok: _ok, ...plan } = range
    const lines = describeSquashPlan(plan)

    expect(lines[0]).toBe("1 convoy commit on feat/thing → 1")
    expect(lines.join("\n")).toContain("convoy(tests): add tests")
    expect(lines.join("\n")).toContain("your own commit, left untouched")
  })
})
