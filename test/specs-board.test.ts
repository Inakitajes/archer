import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { SpecsBrowser } from "../src/specs-browser"
import type { FeatureRow, WorktreeWithoutSpec } from "../src/control-board"
import type { SpecsChangeEntry, SpecsResolution, SpecsView } from "../src/specs"

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean; sequence?: string } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: options.sequence ?? name,
    number: false,
    raw: name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

const worktreeDir = "/wt/feat-add-foo"

function featureRow(overrides: Partial<FeatureRow> & { id: string }): FeatureRow {
  return {
    location: "main",
    runs: [],
    liveRuns: 0,
    uncommittedProposal: false,
    probablyMerged: false,
    stage: "stranded",
    ...overrides,
  }
}

function change(id: string, title = id): SpecsChangeEntry {
  return { kind: "change", id, title, artifacts: [] }
}

function viewWith(rows: FeatureRow[], worktreesWithoutSpec: WorktreeWithoutSpec[] = []): SpecsView {
  return {
    present: true,
    changes: rows.map((row) => change(row.id, `Title of ${row.id}`)),
    specs: [],
    rows,
    worktreesWithoutSpec,
  }
}

async function openBoard(view: SpecsView) {
  const testRenderer = await createTestRenderer({ width: 120, height: 40 })
  const instance = new SpecsBrowser(testRenderer.renderer, view, async () => "copied-native")
  await testRenderer.renderOnce()
  return {
    ...testRenderer,
    instance,
    press(key: string, options: { ctrl?: boolean; shift?: boolean; sequence?: string } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(key, options))
    },
  }
}

async function frameOf(view: SpecsView) {
  const session = await openBoard(view)
  try {
    return session.captureCharFrame()
  } finally {
    session.press("c", { ctrl: true })
    await session.instance.result.catch(() => {})
  }
}

/** The only change row's ordinal in the list: 1-based, skipping headers. */
async function selectFirstChange(session: Awaited<ReturnType<typeof openBoard>>) {
  // The first selectable row after the leading header is the first change.
  session.press("g")
  await session.renderOnce()
  session.press("down")
  await session.renderOnce()
}

describe("board rows derive their lifecycle state", () => {
  test("a stranded change on main shows its stage and the worktrees-without-spec section stays a peer", async () => {
    const frame = await frameOf(
      viewWith([featureRow({ id: "add-foo", stage: "stranded" })], [{ dir: "/wt/iso", branch: "feat/quick-fix", runCount: 2 }]),
    )
    expect(frame).toContain("stranded on main")
    expect(frame).toContain("WORKTREES WITHOUT SPEC")
    expect(frame).toContain("feat/quick-fix")
    expect(frame).toContain("2 runs")
    // Sections render in order: changes above worktrees above specs.
    const lines = frame.split("\n")
    const changes = lines.findIndex((line) => line.includes("ACTIVE CHANGES"))
    const worktrees = lines.findIndex((line) => line.includes("WORKTREES WITHOUT SPEC"))
    const specs = lines.findIndex((line) => line.includes("CANONICAL SPECS"))
    expect(changes).toBeGreaterThanOrEqual(0)
    expect(worktrees).toBeGreaterThan(changes)
    expect(specs).toBeGreaterThan(worktrees)
  })

  test("an implementing feature marks the live run and its task counts", async () => {
    const frame = await frameOf(
      viewWith([
        featureRow({
          id: "add-bar",
          location: "worktree",
          worktreeDir,
          branch: "feat/add-bar",
          stage: "implementing",
          tasks: { done: 3, total: 11 },
          runs: [{ runID: "r1", branch: "feat/add-bar", live: false }, { runID: "r2", branch: "feat/add-bar", live: true }],
          liveRuns: 1,
          uncommittedProposal: true,
          synced: false,
        }),
      ]),
    )
    expect(frame).toContain("implementing")
    expect(frame).toContain("3/11")
    // The full run signal lives in the detail pane (the row column truncates).
    expect(frame).toContain("runs: 2 (1 live)")
    expect(frame).toContain("uncommitted")
    expect(frame).toContain("unsynced")
  })

  test("a completed-unarchived change reads ready to close; probably-merged reads honestly", async () => {
    const ready = await frameOf(viewWith([featureRow({ id: "add-baz", stage: "ready", tasks: { done: 11, total: 11 } })]))
    expect(ready).toContain("ready to close")

    const merged = await frameOf(viewWith([featureRow({ id: "old-one", stage: "probably-merged", probablyMerged: true })]))
    expect(merged).toContain("probably merged")
  })
})

describe("row actions route to the right handoff", () => {
  test("s on a stranded row spins it out", async () => {
    const session = await openBoard(viewWith([featureRow({ id: "add-foo", stage: "stranded" })]))
    await selectFirstChange(session)
    session.press("s")
    await expect(session.instance.result).resolves.toEqual({ type: "spin-change", changeID: "add-foo" })
  })

  test("c continues a feature with its worktree and branch", async () => {
    const session = await openBoard(
      viewWith([featureRow({ id: "add-foo", location: "worktree", worktreeDir, branch: "feat/add-foo", stage: "proposing" })]),
    )
    await selectFirstChange(session)
    session.press("c")
    await expect(session.instance.result).resolves.toEqual({ type: "continue-change", changeID: "add-foo", worktreeDir, branch: "feat/add-foo" })
  })

  test("x closes a feature that has a worktree and branch", async () => {
    const session = await openBoard(
      viewWith([featureRow({ id: "add-foo", location: "worktree", worktreeDir, branch: "feat/add-foo", stage: "ready", tasks: { done: 4, total: 4 } })]),
    )
    await selectFirstChange(session)
    session.press("x")
    await expect(session.instance.result).resolves.toEqual({ type: "close-change", changeID: "add-foo", worktreeDir, branch: "feat/add-foo" })
  })

  test("m archives a probably-merged change on main", async () => {
    const session = await openBoard(viewWith([featureRow({ id: "add-foo", stage: "probably-merged", probablyMerged: true })]))
    await selectFirstChange(session)
    session.press("m")
    await expect(session.instance.result).resolves.toEqual({ type: "archive-change-main", changeID: "add-foo" })
  })

  test("actions stay inert on rows they do not apply to", async () => {
    // s on a worktree row does nothing; the browser stays open.
    const session = await openBoard(
      viewWith([featureRow({ id: "add-foo", location: "worktree", worktreeDir, branch: "feat/add-foo", stage: "proposing" })]),
    )
    await selectFirstChange(session)
    session.press("s")
    session.press("m")
    await session.renderOnce()
    expect(session.instance.result).toBeInstanceOf(Promise)
    session.press("c", { ctrl: true })
    await expect(session.instance.result).resolves.toEqual({ type: "exit" })
  })
})

describe("the fullscreen reader stays at the detail level", () => {
  test("v is a no-op at the root level", async () => {
    const session = await openBoard(viewWith([featureRow({ id: "add-foo" })]))
    session.press("v")
    await session.renderOnce()
    // The header is still visible: the reader never opened.
    expect(session.captureCharFrame()).toContain("convoy control")
    session.press("c", { ctrl: true })
    await expect(session.instance.result).resolves.toEqual({ type: "exit" })
  })
})
