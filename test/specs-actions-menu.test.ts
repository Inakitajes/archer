import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTestRenderer } from "@opentui/core/testing"

import { SpecsBrowser } from "../src/specs-browser"
import type { LifecycleFeatureRow, SpecsChangeEntry, SpecsView } from "../src/specs"

/**
 * The dispatchable Actions menu (task 6.4, SC-3): close review is reachable
 * from root and ordinary detail — including when the worktree is gone —
 * blocked actions stay inspectable with their reasons, and footer truncation
 * keeps the discoverable `! actions` entry.
 */

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: name,
    number: false,
    raw: name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-specs-actions-"))
  const dir = join(root, "openspec", "changes", "add-widget")
  const specsDir = join(root, "openspec", "specs", "cli")
  await mkdir(dir, { recursive: true })
  await mkdir(specsDir, { recursive: true })
  await writeFile(join(dir, "proposal.md"), "# Add widget\n")
  await writeFile(join(dir, "tasks.md"), "- [x] one\n")
  await writeFile(join(specsDir, "spec.md"), "# Cli spec\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The change fixture and its registered feature row; `overrides` shapes the lifecycle facts per test. */
function changeEntry(): SpecsChangeEntry {
  return {
    kind: "change",
    id: "add-widget",
    title: "Add widget",
    artifacts: [{ section: "proposal", file: join(root, "openspec", "changes", "add-widget", "proposal.md") }],
  }
}

function featureRow(overrides: Partial<LifecycleFeatureRow> = {}): LifecycleFeatureRow {
  return {
    featureId: "11111111-2222-3333-4444-555555555555",
    displayName: "add-widget",
    branch: "feat/add-widget",
    summary: "Ready to close",
    blockers: [],
    tasks: { done: 2, total: 2 },
    liveRuns: 0,
    integration: "pending",
    contracts: [{ changeId: "add-widget", state: "active" }],
    actions: [
      { id: "close", label: "Close review", enabled: true, blockers: [] },
      { id: "continue", label: "Continue implementation", enabled: true, blockers: [] },
      { id: "history", label: "Open history", enabled: true, blockers: [] },
    ],
    ...overrides,
  }
}

function viewWith(feature: LifecycleFeatureRow, width = 120): SpecsView {
  return { targetDir: root, present: true, changes: [changeEntry()], specs: [], features: [feature] }
}

async function openBrowser(view: SpecsView, width = 120, height = 40) {
  const testRenderer = await createTestRenderer({ width, height })
  const instance = new SpecsBrowser(testRenderer.renderer, view)
  await testRenderer.renderOnce()
  return {
    ...testRenderer,
    instance,
    press(key: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(key, options))
    },
  }
}

async function close(session: Awaited<ReturnType<typeof openBrowser>>) {
  session.press("c", { ctrl: true })
  await session.instance.result.catch(() => {})
}

/** The first selectable row is the feature row (Features leads the board). */
async function selectFeatureRow(session: Awaited<ReturnType<typeof openBrowser>>) {
  // Rows start past headers; with one feature the cursor already sits on it.
}

test("! opens the Actions menu on a feature row and Enter dispatches close review by feature id", async () => {
  const session = await openBrowser(viewWith(featureRow()))
  await selectFeatureRow(session)

  session.press("!")
  await session.renderOnce()
  const frame = session.captureCharFrame()
  expect(frame).toContain("Actions — add-widget")
  expect(frame).toContain("Close review")

  session.press("return")
  await expect(session.instance.result).resolves.toEqual({ type: "close-feature", featureId: "11111111-2222-3333-4444-555555555555" })
})

test("x on a worktree-less feature row dispatches close review by identity instead of dying silently", async () => {
  // No checkoutPath: the old close-change handoff required it and no-oped.
  const session = await openBrowser(viewWith(featureRow({ checkoutPath: undefined })))
  await selectFeatureRow(session)

  session.press("x")
  await expect(session.instance.result).resolves.toEqual({ type: "close-feature", featureId: "11111111-2222-3333-4444-555555555555" })
})

test("the ordinary detail view's menu offers the same close action as the root", async () => {
  const session = await openBrowser(viewWith(featureRow()))
  await selectFeatureRow(session)

  // Enter opens the feature's history view (the detail level).
  session.press("return")
  await session.renderOnce()
  session.press("!")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Close review")

  session.press("return")
  await expect(session.instance.result).resolves.toEqual({ type: "close-feature", featureId: "11111111-2222-3333-4444-555555555555" })
})

test("a blocked close review stays inspectable with its blockers and never dispatches", async () => {
  const blocked = featureRow({
    summary: "Implementation complete · blocked",
    actions: [
      { id: "close", label: "Close review", enabled: false, blockers: ["2 live runs are attached to feat/add-widget — wait for or stop them first"], remediation: ["resolve: 2 live runs are attached to feat/add-widget — wait for or stop them first"] },
      { id: "history", label: "Open history", enabled: true, blockers: [] },
    ],
  })
  const session = await openBrowser(viewWith(blocked))

  // The menu starts on the first enabled dispatchable entry (history); move
  // up to the blocked Close review.
  session.press("!")
  await session.renderOnce()
  session.press("up")
  await session.renderOnce()
  const frame = session.captureCharFrame()
  expect(frame).toContain("Close review — blocked")
  expect(frame).toContain("live runs")

  // Enter on the blocked entry must not dispatch anything: the menu stays open.
  session.press("return")
  await session.renderOnce()
  expect(session.captureCharFrame()).toContain("Actions — add-widget")

  // Escape closes the menu; q/q leave the subject and quit.
  session.press("escape")
  await session.renderOnce()
  session.press("q")
  await session.renderOnce()
  session.press("q")
  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})

test("the pinned ! actions hint survives footer truncation in a narrow terminal", async () => {
  const crowded = featureRow({
    actions: [
      { id: "close", label: "Close review", enabled: true, blockers: [] },
      { id: "continue", label: "Continue implementation", enabled: true, blockers: [] },
      { id: "history", label: "Open history", enabled: true, blockers: [] },
      { id: "bind", label: "Rebind context", enabled: false, blockers: ["the worktree for \"feat/add-widget\" moved"], remediation: ["run `convoy feature bind <feature-id> --branch <name> --worktree <path>` from the surviving checkout"] },
    ],
  })
  const session = await openBrowser(viewWith(crowded), 62, 40)

  const frame = session.captureCharFrame()
  // Many hints compete for the narrow footer, but the menu entry is pinned.
  expect(frame).toContain("actions")
  expect(frame).toContain("!")

  // And the menu itself still opens and dispatches.
  session.press("!")
  await session.renderOnce()
  session.press("return")
  await expect(session.instance.result).resolves.toEqual({ type: "close-feature", featureId: "11111111-2222-3333-4444-555555555555" })
})

test("the fullscreen reader keeps its copy keys and never opens the menu", async () => {
  const session = await openBrowser(viewWith(featureRow()))
  await selectFeatureRow(session)

  session.press("return")
  await session.renderOnce()
  session.press("v")
  await session.renderOnce()
  session.press("!")
  await session.renderOnce()
  const frame = session.captureCharFrame()
  expect(frame).toContain("c copy")
  expect(frame).not.toContain("Actions — add-widget")

  session.press("escape")
  await session.renderOnce()
  session.press("q")
  await session.renderOnce()
  session.press("q")
  await expect(session.instance.result).resolves.toEqual({ type: "exit" })
})
