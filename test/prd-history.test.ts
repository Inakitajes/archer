import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { pickPrdHistory, prdHistoryDir, readPrdHistoryIndex, writePrdHistory, type PrdHistoryEntry } from "../src/prd-history"

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

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
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`)
  return stdout.trim()
}

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-prd-history-"))
  dirs.push(dir)
  await git(["init", "-q", "-b", "main"], dir)
  await writeFile(join(dir, "README.md"), "# test\n")
  await git(["add", "README.md"], dir)
  await git(["commit", "-qm", "initial"], dir)
  return dir
}

describe("PRD history", () => {
  test("writes private append-only prompt history without dirtying or cleaning the repository", async () => {
    const dir = await repo()

    await writePrdHistory({ targetDir: dir, runID: "run-1", prompt: "# First PRD\n", pipeline: "implement", branch: "main" })
    await writeFile(join(prdHistoryDir(dir), ".gitignore"), "not ignored\n")
    await writePrdHistory({ targetDir: dir, runID: "run-2", prompt: "# Second PRD\n", pipeline: "review", branch: "main" })

    const history = prdHistoryDir(dir)
    expect(await readFile(join(history, ".gitignore"), "utf8")).toBe("*\n")
    expect(await readFile(join(history, "run-1.prd.md"), "utf8")).toBe("# First PRD\n")
    expect(await readFile(join(history, "run-2.prd.md"), "utf8")).toBe("# Second PRD\n")
    expect((await stat(join(history, "run-1.prd.md"))).mode & 0o777).toBe(0o600)
    // The index records branch/pipeline names; keep it as private as the prompts.
    expect((await stat(join(history, "index.jsonl"))).mode & 0o777).toBe(0o600)

    const entries = await readPrdHistoryIndex(dir)
    expect(entries).toHaveLength(2)
    expect(entries.map(({ runID, pipeline, branch, file }) => ({ runID, pipeline, branch, file }))).toEqual([
      { runID: "run-1", pipeline: "implement", branch: "main", file: "run-1.prd.md" },
      { runID: "run-2", pipeline: "review", branch: "main", file: "run-2.prd.md" },
    ])
    expect(await git(["status", "--porcelain=v1", "--untracked-files=all"], dir)).toBe("")

    await git(["clean", "-fd"], dir)
    expect(await readFile(join(history, "run-1.prd.md"), "utf8")).toBe("# First PRD\n")
    expect(await readFile(join(history, "index.jsonl"), "utf8")).toContain('"runID":"run-2"')
  })

  test("skips malformed index records", async () => {
    const dir = await repo()
    const history = prdHistoryDir(dir)
    await mkdir(history, { recursive: true })
    await Bun.write(join(history, "index.jsonl"), ["not json", JSON.stringify({ runID: "good", pipeline: "implement", branch: "main", timestamp: 1, file: "good.prd.md" }), '{"file":"../escape.prd.md"}'].join("\n"))

    expect(await readPrdHistoryIndex(dir)).toEqual([{ runID: "good", pipeline: "implement", branch: "main", timestamp: 1, file: "good.prd.md" }])
  })

  test("returns an empty index when no history directory exists yet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-prd-history-empty-"))
    dirs.push(dir)
    expect(await readPrdHistoryIndex(dir)).toEqual([])
  })

  test("rejects when the history directory cannot be created, leaving no index", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-prd-history-blocked-"))
    dirs.push(dir)
    // Put a file where the history dir would descend through, so mkdir -p hits
    // ENOTDIR regardless of uid (chmod-to-deny is a no-op for root; ENOTDIR is not).
    await writeFile(join(dir, "blocker"), "not a directory\n")
    await expect(
      writePrdHistory({ targetDir: join(dir, "blocker"), runID: "nope", prompt: "p", pipeline: "implement", branch: "main" }),
    ).rejects.toThrow()
    // The caller (run()) swallows this; confirm no partial index survived.
    expect(await readPrdHistoryIndex(dir)).toEqual([])
  })

  test("picks the oldest existing matching-branch entry, excluding the current run", () => {
    const entries: PrdHistoryEntry[] = [
      { runID: "new", pipeline: "review", branch: "feat/history", timestamp: 30, file: "new.prd.md" },
      { runID: "other-branch", pipeline: "implement", branch: "main", timestamp: 1, file: "other-branch.prd.md" },
      { runID: "missing", pipeline: "implement", branch: "feat/history", timestamp: 2, file: "missing.prd.md" },
      { runID: "old", pipeline: "implement", branch: "feat/history", timestamp: 10, file: "old.prd.md" },
      { runID: "tie-z", pipeline: "implement", branch: "feat/tie", timestamp: 5, file: "tie-z.prd.md" },
      { runID: "tie-a", pipeline: "implement", branch: "feat/tie", timestamp: 5, file: "tie-a.prd.md" },
    ]

    expect(pickPrdHistory([], { branch: "feat/history", fileExists: () => true })).toBeUndefined()
    expect(
      pickPrdHistory(entries, { branch: "feat/history", excludeRunID: "new", fileExists: (entry) => entry.runID !== "missing" }),
    ).toMatchObject({ runID: "old" })
    expect(pickPrdHistory(entries, { branch: "feat/tie", fileExists: () => true })).toMatchObject({ runID: "tie-a" })

    // A detached-HEAD run records no branch and must never be selected: not when
    // the current branch is undefined, and not as a recorded entry shadowing an
    // actual branch match even when its timestamp is the smallest.
    expect(pickPrdHistory(entries, { branch: undefined, fileExists: () => true })).toBeUndefined()
    expect(
      pickPrdHistory(
        [
          { runID: "detached", pipeline: "implement", timestamp: 0, file: "detached.prd.md" },
          { runID: "later", pipeline: "implement", branch: "feat/history", timestamp: 100, file: "later.prd.md" },
        ],
        { branch: "feat/history", fileExists: () => true },
      ),
    ).toMatchObject({ runID: "later" })
  })
})
