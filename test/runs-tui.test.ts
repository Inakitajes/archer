import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { RunsBrowser } from "../src/runs-browser"
import { shortVersion } from "../src/version"

import type { RunEntry } from "../src/runs"

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean; raw?: string } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: name,
    number: false,
    raw: options.raw ?? name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

function sampleRuns(): RunEntry[] {
  return [
    {
      runID: "20250809-100000",
      dir: "/tmp/runs/20250809-100000",
      targetDir: "/repo/first",
      title: "feat: add login",
      status: "completed",
      statusKind: "completed",
      live: false,
      phases: [
        { name: "design", status: "completed", durationMs: 8_000, cost: 0.02 },
        { name: "implement", status: "completed", durationMs: 45_000, cost: 0.15 },
      ],
      cost: 0.17,
    },
    {
      runID: "20250809-110000",
      dir: "/tmp/runs/20250809-110000",
      targetDir: "/repo/second",
      title: "fix: resolve timeout",
      status: "failed",
      statusKind: "failed",
      live: false,
      phases: [{ name: "implement", status: "failed", durationMs: 20_000, cost: 0.08 }],
      cost: 0.08,
    },
    {
      runID: "20250809-120000",
      dir: "/tmp/runs/20250809-120000",
      targetDir: "/repo/live",
      title: "feat: onboarding wizard",
      status: "running",
      statusKind: "incomplete",
      live: true,
      serverUrl: "http://127.0.0.1:34567",
      phases: [{ name: "design", status: "completed" }],
      cost: 0.03,
    },
  ]
}

async function browser(initialIndex = 0) {
  const { renderer } = await createTestRenderer({ width: 120, height: 40 })
  const runs = sampleRuns()
  const instance = new RunsBrowser(renderer, runs, initialIndex)
  return { renderer, runs, result: instance.result }
}

test("keyboard navigation opens the selected run", async () => {
  const { renderer, runs, result } = await browser()

  renderer.keyInput.emit("keypress", keyEvent("j"))
  renderer.keyInput.emit("keypress", keyEvent("return", { raw: "\r" }))

  await expect(result).resolves.toEqual({
    type: "open",
    runID: runs[1]!.runID,
    targetDir: runs[1]!.targetDir,
  })
})

test("o opens the current run", async () => {
  const { renderer, runs, result } = await browser(0)

  renderer.keyInput.emit("keypress", keyEvent("o"))

  await expect(result).resolves.toEqual({
    type: "open",
    runID: runs[0]!.runID,
    targetDir: runs[0]!.targetDir,
  })
})

test("r opens a retry confirmation and y confirms a retry", async () => {
  const { renderer, runs, result } = await browser(2)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  // Arrow keys are ignored while the confirmation modal is up.
  renderer.keyInput.emit("keypress", keyEvent("j"))
  renderer.keyInput.emit("keypress", keyEvent("y"))

  await expect(result).resolves.toEqual({
    type: "retry",
    runID: runs[2]!.runID,
    targetDir: runs[2]!.targetDir,
  })
})

test("return confirms the retry modal", async () => {
  const { renderer, runs, result } = await browser(0)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  renderer.keyInput.emit("keypress", keyEvent("return", { raw: "\r" }))

  await expect(result).resolves.toEqual({
    type: "retry",
    runID: runs[0]!.runID,
    targetDir: runs[0]!.targetDir,
  })
})

test("n cancels the retry confirmation and returns to the list", async () => {
  const { renderer, result } = await browser(1)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  renderer.keyInput.emit("keypress", keyEvent("n"))
  renderer.keyInput.emit("keypress", keyEvent("q"))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("escape cancels the retry confirmation", async () => {
  const { renderer, result } = await browser(1)

  renderer.keyInput.emit("keypress", keyEvent("r"))
  renderer.keyInput.emit("keypress", keyEvent("escape"))
  renderer.keyInput.emit("keypress", keyEvent("q"))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("R (shift+r) resumes the current run", async () => {
  const { renderer, runs, result } = await browser(2)

  renderer.keyInput.emit("keypress", keyEvent("r", { shift: true }))

  await expect(result).resolves.toEqual({
    type: "resume",
    runID: runs[2]!.runID,
    targetDir: runs[2]!.targetDir,
  })
})

test("summary mode returns to the run list before quitting", async () => {
  const { renderer, result } = await browser()

  renderer.keyInput.emit("keypress", keyEvent("s"))
  renderer.keyInput.emit("keypress", keyEvent("escape"))
  renderer.keyInput.emit("keypress", keyEvent("q"))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("Ctrl-C exits immediately", async () => {
  const { renderer, result } = await browser()

  renderer.keyInput.emit("keypress", keyEvent("c", { ctrl: true, raw: "\u0003" }))

  await expect(result).resolves.toEqual({ type: "exit" })
})

test("wide screens keep the run list and details side by side", async () => {
  const testRenderer = await createTestRenderer({ width: 120, height: 40 })
  const instance = new RunsBrowser(testRenderer.renderer, sampleRuns(), 0)
  try {
    await Bun.sleep(260)
    const lines = testRenderer.captureCharFrame().split("\n")
    // The header carries convoy+version on its border, not a meter row.
    // shortVersion() is "dev" in a bare checkout and "vX.Y.Z-dev" when
    // npm_package_version is set (CI), so the assertion has to follow it.
    expect(lines.join("\n")).toContain(`convoy ${shortVersion()}`)
    expect(lines.join("\n")).not.toContain("OpenRouter")
    expect(lines.join("\n")).not.toContain("OpenAI")
    // Side by side: both panel titles share the same horizontal band.
    const runsTitle = lines.findIndex((line) => line.trimStart().startsWith("╭─ runs"))
    expect(runsTitle).toBeGreaterThanOrEqual(0)
    // The stock title starts the line; the details border follows on the same row.
    expect(lines[runsTitle]).toContain("╭─ deta")
  } finally {
    testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})

test("compact screens stack the run list above the details panel", async () => {
  const testRenderer = await createTestRenderer({ width: 84, height: 30 })
  const instance = new RunsBrowser(testRenderer.renderer, sampleRuns(), 0)
  try {
    await Bun.sleep(260)
    const lines = testRenderer.captureCharFrame().split("\n")
    const runsTitle = lines.findIndex((line) => line.trimStart().startsWith("╭─ runs"))
    const detailsTitle = lines.findIndex((line) => line.trimStart().startsWith("╭─ deta"))
    // Stacked: the details panel's title sits below the runs panel's.
    expect(runsTitle).toBeGreaterThanOrEqual(0)
    expect(detailsTitle).toBeGreaterThan(runsTitle)
  } finally {
    testRenderer.mockInput.pressKey("c", { ctrl: true })
  }
})
