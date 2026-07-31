import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { addAllAndCommit, addWorktree, branchExists, detectBaseRef, diffTotals, ensureRepoReady, findSuspiciousStagedFiles, initializeRepoWithInitialCommit, repoBootstrapStatus } from "../src/git"

describe("findSuspiciousStagedFiles", () => {
  test("flags common secret filenames", () => {
    const porcelain = [
      "A  lib/feature/onboarding.dart",
      "A  .env",
      "A  android/app/keystore.jks",
      "M  config/credentials.json",
      "A  certs/server.pem",
      "A  ssh/id_rsa",
      "?? .env.local",
    ].join("\n")

    expect(findSuspiciousStagedFiles(porcelain)).toEqual([
      ".env",
      "android/app/keystore.jks",
      "config/credentials.json",
      "certs/server.pem",
      "ssh/id_rsa",
      ".env.local",
    ])
  })

  test("does not flag innocuous Flutter files", () => {
    const porcelain = [
      "A  lib/feature/onboarding.dart",
      "M  pubspec.yaml",
      "A  test/onboarding_test.dart",
      "A  assets/images/logo.png",
    ].join("\n")

    expect(findSuspiciousStagedFiles(porcelain)).toEqual([])
  })

  test("ignores deletions of previously committed secrets", () => {
    const porcelain = ["D  .env", "D  certs/server.pem"].join("\n")
    expect(findSuspiciousStagedFiles(porcelain)).toEqual([])
  })

  test("handles renames using -> arrow", () => {
    const porcelain = `R  config/old.txt -> config/credentials.json`
    expect(findSuspiciousStagedFiles(porcelain)).toEqual(["config/credentials.json"])
  })

  test("decodes C-quoted porcelain paths before matching", () => {
    const porcelain = ['A  "secret dir/.env"', 'A  "caf\\303\\251/.env"'].join("\n")
    expect(findSuspiciousStagedFiles(porcelain)).toEqual(["secret dir/.env", "cafÃ©/.env"])
  })
})

describe("ensureRepoReady", () => {
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

  async function emptyRepo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-ensure-repo-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    // git reports the physical path; ensureRepoReady resolves symlinks too, but
    // mkdtemp on macOS hands back a /var → /private/var symlink, so compare from there.
    const proc = Bun.spawn(["git", "-C", dir, "rev-parse", "--show-toplevel"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return (await new Response(proc.stdout).text()).trim()
  }

  async function dirtyRepo(): Promise<string> {
    const dir = await emptyRepo()
    await writeFile(join(dir, "dirty.txt"), "uncommitted\n")
    return dir
  }

  test("throws on a dirty tree without allowDirty", async () => {
    const dir = await dirtyRepo()
    await expect(ensureRepoReady(dir)).rejects.toThrow(/not clean/)
  })

  test("allowDirty defers the dirty-tree decision so resume can recover", async () => {
    const dir = await dirtyRepo()
    await expect(ensureRepoReady(dir, { allowDirty: true })).resolves.toBeUndefined()
  })

  test("rejects an explicit base ref that doesn't exist, pointing at auto-detection", async () => {
    const dir = await emptyRepo()
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    await expect(ensureRepoReady(dir, { baseRef: "nope" })).rejects.toThrow(/auto-detect/)
  })

  test("reports a repo with no commits instead of blaming the base ref", async () => {
    const dir = await emptyRepo()
    await expect(ensureRepoReady(dir, { baseRef: "main" })).rejects.toThrow(/no commits/)
  })

  // The launcher's worktree pre-check: a dirty source tree is fine (the run
  // gets a fresh worktree) but a bad base ref must still fail before launch.
  test("allowDirty still rejects a base ref that doesn't exist", async () => {
    const dir = await dirtyRepo()
    await git(["add", "."], dir)
    await git(["commit", "-q", "-m", "init"], dir)
    await writeFile(join(dir, "dirty.txt"), "uncommitted again\n")
    await expect(ensureRepoReady(dir, { allowDirty: true, baseRef: "nope" })).rejects.toThrow(/auto-detect/)
    await expect(ensureRepoReady(dir, { allowDirty: true, baseRef: "HEAD" })).resolves.toBeUndefined()
  })
})

describe("detectBaseRef", () => {
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

  async function repo(branch: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-detect-base-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", branch], dir)
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    return dir
  }

  /** Points origin/HEAD at a fabricated remote-tracking branch, no network involved. */
  async function setOriginHead(dir: string, branch: string, options: { createRef?: boolean } = {}) {
    if (options.createRef !== false) await git(["update-ref", `refs/remotes/origin/${branch}`, "HEAD"], dir)
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branch}`], dir)
  }

  test("origin/HEAD wins over the probe order", async () => {
    const dir = await repo("develop")
    await git(["branch", "main"], dir) // decoy: the probe alone would pick main
    await setOriginHead(dir, "develop")
    expect(await detectBaseRef(dir)).toEqual({ ref: "develop", source: "origin-head" })
  })

  test("uses the remote-tracking ref when the default branch has no local checkout", async () => {
    const dir = await repo("main")
    await setOriginHead(dir, "develop")
    expect(await detectBaseRef(dir)).toEqual({ ref: "origin/develop", source: "origin-head" })
  })

  test("ignores an origin/HEAD that points at a deleted branch", async () => {
    const dir = await repo("main")
    await setOriginHead(dir, "gone", { createRef: false })
    expect(await detectBaseRef(dir)).toEqual({ ref: "main", source: "probe" })
  })

  test("probes common base names in order", async () => {
    const dir = await repo("master")
    await git(["branch", "develop"], dir)
    expect(await detectBaseRef(dir)).toEqual({ ref: "master", source: "probe" })
  })

  test("probe finds develop when it is the only common name", async () => {
    const dir = await repo("develop")
    expect(await detectBaseRef(dir)).toEqual({ ref: "develop", source: "probe" })
  })

  test("falls back to the current branch for exotic names", async () => {
    const dir = await repo("dev-trunk")
    expect(await detectBaseRef(dir)).toEqual({ ref: "dev-trunk", source: "current-branch" })
  })

  test("falls back to HEAD when detached", async () => {
    const dir = await repo("dev-trunk")
    await git(["checkout", "-q", "--detach"], dir)
    expect(await detectBaseRef(dir)).toEqual({ ref: "HEAD", source: "current-branch" })
  })

  test("returns undefined for a repo with no commits", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-detect-base-"))
    dirs.push(dir)
    await git(["init", "-q"], dir)
    expect(await detectBaseRef(dir)).toBeUndefined()
  })

  test("returns undefined outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-detect-base-"))
    dirs.push(dir)
    expect(await detectBaseRef(dir)).toBeUndefined()
  })
})

describe("initializeRepoWithInitialCommit", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function tmpRepoDir() {
    const dir = await mkdtemp(join(tmpdir(), "convoy-init-repo-"))
    dirs.push(dir)
    return dir
  }

  async function gitOutput(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    const exitCode = await proc.exited
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
    return stdout.trim()
  }

  test("detects a directory without a git repository", async () => {
    const dir = await tmpRepoDir()
    expect(await repoBootstrapStatus(dir)).toBe("no-repo")
  })

  test("initializes a new repository with an empty initial commit", async () => {
    const dir = await tmpRepoDir()

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await repoBootstrapStatus(dir)).toBe("ready")
    expect(await gitOutput(["branch", "--show-current"], dir)).toBe("main")
    expect(await gitOutput(["log", "-1", "--format=%s"], dir)).toBe("convoy: initial commit")
    await expect(ensureRepoReady(dir, { baseRef: "main" })).resolves.toBeUndefined()
  })

  test("includes existing project files in the initial commit", async () => {
    const dir = await tmpRepoDir()
    await writeFile(join(dir, "README.md"), "hello\n")

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await gitOutput(["show", "--format=", "--name-only", "HEAD"], dir)).toBe("README.md")
    expect(await gitOutput(["status", "--porcelain"], dir)).toBe("")
  })

  test("creates an initial commit for a repository with no commits", async () => {
    const dir = await tmpRepoDir()
    await gitOutput(["init", "-q", "-b", "main"], dir)

    expect(await repoBootstrapStatus(dir)).toBe("no-commits")
    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })
    expect(await repoBootstrapStatus(dir)).toBe("ready")
  })

  test("creates the initial commit on the requested base branch", async () => {
    const dir = await tmpRepoDir()
    await gitOutput(["init", "-q", "-b", "master"], dir)

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await gitOutput(["branch", "--show-current"], dir)).toBe("main")
    await expect(ensureRepoReady(dir, { baseRef: "main" })).resolves.toBeUndefined()
  })

  test("refuses to create an initial commit with likely secrets", async () => {
    const dir = await tmpRepoDir()
    await writeFile(join(dir, ".env"), "TOKEN=secret\n")

    await expect(initializeRepoWithInitialCommit(dir, { baseRef: "main" })).rejects.toThrow(/look like secrets/)
    expect(await repoBootstrapStatus(dir)).toBe("no-commits")
  })
})

describe("unsigned commits", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: process.env })
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
    return stdout.trim()
  }

  /**
   * A repo whose config demands a signature it can never produce: /usr/bin/false
   * stands in for a 1Password/gpg-agent prompt nobody answers during an
   * unattended run. Any commit Convoy makes without --no-gpg-sign dies here.
   */
  async function repoThatCannotSign(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-unsigned-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", "main"], dir)
    await git(["config", "user.name", "convoy-test"], dir)
    await git(["config", "user.email", "convoy-test@example.invalid"], dir)
    await git(["config", "commit.gpgsign", "true"], dir)
    await git(["config", "gpg.format", "ssh"], dir)
    await git(["config", "user.signingkey", join(dir, "nonexistent.pub")], dir)
    await git(["config", "gpg.ssh.program", "/usr/bin/false"], dir)
    return dir
  }

  test("initializeRepoWithInitialCommit commits when the repo config forces signing", async () => {
    const dir = await repoThatCannotSign()
    await writeFile(join(dir, "README.md"), "hello\n")

    await initializeRepoWithInitialCommit(dir, { baseRef: "main" })

    expect(await repoBootstrapStatus(dir)).toBe("ready")
    expect(await git(["log", "-1", "--format=%s"], dir)).toBe("convoy: initial commit")
  })

  test("addAllAndCommit commits when the repo config forces signing", async () => {
    const dir = await repoThatCannotSign()
    await git(["commit", "-q", "--allow-empty", "-m", "base"], dir)
    await writeFile(join(dir, "feature.ts"), "export const feature = true\n")

    expect(await addAllAndCommit("convoy(implement): add feature", dir)).toBe(true)

    expect(await git(["log", "-1", "--format=%s"], dir)).toBe("convoy(implement): add feature")
    expect(await git(["log", "-1", "--format=%an <%ae>"], dir)).toBe("convoy <convoy@local>")
    // %G? is "N" for an unsigned commit; anything else means we tried to sign.
    expect(await git(["log", "-1", "--format=%G?"], dir)).toBe("N")
    expect(await git(["status", "--porcelain"], dir)).toBe("")
  })
})

describe("addWorktree", () => {
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

  test("branchExists tells a taken branch name from a free one", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-branch-exists-"))
    dirs.push(repo)

    await git(["init", "-q"], repo)
    await writeFile(join(repo, "README.md"), "base\n")
    await git(["add", "README.md"], repo)
    await git(["commit", "-q", "-m", "init"], repo)
    await git(["branch", "feat/add-onboarding"], repo)

    expect(await branchExists("feat/add-onboarding", repo)).toBe(true)
    expect(await branchExists("feat/add-onboarding-2", repo)).toBe(false)
    expect(await branchExists("", repo)).toBe(false)
  })

  test("creates a branch checked out in a separate worktree", async () => {
    const repo = await mkdtemp(join(tmpdir(), "convoy-worktree-repo-"))
    const worktree = await mkdtemp(join(tmpdir(), "convoy-worktree-dir-"))
    await rm(worktree, { recursive: true, force: true })
    dirs.push(repo, worktree)

    await git(["init", "-q"], repo)
    await writeFile(join(repo, "README.md"), "base\n")
    await git(["add", "README.md"], repo)
    await git(["commit", "-q", "-m", "init"], repo)

    await addWorktree(worktree, "add-onboarding-flow", "HEAD", repo)

    expect(await readFile(join(worktree, "README.md"), "utf8")).toBe("base\n")
    const branch = Bun.spawn(["git", "branch", "--show-current"], { cwd: worktree, stdout: "pipe", stderr: "pipe" })
    expect((await new Response(branch.stdout).text()).trim()).toBe("add-onboarding-flow")
    expect(await branch.exited).toBe(0)
  })
})

describe("diffTotals", () => {
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
    const stdout = await new Response(proc.stdout).text()
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
    return stdout.trim()
  }

  async function repo(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "convoy-difftotals-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", "main"], dir)
    await writeFile(join(dir, "base.txt"), "line1\nline2\nline3\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-q", "-m", "initial"], dir)
    return dir
  }

  test("returns undefined when the range is empty (no diff)", async () => {
    const dir = await repo()
    const head = await git(["rev-parse", "HEAD"], dir)
    expect(await diffTotals(head, head, dir)).toBeUndefined()
  })

  test("counts insertions for a new file", async () => {
    const dir = await repo()
    const base = await git(["rev-parse", "HEAD"], dir)
    await writeFile(join(dir, "new.ts"), "export const x = 1\nexport const y = 2\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-q", "-m", "add new file"], dir)
    const head = await git(["rev-parse", "HEAD"], dir)

    const result = await diffTotals(base, head, dir)
    expect(result).toEqual({ files: 1, insertions: 2, deletions: 0 })
  })

  test("counts deletions for a removed file", async () => {
    const dir = await repo()
    const base = await git(["rev-parse", "HEAD"], dir)
    await git(["rm", "base.txt"], dir)
    await git(["commit", "-q", "-m", "remove file"], dir)
    const head = await git(["rev-parse", "HEAD"], dir)

    const result = await diffTotals(base, head, dir)
    expect(result).toEqual({ files: 1, insertions: 0, deletions: 3 })
  })

  test("counts both insertions and deletions for a modified file", async () => {
    const dir = await repo()
    const base = await git(["rev-parse", "HEAD"], dir)
    await writeFile(join(dir, "base.txt"), "line1\nline2\nnew-line\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-q", "-m", "modify file"], dir)
    const head = await git(["rev-parse", "HEAD"], dir)

    const result = await diffTotals(base, head, dir)
    expect(result).toEqual({ files: 1, insertions: 1, deletions: 1 })
  })

  test("aggregates multiple files in the same commit", async () => {
    const dir = await repo()
    const base = await git(["rev-parse", "HEAD"], dir)
    await writeFile(join(dir, "a.ts"), "const a = 1\n")
    await writeFile(join(dir, "b.ts"), "const b = 2\nconst c = 3\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-q", "-m", "add two files"], dir)
    const head = await git(["rev-parse", "HEAD"], dir)

    const result = await diffTotals(base, head, dir)
    expect(result).toEqual({ files: 2, insertions: 3, deletions: 0 })
  })

  test("counts binary file as 1 file with 0 lines", async () => {
    const dir = await repo()
    const base = await git(["rev-parse", "HEAD"], dir)
    // Write a proper binary with null bytes; git treats null-byte files as binary.
    const binaryContent = new Uint8Array(16)
    binaryContent[0] = 0x00 // null byte forces git to detect binary
    binaryContent[1] = 0x89
    binaryContent[2] = 0x50
    binaryContent[3] = 0x4e
    binaryContent[4] = 0x47
    binaryContent.fill(0x00, 5) // rest are null bytes
    await Bun.write(join(dir, "image.bin"), binaryContent)
    await git(["add", "-A"], dir)
    await git(["commit", "-q", "-m", "add binary"], dir)
    const head = await git(["rev-parse", "HEAD"], dir)

    const result = await diffTotals(base, head, dir)
    expect(result).toEqual({ files: 1, insertions: 0, deletions: 0 })
  })

  test("returns undefined when git cannot resolve the range", async () => {
    const dir = await repo()
    expect(await diffTotals("nonexistent-sha", "HEAD", dir)).toBeUndefined()
  })

  test("handles file renames correctly", async () => {
    const dir = await repo()
    const base = await git(["rev-parse", "HEAD"], dir)
    await git(["mv", "base.txt", "renamed.txt"], dir)
    await git(["commit", "-q", "-m", "rename base.txt to renamed.txt"], dir)
    const head = await git(["rev-parse", "HEAD"], dir)

    const result = await diffTotals(base, head, dir)
    expect(result).toEqual({ files: 1, insertions: 0, deletions: 0 })
  })

  test("handles a single-commit range correctly", async () => {
    const dir = await repo()
    const base = await git(["rev-parse", "HEAD"], dir)
    await writeFile(join(dir, "feat.ts"), "export const feature = true\n")
    await git(["add", "-A"], dir)
    await git(["commit", "-q", "-m", "add feature"], dir)
    const head = await git(["rev-parse", "HEAD"], dir)

    const result = await diffTotals(base, head, dir)
    expect(result).toBeDefined()
    expect(result?.files).toBe(1)
    expect(result?.insertions).toBeGreaterThan(0)
    expect(result?.deletions).toBe(0)
  })
})
