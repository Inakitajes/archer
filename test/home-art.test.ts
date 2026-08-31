import { expect, test } from "bun:test"

import {
  TETRIS_TOTAL,
  formCloud,
  homeArtCount,
  homeArtMaxHeight,
  homeArtPlain,
  homeArtTickMs,
  isHomeArtKind,
  renderHomeArt,
  type HomeArtKind,
} from "../src/home-art"
import { displayWidth, paletteForMode, setTheme } from "../src/tui-theme"

const kinds: readonly HomeArtKind[] = ["pipelines", "specs", "runs", "config"]

function frame(kind: HomeArtKind, extra: Partial<Parameters<typeof renderHomeArt>[0]> = {}) {
  return renderHomeArt({ kind, tick: 0, width: 72, height: 14, ...extra })
}

function linesOf(kind: HomeArtKind, extra: Partial<Parameters<typeof renderHomeArt>[0]> = {}) {
  return homeArtPlain(frame(kind, extra).content).split("\n")
}

setTheme(paletteForMode("dark"))

test("formCloud always returns exactly n points", () => {
  for (const kind of kinds) {
    expect(formCloud(kind, 1, 0)).toHaveLength(1)
    expect(formCloud(kind, 40, 3)).toHaveLength(40)
    expect(formCloud(kind, 180, 9)).toHaveLength(180)
  }
})

test("isHomeArtKind accepts the four destinations only", () => {
  expect(kinds.every(isHomeArtKind)).toBeTrue()
  expect(isHomeArtKind("home")).toBeFalse()
})

test("homeArtCount scales with the canvas and never drops below a readable field", () => {
  expect(homeArtCount(20, 3)).toBe(36)
  expect(homeArtCount(40, 6)).toBe(80)
  expect(homeArtCount(80, 16)).toBeGreaterThanOrEqual(108)
  expect(homeArtCount(80, 16)).toBeLessThanOrEqual(280)
})

test("the fitted camera uses the canvas below the wordmark instead of sitting in the top half", () => {
  // The atom's silhouette changes as it tumbles, so judge the fit by the
  // union of several spins: together they must sweep most of the canvas. The
  // wordmark's band (glyphs + shadow + air) ends at row 7, so the sculpture
  // owns rows 8-19.
  let first = Infinity
  let last = -Infinity
  for (const tick of [4, 12, 20, 28]) {
    const rows = linesOf("specs", { width: 72, height: 20, tick })
    rows.forEach((row, index) => {
      if (/[·•]/.test(row)) {
        if (index < first) first = index
        if (index > last) last = index
      }
    })
  }
  expect(first).toBeGreaterThanOrEqual(8)
  expect(first).toBeLessThan(11)
  expect(last).toBeGreaterThan(15)
  expect(last - first).toBeGreaterThan(6)
})

test("the camera never refits while the rotation-invariant sculptures spin", () => {
  // The orb is a sphere and the coil lives on a cylinder: both project to the
  // same bounding box at every yaw, so any drift here is the camera zooming —
  // the exact regression this test guards against.
  for (const kind of ["config", "runs"] as const) {
    const boxes = [0, 9, 17, 26, 35].map((tick) => {
      const rows = linesOf(kind, { width: 72, height: 20, tick })
      let minX = Infinity
      let maxX = -Infinity
      let minY = Infinity
      let maxY = -Infinity
      for (const [index, row] of rows.entries()) {
        for (const match of row.matchAll(/[·•]/g)) {
          const x = match.index ?? 0
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (index < minY) minY = index
          if (index > maxY) maxY = index
        }
      }
      return { minX, maxX, minY, maxY }
    })
    const rowSpans = boxes.map((box) => box.maxY - box.minY)
    const colSpans = boxes.map((box) => box.maxX - box.minX)
    const centers = boxes.map((box) => (box.minX + box.maxX) / 2)
    expect(Math.max(...rowSpans) - Math.min(...rowSpans)).toBeLessThanOrEqual(2)
    expect(Math.max(...colSpans) - Math.min(...colSpans)).toBeLessThanOrEqual(2)
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(2)
  }
})

test("the tetris run cycles through distinct tetrominoes and scatters home", () => {
  // Hold phases of the four beats (I, T, L, S) — different silhouettes each.
  const shapes = [30, 74, 118, 162].map((tick) => homeArtPlain(frame("pipelines", { tick }).content))
  expect(new Set(shapes).size).toBe(4)
  // The scatter beat breaks the last piece apart again.
  const scatter = homeArtPlain(frame("pipelines", { tick: 205 }).content)
  expect(scatter).not.toBe(shapes[3])
  // One full cycle later, the same beat paints the same frame.
  const again = homeArtPlain(frame("pipelines", { tick: 30 + TETRIS_TOTAL }).content)
  expect(again).toBe(shapes[0])
})

test("the tetris run's resting pose centers in the band below the wordmark", () => {
  // The fit reserves headroom for blocks in flight; centering on that
  // worst-case sweep used to hang the locked tetromino — the pose the scene
  // dwells in — several rows below center. Hold phases of the four beats
  // (0.75: locked) must sit on the band's midpoint.
  const bandCenter = (8 + 19) / 2
  for (let beat = 0; beat < 4; beat++) {
    const tick = Math.floor((beat + 0.75) * 44)
    const rows = linesOf("pipelines", { width: 72, height: 20, tick })
    let first = Infinity
    let last = -Infinity
    rows.forEach((row, index) => {
      if (index < 8 || !/\S/.test(row)) return
      if (index < first) first = index
      if (index > last) last = index
    })
    expect(Math.abs((first + last) / 2 - bandCenter)).toBeLessThanOrEqual(1.5)
  }
})

test("the tetris run never intrudes on the wordmark's air gap", () => {
  // Every renderable tick: row 0 and the row under the wordmark's shadow
  // stay blank. Flying blocks peak sharply; a fit that samples coarse ticks
  // or a decimated cloud misses the apex and paints into this gap.
  for (let tick = 0; tick < TETRIS_TOTAL; tick++) {
    const rows = linesOf("pipelines", { width: 120, height: homeArtMaxHeight, tick })
    expect(rows[0]!.trim()).toBe("")
    expect(rows[7]!.trim()).toBe("")
  }
})

test("a settled frame fills the canvas without overflowing columns", () => {
  for (const kind of kinds) {
    const rows = linesOf(kind, { width: 64, height: 12, tick: 8 })
    expect(rows).toHaveLength(12)
    for (const row of rows) expect(displayWidth(row)).toBeLessThanOrEqual(64)
    expect(rows.join("\n")).toMatch(/[·•]/)
  }
})

test("tiny and huge canvases stay in bounds", () => {
  const tiny = linesOf("config", { width: 8, height: 3, tick: 0 })
  expect(tiny).toHaveLength(3)
  for (const row of tiny) expect(displayWidth(row)).toBeLessThanOrEqual(8)

  const huge = linesOf("pipelines", { width: 120, height: homeArtMaxHeight, tick: 20 })
  expect(huge).toHaveLength(homeArtMaxHeight)
  for (const row of huge) expect(displayWidth(row)).toBeLessThanOrEqual(120)
})

test("the four destinations settle into distinct sculptures", () => {
  const plains = kinds.map((kind) => homeArtPlain(frame(kind, { tick: 4 }).content))
  expect(new Set(plains).size).toBe(4)
})

test("the idle spin changes the projection", () => {
  const a = homeArtPlain(frame("specs", { tick: 0 }).content)
  const b = homeArtPlain(frame("specs", { tick: 18 }).content)
  expect(a).not.toBe(b)
})

test("a short canvas still paints a sculpture", () => {
  const rows = linesOf("config", { width: 18, height: 5, tick: 2 })
  expect(rows).toHaveLength(5)
  expect(rows.join("\n")).toMatch(/[·•]/)
})

test("identical inputs paint the same frame", () => {
  const a = homeArtPlain(frame("pipelines", { tick: 11 }).content)
  const b = homeArtPlain(frame("pipelines", { tick: 11 }).content)
  expect(a).toBe(b)
})

test("the embedded wordmark can be disabled when the home renders its own title", () => {
  const withWordmark = homeArtPlain(frame("specs", { width: 100, height: 20 }).content)
  const withoutWordmark = homeArtPlain(frame("specs", { width: 100, height: 20, wordmark: false }).content)
  expect(withWordmark).toContain("███████")
  expect(withoutWordmark).not.toContain("███████")
  expect(withoutWordmark).toMatch(/[·•]/)
})

test("animation cadence keeps the idle orbit smooth", () => {
  expect(homeArtTickMs).toBeLessThanOrEqual(80)
})
