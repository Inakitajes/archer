import { expect, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { HomeLauncher, compactHomeMaxWidth, type HomeSelection } from "../src/home-tui"
import { displayWidth } from "../src/tui-theme"
import { versionDetails } from "../src/version"

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

async function openHome(
  width = 110,
  height = 28,
  targetDir = "/work/acme/convoy",
  options: { kittyGraphics?: boolean } = {},
) {
  const testRenderer = await createTestRenderer({ width, height })
  const home = new HomeLauncher(testRenderer.renderer, targetDir, options)
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

test("wide home puts destinations on one row followed by the selected description", async () => {
  const session = await openHome(compactHomeMaxWidth + 26)
  try {
    const frame = session.captureCharFrame()
    const lines = frame.split("\n")
    const strip = lines.findIndex((line) => line.includes("PIPELINES") && line.includes("SPECS"))

    expect(lines[0]!.trim()).toBe("")
    expect(lines[1]).toContain(versionDetails())
    expect(lines[1].trimStart()).toStartWith("████")
    expect(lines[2]).toContain("██")
    expect(lines[2]).toContain("/work/acme/convoy")
    expect(lines[3]).toContain("████")
    expect(lines[4]!.trim()).toBe("")
    expect(frame).not.toContain("1/4")
    expect(frame).not.toContain("←→ · enter · q")
    expect(lines.slice(4, strip).join("\n")).not.toMatch(/[·•]/)
    expect(frame).not.toContain("Home")
    expect(frame).not.toContain("Choose where to work")
    // Just the bracketed shortcut + label: no cards or borders.
    expect(frame).toContain("◆ [P]  PIPELINES ◆")
    expect(frame).toContain("[S]  SPECS")
    expect(frame).toContain("[R]  RUNS")
    expect(frame).toContain("[C]  CONFIG")
    expect(frame.match(/◆/g)).toHaveLength(2)
    expect(lines[strip]).toContain("CONFIG")
    expect(frame).not.toContain("╭")
    expect(frame).not.toContain("│")
    expect(lines[strip + 1]!.trim()).toBe("")
    expect(lines[strip + 2]).toContain("Compose agents into a reviewed, repeatable path")
    expect(frame).not.toContain("Explore,")
    expect(frame).not.toContain("Follow live")
    expect(frame).not.toContain("Tune models")
    expect(frame.match(/PIPELINES/g)).toHaveLength(1)
  } finally {
    session.press("q")
    await session.home.result
  }
})

test("a tall no-graphics home centers navigation in the available body", async () => {
  const session = await openHome(100, 42)
  try {
    const frame = session.captureCharFrame()
    const lines = frame.split("\n")
    const tabs = lines.findIndex((line) => line.includes("PIPELINES") && line.includes("SPECS"))
const project = lines.findIndex((line) => line.includes("/work/acme/convoy"))
    const bodyTop = 4
    expect(project).toBe(2)
    expect(lines[project - 1]).toContain("█")
    expect(lines[project + 1]).toContain("█")
    expect(lines[tabs + 1]!.trim()).toBe("")
    expect(lines[tabs + 2]).toContain("Compose agents into")
    expect(Math.abs((tabs - bodyTop) - ((lines.length - 3) - (tabs + 3)))).toBeLessThanOrEqual(1)
    expect(lines.slice(bodyTop, lines.length - 1).join("\n")).not.toMatch(/[·•]/)
    expect(frame).not.toContain("1/4")
  } finally {
    session.press("q")
    await session.home.result
  }
})

test("the compact width still stacks; one column wider becomes a single row", async () => {
  const stacked = await openHome(compactHomeMaxWidth, 24)
  try {
    const frame = stacked.captureCharFrame()
    expect(frame).toContain("◆ [P]  PIPELINES ◆")
    expect(frame).not.toContain("╭")
    // Stacked: each destination on its own line and marker slots align.
    const lines = frame.split("\n")
    const p = lines.findIndex((line) => line.includes("[P]"))
    const s = lines.findIndex((line) => line.includes("[S]"))
    expect(s).toBeGreaterThan(p)
    expect(lines[p]!.indexOf("[P]")).toBe(lines[s]!.indexOf("[S]"))
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(compactHomeMaxWidth)
  } finally {
    stacked.press("q")
    await stacked.home.result
  }

  const row = await openHome(compactHomeMaxWidth + 1, 24)
  try {
    const frame = row.captureCharFrame()
    expect(frame).toContain("◆ [P]  PIPELINES ◆")
    expect(frame).not.toContain("╭")
    expect(frame).not.toContain("│")
    // Row mode: everything, including reserved marker slots, fits one line.
    const lines = frame.split("\n")
    const one = lines.findIndex((line) => line.includes("PIPELINES") && line.includes("CONFIG"))
    expect(one).toBeGreaterThanOrEqual(0)
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(73)
  } finally {
    row.press("q")
    await row.home.result
  }
})

test("narrow home stacks destinations with balanced spacing and one description", async () => {
  const width = 44
  const session = await openHome(width, 20)
  try {
    const lines = session.captureCharFrame().split("\n")
    const p = lines.findIndex((line) => line.includes("◆ [P]  PIPELINES ◆"))
    const r = lines.findIndex((line) => line.includes("[R]  RUNS"))
    const config = lines.findIndex((line) => line.includes("[C]  CONFIG"))
    const description = lines.findIndex((line) => line.includes("Compose agents"))
    const project = lines.findIndex((line) => line.includes("project  "))
    expect(project).toBe(2)
    expect(lines[2]).toContain("project  /work/acme/convoy")
    expect(lines[0]!.trim()).toBe("")
    expect(lines[1]).toContain("CONVOY")
    expect(p).toBeGreaterThanOrEqual(0)
    expect(r).toBeGreaterThan(p)
    expect(r - p).toBeLessThan(4)
    expect(config).toBe(p + 3)
    expect(lines[config + 1]!.trim()).toBe("")
    expect(description).toBe(config + 2)
    expect(lines[p - 1]!.trim()).toBe("")
    expect(Math.abs((p - (project + 1)) - ((lines.length - 3) - (description + 1)))).toBeLessThanOrEqual(1)
    expect(lines[description]!.trimEnd()).toEndWith("…")
    expect(session.captureCharFrame()).not.toContain("╭")
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width)
  } finally {
    session.press("escape")
    await session.home.result
  }
})

test("selection changes fixed-slot diamonds and the one-line description without shifting items", async () => {
  const session = await openHome()
  try {
    const first = session.captureCharFrame()
    const firstStrip = first.split("\n").find((line) => line.includes("PIPELINES") && line.includes("SPECS"))!
    const positions = (line: string) => ["[P]", "[S]", "[R]", "[C]"].map((label) => line.indexOf(label))
    session.press("down")
    await session.renderOnce()
    const specsFrame = session.captureCharFrame()
    const specsLines = specsFrame.split("\n")
    const specsStrip = specsLines.find((line) => line.includes("PIPELINES") && line.includes("SPECS"))!
    const specsStripRow = specsLines.findIndex((line) => line.includes("PIPELINES") && line.includes("SPECS"))
    expect(specsFrame).not.toBe(first)
    expect(first).toContain("◆ [P]  PIPELINES ◆")
    expect(specsFrame).toContain("◆ [S]  SPECS ◆")
    expect(positions(specsStrip)).toEqual(positions(firstStrip))
    expect(specsFrame.match(/◆/g)).toHaveLength(2)
    expect(specsLines.slice(3, specsStripRow).join("\n")).not.toMatch(/[·•]/)
    expect(specsFrame).toContain("project's living specification")
    expect(specsFrame).not.toContain("Compose agents into")
    session.press("right")
    await session.renderOnce()
    expect(session.captureCharFrame()).toContain("Follow live execution")
  } finally {
    session.press("q")
    await session.home.result
  }
})

test("an unavailable image uses the same centered navigation-only fallback", async () => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true })
  const writes: string[] = []
  const writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write)

  const session = await openHome(90, 28, "/work/acme/convoy", { kittyGraphics: true })
  const internals = session.home as unknown as {
    imagePathByKind: Map<string, string | undefined>
    artBox: { visible: boolean }
    render(): void
  }
  try {
    internals.imagePathByKind.set("pipelines", undefined)
    writes.length = 0
    internals.render()
    await session.renderOnce()

    const frame = session.captureCharFrame()
    const lines = frame.split("\n")
    const project = lines.findIndex((line) => line.includes("/work/acme/convoy"))
    const tabs = lines.findIndex((line) => line.includes("PIPELINES") && line.includes("SPECS"))
    const description = lines.findIndex((line) => line.includes("Compose agents into"))
    expect(internals.artBox.visible).toBeFalse()
    expect(project).toBe(2)
    expect(lines[tabs]).toContain("◆ [P]  PIPELINES ◆")
    expect(description).toBe(tabs + 2)
    expect(Math.abs((tabs - 4) - ((lines.length - 3) - (description + 1)))).toBeLessThanOrEqual(1)
    expect(lines.slice(4, tabs).join("\n")).not.toMatch(/[·•]/)
    expect(writes.join("")).toContain("\x1b_Ga=d,d=i,i=100")
  } finally {
    session.press("q")
    await session.home.result
    writeSpy.mockRestore()
    if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
})

test("image selection and resize delete the old placement before drawing the next one", async () => {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true })
  const writes: string[] = []
  const writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write)

  const session = await openHome(90, 28, "/work/acme/convoy", { kittyGraphics: true })
  const syncImage = () => (session.home as unknown as { syncImage(): void }).syncImage()
  try {
    expect((session.home as unknown as { imageMode: boolean }).imageMode).toBeTrue()
    writes.length = 0
    syncImage()
    const initial = writes.join("")
    expect(initial).toContain("\x1b[6;2H")
    expect(initial).toMatch(/\x1b_Ga=p,i=100[^;]*c=88,r=16/)

    writes.length = 0
    session.press("down")
    await session.renderOnce()
    syncImage()
    const switched = writes.join("")
    expect(switched.indexOf("\x1b_Ga=d,d=i,i=100")).toBeGreaterThanOrEqual(0)
    expect(switched.indexOf("\x1b_Ga=p,i=101")).toBeGreaterThan(switched.indexOf("\x1b_Ga=d,d=i,i=100"))
    expect(switched).toContain("\x1b[6;2H")
    expect(switched).toMatch(/\x1b_Ga=p,i=101[^;]*c=88,r=16/)

    writes.length = 0
    session.resize(80, 24)
    await session.renderOnce()
    syncImage()
    const resized = writes.join("")
    expect(resized.indexOf("\x1b_Ga=d,d=i,i=101")).toBeGreaterThanOrEqual(0)
    expect(resized.indexOf("\x1b_Ga=p,i=101")).toBeGreaterThan(resized.indexOf("\x1b_Ga=d,d=i,i=101"))
    // The shortened masthead build line lets the block wordmark fit at 80
    // columns too, so the image keeps its row and only loses one row of height.
    expect(resized).toContain("\x1b[6;2H")
    expect(resized).toMatch(/\x1b_Ga=p,i=101[^;]*c=78,r=12/)
  } finally {
    session.press("q")
    await session.home.result
    writeSpy.mockRestore()
    if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
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
] as const)("%s directly opens %s after destroyingthe renderer", async (key, expected) => {
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
