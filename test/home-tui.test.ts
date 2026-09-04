import { expect, spyOn, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"

import { HomeLauncher, compactHomeMaxWidth, homePosterMaxCols, homePosterMaxRows, type HomeSelection } from "../src/home-tui"
import { displayWidth } from "../src/tui-theme"
import { versionDetails, versionInfo } from "../src/version"

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
    expect(lines[1]!.trimEnd()).toEndWith(versionDetails())
    expect(lines[1]).not.toContain("(")
    expect(lines[1]).not.toContain(versionInfo.platform)
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
    // The description caps at DESCRIPTION_MAX_COLS and wraps to two balanced
    // centered rows even on this wide terminal.
    expect(lines[strip + 2]).toContain("Compose agents into a reviewed, repeatable")
    expect(lines[strip + 3]).toContain("path from intent to shipped code.")
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

test("narrow home stacks destinations with balanced spacing and a two-line description", async () => {
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
    expect(lines[1]!.trimEnd()).toEndWith(versionDetails())
    expect(lines[1]).not.toContain("(")
    expect(lines[1]).not.toContain(versionInfo.platform)
    expect(p).toBeGreaterThanOrEqual(0)
    expect(r).toBeGreaterThan(p)
    expect(r - p).toBeLessThan(4)
    expect(config).toBe(p + 3)
    expect(lines[config + 1]!.trim()).toBe("")
    expect(description).toBe(config + 2)
    expect(lines[p - 1]!.trim()).toBe("")
    expect(Math.abs((p - (project + 1)) - ((lines.length - 3) - (description + 2)))).toBeLessThanOrEqual(1)
    expect(lines[description]!.trimEnd()).not.toEndWith("…")
    expect(lines[description + 1]!.trimEnd()).toEndWith("…")
    expect(session.captureCharFrame()).not.toContain("╭")
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(width)
  } finally {
    session.press("escape")
    await session.home.result
  }
})

test("selection changes fixed-slot diamonds and the contextual description without shifting items", async () => {
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
    // 90x28 poster with the column dock (7 rows): slim chrome (2) + gap (1) +
    // topPad (1) + wordmark (3) + 2-row gap puts the contain card (33x9,
    // height-bound) at row 9, centered at col 28 — and the full 800x436
    // source rect means nothing is cropped. The block centers with equal
    // margins: 1 row above the wordmark, 1 below the description.
    expect(initial).toContain("\x1b[10;29H")
    expect(initial).toMatch(/\x1b_Ga=p,i=100[^;]*c=33,r=9,x=0,y=0,w=800,h=436/)

    writes.length = 0
    session.press("down")
    await session.renderOnce()
    syncImage()
    const switched = writes.join("")
    expect(switched.indexOf("\x1b_Ga=d,d=i,i=100")).toBeGreaterThanOrEqual(0)
    expect(switched.indexOf("\x1b_Ga=p,i=101")).toBeGreaterThan(switched.indexOf("\x1b_Ga=d,d=i,i=100"))
    // Selection swaps the picture but the poster geometry is identical.
    expect(switched).toContain("\x1b[10;29H")
    expect(switched).toMatch(/\x1b_Ga=p,i=101[^;]*c=33,r=9,x=0,y=0,w=800,h=436/)

    writes.length = 0
    session.resize(80, 24)
    await session.renderOnce()
    syncImage()
    const resized = writes.join("")
    expect(resized.indexOf("\x1b_Ga=d,d=i,i=101")).toBeGreaterThanOrEqual(0)
    expect(resized.indexOf("\x1b_Ga=p,i=101")).toBeGreaterThan(resized.indexOf("\x1b_Ga=d,d=i,i=101"))
    // Shorter canvas: the height budget binds harder, so the card shrinks to
    // 18x5 while staying centered below the fixed wordmark rows (topPad 1).
    expect(resized).toContain("\x1b[10;32H")
    expect(resized).toMatch(/\x1b_Ga=p,i=101[^;]*c=18,r=5,x=0,y=0,w=800,h=436/)
  } finally {
    session.press("q")
    await session.home.result
    writeSpy.mockRestore()
    if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor)
    else delete (process.stdout as { isTTY?: boolean }).isTTY
  }
})

async function openGraphicsHome(width = 120, height = 40) {
  const ttyDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true })
  const writes: string[] = []
  const writeSpy = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
    return true
  }) as typeof process.stdout.write)
  const session = await openHome(width, height, "/work/acme/convoy", { kittyGraphics: true })
  return {
    ...session,
    writes,
    syncImage: () => (session.home as unknown as { syncImage(): void }).syncImage(),
    posterLayout: () => (session.home as unknown as { posterLayout(): { cardRow: number; cardCol: number; cardCols: number; cardRows: number; topPad: number; bottomPad: number; wordmarkRows: number } | undefined }).posterLayout(),
    restore() {
      writeSpy.mockRestore()
      if (ttyDescriptor) Object.defineProperty(process.stdout, "isTTY", ttyDescriptor)
      else delete (process.stdout as { isTTY?: boolean }).isTTY
    },
  }
}

test("graphics poster: card respects caps, sits below the wordmark, and keeps dock clearances", async () => {
  const session = await openGraphicsHome(120, 40)
  try {
    const layout = session.posterLayout()!
    expect(layout).toBeDefined()
    // Caps: never wider/taller than the poster ceiling.
    expect(layout.cardCols).toBeLessThanOrEqual(homePosterMaxCols)
    expect(layout.cardRows).toBeLessThanOrEqual(homePosterMaxRows)
    // The placement rect starts strictly below the wordmark block (1 gap row).
    expect(layout.cardRow).toBeGreaterThan(layout.topPad + layout.wordmarkRows)
    // The wordmark, card, and controls center as ONE block: the blank margin
    // above the wordmark equals the margin below the description (±1 row for
    // odd leftovers), so extra height never piles between image and selector.
    expect(Math.abs(layout.topPad - layout.bottomPad)).toBeLessThanOrEqual(1)
    // The controls sit exactly DOCK_GAP_ROWS (2) blank rows under the card.
    const lines = session.captureCharFrame().split("\n")
    const selectorRow = lines.findIndex((line) => line.includes("[P]  PIPELINES"))
    expect(selectorRow).toBe(layout.cardRow + layout.cardRows + 2)
    // Dock clearance: at least 2 blank rows between the card bottom and the
    // destination controls (DOCK_GAP_ROWS) plus the 2 bottom pad rows.
    const cardBottom = layout.cardRow + layout.cardRows
    expect(session.renderer.height - cardBottom).toBeGreaterThanOrEqual(4)
    // Horizontal centering of the card.
    expect(layout.cardCol).toBe(Math.floor((120 - layout.cardCols) / 2))
    // The emitted placement matches the layout rect and crops nothing.
    session.writes.length = 0
    session.syncImage()
    const cmd = session.writes.join("")
    expect(cmd).toMatch(new RegExp(`\\x1b_Ga=p,i=100[^;]*c=${layout.cardCols},r=${layout.cardRows},x=0,y=0,w=800,h=436`))
    expect(cmd).toContain(`\x1b[${layout.cardRow + 1};${layout.cardCol + 1}H`)
  } finally {
    session.press("q")
    await session.home.result
    session.restore()
  }
})

test("graphics poster: chrome is a slim project/version row and the wordmark centers in the art", async () => {
  const session = await openGraphicsHome(120, 40)
  try {
    const lines = session.captureCharFrame().split("\n")
    // Row 0 blank, row 1 is the faint chrome: project left + version right,
    // no block wordmark up there anymore.
    expect(lines[0]!.trim()).toBe("")
    expect(lines[1]).toContain("project")
    expect(lines[1]).toContain("/work/acme/convoy")
    expect(lines[1]!.trimEnd()).toEndWith(versionDetails())
    expect(lines[1]).not.toContain("█")
    // The block wordmark now lives in the art canvas, centered horizontally.
    const wordmarkRow = lines.findIndex((line) => line.includes("████"))
    expect(wordmarkRow).toBeGreaterThan(1)
    const leftPad = lines[wordmarkRow]!.length - lines[wordmarkRow]!.trimStart().length
    const blockWidth = lines[wordmarkRow]!.trimEnd().length - leftPad
    expect(Math.abs(leftPad - Math.floor((120 - blockWidth) / 2))).toBeLessThanOrEqual(1)
    // Poster mode lists destinations as a centered column even at 120 cols:
    // PIPELINES and SPECS never share a row, and the block is centered.
    const p = lines.findIndex((line) => line.includes("[P]  PIPELINES"))
    const s = lines.findIndex((line) => line.includes("[S]  SPECS"))
    expect(p).toBeGreaterThan(0)
    expect(s).toBe(p + 1)
    expect(lines[p]!.indexOf("◆")).toBe(Math.floor((120 - lines[p]!.trim().length) / 2))
    // No footer/key hints anywhere.
    expect(session.captureCharFrame()).not.toContain("←→")
  } finally {
    session.press("q")
    await session.home.result
    session.restore()
  }
})

test("graphics poster: selecting another destination keeps the wordmark row fixed", async () => {
  const session = await openGraphicsHome(120, 40)
  try {
    const before = session.captureCharFrame().split("\n")
    const rowBefore = before.findIndex((line) => line.includes("████"))
    session.press("down")
    await session.renderOnce()
    const after = session.captureCharFrame().split("\n")
    const rowAfter = after.findIndex((line) => line.includes("████"))
    expect(rowAfter).toBe(rowBefore)
    // And the chrome row is unchanged too.
    expect(after[1]).toBe(before[1])
  } finally {
    session.press("q")
    await session.home.result
    session.restore()
  }
})

test("graphics poster: a canvas too short for wordmark + card falls back to centered nav", async () => {
  // 60x20: the column dock + wordmark + 2-row gap leave < 4 card rows — the
  // dither would be noise, so the poster yields to navigation-only.
  const squat = await openGraphicsHome(60, 20)
  try {
    expect(squat.posterLayout()).toBeUndefined()
    expect(squat.captureCharFrame()).toContain("◆ [P]  PIPELINES ◆")
  } finally {
    squat.press("q")
    await squat.home.result
    squat.restore()
  }
  // Height that leaves no room for a useful card under the wordmark.
  const session = await openGraphicsHome(120, 12)
  const internals = session.home as unknown as { artBox: { visible: boolean } }
  try {
    expect(session.posterLayout()).toBeUndefined()
    expect(internals.artBox.visible).toBeFalse()
    const lines = session.captureCharFrame().split("\n")
    // Navigation-only: the art canvas is gone and destinations are present.
    expect(session.captureCharFrame()).toContain("◆ [P]  PIPELINES ◆")
    // The full masthead is back on top: block wordmark rows with the project
    // path on its second row (the slim chrome would sit on row 1).
    expect(lines[1]).toContain("████")
    expect(lines[2]).toContain("/work/acme/convoy")
  } finally {
    session.press("q")
    await session.home.result
    session.restore()
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
