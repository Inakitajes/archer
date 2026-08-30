import { BoxRenderable, createCliRenderer } from "@opentui/core"

import { paletteForTerminal, setTheme, terminalBackgroundHex } from "./tui-theme"

import type { CliRenderer } from "@opentui/core"

/** A destination opened inside the zero-argument home session. */
export type TuiRoute = {
  session: TuiSession
  /** Ctrl+C quits the whole home session; q/Escape only close this destination. */
  onInterrupt?: () => void
}

/**
 * One render tree mounted on a session-owned renderer.
 *
 * Screens remove their listeners and timers when they resolve, but deliberately
 * leave this tree painted until the next scene mounts. That makes a handoff
 * atomic from the terminal's point of view: no blank frame and, crucially, no
 * alternate-screen exit/re-entry between Convoy screens.
 */
export class TuiScene {
  private closed = false

  constructor(
    readonly renderer: CliRenderer,
    readonly root: BoxRenderable,
    private readonly onInterrupt?: () => void,
    private readonly onClose?: () => void,
  ) {}

  get isClosed(): boolean {
    return this.closed
  }

  requestInterrupt(): void {
    this.onInterrupt?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.renderer.clearSelection()
    this.root.destroyRecursively()
    this.onClose?.()
  }
}

/** Owns alternate-screen/raw-terminal state for one complete home session. */
export class TuiSession {
  private active?: TuiScene

  constructor(readonly renderer: CliRenderer) {}

  openScene(id: string, onInterrupt?: () => void): TuiScene {
    this.active?.close()
    const root = new BoxRenderable(this.renderer, {
      id,
      width: "100%",
      height: "100%",
    })
    this.renderer.root.add(root)
    let scene!: TuiScene
    scene = new TuiScene(this.renderer, root, onInterrupt, () => {
      if (this.active === scene) this.active = undefined
    })
    this.active = scene
    return scene
  }

  destroy(): void {
    this.active?.close()
    this.active = undefined
    if (!this.renderer.isDestroyed) this.renderer.destroy()
  }
}

export async function createTuiSession(): Promise<TuiSession> {
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new TuiSession(renderer)
}

/** Opens a scene only when a screen is running under the shared home host. */
export function sceneForRoute(route: TuiRoute | undefined, id: string): TuiScene | undefined {
  return route?.session.openScene(id, route.onInterrupt)
}
