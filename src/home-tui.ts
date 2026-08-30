import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg } from "@opentui/core"

import { homeArtMorphFrames, homeArtTickMs, renderHomeArt, type HomeArtKind, type Vec3 } from "./home-art"
import {
  chunksLength,
  clipChunks,
  displayWidth,
  hintsRow,
  joinLines,
  moreHintsMarker,
  paletteForTerminal,
  raw,
  setTheme,
  shortPath,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import { shortVersion } from "./version"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { Hint, PaletteColor } from "./tui-theme"

export type HomeDestination = HomeArtKind
export type HomeSelection = HomeDestination | undefined

type HomeItem = {
  id: HomeDestination
  shortcut: string
  label: string
  description: string
}

const homeItems: readonly HomeItem[] = [
  {
    id: "pipelines",
    shortcut: "p",
    label: "Pipelines",
    description: "Compose agents into a reviewed, repeatable path from intent to shipped code.",
  },
  {
    id: "specs",
    shortcut: "s",
    label: "Specs",
    description: "Explore, shape, run, and close work around the project's living specification.",
  },
  {
    id: "runs",
    shortcut: "r",
    label: "Runs",
    description: "Follow live execution and revisit the history, reports, and decisions behind every run.",
  },
  {
    id: "config",
    shortcut: "c",
    label: "Config",
    description: "Tune models, agents, pipelines, permissions, hooks, and project defaults.",
  },
]

/** At this width and below, the four destinations become a centered 2×2 grid. */
export const compactHomeMaxWidth = 72

export async function launchHomeTui(
  targetDir: string,
  options: { route?: TuiRoute; initialSelection?: HomeDestination } = {},
): Promise<HomeSelection> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("convoy needs an interactive terminal to open the home launcher")
  }

  if (options.route) {
    const scene = sceneForRoute(options.route, "convoy-home-scene")!
    return new HomeLauncher(options.route.session.renderer, targetDir, { scene, initialSelection: options.initialSelection }).result
  }

  const renderer = await createCliRenderer({ screenMode: "alternate-screen", consoleMode: "console-overlay", exitOnCtrlC: false })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new HomeLauncher(renderer, targetDir, { initialSelection: options.initialSelection }).result
}

export class HomeLauncher {
  readonly result: Promise<HomeSelection>

  private resolveResult!: (selection: HomeSelection) => void
  private selected = 0
  private finished = false
  private tick = 0
  private morph = 1
  private morphFrom: HomeDestination = "pipelines"
  private cloud: Vec3[] | undefined
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly scene?: TuiScene

  private readonly headerText: TextRenderable
  private readonly artText: TextRenderable
  private readonly artBox: BoxRenderable
  private readonly destinationsText: TextRenderable
  private readonly destinationsBox: BoxRenderable
  private readonly overviewBox: BoxRenderable
  private readonly overviewText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handleResize = () => this.render()

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
    options: { scene?: TuiScene; initialSelection?: HomeDestination } = {},
  ) {
    this.scene = options.scene
    const initialIndex = options.initialSelection ? homeItems.findIndex((item) => item.id === options.initialSelection) : -1
    if (initialIndex >= 0) {
      this.selected = initialIndex
      this.morphFrom = homeItems[initialIndex]!.id
    }
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
      paddingX: 1,
    })
    const header = this.panel({
      id: "convoy-home-header",
      height: 3,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: ` convoy ${shortVersion()} `,
      titleAlignment: "left",
    })
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
    // Destinations and overview float: no border, no title, just the rows,
    // glued to the bottom of the body with one row of air between them.
    const destinationsBox = new BoxRenderable(renderer, {
      id: "convoy-home-destinations",
      width: "100%",
      flexDirection: "column",
      backgroundColor: theme.bg,
    })
    const destinationsText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    destinationsBox.add(destinationsText)
    const dockGap = new BoxRenderable(renderer, {
      id: "convoy-home-dock-gap",
      width: "100%",
      height: 1,
      backgroundColor: theme.bg,
    })
    const overviewBox = new BoxRenderable(renderer, {
      id: "convoy-home-overview",
      width: "100%",
      flexDirection: "column",
      backgroundColor: theme.bg,
    })
    const overviewText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", wrapMode: "none" })
    overviewBox.add(overviewText)
    const dockTail = new BoxRenderable(renderer, {
      id: "convoy-home-dock-tail",
      width: "100%",
      height: 1,
      backgroundColor: theme.bg,
    })
    const dock = new BoxRenderable(renderer, {
      id: "convoy-home-dock",
      width: "100%",
      flexShrink: 0,
      flexDirection: "column",
      backgroundColor: theme.bg,
    })
    const footer = this.panel({
      id: "convoy-home-footer",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
    })

    this.headerText = header.text
    this.artText = artText
    this.artBox = artBox
    this.destinationsText = destinationsText
    this.destinationsBox = destinationsBox
    this.overviewText = overviewText
    this.overviewBox = overviewBox
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header.box, background: "bg", border: "border" },
      { box: body, background: "bg" },
      { box: artBox, background: "bg" },
      { box: dock, background: "bg" },
      { box: destinationsBox, background: "bg" },
      { box: dockGap, background: "bg" },
      { box: overviewBox, background: "bg" },
      { box: dockTail, background: "bg" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    dock.add(destinationsBox)
    dock.add(dockGap)
    dock.add(overviewBox)
    dock.add(dockTail)
    body.add(artBox)
    body.add(dock)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    mount.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("resize", this.handleResize)
    renderer.on("theme_mode", this.handleThemeMode)
    this.ticker = setInterval(() => {
      if (this.finished || this.renderer.isDestroyed) return
      this.tick += 1
      if (this.morph < 1) this.morph = Math.min(1, this.morph + 1 / homeArtMorphFrames)
      this.render()
    }, homeArtTickMs)
    this.ticker.unref?.()
    this.render()
  }

  private move(delta: number) {
    const next = Math.max(0, Math.min(homeItems.length - 1, this.selected + delta))
    if (next !== this.selected) {
      this.morphFrom = homeItems[this.selected]!.id
      this.morph = 0
      this.selected = next
    }
    this.render()
  }

  private finish(selection: HomeSelection) {
    if (this.finished) return
    this.finished = true
    clearInterval(this.ticker)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("resize", this.handleResize)
    this.renderer.off("theme_mode", this.handleThemeMode)
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult(selection)
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: "rounded",
      paddingX: 1,
      paddingY: 0,
      ...options,
    })
    const text = new TextRenderable(this.renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    box.add(text)
    return { box, text }
  }

  private render() {
    if (this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(1, this.renderer.width - 6)
    const compact = this.renderer.width <= compactHomeMaxWidth
    const destinationsHeight = compact ? 2 : 1
    const dockHeight = destinationsHeight + 3
    const availableBodyHeight = Math.max(1, this.renderer.height - 6)
    const artHeight = Math.max(4, availableBodyHeight - dockHeight)
    this.artBox.height = artHeight
    this.destinationsBox.height = destinationsHeight
    this.overviewBox.height = 1

    this.headerText.content = this.headerContent(width)
    this.artText.content = this.artContent(Math.max(1, this.renderer.width - 2), artHeight)
    this.destinationsText.content = this.destinationsContent(width, compact)
    this.overviewText.content = this.overviewContent(width)
    this.footerText.content = this.footerContent(width)
    this.renderer.requestRender()
  }

  private headerContent(width: number) {
    const pathWidth = Math.max(1, width - 9)
    return new StyledText([fg(theme.faint)("project  "), fg(theme.text)(shortPath(this.targetDir, pathWidth))])
  }

  private artContent(width: number, height: number) {
    const kind = homeItems[this.selected]!.id
    const frame = renderHomeArt({
      kind,
      previous: this.morphFrom,
      from: this.cloud,
      morph: this.morph,
      tick: this.tick,
      width,
      height,
    })
    this.cloud = frame.cloud
    return frame.content
  }

  private destinationsContent(width: number, compact: boolean) {
    if (!compact) return this.destinationLine([0, 1, 2, 3], width)
    return joinLines([this.destinationLine([0, 1], width), this.destinationLine([2, 3], width)])
  }

  private destinationLine(indices: readonly number[], width: number): StyledText {
    const chunks: TextChunk[] = []
    indices.forEach((index, position) => {
      const item = homeItems[index]!
      const selected = index === this.selected
      if (position > 0) chunks.push(raw("    "))
      chunks.push(selected ? fg(theme.accent)("▸ ") : raw("  "))
      chunks.push(fg(selected ? theme.accent : theme.dim)(`[${item.shortcut}]`), raw(" "))
      chunks.push(selected ? bold(fg(theme.text)(item.label.toUpperCase())) : fg(theme.text)(item.label.toUpperCase()))
    })
    const fitted = clipChunks(chunks, width)
    const indent = " ".repeat(Math.max(0, Math.floor((width - chunksLength(fitted)) / 2)))
    return new StyledText([raw(indent), ...fitted])
  }

  private overviewContent(width: number) {
    const description = truncate(homeItems[this.selected]!.description, width)
    const indent = " ".repeat(Math.max(0, Math.floor((width - displayWidth(description)) / 2)))
    return new StyledText([raw(indent), fg(theme.dim)(description)])
  }

  private footerContent(width: number) {
    const hints: Hint[] = [
      { keys: "←/→", label: "select", priority: 4, tone: "dim" },
      { keys: "enter", label: "open", priority: 2 },
      { keys: "q", label: "uit", priority: 1, style: "glued" },
    ]
    return hintsRow(hints, [[fg(theme.faint)(`${this.selected + 1}/${homeItems.length}`)]], width, {
      style: "spaced",
      overflow: moreHintsMarker,
    })
  }
}
