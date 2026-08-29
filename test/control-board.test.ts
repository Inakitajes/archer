import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  assembleControlBoard,
  branchForChange,
  hasUncommittedProposal,
  openspecTaskCounts,
  type BoardReads,
  type BoardRun,
  type BoardTasks,
  type BoardWorktree,
} from "../src/control-board"

const cleanupDirs: string[] = []

afterAll(async () => {
  await Promise.all(cleanupDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const mainDir = "/repo"
const worktreeDir = "/wt/feat-add-foo"

function readsFixture(input: {
  worktrees?: BoardWorktree[]
  mainChanges?: string[]
  worktreeChanges?: string[]
  tasks?: Record<string, Record<string, BoardTasks>>
  runs?: BoardRun[]
  status?: Record<string, string>
  synced?: boolean
  cherryClean?: boolean
  baseBranch?: string
  present?: boolean
}): BoardReads {
  const {
    worktrees = [
      { dir: mainDir, branch: "main", main: true },
      { dir: worktreeDir, branch: "feat/add-foo", main: false },
    ],
    mainChanges = [],
    worktreeChanges = ["add-foo"],
    tasks = {},
    runs = [],
    status = {},
    synced = true,
    cherryClean = true,
    baseBranch = "main",
    present = true,
  } = input
  return {
    worktrees: async () => worktrees,
    openspecPresent: async (dir) => (dir === mainDir ? present : worktreeChanges.length > 0),
    changeIds: async (dir) => (dir === mainDir ? mainChanges : worktreeChanges),
    changeTitle: async (_dir, id) => `Title of ${id}`,
    taskCounts: async (dir) => new Map(Object.entries(tasks[dir] ?? {})),
    runs: async () => runs,
    status: async (dir) => status[dir] ?? "",
    contains: async () => synced,
    patchEquivalent: async () => cherryClean,
    baseBranch: async () => baseBranch,
    canonicalSpecs: async () => ["openspec/specs/specs-viewer/spec.md"],
  }
}

describe("branchForChange", () => {
  test("links a worktree branch whose id matches the change id (the shared resolver rule)", () => {
    expect(branchForChange("add-foo", "feat/add-foo")).toBe("feat/add-foo")
    expect(branchForChange("add-foo", "add-foo")).toBe("add-foo")
  })

  test("a renamed branch orphans the linkage so the row degrades without runs", () => {
    expect(branchForChange("add-foo", "feat/add-bar")).toBeUndefined()
    expect(branchForChange("add-foo", undefined)).toBeUndefined()
  })
})

describe("hasUncommittedProposal", () => {
  test("matches the exact proposal path in porcelain output", () => {
    const status = "?? openspec/changes/add-foo/proposal.md\n M src/cli.ts\n"
    expect(hasUncommittedProposal(status, "add-foo")).toBe(true)
    expect(hasUncommittedProposal(status, "add-bar")).toBe(false)
  })

  test("unrelated dirt and other change files never flip the marker", () => {
    expect(hasUncommittedProposal("?? openspec/changes/add-foo/design.md", "add-foo")).toBe(false)
    expect(hasUncommittedProposal("", "add-foo")).toBe(false)
  })
})

describe("assembleControlBoard", () => {
  test("a change in a worktree with two runs, one live, shows implementing", async () => {
    const runs: BoardRun[] = [
      { runID: "r1", branch: "feat/add-foo", live: false },
      { runID: "r2", branch: "feat/add-foo", live: true },
    ]
    const board = await assembleControlBoard(readsFixture({ runs }))
    expect(board.rows).toHaveLength(1)
    const row = board.rows[0]!
    expect(row.stage).toBe("implementing")
    expect(row.runs).toHaveLength(2)
    expect(row.liveRuns).toBe(1)
    expect(row.location).toBe("worktree")
    expect(row.branch).toBe("feat/add-foo")
    expect(row.synced).toBe(true)
  })

  test("a stranded change on main offers its own row", async () => {
    const board = await assembleControlBoard(readsFixture({ worktreeChanges: [], mainChanges: ["add-foo"] }))
    const row = board.rows[0]!
    expect(row.stage).toBe("stranded")
    expect(row.location).toBe("main")
    expect(row.worktreeDir).toBeUndefined()
  })

  test("tasks complete and a clean tree read as ready to close", async () => {
    const board = await assembleControlBoard(
      readsFixture({ tasks: { [worktreeDir]: { "add-foo": { done: 11, total: 11 } } } }),
    )
    expect(board.rows[0]!.stage).toBe("ready")
    expect(board.rows[0]!.tasks).toEqual({ done: 11, total: 11 })
  })

  test("incomplete tasks stay below ready even with runs recorded", async () => {
    const board = await assembleControlBoard(
      readsFixture({
        tasks: { [worktreeDir]: { "add-foo": { done: 8, total: 11 } } },
        runs: [{ runID: "r1", branch: "feat/add-foo", live: false }],
      }),
    )
    expect(board.rows[0]!.stage).toBe("implementing")
  })

  test("unsynced branch that is patch-equivalent reports probably merged", async () => {
    const board = await assembleControlBoard(readsFixture({ synced: false, cherryClean: true }))
    const row = board.rows[0]!
    expect(row.synced).toBe(false)
    expect(row.probablyMerged).toBe(true)
    expect(row.stage).toBe("probably-merged")
  })

  test("unsynced branch that is not patch-equivalent stays implementing", async () => {
    const board = await assembleControlBoard(readsFixture({ synced: false, cherryClean: false }))
    expect(board.rows[0]!.probablyMerged).toBe(false)
  })

  test("a renamed branch degrades the row: no runs, not synced, stranded signals kept", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: worktreeDir, branch: "feat/add-bar", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({ worktrees, runs: [{ runID: "r1", branch: "feat/add-bar", live: false }] }),
    )
    const row = board.rows[0]!
    expect(row.branch).toBeUndefined()
    expect(row.runs).toHaveLength(0)
    expect(row.synced).toBeUndefined()
    expect(row.stage).toBe("proposing")
  })

  test("a worktree with runs but no change dir lands in worktrees-without-spec", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/iso-run", branch: "feat/quick-fix", main: false },
    ]
    const board = await assembleControlBoard(
      readsFixture({
        worktrees,
        worktreeChanges: [],
        runs: [{ runID: "r1", branch: "feat/quick-fix", live: false }],
      }),
    )
    expect(board.rows).toHaveLength(0)
    expect(board.worktreesWithoutSpec).toEqual([{ dir: "/wt/iso-run", branch: "feat/quick-fix", runCount: 1 }])
  })

  test("a worktree with no change dir and no runs is not listed", async () => {
    const worktrees: BoardWorktree[] = [
      { dir: mainDir, branch: "main", main: true },
      { dir: "/wt/empty", branch: "feat/nothing", main: false },
    ]
    const board = await assembleControlBoard(readsFixture({ worktrees, worktreeChanges: [] }))
    expect(board.worktreesWithoutSpec).toHaveLength(0)
  })

  test("the same change id prefers the worktree row over the stranded main copy", async () => {
    const board = await assembleControlBoard(readsFixture({ mainChanges: ["add-foo"] }))
    expect(board.rows).toHaveLength(1)
    expect(board.rows[0]!.location).toBe("worktree")
  })

  test("the uncommitted-proposal marker reflects the change's own checkout", async () => {
    const board = await assembleControlBoard(
      readsFixture({ status: { [worktreeDir]: "?? openspec/changes/add-foo/proposal.md\n" } }),
    )
    expect(board.rows[0]!.uncommittedProposal).toBe(true)
  })

  test("no worktrees at all answers an empty board instead of throwing", async () => {
    const board = await assembleControlBoard(readsFixture({ worktrees: [] }))
    expect(board.present).toBe(false)
    expect(board.rows).toEqual([])
  })

  test("canonical specs and base branch ride along for the view", async () => {
    const board = await assembleControlBoard(readsFixture({}))
    expect(board.specs).toEqual(["openspec/specs/specs-viewer/spec.md"])
    expect(board.baseBranch).toBe("main")
  })

  test("a run on feat/<id> links to the stranded main row even without a worktree", async () => {
    const board = await assembleControlBoard(
      readsFixture({
        worktreeChanges: [],
        mainChanges: ["add-foo"],
        runs: [{ runID: "r1", branch: "feat/add-foo", live: false }],
      }),
    )
    expect(board.rows[0]!.runs).toHaveLength(1)
    expect(board.rows[0]!.stage).toBe("implementing")
  })
})

describe("openspecTaskCounts", () => {
  test("falls back to checkbox parsing when the openspec CLI is absent", async () => {
    // A spawn of a missing binary throws (ENOENT) rather than exiting
    // non-zero; the fallback must still serve, or the whole board join
    // degrades on machines without the CLI.
    const dir = await mkdtemp(join(tmpdir(), "convoy-board-tasks-"))
    cleanupDirs.push(dir)
    const changeDir = join(dir, "openspec", "changes", "add-foo")
    await mkdir(changeDir, { recursive: true })
    await writeFile(join(changeDir, "tasks.md"), "# Tasks\n\n- [x] one\n- [x] two\n- [ ] three\n")

    const originalPath = process.env.PATH
    process.env.PATH = join(dir, "no-bin")
    try {
      const counts = await openspecTaskCounts(dir)
      expect(counts.get("add-foo")).toEqual({ done: 2, total: 3 })
    } finally {
      process.env.PATH = originalPath
    }
  })
})
