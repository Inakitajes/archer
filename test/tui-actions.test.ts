import { describe, expect, test } from "bun:test"

import { comparePaletteActions, dashboardActions, shortcutGroupOrder, type Action, type ActionID, type DashboardActionState } from "../src/tui-actions"

function state(overrides: Partial<DashboardActionState> = {}): DashboardActionState {
  return {
    finished: false,
    observer: false,
    contentFocused: false,
    selectedGroup: false,
    fullscreen: false,
    contentTab: "session",
    permissionPending: false,
    reviewCanRetry: false,
    ctrlC: "abort",
    controlState: "running",
    canPause: true,
    canKeepAwake: true,
    canBackground: true,
    finishSeam: true,
    interactiveArmed: false,
    reportCopyable: false,
    autoAccept: "off",
    keepAwake: "off",
    ...overrides,
  }
}

const available = (overrides: Partial<DashboardActionState> = {}): ActionID[] =>
  dashboardActions(state(overrides))
    .filter((action) => action.available)
    .map((action) => action.id)

/** What the palette can actually run, in the order it lists them. */
const commands = (overrides: Partial<DashboardActionState> = {}): ActionID[] =>
  dashboardActions(state(overrides))
    .filter((action) => action.available && action.label !== undefined)
    .sort(comparePaletteActions)
    .map((action) => action.id)

const footer = (overrides: Partial<DashboardActionState> = {}): ActionID[] =>
  dashboardActions(state(overrides))
    .filter((action) => action.available && action.hint !== undefined && action.keys !== undefined)
    .map((action) => action.id)

describe("dashboard action registry", () => {
  test("ids are unique, so the palette can dispatch on them", () => {
    const ids = dashboardActions(state()).map((action) => action.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("every group in the catalog has a place in the shortcuts view", () => {
    const groups = new Set(dashboardActions(state()).map((action) => action.group))
    for (const group of groups) expect(shortcutGroupOrder).toContain(group)
  })

  test("a live run offers the run controls", () => {
    expect(commands()).toEqual(["keep-awake", "pause", "permissions", "interactive", "usage", "background", "session", "fullscreen", "tab-session", "tab-reports", "tab-logs", "tab-advisor", "help"])
  })

  test("an attached observer cannot pause, keep awake, or take over", () => {
    const ids = commands({ observer: true })
    expect(ids).not.toContain("pause")
    expect(ids).not.toContain("keep-awake")
    expect(ids).not.toContain("interactive")
    expect(ids).toContain("session")
  })

  test("keep-awake disappears where caffeinate does not exist", () => {
    expect(commands({ canKeepAwake: false, keepAwake: "unavailable" })).not.toContain("keep-awake")
  })

  test("pause disappears when the runner wired no toggle", () => {
    expect(commands({ canPause: false })).not.toContain("pause")
  })

  test("background disappears when the host wired no handler", () => {
    // A bare in-process dashboard (smoke script, tests) has nothing to release
    // the terminal to; offering the command would dispatch into a no-op.
    expect(commands({ canBackground: false })).not.toContain("background")
  })

  test("a menu-opened controller detaches with ctrl+c and keeps abort behind the palette confirm", () => {
    const detach = state({ ctrlC: "detach" })
    const abort = dashboardActions(detach).find((action) => action.id === "abort")!
    expect(abort.hint).toBe("detach")
    // The full phrase is the list item; Enter on it opens the y/n modal.
    expect(abort.label).toBe("Abort the run")
    // The first-attach dashboard keeps abort on ctrl+c and out of the palette.
    const first = dashboardActions(state({ ctrlC: "abort" })).find((action) => action.id === "abort")!
    expect(first.hint).toBe("abort")
    expect(first.label).toBeUndefined()
  })

  test("a menu-opened observer is never offered the palette abort", () => {
    // An observer's ctrl+c only detaches — offering "Abort the run" would be
    // an abort that cannot abort (and must never become one).
    const abort = dashboardActions(state({ ctrlC: "detach", observer: true })).find((action) => action.id === "abort")!
    expect(abort.hint).toBe("detach")
    expect(abort.label).toBeUndefined()
    expect(abort.detail).toBeUndefined()
  })

  // The bug this registry exists to kill: the finish screen used to gate every
  // action behind `!finished`, so its palette offered one entry ("Keyboard
  // shortcuts") while five real actions sat live on the keyboard.
  test("the finish screen offers its own actions, not just the help entry", () => {
    const ids = commands({ finished: true })
    expect(ids).toContain("iterate")
    expect(ids).toContain("lazygit")
    expect(ids).toContain("finish")
    expect(ids).toContain("close")
    expect(ids).toContain("session")
    expect(ids.length).toBeGreaterThan(5)
  })

  test("a finished run without a finish seam cannot squash", () => {
    expect(commands({ finished: true, finishSeam: false })).not.toContain("finish")
  })

  test("a finished run drops the live-only controls", () => {
    const ids = commands({ finished: true })
    expect(ids).not.toContain("pause")
    expect(ids).not.toContain("interactive")
    expect(ids).not.toContain("permissions")
  })

  test("all four content tabs are reachable, matching the digit keys", () => {
    const keys = dashboardActions(state())
      .filter((action) => action.id.startsWith("tab-") && action.id !== "tab-cycle")
      .map((action) => action.keys)
    expect(keys).toEqual(["1", "2", "3", "4"])
  })

  test("aborting is documented but never runnable from the palette", () => {
    const abort = dashboardActions(state()).find((action) => action.id === "abort")!
    expect(abort.available).toBe(true)
    expect(abort.help).toBeDefined()
    // Typing "a" and hitting enter must not be able to kill a run.
    expect(abort.label).toBeUndefined()
  })

  test("the reader swaps select for scroll rather than offering both", () => {
    expect(available({ contentFocused: true })).toContain("scroll")
    expect(available({ contentFocused: true })).not.toContain("select")
    expect(available()).toContain("select")
    expect(available()).not.toContain("scroll")
    expect(footer({ contentFocused: true })).toContain("scroll")
    expect(footer()).not.toContain("scroll")
  })

  test("arrows, enter, and tab-cycle stay out of the footer", () => {
    expect(footer()).not.toContain("select")
    expect(footer()).not.toContain("read")
    expect(footer()).not.toContain("tab-cycle")
    expect(available()).toContain("select")
    expect(available()).toContain("read")
    expect(available()).toContain("tab-cycle")
  })

  test("lazygit is withdrawn while reading, where [g] jumps to the top instead", () => {
    expect(available({ finished: true })).toContain("lazygit")
    expect(available({ finished: true, contentFocused: true })).not.toContain("lazygit")
  })

  test("a group selection withdraws the single-session keys", () => {
    const ids = available({ selectedGroup: true })
    expect(ids).not.toContain("session")
    expect(ids).not.toContain("fullscreen")
    expect(ids).toContain("select")
    expect(footer({ selectedGroup: true })).not.toContain("session")
    expect(footer({ selectedGroup: true })).not.toContain("fullscreen")
  })

  test("a permission prompt owns the row instead of sharing it with navigation", () => {
    // shift+tab rides along at the end because it is checked before the queue
    // and answers the prompt by flushing it, exactly as the old row read.
    expect(footer({ permissionPending: true })).toEqual([
      "permission-choose",
      "permission-confirm",
      "permission-inspect",
      "permission-explain",
      "permission-once",
      "permission-always",
      "permission-reject",
      "permission-escape",
      "permission-auto-accept",
    ])
  })

  test("[MF-1] permission takes precedence when a review gate is also waiting", () => {
    // [a] always allows a permission before it can abort the review gate, so
    // review actions must not be advertised in this combined state.
    expect(footer({ permissionPending: true, humanReviewGate: "review" })).toEqual([
      "permission-choose",
      "permission-confirm",
      "permission-inspect",
      "permission-explain",
      "permission-once",
      "permission-always",
      "permission-reject",
      "permission-escape",
      "permission-auto-accept",
    ])
  })

  test("a review gate owns the row too", () => {
    expect(footer({ humanReviewGate: "review" })).toEqual(["review-continue", "review-open", "review-abort"])
  })

  test("a failure gate swaps continue for retry, offered only when a baseline exists", () => {
    // [c] is never offered on a failure gate: taking control via [o] is the only
    // safe way forward. [r] appears only when canRetry (a baseline snapshot).
    expect(available({ humanReviewGate: "failure", reviewCanRetry: true })).not.toContain("review-continue")
    expect(available({ humanReviewGate: "failure", reviewCanRetry: true })).toContain("review-retry")
    expect(available({ humanReviewGate: "failure", reviewCanRetry: true })).toContain("review-open")
    expect(available({ humanReviewGate: "failure", reviewCanRetry: true })).toContain("review-abort")
    expect(available({ humanReviewGate: "failure", reviewCanRetry: false })).not.toContain("review-retry")
    expect(available({ humanReviewGate: "interactive", reviewCanRetry: true })).toContain("review-continue")
    expect(available({ humanReviewGate: "interactive", reviewCanRetry: true })).not.toContain("review-retry")
  })

  test("a budget gate offers only reset and abort", () => {
    const ids = available({ humanReviewGate: "budget-gate" })
    expect(ids).toContain("review-reset")
    expect(ids).toContain("review-abort")
    expect(ids).not.toContain("review-continue")
    expect(ids).not.toContain("review-open")
    expect(ids).not.toContain("review-retry")
  })

  test("[MF-2] the focused reader keeps session available to the palette but not its footer", () => {
    expect(commands({ contentFocused: true })).toContain("session")
    expect(footer({ contentFocused: true })).not.toContain("session")
  })

  test("the copy key exists only in the fullscreen reports reader", () => {
    expect(available({ fullscreen: true, contentTab: "reports", reportCopyable: true })).toContain("copy-report")
    expect(available({ fullscreen: true, contentTab: "logs", reportCopyable: true })).not.toContain("copy-report")
    expect(available({ contentTab: "reports", reportCopyable: true })).not.toContain("copy-report")
  })

  test("the palette hint stays pinned at priority zero", () => {
    const commandsAction = dashboardActions(state()).find((action) => action.id === "commands")!
    expect(commandsAction.priority).toBe(0)
  })

  test("every documented action carries a key and a description", () => {
    const documented = dashboardActions(state()).filter((action: Action) => action.help !== undefined)
    for (const action of documented) {
      expect(action.keys, `${action.id} is documented without a key`).toBeDefined()
      expect(action.help!.length).toBeGreaterThan(0)
    }
  })

  test("keyboard shortcuts sorts last, however many commands appear", () => {
    expect(commands().at(-1)).toBe("help")
    expect(commands({ finished: true }).at(-1)).toBe("help")
  })
})
