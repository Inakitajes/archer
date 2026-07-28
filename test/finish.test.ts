import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { addAllAndCommit } from "../src/git"
import { applySquash, backupRefFor, describeSquashPlan, parseMessage, resolveSquashRange } from "../src/finish"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

/** The user's own git, deliberately never convoy@local, and never signing in tests. */
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

/** A repo on `main` with one user commit, plus a run branch checked out. */
async function repoWithBranch(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), "convoy-finish-"))
  dirs.push(raw)
  const dir = await git(["rev-parse", "--show-toplevel"], await initRepo(raw))
  await git(["checkout", "-q", "-b", "feat/thing"], dir)
  return dir
}

async function initRepo(dir: string): Promise<string> {
  await git(["init", "-q", "-b", "main"], dir)
  // commitAsUser deliberately does NOT set GIT_AUTHOR_*: it commits as whoever
  // the repo's git config says. Pin that config so the assertion doesn't depend
  // on the developer's global identity.
  await git(["config", "user.name", "convoy-test"], dir)
  await git(["config", "user.email", "convoy-test@example.invalid"], dir)
  await git(["config", "commit.gpgsign", "false"], dir)
  await writeFile(join(dir, "README.md"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-q", "-m", "chore: base"], dir)
  return dir
}

/** A step commit, made exactly the way the runner makes them. */
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

  test("refuses commits that are already on the upstream, which would need a force-push", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): first pass")
    // Fabricate the remote-tracking state locally, the way detectBaseRef's tests
    // do: the remote is never contacted, only its refs and config are needed.
    await git(["remote", "add", "origin", "https://example.invalid/repo.git"], dir)
    await git(["update-ref", "refs/remotes/origin/feat/thing", "HEAD"], dir)
    await git(["branch", "--set-upstream-to=origin/feat/thing", "feat/thing"], dir)

    const range = await resolveSquashRange(dir, "main")
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toBe("already-pushed")
  })

  test("refuses when the whole history is convoy's, rather than eating the root commit", async () => {
    const raw = await mkdtemp(join(tmpdir(), "convoy-finish-root-"))
    dirs.push(raw)
    await git(["init", "-q", "-b", "main"], raw)
    const dir = await git(["rev-parse", "--show-toplevel"], raw)
    await convoyCommit(dir, "a.txt", "convoy: initial commit")
    await convoyCommit(dir, "b.txt", "convoy(implementer): first pass")

    // "main" is the branch itself here, so the merge-base is HEAD and there is
    // nothing above it; either way the root must survive.
    const range = await resolveSquashRange(dir, "main")
    expect(range.ok).toBe(false)
    if (range.ok) return
    expect(range.reason).toBe("no-commits")
  })
})

describe("applySquash", () => {
  test("replaces the convoy commits with one commit authored by the user", async () => {
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
    // The tree is what the steps left behind, not what the base had.
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

  test("signs the commit with the user's key, while the step commits it replaces stay unsigned", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): Implementer report")
    // Every step commit is unsigned by construction, whatever the config says.
    await git(["config", "commit.gpgsign", "true"], dir)
    expect(await git(["log", "-1", "--format=%G?"], dir)).toBe("N")

    // A real SSH signing setup, generated on the fly: this is the whole promise
    // of finish — convoy's own commits can't sign, the user's commit does. The
    // key lives outside the repo so it never shows up as an uncommitted file.
    const keyDir = await mkdtemp(join(tmpdir(), "convoy-finish-key-"))
    dirs.push(keyDir)
    const key = join(keyDir, "signing-key")
    const keygen = Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "convoy-test", "-f", key], { stdout: "pipe", stderr: "pipe" })
    if ((await keygen.exited) !== 0) throw new Error(`ssh-keygen: ${await new Response(keygen.stderr).text()}`)
    const publicKey = (await Bun.file(`${key}.pub`).text()).trim()
    const allowedSigners = join(keyDir, "allowed_signers")
    await writeFile(allowedSigners, `convoy-test@example.invalid ${publicKey}\n`)
    await git(["config", "gpg.format", "ssh"], dir)
    await git(["config", "user.signingkey", `${key}.pub`], dir)
    await git(["config", "gpg.ssh.allowedSignersFile", allowedSigners], dir)
    // Pinned because commitAsUser inherits the developer's real git config, and
    // theirs may route signing through 1Password, which can't sign this key.
    await git(["config", "gpg.ssh.program", "ssh-keygen"], dir)

    const range = await resolveSquashRange(dir, "main")
    if (!range.ok) throw new Error("expected a squashable range")
    const { ok: _ok, ...plan } = range
    await applySquash({ cwd: dir, plan, message: "feat: signed by the user", noVerify: true })

    // "G" is a good signature from a known signer.
    expect(await git(["log", "-1", "--format=%G?"], dir)).toBe("G")
    expect(await git(["log", "-1", "--format=%GS"], dir)).toBe("convoy-test@example.invalid")
    expect(await git(["log", "-1", "--format=%s"], dir)).toBe("feat: signed by the user")
  })

  test("restores the branch when the commit fails", async () => {
    const dir = await repoWithBranch()
    await convoyCommit(dir, "a.txt", "convoy(implementer): Implementer report")
    await convoyCommit(dir, "b.txt", "convoy(patterns): Pattern audit")
    const before = await git(["rev-parse", "HEAD"], dir)
    // A repo that cannot sign: the commit convoy makes on the user's behalf
    // inherits commit.gpgsign, so this is the "user cancelled 1Password" path.
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

describe("parseMessage", () => {
  test("splits an edited message back into subject and body, dropping git's comments", () => {
    const raw = ["feat(advisor): add per-step model", "", "- route calls through the bridge", "- cap consultations", "", "# Lines starting with '#' are ignored."].join("\n")
    expect(parseMessage(raw)).toEqual({
      subject: "feat(advisor): add per-step model",
      body: ["route calls through the bridge", "cap consultations"],
    })
  })

  test("treats an emptied file as a cancelled commit, the way git does", () => {
    expect(parseMessage("\n\n# only comments\n")).toBeUndefined()
    expect(parseMessage("")).toBeUndefined()
  })

  test("keeps a body written as plain paragraphs", () => {
    expect(parseMessage("fix: stop the leak\n\nThe session was never closed.\n")).toEqual({
      subject: "fix: stop the leak",
      body: ["The session was never closed."],
    })
  })
})

describe("describeSquashPlan", () => {
  test("counts the commits and names the user commit it stopped at", async () => {
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
