import { join } from "node:path"

import { existsSync, readFileSync } from "node:fs"

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import {
  containCard,
  deleteKittyImages,
  kittyGraphicsSupported,
  placeKittyImage,
  pngDimensions,
  pngIsWellFormed,
  probeKittyGraphics,
  terminalCellAspectRatio,
  transmitKittyImage,
} from "./kitty-graphics"
import { tintPngToAccent } from "./png-tint"
import {
  chunksLength,
  displayWidth,
  joinLines,
  padBetween,
  paletteForTerminal,
  raw,
  setTheme,
  shortPath,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import { versionDetails } from "./version"
import { homeRendererConfig, sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { PaletteColor } from "./tui-theme"

/** One of the four home destinations; doubles as the key for its photo asset. */
export type HomeDestination = "pipelines" | "specs" | "runs" | "config"
export type HomeSelection = HomeDestination | undefined

type HomeItem = {
  id: HomeDestination
  shortcut: string
  label: string
  kicker: string
  description: string
}

// Poster photos, one per destination: assets/home/<kind>.png, shown as a
// centered contain-fit card. A kind without a valid file falls back to the
// centered navigation-only layout.
const IMAGE_BASE_ID = 100
const IMAGE_PADDING_COLS = 1
const CHROME_PADDING_COLS = 1
const TOP_PAD_ROWS = 1
const BOTTOM_PAD_ROWS = 2
const IMAGE_GAP_ROWS = 1
/** Two rows keep the destination column clearly separated under the poster. */
const DOCK_GAP_ROWS = 2
/** The contextual description wraps to at most this many centered rows. */
const DESCRIPTION_LINES = 2
/** Hard width ceiling for the centered description block, in cells. */
const DESCRIPTION_MAX_COLS = 48
const WORDMARK_GAP = "  "
/** Blank rows separating the poster wordmark from the photo card. */
const WORDMARK_IMAGE_GAP_ROWS = 2
/** Graphics-mode chrome is a single faint project/version row. */
const SLIM_CHROME_ROWS = 1
/** Hard ceiling on the centered photo card, in cells. */
export const homePosterMaxCols = 60
export const homePosterMaxRows = 50
/** Below this many card rows the dither is noise: use the nav fallback. */
const HOME_POSTER_MIN_CARD_ROWS = 4

/**
 * Shared geometry for the graphics-mode poster. `render()` paints the backing
 * canvas from it and `syncImage()` places the photo from it, so the wordmark
 * rows and the image rect are computed once and can never disagree. Undefined
 * means "no poster": fall back to the centered navigation-only layout.
 */
type PosterLayout = {
  artTop: number
  /** Content rows of the art canvas: top margin + wordmark + gap + card. */
  artHeight: number
  topPad: number
  /** Blank rows under the description — mirrors `topPad` so the block centers. */
  bottomPad: number
  wordmarkRows: number
  wordmarkCol: number
  cardCol: number
  cardRow: number
  cardCols: number
  cardRows: number
  sourceWidth: number
  sourceHeight: number
}

const CONVOY_WORDMARK: Readonly<Record<string, readonly [string, string, string]>> = {
  C: ["████", "██  ", "████"],
  O: ["████", "█  █", "████"],
  N: ["█  █", "██ █", "█ ██"],
  V: ["█  █", "█  █", " ██ "],
  Y: ["█  █", " ██ ", " ██ "],
}

const CONVOY_LETTERS = [..."CONVOY"]
const CONVOY_WORDMARK_WIDTH = CONVOY_LETTERS.reduce(
  (width, letter, index) => width + CONVOY_WORDMARK[letter]![0].length + (index > 0 ? WORDMARK_GAP.length : 0),
  0,
)

function homeImagePath(kind: HomeDestination): string {
  const relative = join("assets", "home", `${kind}.png`)
  // Running from source resolves next to the module; built binaries and
  // installs fall back to the process working directory. First existing wins.
  const candidates = [join(import.meta.dir, "..", relative), join(process.cwd(), relative)]
  return candidates.find((path) => existsSync(path)) ?? candidates[0]!
}

const homeItems: readonly HomeItem[] = [
  {
    id: "pipelines",
    shortcut: "p",
    label: "Pipelines",
    kicker: "From intent to ship",
    description: "Compose agents into a reviewed, repeatable path from intent to shipped code.",
  },
  {
    id: "specs",
    shortcut: "s",
    label: "Specs",
    kicker: "The living spec",
    description: "Explore, shape, run, and close work around the project's living specification.",
  },
  {
    id: "runs",
    shortcut: "r",
    label: "Runs",
    kicker: "Live and history",
    description: "Follow live execution and revisit the history, reports, and decisions behind every run.",
  },
  {
    id: "config",
    shortcut: "c",
    label: "Config",
    kicker: "Models and agents",
    description: "Tune models, agents, pipelines, permissions, hooks, and project defaults.",
  },
]

/** At this width and below, the home is considered compact (footer hints, art fit). */
export const compactHomeMaxWidth = 72

export async function launchHomeTui(
  targetDir: string,
  options: { route?: TuiRoute; initialSelection?: HomeDestination; kittyGraphics?: boolean } = {},
): Promise<HomeSelection> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("convoy needs an interactive terminal to open the home launcher")
  }

  if (options.route) {
    const scene = sceneForRoute(options.route, "convoy-home-scene")!
    return new HomeLauncher(options.route.session.renderer, targetDir, {
      scene,
      initialSelection: options.initialSelection,
      kittyGraphics: options.kittyGraphics,
    }).result
  }

  // Probe before the renderer takes stdin: over SSH the client's environment
  // doesn't travel with the session, so the terminal itself has to answer
  // whether it speaks the Kitty graphics protocol.
  const kittyGraphics = await probeKittyGraphics()
  const renderer = await createCliRenderer(homeRendererConfig(kittyGraphics))
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new HomeLauncher(renderer, targetDir, { initialSelection: options.initialSelection, kittyGraphics }).result
}

export class HomeLauncher {
  readonly result: Promise<HomeSelection>

  private resolveResult!: (selection: HomeSelection) => void
  private selected = 0
  private finished = false
  private readonly scene?: TuiScene
  /** Kitty-graphics mode: the selected destination's photo owns the canvas. */
  private readonly imageMode: boolean
  /** Physical width/height of one terminal cell, measured before the renderer starts. */
  private readonly cellAspectRatio: number
  /** Pixel data already sitting in the terminal's image store. */
  private readonly transmittedImages = new Set<HomeDestination>()
  /** Accent the currently stored photos were tinted with; a theme change re-sends. */
  private transmittedAccent = ""
  /** Tinted PNG bytes, keyed by kind + accent so a theme flip is one decode. */
  private readonly tintedPngByKind = new Map<string, Buffer>()
  /** Resolved photo path per kind; undefined means missing or a damaged PNG. */
  private readonly imagePathByKind = new Map<HomeDestination, string | undefined>()
  /** Poster backing canvases keep transparent photo pixels free of stale glyphs. */
  private readonly blankArtBySize = new Map<string, StyledText>()
  private placedImage: { kind: HomeDestination; width: number; height: number } | undefined

  private readonly wordmarkText: TextRenderable
  private readonly wordmarkBox: BoxRenderable
  private readonly artText: TextRenderable
  private readonly artBox: BoxRenderable
  private readonly dockBox: BoxRenderable
  private readonly tabsText: TextRenderable
  private readonly destinationsText: TextRenderable
  private readonly destinationsBox: BoxRenderable
  private readonly descriptionText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    this.clearPlacedImage()
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  /**
   * Photos are painted strictly AFTER a renderer frame has hit the screen:
   * a repaint that clears the display erases image placements (per the
   * graphics spec), so drawing before a frame would put the photo under the
   * erase. Drawing here also makes selection changes and resizes re-place the
   * image over the freshly painted frame without re-sending its pixel data.
   */
  private readonly handleFrame = () => {
    if (this.finished || this.renderer.isDestroyed) return
    this.syncImage()
  }

  private readonly handleResize = () => {
    // Remove the old cell rectangle before OpenTUI paints the resized frame.
    // Some protocol implementations otherwise retain fragments of both sizes.
    this.clearPlacedImage()
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.finish(undefined)
      return
    }

    key.preventDefault()
    key.stopPropagation()

    if (!key.ctrl && !key.meta && !key.option) {
      const direct = homeItems.find((item) => item.shortcut === key.name)
      if (direct) {
        this.finish(direct.id)
        return
      }
    }

    switch (key.name) {
      case "up":
      case "k":
      case "left":
      case "h":
        this.move(-1)
        return
      case "down":
      case "j":
      case "right":
      case "l":
        this.move(1)
        return
      case "return":
      case "linefeed":
        this.finish(homeItems[this.selected]!.id)
        return
      case "q":
      case "escape":
        this.finish(undefined)
        return
    }
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    options: { scene?: TuiScene; initialSelection?: HomeDestination; kittyGraphics?: boolean } = {},
  ) {
    this.scene = options.scene
    // Photos only when the terminal speaks the Kitty graphics protocol (the
    // probed result wins when provided) and a real TTY is attached (tests and
    // pipes use the centered navigation-only fallback). Shared-session homes
    // are included:
    // the session renderer uses passthrough stdout, and the frame hook keeps
    // image traffic ordered against its repaints.
    this.imageMode = (options.kittyGraphics ?? kittyGraphicsSupported()) && process.stdout.isTTY === true
    this.cellAspectRatio = terminalCellAspectRatio()
    const initialIndex = options.initialSelection ? homeItems.findIndex((item) => item.id === options.initialSelection) : -1
    if (initialIndex >= 0) this.selected = initialIndex
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    const mount = this.scene?.root ?? renderer.root

    const shell = new BoxRenderable(renderer, {
      id: "convoy-home-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
    })
    const wordmarkBox = new BoxRenderable(renderer, {
      id: "convoy-home-wordmark",
      width: "100%",
      height: 3,
      flexShrink: 0,
      backgroundColor: theme.bg,
      paddingX: CHROME_PADDING_COLS,
      paddingTop: TOP_PAD_ROWS,
    })
    const wordmarkText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    wordmarkBox.add(wordmarkText)
    const body = new BoxRenderable(renderer, {
      id: "convoy-home-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "column",
      backgroundColor: theme.bg,
    })
    const artBox = new BoxRenderable(renderer, {
      id: "convoy-home-art",
      width: "100%",
      flexGrow: 1,
      backgroundColor: theme.bg,
    })
    const artText = new TextRenderable(renderer, {
      content: "",
      fg: theme.text,
      width: "100%",
      height: "100%",
      wrapMode: "none",
    })
    artBox.add(artText)
    // The destination strip stays borderless: shortcuts and labels on one row
    // when wide, stacked when compact, followed by one contextual description.
    const dock = new BoxRenderable(renderer, {
      id: "convoy-home-dock",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: theme.bg,
      paddingBottom: BOTTOM_PAD_ROWS,
    })
    const tabsText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    const destinationsBox = new BoxRenderable(renderer, {
      id: "convoy-home-destinations",
      width: "100%",
      flexDirection: "column",
      backgroundColor: theme.bg,
    })
    const destinationsText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    destinationsBox.add(destinationsText)
    const descriptionText = new TextRenderable(renderer, {
      content: "",
      fg: theme.dim,
      width: "100%",
      wrapMode: "none",
    })

    this.wordmarkText = wordmarkText
    this.wordmarkBox = wordmarkBox
    this.artText = artText
    this.artBox = artBox
    this.dockBox = dock
    this.tabsText = tabsText
    this.destinationsText = destinationsText
    this.destinationsBox = destinationsBox
    this.descriptionText = descriptionText

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: wordmarkBox, background: "bg" },
      { box: body, background: "bg" },
      { box: artBox, background: "bg" },
      { box: dock, background: "bg" },
      { box: destinationsBox, background: "bg" },
    )

    dock.add(tabsText)
    dock.add(destinationsBox)
    dock.add(descriptionText)
    body.add(artBox)
    body.add(dock)
    shell.add(wordmarkBox)
    shell.add(body)
    mount.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("resize", this.handleResize)
    renderer.on("theme_mode", this.handleThemeMode)
    renderer.on("frame", this.handleFrame)
    this.render()
  }

  private move(delta: number) {
    const next = Math.max(0, Math.min(homeItems.length - 1, this.selected + delta))
    if (next !== this.selected) {
      // Retire the old placement before the renderer clears and redraws the
      // backing canvas for the next selection.
      this.clearPlacedImage()
      this.selected = next
    }
    this.render()
  }

  private finish(selection: HomeSelection) {
    if (this.finished) return
    this.finished = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("resize", this.handleResize)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.renderer.off("frame", this.handleFrame)
    // Take the photos down and free their pixel data before the renderer
    // restores the screen; kitty placements survive text repaints, so they
    // must be deleted explicitly.
    if (this.imageMode) deleteKittyImages(homeItems.map((_, index) => IMAGE_BASE_ID + index), true)
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult(selection)
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
  }

  private render() {
    if (this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(1, this.renderer.width)
    const chromeWidth = Math.max(1, width - CHROME_PADDING_COLS * 2)
    const row = this.usesRowTabs()
    const layout = this.posterLayout()
    const hasPoster = layout !== undefined
    this.tabsText.visible = row
    this.destinationsBox.visible = !row
    const dockHeight = this.dockRows()
    // Poster mode swaps the block-wordmark masthead for a slim chrome row;
    // the wordmark itself moves into the centered art canvas.
    const chromeRows = hasPoster ? TOP_PAD_ROWS + SLIM_CHROME_ROWS : this.mastheadRows(width)
    const availableBodyHeight = Math.max(1, this.renderer.height - chromeRows)
    const gap = hasPoster ? IMAGE_GAP_ROWS + DOCK_GAP_ROWS : 0
    const artHeight = hasPoster ? layout.artHeight : Math.max(1, availableBodyHeight - dockHeight - BOTTOM_PAD_ROWS - gap)
    this.wordmarkBox.height = chromeRows
    this.artBox.visible = hasPoster
    this.artBox.flexGrow = hasPoster ? 1 : 0
    this.artBox.height = hasPoster ? artHeight : 0
    this.artBox.marginTop = hasPoster ? IMAGE_GAP_ROWS : 0
    this.artBox.marginBottom = hasPoster ? DOCK_GAP_ROWS : 0
    this.dockBox.flexGrow = hasPoster ? 0 : 1
    // Poster mode: the dock keeps its content height plus the block's bottom
    // margin, so wordmark+card+controls center as one unit (topPad mirrors
    // bottomPad). Fallback mode stretches over the body as before.
    this.dockBox.height = hasPoster ? dockHeight + layout.bottomPad : availableBodyHeight
    // Deterministic centering: explicit top padding instead of flex centering,
    // whose sub-row rounding swallows spacer rows at odd terminal heights.
    this.dockBox.paddingTop = hasPoster ? 0 : Math.max(0, Math.floor((availableBodyHeight - BOTTOM_PAD_ROWS - dockHeight) / 2))
    this.dockBox.paddingBottom = hasPoster ? layout.bottomPad : BOTTOM_PAD_ROWS
    this.destinationsBox.height = homeItems.length

    this.wordmarkText.content = hasPoster ? this.chromeContent(chromeWidth) : this.wordmarkContent(chromeWidth)
    this.artText.content = hasPoster ? this.posterArtContent(width, layout) : new StyledText([raw("")])
    this.descriptionText.content = this.descriptionContent(width)
    if (row) {
      this.tabsText.content = this.tabsContent(width)
    } else {
      this.destinationsText.content = this.destinationsContent(width)
    }
    // The photo sync happens in handleFrame, after this paint hits the
    // screen — never before it.
    this.renderer.requestRender()
  }

  /**
   * One deterministic source of truth for the poster: slim chrome above, and
   * ONE centered block — wordmark, photo card, controls, description — that
   * keeps equal blank margins above the wordmark and below the description.
   * The controls always follow the image after the fixed dock gap, so extra
   * height never piles up between the photo and the selector. Returns
   * undefined when the selected kind has no valid photo or the canvas cannot
   * fit wordmark + gap + a useful (≥ HOME_POSTER_MIN_CARD_ROWS) card with its
   * clearances — the kind then uses the centered navigation-only fallback.
   */
  private posterLayout(): PosterLayout | undefined {
    if (!this.imageMode) return undefined
    const kind = homeItems[this.selected]!.id
    const path = this.imageFor(kind)
    if (!path) return undefined
    const png = this.photoPng(kind, path)
    const dimensions = png ? pngDimensions(png) : undefined
    if (!png || !dimensions) return undefined
    const width = Math.max(1, this.renderer.width)
    const wordmarkRows = width >= CONVOY_WORDMARK_WIDTH ? 3 : 1
    const wordmarkWidth = wordmarkRows === 3 ? CONVOY_WORDMARK_WIDTH : "CONVOY".length
    const chromeRows = TOP_PAD_ROWS + SLIM_CHROME_ROWS
    const body = Math.max(1, this.renderer.height - chromeRows)
    const fixedRows = IMAGE_GAP_ROWS + DOCK_GAP_ROWS + wordmarkRows + WORDMARK_IMAGE_GAP_ROWS + this.dockRows()
    // One blank row reserved on each side of the block so it never touches
    // an edge; the fit math matches the card budget of the dock clearance.
    const cardAvailableRows = body - fixedRows - 2
    if (cardAvailableRows < HOME_POSTER_MIN_CARD_ROWS) return undefined
    const card = containCard({
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
      availableCols: Math.max(1, width - IMAGE_PADDING_COLS * 2),
      availableRows: cardAvailableRows,
      cellAspect: this.cellAspectRatio,
      maxCols: homePosterMaxCols,
      maxRows: homePosterMaxRows,
    })
    // A narrow terminal can cap the card below the budget via the width axis;
    // that dither would be noise, so fall back instead.
    if (card.rows < HOME_POSTER_MIN_CARD_ROWS) return undefined
    // Center the whole block: leftover rows split into the margin above the
    // wordmark and the margin below the description (card ≤ budget keeps
    // this ≥ 2, so each margin gets at least one blank row).
    const free = body - fixedRows - card.rows
    const topPad = Math.floor(free / 2)
    const artTop = chromeRows + IMAGE_GAP_ROWS
    return {
      artTop,
      artHeight: topPad + wordmarkRows + WORDMARK_IMAGE_GAP_ROWS + card.rows,
      topPad,
      bottomPad: free - topPad,
      wordmarkRows,
      wordmarkCol: Math.max(0, Math.floor((width - wordmarkWidth) / 2)),
      cardCol: Math.max(0, Math.floor((width - card.cols) / 2)),
      cardRow: artTop + topPad + wordmarkRows + WORDMARK_IMAGE_GAP_ROWS,
      cardCols: card.cols,
      cardRows: card.rows,
      sourceWidth: dimensions.width,
      sourceHeight: dimensions.height,
    }
  }

  /** Backing canvas for the poster: blank everywhere (the photo's transparent
   *  holes must never reveal stale glyphs) except the centered wordmark rows. */
  private posterArtContent(width: number, layout: PosterLayout): StyledText {
    const key = `poster:${width}x${layout.artHeight}x${layout.topPad}x${layout.wordmarkRows}`
    const cached = this.blankArtBySize.get(key)
    if (cached) return cached
    const blankLine = " ".repeat(Math.max(1, width))
    const lines: StyledText[] = Array.from({ length: Math.max(1, layout.artHeight) }, () => new StyledText([raw(blankLine)]))
    this.posterWordmarkLines(width, layout.wordmarkCol, layout.wordmarkRows).forEach((line, index) => {
      const row = layout.topPad + index
      if (row >= 0 && row < lines.length) lines[row] = line
    })
    const content = joinLines(lines)
    this.blankArtBySize.set(key, content)
    return content
  }

  /** Block CONVOY centered for the poster; a text wordmark when too narrow. */
  private posterWordmarkLines(width: number, col: number, rows: number): StyledText[] {
    const indent = " ".repeat(Math.max(0, col))
    const pad = (chunks: TextChunk[], used: number): TextChunk[] => {
      const trailing = Math.max(0, width - used)
      return trailing > 0 ? [...chunks, raw(" ".repeat(trailing))] : chunks
    }
    if (rows <= 1) {
      return [new StyledText(pad([raw(indent), bold(fg(theme.text)("CONVOY"))], col + "CONVOY".length))]
    }
    return [0, 1, 2].map((glyphRow) => {
      const chunks: TextChunk[] = [raw(indent)]
      CONVOY_LETTERS.forEach((letter, index) => {
        if (index > 0) chunks.push(raw(WORDMARK_GAP))
        chunks.push(bold(fg(theme.text)(CONVOY_WORDMARK[letter]![glyphRow]!)))
      })
      return new StyledText(pad(chunks, col + CONVOY_WORDMARK_WIDTH))
    })
  }

  /** Graphics-mode chrome: one faint row, labeled project left, version right. */
  private chromeContent(width: number): StyledText {
    const project = shortPath(this.targetDir, Math.max(1, width - 9))
    return this.alignRight(
      [fg(theme.faint)("project  "), fg(theme.faint)(project)],
      [fg(theme.faint)(versionDetails())],
      width,
    )
  }

  /** Destination row(s) + spacer + contextual description. */
  private dockRows() {
    // Selector rows + one blank spacer + the wrapped description block.
    return (this.usesRowTabs() ? 1 : homeItems.length) + 1 + DESCRIPTION_LINES
  }

  private wordmarkGlyphRows(width: number) {
    const rightNeeded = Math.max(displayWidth(versionDetails()), 16)
    return width >= CONVOY_WORDMARK_WIDTH + rightNeeded + 1 ? 3 : 2
  }

  /** Shared masthead row total (top padding + wordmark) for layout and Kitty placement. */
  private mastheadRows(width = this.renderer.width) {
    const chromeWidth = Math.max(1, width - CHROME_PADDING_COLS * 2)
    return this.wordmarkGlyphRows(chromeWidth) + TOP_PAD_ROWS
  }

  /**
   * Wide non-poster terminals put the four destinations on one centered row.
   * The graphics poster always lists them as a centered column beneath the
   * card, at any width. Keyed on photo validity (not the fitted layout) so
   * `posterLayout` can consume `dockRows` without recursing.
   */
  private usesRowTabs() {
    if (this.imageMode && this.imageFor(homeItems[this.selected]!.id) !== undefined) return false
    return this.renderer.width > compactHomeMaxWidth
  }



  /** Masthead lines: block wordmark left, full version and project path
   *  right-aligned beside it. Narrow screens swap to a text wordmark. */
  private wordmarkContent(width: number): StyledText {
    if (this.wordmarkGlyphRows(width) === 2) {
      const mark = [bold(fg(theme.text)("CONVOY"))]
      const versionLine = this.alignRight(mark, [fg(theme.faint)(versionDetails())], width)
      const project = shortPath(this.targetDir, Math.max(1, width-9))
      return joinLines([
        versionLine,
        new StyledText([fg(theme.faint)("project  "), fg(theme.text)(project)]),
      ])
    }

    const lines = Array.from({ length:3 }, (_, row) => {
      const chunks: TextChunk[] = []
      CONVOY_LETTERS.forEach((letter , index) => {
        if (index>0) chunks.push(raw(WORDMARK_GAP))
        chunks.push(bold(fg(theme.text)(CONVOY_WORDMARK[letter]![row]!)))
      })
      if (row===0) return this.alignRight(chunks , [fg(theme.faint)(versionDetails())], width)
      if (row===1) return this.alignRight(chunks , [fg(theme.text)(shortPath(this.targetDir , Math.max(1, width-CONVOY_WORDMARK_WIDTH)))], width)
      return new StyledText(chunks)
    })
    return joinLines(lines)
  }

  /** Left flush, right flush, ellipsis-clipped when they can't share. */
  private alignRight(left: TextChunk[], right: TextChunk[], width: number): StyledText {
    return padBetween(left, right, width)
  }


  private imageFor(kind: HomeDestination): string | undefined {
    if (!this.imageMode) return undefined
    if (this.imagePathByKind.has(kind)) return this.imagePathByKind.get(kind)
    const path = homeImagePath(kind)
    // Ghostty's decoder is strict: a PNG with a bad IDAT CRC (Preview will
    // still show a sliver) transmits as a black rectangle. A damaged asset uses
    // the same centered navigation-only fallback as a terminal without Kitty.
    const resolved = existsSync(path) && pngIsWellFormed(path) ? path : undefined
    this.imagePathByKind.set(kind, resolved)
    return resolved
  }

  /** Decode + recolor once per kind per accent; white paper becomes alpha. */
  private photoPng(kind: HomeDestination, path: string): Buffer | undefined {
    const key = `${kind}:${theme.accent}`
    const cached = this.tintedPngByKind.get(key)
    if (cached) return cached
    let source: Buffer
    try {
      source = readFileSync(path)
    } catch {
      return undefined
    }
    const tinted = tintPngToAccent(source, theme.accent)
    this.tintedPngByKind.set(key, tinted)
    return tinted
  }

  private imageId(kind: HomeDestination): number {
    return IMAGE_BASE_ID + Math.max(0, homeItems.findIndex((item) => item.id === kind))
  }

  /** Deletes only the placement; transmitted pixels stay cached for reuse. */
  private clearPlacedImage() {
    if (!this.placedImage) return
    deleteKittyImages([this.imageId(this.placedImage.kind)])
    this.placedImage = undefined
  }

  /**
   * Keeps the photo in sync with the selection and the canvas size. The
   * split matters: pixel data is transmitted once per kind, while the
   * placement is re-issued after every frame — startup repaints (theme and
   * size query responses) and resizes erase placements, and this heals them
   * within one frame. Same image id + placement id replaces in place, so the
   * re-issue is a tiny escape, not a re-send.
   */
  private syncImage() {
    const kind = homeItems[this.selected]!.id
    const id = this.imageId(kind)
    const layout = this.posterLayout()
    if (!layout) {
      // No displayable photo for this kind (missing, damaged, or the canvas
      // is too small for the poster): clear any lingering placement before
      // the centered navigation-only fallback is painted.
      this.clearPlacedImage()
      return
    }
    if (this.transmittedAccent !== theme.accent) {
      this.transmittedImages.clear()
      this.transmittedAccent = theme.accent
    }
    const png = this.photoPng(kind, this.imageFor(kind)!)
    if (!png) return
    if (!this.transmittedImages.has(kind)) {
      if (!transmitKittyImage({ id, png })) return
      this.transmittedImages.add(kind)
    }
    const { cardCols: cols, cardRows: rows } = layout
    const changed =
      !this.placedImage || this.placedImage.kind !== kind || this.placedImage.width !== cols || this.placedImage.height !== rows
    if (changed) {
      // Explicit deletion is more portable than relying on every Kitty-
      // protocol implementation to replace a resized placement atomically.
      this.clearPlacedImage()
      this.placedImage = { kind, width: cols, height: rows }
    }
    // Contain fit: the full source rect into the cell-correct centered card,
    // so the illustration is never cropped.
    placeKittyImage({
      id,
      col: layout.cardCol,
      row: layout.cardRow,
      cols,
      rows,
      source: { x: 0, y: 0, width: layout.sourceWidth, height: layout.sourceHeight },
    })
  }

  /** The four destinations on one centered row, with fixed marker slots. */
  private tabsContent(width: number): StyledText {
    const chunks: TextChunk[] = []
    homeItems.forEach((item, index) => {
      if (index > 0) chunks.push(fg(theme.text)("    "))
      chunks.push(...this.destinationItem(item, index === this.selected))
    })
    const indent = " ".repeat(Math.max(0, Math.floor((width - chunksLength(chunks)) / 2)))
    return new StyledText([raw(indent), ...chunks])
  }

  private destinationsContent(width: number) {
    const rows = homeItems.map((item, index) => this.destinationRow(item, index === this.selected))
    // Center the block as a whole: a left-aligned column of equal-width rows
    // keeps the keys and labels in a straight rail — per-row centering would
    // scatter them.
    const blockWidth = Math.max(
      ...homeItems.map((item) => chunksLength(this.destinationItem(item, false))))
    const indent = " ".repeat(Math.max(0, Math.floor((width - blockWidth) / 2)))
    return joinLines(rows.map((row) => new StyledText([raw(indent), ...row])))
  }

  /** One centered, clipped line explaining the selected destination, preceded by
   *  its own blank spacer row (in-content, so flex rounding can't collapse it). */
  private descriptionContent(width: number): StyledText {
    const available = Math.min(Math.max(1, width - 4), DESCRIPTION_MAX_COLS)
    const lines = this.descriptionLines(homeItems[this.selected]!.description, available)
    const centered = lines.map((text) => {
      const line = new StyledText([fg(theme.dim)(text)])
      const indent = " ".repeat(Math.max(0, Math.floor((width - chunksLength(line.chunks)) / 2)))
      return new StyledText([raw(indent), ...line.chunks])
    })
    return joinLines([new StyledText([raw("")]), ...centered])
  }

  /**
   * The description block never spans the terminal: it caps at `maxCols` and
   * wraps to at most `DESCRIPTION_LINES` rows, splitting near the middle at a
   * word boundary so the centered pair reads as a subtitle instead of a
   * greedy line + orphan. When even two rows can't hold it, the first row
   * greedy-fills and the rest ellipsis-clips.
   */
  private descriptionLines(text: string, maxCols: number): string[] {
    if (displayWidth(text) <= maxCols) return [text]
    const words = text.split(" ")
    let best: [string, string] | undefined
    let bestDiff = Number.POSITIVE_INFINITY
    for (let index = 1; index < words.length; index++) {
      const left = words.slice(0, index).join(" ")
      const right = words.slice(index).join(" ")
      const leftCells = displayWidth(left)
      const rightCells = displayWidth(right)
      if (leftCells > maxCols || rightCells > maxCols) continue
      const diff = Math.abs(leftCells - rightCells)
      if (diff < bestDiff) {
        best = [left, right]
        bestDiff = diff
      }
    }
    if (best) return best
    const head: string[] = []
    let cells = 0
    let index = 0
    while (index < words.length) {
      const add = displayWidth(words[index]!) + (head.length > 0 ? 1 : 0)
      if (cells + add > maxCols) break
      head.push(words[index]!)
      cells += add
      index++
    }
    if (head.length === 0) return [truncate(text, maxCols)]
    return [head.join(" "), truncate(words.slice(index).join(" "), maxCols)]
  }

  /** `◆ [P]  PIPELINES ◆`; inactive items retain equal-width marker slots. */
  private destinationItem(item: HomeItem, selected: boolean): TextChunk[] {
    const key = `[${item.shortcut.toUpperCase()}]`
    const label = item.label.toUpperCase()
    const leadingMarker = selected ? fg(theme.accent)("◆") : raw(" ")
    const trailingMarker = selected ? fg(theme.accent)("◆") : raw(" ")
    if (selected) {
      return [leadingMarker, raw(" "), bold(fg(theme.accent)(key)), raw("  "), bold(fg(theme.accent)(label)), raw(" "), trailingMarker]
    }
    return [leadingMarker, raw(" "), fg(theme.text)(key), raw("  "), fg(theme.text)(label), raw(" "), trailingMarker]
  }

  /** One row per destination in the narrow stack. */
  private destinationRow(item: HomeItem, selected: boolean): TextChunk[] {
    return this.destinationItem(item, selected)
  }

}
