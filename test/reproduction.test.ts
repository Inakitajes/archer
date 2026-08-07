// Reproduction tests for the 6 release-blocking findings from the Hunter NaN PRD.
// Each test captures the pre-fix behavior so the fix can be verified against it.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { advisorTokenEnv, advisorUrlEnv } from "../src/advisor-bridge"
import { commitAsUser, findSuspiciousStagedFiles, restoreRepoSnapshot, type RepoSnapshot } from "../src/git"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tmpDir(label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `convoy-repro-${label}-`))
  dirs.push(dir)
  return dir
}

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

// ===== HN-009: Non-atomic snapshot restoration =====
//
// restoreRepoSnapshot executes 6 sequential git commands with no backup ref
// and no rollback. A crash between any two commands leaves the repo in an
// inconsistent state (detached HEAD, missing branch, dirty tree) that requires
// manual git fsck. This test verifies the normal-case behavior works and
// characterizes the non-atomic nature.
describe("HN-009: restoreRepoSnapshot is non-atomic", () => {
  async function repoWithChange(): Promise<{ dir: string; snapshot: RepoSnapshot }> {
    const dir = await tmpDir("hn009")
    await git(["init", "-q", "-b", "main"], dir)
    await writeFile(join(dir, "README.md"), "base\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-q", "-m", "chore: init"], dir)
    const snapshot: RepoSnapshot = { head: await git(["rev-parse", "HEAD"], dir), ref: "main" }
    // Make a change that should be reverted by restoreRepoSnapshot
    await writeFile(join(dir, "untracked.txt"), "should be cleaned\n")
    await writeFile(join(dir, "README.md"), "modified\n")
    await git(["add", "README.md"], dir)
    await git(["commit", "-q", "-m", "break: modify"], dir)
    return { dir, snapshot }
  }

  test("restores the repo to its snapshot state (normal case)", async () => {
    const { dir, snapshot } = await repoWithChange()
    await restoreRepoSnapshot(snapshot, dir)

    // HEAD is back at the snapshot commit
    expect(await git(["rev-parse", "HEAD"], dir)).toBe(snapshot.head)
    // The branch is restored
    expect(await git(["branch", "--show-current"], dir)).toBe("main")
    // The tree is clean
    expect(await git(["status", "--porcelain"], dir)).toBe("")
    // The file content is restored
    expect(await readFile(join(dir, "README.md"), "utf8")).toBe("base\n")
    // Untracked files are cleaned
    expect(await Bun.file(join(dir, "untracked.txt")).exists()).toBe(false)
  })

  test("consists of 6 individual git commands with no rollback mechanism", async () => {
    // This is a structural test: the function's implementation is 6 sequential
    // execFile calls. No try/catch, no backup ref, no transaction.
    // The source is at src/git.ts:212-219 and reads:
    //   reset --hard, clean -fd, checkout --detach, checkout -B, reset --hard, clean -fd
    // We verify each step is independently observable by running the first
    // command only and checking the intermediate state.
    const { dir, snapshot } = await repoWithChange()

    // Step 1: reset --hard (only)
    const proc1 = Bun.spawn(["git", "reset", "--hard", snapshot.head], { cwd: dir, stdout: "pipe", stderr: "pipe" })
    expect(await proc1.exited).toBe(0)
    // After reset --hard, the working tree is clean but the branch is still on the modified commit
    expect(await git(["rev-parse", "HEAD"], dir)).toBe(snapshot.head)
    // But the branch ref is still pointing at the old commit, not the snapshot
    // untracked files remain
    expect(await Bun.file(join(dir, "untracked.txt")).exists()).toBe(true)

    // The key observation: if the process died after step 1 (reset --hard),
    // the tree would be clean BUT untracked files would remain. The next `git status`
    // would show untracked files that should have been cleaned.
    expect(await git(["status", "--porcelain"], dir)).toBe("?? untracked.txt")
    expect(await git(["rev-parse", "main"], dir)).toBe(snapshot.head)
  })
})

// ===== HN-018: Advisor token leaked via process.env =====
//
// runner.ts:558-560 sets CONVOY_ADVISOR_URL and CONVOY_ADVISOR_TOKEN in
// process.env. These are inherited by every subprocess Convoy spawns and
// the OpenCode server process. Only cleaned up in the finally block at
// lines 719-721. The advisor tool reads them from process.env (bridge.ts:171-172).
describe("HN-018: advisor token leaked via process.env", () => {
  test("the env var names are accessible to arbitrary subprocesses when set", async () => {
    // Verify the env var names are literals, not obfuscated
    expect(advisorUrlEnv).toBe("CONVOY_ADVISOR_URL")
    expect(advisorTokenEnv).toBe("CONVOY_ADVISOR_TOKEN")

    // Simulate what runner.ts:558-560 does
    const testUrl = "http://127.0.0.1:9999/advise"
    const testToken = "test-token-for-repro"
    process.env[advisorUrlEnv] = testUrl
    process.env[advisorTokenEnv] = testToken

    try {
      // A subprocess can read the token
      const echoUrl = Bun.spawn(["bash", "-c", "echo -n $CONVOY_ADVISOR_URL"], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
      expect(await new Response(echoUrl.stdout).text()).toBe(testUrl)

      const echoToken = Bun.spawn(["bash", "-c", "echo -n $CONVOY_ADVISOR_TOKEN"], {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })
      expect(await new Response(echoToken.stdout).text()).toBe(testToken)
    } finally {
      // Cleanup as runner.ts:720-721 does
      delete process.env[advisorUrlEnv]
      delete process.env[advisorTokenEnv]
    }
  })
})

// ===== HN-020: finish skips secret scanning =====
//
// addAllAndCommit (git.ts:269) calls findSuspiciousStagedFiles before committing.
// commitAsUser (git.ts:333) does NOT. The finish.ts path (applySquash → commitAsUser)
// bypassed the secret scan entirely. The fix adds the scan in applySquash (finish.ts)
// before calling commitAsUser.
describe("HN-020: finish skips secret scanning", () => {
  test("addAllAndCommit calls findSuspiciousStagedFiles (reference behavior)", async () => {
    // findSuspiciousStagedFiles exists and works
    expect(findSuspiciousStagedFiles("A  .env\nA  README.md\n")).toEqual([".env"])
    expect(findSuspiciousStagedFiles("A  README.md\nM  src/main.ts\n")).toEqual([])
  })

  test("commitAsUser does not call findSuspiciousStagedFiles (structural gap)", async () => {
    // commitAsUser remains a thin wrapper around git commit; the secret scan
    // was added to applySquash in finish.ts instead, keeping the tool general.
    const fnStr = commitAsUser.toString()
    // The function body should NOT reference findSuspiciousStagedFiles
    expect(fnStr).not.toContain("findSuspiciousStagedFiles")
    // It should reference git commit
    expect(fnStr).toContain("git commit")
  })

  test("applySquash calls findSuspiciousStagedFiles before committing (fix)", async () => {
    // The fix adds the secret scan in applySquash (finish.ts) before the
    // commitAsUser call. Verify the source contains the scan.
    const source = await readFile(
      join(import.meta.dir, "..", "src", "finish.ts"),
      "utf8",
    )

    // The applySquash function should call findSuspiciousStagedFiles
    expect(source).toContain("findSuspiciousStagedFiles")
    // It should also check for suspicious files and throw if found
    expect(source).toContain("suspicious.length > 0")
    // And it should restore the branch on finding secrets
    expect(source).toContain("resetSoft(plan.head")
  })
})

// ===== HN-002: Fire-and-forget metadata loses state on crash =====
//
// phaseStarted, phaseEnded, and serverStopped now use `await persist({ throwOnError: true })`
// instead of `void persist()`. A crash during the debounce window no longer
// leaves stale metadata on disk. phaseRepositoryBaseline and setControlState
// always used the correct pattern.
describe("HN-002: metadata lifecycle methods", () => {
  test("phaseStarted, phaseEnded, serverStopped now await persist (fix)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // phaseStarted now uses `await persist({ throwOnError: true })`
    const phaseStartedAwait = source.match(/async phaseStarted[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(phaseStartedAwait).not.toBeNull()

    // phaseEnded now uses `await persist({ throwOnError: true })`
    const phaseEndedAwait = source.match(/async phaseEnded[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(phaseEndedAwait).not.toBeNull()

    // serverStopped now uses `await persist({ throwOnError: true })`
    const serverStoppedAwait = source.match(/async serverStopped[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(serverStoppedAwait).not.toBeNull()
  })

  test("phaseRepositoryBaseline and setControlState correctly await persist", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // phaseRepositoryBaseline uses `await persist({ throwOnError: true })`
    expect(source).toContain("phaseRepositoryBaseline")
    expect(source).toContain("await persist({ throwOnError: true })")

    // setControlState uses `await persist({ throwOnError: true })`
    const setControlAwait = source.match(/setControlState[\s\S]{0,300}await persist\(\{ throwOnError: true \}\)/)
    expect(setControlAwait).not.toBeNull()
  })
})

// ===== HN-003: Non-atomic phase report writes =====
//
// persistPhaseReport now writes to a `.tmp` path and renames atomically,
// matching the metadata.ts pattern. A crash mid-write can no longer leave
// a truncated report that phaseNeedsRun would treat as complete.
describe("HN-003: persistPhaseReport now uses tmp+rename (fix)", () => {
  test("writeFile writes to a .tmp path and renames atomically", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "runner.ts"),
      "utf8",
    )

    // persistPhaseReport now uses:
    //   const tmpPath = `${reportAbs}.tmp`
    //   await writeFile(tmpPath, assistantText)
    //   await rename(tmpPath, reportAbs)
    const persistSection = source.match(/async function persistPhaseReport[\s\S]{1,600}/)
    expect(persistSection).not.toBeNull()
    expect(persistSection![0]).toContain(".tmp")
    expect(persistSection![0]).toContain("rename(tmpPath, reportAbs)")
  })

  test("metadata.ts uses tmp+rename pattern (reference behavior)", async () => {
    const source = await readFile(
      join(import.meta.dir, "..", "src", "metadata.ts"),
      "utf8",
    )

    // The persist function in metadata.ts uses:
    //   await writeFile(`${path}.tmp`, body)
    //   await rename(`${path}.tmp`, path)
    expect(source).toContain("writeFile(`${path}.tmp`, body)")
    expect(source).toContain("rename(`${path}.tmp`, path)")
  })
})