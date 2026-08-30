import { createCliRenderer } from "@opentui/core"

import { RunsBrowser } from "./runs-browser"
import { paletteForTerminal, setTheme, terminalBackgroundHex } from "./tui-theme"
import { sceneForRoute, type TuiRoute } from "./tui-session"

import type { RunEntry, RunsResolution } from "./runs"

export async function browseRunsTui(runs: RunEntry[], initialIndex: number, route?: TuiRoute): Promise<RunsResolution> {
  if (route) {
    const scene = sceneForRoute(route, "convoy-runs-scene")!
    return new RunsBrowser(route.session.renderer, runs, initialIndex, scene).result
  }
  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  // No targetFps: it only applies while opentui's own loop runs, which convoy
  // never starts — frames come on demand from requestRender.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new RunsBrowser(renderer, runs, initialIndex).result
}
