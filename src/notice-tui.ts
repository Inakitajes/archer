import { BoxRenderable, StyledText, TextRenderable, bold, fg } from "@opentui/core"

import { hintsRow, paletteForTerminal, setTheme, terminalBackgroundHex, theme } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"
import { shortVersion } from "./version"

import type { CliRenderer, KeyEvent } from "@opentui/core"

/** A shared-session empty state that never leaks text behind alternate screen. */
export function showNoticeTui(route: TuiRoute, options: { title: string; message: string }): Promise<void> {
  const scene = sceneForRoute(route, "convoy-notice-scene")!
  return new NoticeTui(route.session.renderer, scene, options).result
}

class NoticeTui {
  readonly result: Promise<void>
  private resolveResult!: () => void
  private finished = false
  private readonly contentText: TextRenderable
  private readonly footerText: TextRenderable

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    const interrupted = (key.ctrl && key.name === "c") || key.raw === "\u0003"
    if (!interrupted && key.name !== "q" && key.name !== "escape" && key.name !== "return" && key.name !== "linefeed") return
    key.preventDefault()
    key.stopPropagation()
    if (interrupted) this.scene.requestInterrupt()
    this.finish()
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly scene: TuiScene,
    private readonly options: { title: string; message: string },
  ) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "convoy-notice-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
    })
    const content = new BoxRenderable(renderer, {
      id: "convoy-notice-content",
      width: "100%",
      flexGrow: 1,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: ` convoy ${options.title} ${shortVersion()} `,
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
      alignItems: "center",
      justifyContent: "center",
    })
    this.contentText = new TextRenderable(renderer, { content: "", fg: theme.text })
    content.add(this.contentText)
    const footer = new BoxRenderable(renderer, {
      id: "convoy-notice-footer",
      width: "100%",
      height: 3,
      border: true,
      borderStyle: "rounded",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      paddingX: 1,
    })
    this.footerText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    footer.add(this.footerText)
    shell.add(content)
    shell.add(footer)
    scene.root.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    this.render()
  }

  private render() {
    if (this.finished || this.renderer.isDestroyed || this.scene.isClosed) return
    this.contentText.content = new StyledText([bold(fg(theme.text)(this.options.message))])
    this.footerText.content = hintsRow([{ keys: "q", label: "back", priority: 1 }], [], Math.max(1, this.renderer.width - 6))
    this.renderer.requestRender()
  }

  private finish() {
    if (this.finished) return
    this.finished = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.resolveResult()
  }
}
