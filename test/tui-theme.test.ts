import { describe, expect, test } from "bun:test"

import type { CliRenderer } from "@opentui/core"
import { displayWidth, fmtCountdown, hintsRow, moreHintsMarker, padBetween, paletteForMode, paletteForTerminal, raw, terminalBackgroundHex, truncate, wrapLines, type Hint, type OverflowHint } from "../src/tui-theme"

// terminalBackgroundHex reaches into opentui internals; the adapter must read a
// real reply but degrade to undefined (→ static palettes) on any shape change.
const fakeRenderer = (themeModeState: unknown) => ({ themeModeState }) as unknown as CliRenderer

describe("palette derivation from the terminal background", () => {
  test("measures wide and combined graphemes in terminal cells", () => {
    expect(displayWidth("ascii")).toBe(5)
    expect(displayWidth("界🙂é")).toBe(5)
    expect(displayWidth("👨‍👩‍👧‍👦")).toBe(2)
    expect(truncate("界界界", 5)).toBe("界界…")
    expect(wrapLines(["界界a"], 3)).toEqual(["界", "界a"])
    expect(wrapLines(["éé"], 1)).toEqual(["é", "é"])
  })

  test("dark background: transparent canvas, borders lifted toward white, overlay repaints the terminal", () => {
    const palette = paletteForTerminal("dark", "#1a1b26")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#1a1b26")
    expect(palette.chipText).toBe("#1a1b26")
    // 16% / 26% toward white from #1a1b26.
    expect(palette.borderDim).toBe("#3f3f49")
    expect(palette.border).toBe("#56565e")
    // Accents come from the static dark palette.
    expect(palette.accent).toBe(paletteForMode("dark").accent)
  })

  test("light background: borders sink toward black with light accents", () => {
    const palette = paletteForTerminal("light", "#fafafa")

    expect(palette.bg).toBe("transparent")
    expect(palette.overlay).toBe("#fafafa")
    expect(palette.borderDim).toBe("#d2d2d2")
    expect(palette.border).toBe("#b9b9b9")
    expect(palette.accent).toBe(paletteForMode("light").accent)
  })

  // The mode needs both OSC replies inside opentui's 250ms window, but a lone
  // background reply is enough to derive the palette ourselves.
  test("brightness of the background wins over an unresolved mode", () => {
    expect(paletteForTerminal(null, "#000000").accent).toBe(paletteForMode("dark").accent)
    expect(paletteForTerminal(null, "#ffffff").accent).toBe(paletteForMode("light").accent)
  })

  test("falls back to the static palettes without a usable background", () => {
    expect(paletteForTerminal("dark", undefined)).toBe(paletteForMode("dark"))
    expect(paletteForTerminal(null, "not-a-color")).toBe(paletteForMode(null))
  })

  test("reads a real OSC background reply but fails safe on a changed internal shape", () => {
    // A usable reply is read straight through.
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: "#1a1b26" }))).toBe("#1a1b26")

    // Anything that isn't a parseable hex string degrades to undefined.
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: "not-a-color" }))).toBeUndefined()
    expect(terminalBackgroundHex(fakeRenderer({ themeOscBackground: 0x1a1b26 }))).toBeUndefined()

    // A dependency upgrade that drops or renames the internal state must not throw.
    expect(terminalBackgroundHex(fakeRenderer(undefined))).toBeUndefined()
    expect(terminalBackgroundHex(fakeRenderer({}))).toBeUndefined()
    expect(terminalBackgroundHex({} as unknown as CliRenderer)).toBeUndefined()
  })

  test("quota reset countdowns collapse to the two most significant units", () => {
    const now = Date.now()
    const minutes = (n: number) => now + n * 60_000
    expect(fmtCountdown(minutes(2 * 1440 + 3 * 60 + 59), now)).toBe("2d 3h")
    expect(fmtCountdown(minutes(2 * 60 + 10), now)).toBe("2h 10m")
    expect(fmtCountdown(minutes(12), now)).toBe("12m")
    expect(fmtCountdown(now + 30_000, now)).toBe("0m")
    expect(fmtCountdown(now - 60_000, now)).toBe("0m")
  })

  test("no palette ever paints a panel background", () => {
    for (const palette of [
      paletteForMode("dark"),
      paletteForMode("light"),
      paletteForMode(null),
      paletteForTerminal("dark", "#1a1b26"),
      paletteForTerminal("light", "#fafafa"),
    ]) {
      expect(palette.bg).toBe("transparent")
    }
  })
})

describe("padBetween", () => {
  const text = (chunks: { text: string }[], width: number) =>
    padBetween(
      chunks.slice(0, 1).map((c) => raw(c.text)),
      chunks.slice(1).map((c) => raw(c.text)),
      width,
    )
      .chunks.map((chunk) => chunk.text)
      .join("")

  test("pads left and right apart to the exact width", () => {
    const row = text([{ text: "name" }, { text: "0:42" }], 20)
    expect(row).toBe("name            0:42")
    expect(displayWidth(row)).toBe(20)
  })

  test("clips the right side inside the width instead of overflowing past the border", () => {
    const row = text([{ text: "name" }, { text: "audit · read-only" }, { text: " · 0:42" }], 20)
    expect(displayWidth(row)).toBeLessThanOrEqual(20)
    expect(row.endsWith("…")).toBe(true)
    expect(row.startsWith("name ")).toBe(true)
  })

  test("drops the right side entirely when the left leaves it no room", () => {
    const row = text([{ text: "a-very-long-left-side-label" }, { text: "0:42" }], 24)
    expect(row).toBe("a-very-long-left-side-label")
  })
})

describe("hintsRow", () => {
  const hints: Hint[] = [
    { keys: "↑↓", label: "step", priority: 3 },
    { keys: "enter", label: "read", priority: 4 },
    { keys: "←→", label: "tab", priority: 5 },
    { keys: "v", label: "full session", priority: 6 },
  ]
  const overflow: OverflowHint = { keys: "ctrl+p", label: "commands", moreLabel: "all shortcuts", priority: 0 }
  const status = [[raw("run abc123 · ⚡ :4096 · now")], [raw("run abc123 · ⚡ :4096")], [raw("run abc123")]]
  const render = (width: number, options = {}) =>
    hintsRow(hints, status, width, { overflow, ...options })
      .chunks.map((chunk) => chunk.text)
      .join("")

  test("keeps every hint and the longest status when the terminal is wide", () => {
    const row = render(120)
    expect(row).toContain("[↑↓] step")
    expect(row).toContain("[v] full session")
    expect(row).toContain("[ctrl+p] commands")
    expect(row).toContain("⚡ :4096 · now")
    expect(displayWidth(row)).toBe(120)
  })

  test("sheds status detail before it touches the keys", () => {
    // 100 and 90 sit either side of the status ladder's two rungs: the quiet
    // timer goes first, then the server URL, and every key survives both.
    const trimmed = render(100)
    expect(trimmed).toContain("[v] full session")
    expect(trimmed).toContain("⚡ :4096")
    expect(trimmed).not.toContain("now")

    const bare = render(90)
    expect(bare).toContain("[v] full session")
    expect(bare).toContain("run abc123")
    expect(bare).not.toContain("⚡")
    // The run id is kept whole rather than ellipsised mid-value.
    expect(bare).not.toContain("…")
    expect(bare).toContain("[ctrl+p] commands")
  })

  test("drops the lowest-priority hint first and says where it went", () => {
    const row = render(58)
    expect(row).not.toContain("full session")
    expect(row).toContain("[↑↓] step")
    expect(row).toContain("[ctrl+p] all shortcuts")
  })

  test("drops hints in priority order, highest number first", () => {
    const dropOrder = ["full session", "tab", "read", "step"]
    const survivors = dropOrder.map((_, index) => dropOrder.slice(index + 1))
    let previous = 200
    survivors.forEach((expected, index) => {
      // Walk down until the hint at `index` is gone, then check what remains.
      let width = previous
      while (width > 20 && render(width).includes(`] ${dropOrder[index]}`)) width -= 1
      for (const label of expected) expect(render(width)).toContain(`] ${label}`)
      previous = width
    })
  })

  test("the pinned hint survives even when nothing else can", () => {
    const row = render(24)
    expect(row).toContain("ctrl+p")
    expect(displayWidth(row)).toBeLessThanOrEqual(24)
  })

  test("never overflows the width it was given", () => {
    for (let width = 20; width <= 160; width += 1) {
      expect(displayWidth(render(width)), `width ${width}`).toBeLessThanOrEqual(width)
    }
  })

  test("keeps the short wording when everything fits, so nothing is dropped for free", () => {
    // The row is measured against "all shortcuts" only once a drop is needed;
    // at a width where "commands" fits exactly, every hint must survive.
    const exact = displayWidth(render(200))
    const row = hintsRow(hints, [], exact, { overflow })
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(row).toContain("[ctrl+p] commands")
    expect(row).toContain("[v] full session")
  })

  test("renders the three footer shapes the TUIs already use", () => {
    const shapes: Hint[] = [
      { keys: "esc", label: "back", priority: 1, style: "bracket" },
      { keys: "enter", label: "confirm", priority: 1, style: "spaced" },
      { keys: "q", label: "uit", priority: 1, style: "glued" },
    ]
    const row = hintsRow(shapes, [], 80)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(row).toBe("[esc] back · enter confirm · quit")
  })

  test("a prefix rides along and counts toward the width", () => {
    const row = hintsRow(hints, [], 40, { prefix: [raw("read · ")] })
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(row.startsWith("read · ")).toBe(true)
    expect(displayWidth(row)).toBeLessThanOrEqual(40)
  })

  test("without an overflow hint a narrow row simply sheds", () => {
    const row = hintsRow(hints, [], 30)
      .chunks.map((chunk) => chunk.text)
      .join("")
    expect(displayWidth(row)).toBeLessThanOrEqual(30)
    expect(row).toContain("[↑↓] step")
  })

  // The footers with no command palette behind them (launcher, runs browser,
  // config editor) share this marker: silent until something is actually
  // hidden, then an honest count.
  describe("the palette-less overflow marker", () => {
    const shed: Hint[] = [
      { keys: "↑/↓", label: "select", priority: 3, tone: "dim" },
      { keys: "enter", label: "open", priority: 2 },
      { keys: "r", label: "esume", priority: 4, style: "glued" },
      { keys: "s", label: "ummary", priority: 5, style: "glued" },
      { keys: "q", label: "uit", priority: 1, style: "glued" },
    ]
    const marked = (width: number) =>
      hintsRow(shed, [[raw("3/12")]], width, { style: "spaced", overflow: moreHintsMarker })
        .chunks.map((chunk) => chunk.text)
        .join("")

    test("stays invisible while every hint fits", () => {
      const row = marked(100)
      expect(row.trimEnd().replace(/\s+3\/12$/, "")).toBe("↑/↓ select · enter open · resume · summary · quit")
      expect(row).not.toContain("+")
    })

    test("counts what it hid, and keeps counting as the row narrows", () => {
      const one = marked(50)
      expect(one).toContain("· +1")
      expect(one).not.toContain("summary")

      const more = marked(42)
      expect(more).toContain("· +2")
      expect(more).not.toContain("resume")
      // Whatever gets you out is priority 1, so it is the last hint standing.
      expect(more).toContain("quit")
    })

    test("still never overflows", () => {
      for (let width = 20; width <= 110; width += 1) {
        expect(displayWidth(marked(width)), `width ${width}`).toBeLessThanOrEqual(width)
      }
    })
  })
})
