import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { HomeLauncher, compactHomeMaxWidth, type HomeSelection } from "../src/home-tui"
import { displayWidth } from "../src/tui-theme"
import { shortVersion } from "../src/version"

import type { KeyEvent } from "@opentui/core"

function keyEvent(name: string, options: { ctrl?: boolean; raw?: string } = {}): KeyEvent {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: false,
    option: false,
    sequence: name,
    number: false,
    raw: options.raw ?? name,
    eventType: "keypress",
    source: "raw",
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as KeyEvent
}

async function openHome(width = 110, height = 28, targetDir = "/work/acme/convoy") {
  const testRenderer = await createTestRenderer({ width, height })
  const home = new HomeLauncher(testRenderer.renderer, targetDir)
  await testRenderer.renderOnce()
  return {
    ...testRenderer,
    home,
    press(name: string, options: { ctrl?: boolean; raw?: string } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(name, options))
    },
  }
}

async function chooseWithKey(key: string): Promise<{ selection: HomeSelection; destroyed: boolean }> {
  const session = await openHome()
  session.press(key)
  const selection = await session.home.result
  return { selection, destroyed: session.renderer.isDestroyed }
}

test("wide home layers contextual art above floating destinations and overview", async () => {
  const session = await openHome(compactHomeMaxWidth + 26)
  try {
    const frame = session.captureCharFrame()
    const lines = frame.split("\n")
    const destinations = lines.findIndex((line) => line.includes("[p] PIPELINES"))
    const overview = lines.findIndex((line) => line.includes("Compose agents into"))

    expect(frame).toContain(`convoy ${shortVersion()}`)
    expect(frame).toContain("project  /work/acme/convoy")
    expect(frame).not.toContain("Home")
    expect(frame).not.toContain("Choose where to work")
    expect(frame).not.toContain(" destinations ")
    expect(frame).not.toContain(" overview ")
    expect(frame).toMatch(/[·•●◆✦]/)
    expect(frame).toContain("[p] PIPELINES")
    expect(frame).toContain("[s] SPECS")
    expect(frame).toContain("[r] RUNS")
    expect(frame).toContain("[c] CONFIG")
    expect(frame.match(/PIPELINES/g)).toHaveLength(1)
    expect(destinations).toBeGreaterThanOrEqual(0)
    expect(overview).toBe(destinations + 2)
  } finally {
    session.press("q")
    await session.home.result
  }
})

test("a tall home gives the sculpture the body and floats the dock rows", async () => {
  const session = await openHome(100, 42)
  try {
    const lines = session.captureCharFrame().split("\n")
    const destinations = lines.findIndex((line) => line.includes("[p] PIPELINES"))
    const overview = lines.findIndex((line) => line.includes("Compose agents into"))
    expect(overview).toBe(destinations + 2)
    const art = lines.slice(3, destinations)
    expect(art.length).toBeGreaterThan(16)
    const ink = art.map((line) => /[·•●◆✦]/.test(line))
    expect(ink.some(Boolean)).toBeTrue()
    expect(ink.lastIndexOf(true) - ink.findIndex(Boolean)).toBeGreaterThan(art.length * 0.5)
  } finally {
    session.press("q")
    await session.home.result
  }
})

test("narrow home stacks destinations above overview without overflowing rows", async () => {
  const width = 44
  const session = await openHome(width, 20)
  try {
    const lines = session.captureCharFrame().split("\n")
    const destinations = lines.findIndex((line) => line.includes("[p] PIPELINES"))
    const overview = lines.findIndex((line) => line.includes("Compose agents into"))

    expect(destinations).toBeGreaterThanOrEqual(0)
    expect(overview).toBe(destinations + 3)
    expect(lines.findIndex((line) => line.includes("[p] PIPELINES"))).toBeLessThan(
      lines.findIndex((line) => line.includes("[r] RUNS")),
    )
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width)
  } finally {
    session.press("escape")
    await session.home.result
  }
})

test("selection changes the contextual art and overview", async () => {
  const session = await openHome()
  try {
    expect(session.captureCharFrame()).toContain("Compose agents into a reviewed, repeatable path")

    session.press("down")
    await session.renderOnce()
    const specsFrame = session.captureCharFrame()
    expect(specsFrame).toContain("project's living specification")
    expect(specsFrame).not.toContain("Compose agents into a reviewed, repeatable path")
    expect(specsFrame).toMatch(/[·•●◆✦]/)

    session.press("right")
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("Follow live execution")
  } finally {
    session.press("q")
    await session.home.result
  }
})

test("arrows and j/k move selection and Enter opens the focused destination", async () => {
  const session = await openHome()
  session.press("down")
  session.press("right")
  session.press("left")
  session.press("j")
  session.press("k")
  session.press("return")

  await expect(session.home.result).resolves.toBe("specs")
  expect(session.renderer.isDestroyed).toBeTrue()
})

test.each([
  ["p", "pipelines"],
  ["s", "specs"],
  ["r", "runs"],
  ["c", "config"],
] as const)("%s directly opens %s after destroying the renderer", async (key, expected) => {
  expect(await chooseWithKey(key)).toEqual({ selection: expected, destroyed: true })
})

test.each([
  ["q", {}],
  ["escape", {}],
  ["c", { ctrl: true, raw: "\u0003" }],
] as const)("%s exits home without dispatch", async (key, options) => {
  const session = await openHome()
  session.press(key, options)
  await expect(session.home.result).resolves.toBeUndefined()
  expect(session.renderer.isDestroyed).toBeTrue()
})
