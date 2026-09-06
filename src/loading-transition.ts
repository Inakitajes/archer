import { BoxRenderable, StyledText, TextRenderable, fg } from "@opentui/core"

import { joinLines, paletteForTerminal, raw, setTheme, terminalBackgroundHex, theme } from "./tui-theme"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { CliRenderer, KeyEvent, TextChunk } from "@opentui/core"

/**
 * The shared loading transition of the home session: while a destination load
 * outlasts a short threshold, a scene of expanding character ripples replaces
 * the frozen home frame, and the destination's own scene mount paints over it
 * atomically (the same contract every home-session screen already uses —
 * scenes close only when the next one mounts). Rejected or interrupted loads
 * never leave a dead screen, and loads that finish quickly never flash it.
 *
 * OpenTUI is imported eagerly by this module, so it is only ever loaded on
 * interactive paths (specs.ts dynamic-imports it under `route`).
 */

/** Quiet period before a slow load earns the transition (no flash on fast loads). */
export const loadingThresholdMs = 150

/** Animation cadence cap (~30 fps): bounds CPU and ANSI output over SSH. */
const frameIntervalMs = 1000 / 30

/** A rejected or slow motion-preference source degrades to "animate". */
const motionResolveBoundMs = 400
const motionProbeKillMs = 250

/**
 * Thrown when the operator presses Ctrl+C while the transition is visible.
 * Callers map it to a quiet exit — the route's interrupt flag already told
 * the home session to quit — rather than opening the destination.
 */
export class LoadingInterruptedError extends Error {
  constructor(message = "interrupted while loading") {
    super(message)
    this.name = "LoadingInterruptedError"
  }
}

export function isLoadingInterrupted(error: unknown): error is LoadingInterruptedError {
  return error instanceof LoadingInterruptedError || (error instanceof Error && error.name === "LoadingInterruptedError")
}

export type LoadingTransitionOptions = {
  /** Overrides the no-flash threshold; tests shrink it to keep the suite fast. */
  thresholdMs?: number
  /** Directory the default reduced-motion resolver reads project config from. */
  targetDir?: string
  /** Overrides the motion preference: a boolean, or a resolver consulted after the threshold wins (tests inject fakes). */
  reducedMotion?: boolean | (() => boolean | Promise<boolean>)
}

/**
 * Runs `load`, showing the ripple transition on the route's session only when
 * the load genuinely outlasts the threshold. Without a route (non-interactive
 * and piped invocations) the load runs unchanged. Every settlement path leaves
 * the session healthy: the transition stops animating as soon as the load
 * settles, and the destination's own scene mount replaces it in place.
 */
export async function withLoadingTransition<T>(
  route: TuiRoute | undefined,
  label: string | undefined,
  load: () => Promise<T>,
  options: LoadingTransitionOptions = {},
): Promise<T> {
  if (!route) return load()

  const threshold = options.thresholdMs ?? loadingThresholdMs
  let loadSettled = false
  const loadPromise = load().then(
    (value) => {
      loadSettled = true
      return value
    },
    (error) => {
      loadSettled = true
      throw error
    },
  )

  // Fast loads win the race before the threshold fires: no scene, no flash.
  const winner = await Promise.race([loadPromise.then(() => "load" as const), delay(threshold).then(() => "threshold" as const)])
  if (winner === "load") return loadPromise

  // The load is genuinely slow. Resolve the motion preference without ever
  // holding the destination back — whichever settles first wins, so a load
  // finishing during resolution skips the transition entirely.
  const resolved = await Promise.race([
    loadPromise.then((): { kind: "load" } => ({ kind: "load" })),
    resolveReducedMotion(options).then((reducedMotion): { kind: "pref"; reducedMotion: boolean } => ({ kind: "pref", reducedMotion })),
  ])
  if (loadSettled || resolved.kind === "load") return loadPromise

  const scene = sceneForRoute(route, "convoy-loading-scene")!
  let rejectInterrupt!: (error: LoadingInterruptedError) => void
  const interrupted = new Promise<never>((_, reject) => {
    rejectInterrupt = reject
  })
  const transition = new LoadingTransition(route.session.renderer, scene, {
    ...(label === undefined ? {} : { label }),
    reducedMotion: resolved.reducedMotion,
    onInterrupt: () =>
      rejectInterrupt(new LoadingInterruptedError(label === undefined ? "interrupted while loading" : `interrupted while loading ${label}`)),
  })
  try {
    return await Promise.race([loadPromise, interrupted])
  } catch (error) {
    transition.stop()
    if (!isLoadingInterrupted(error)) {
      // The transition yields to a readable status message naming the failure;
      // the original error still propagates to the caller.
      const reason = error instanceof Error ? error.message : String(error)
      const { showNoticeTui } = await import("./notice-tui")
      try {
        await showNoticeTui(route, {
          title: label ?? "loading",
          message: `couldn't load${label ? ` ${label}` : ""}: ${reason}`,
        })
      } catch {
        // The session is going away; the original failure still reports.
      }
    }
    throw error
  } finally {
    transition.stop()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Motion preference for the transition, in precedence order: the
 * CONVOY_REDUCED_MOTION environment variable, the config flag
 * `ui.reducedMotion`, then the OS accessibility probe. "auto" and unset
 * values fall through; an unknown value is never treated as a preference.
 */
export async function defaultReducedMotion(targetDir?: string): Promise<boolean> {
  const env = envReducedMotion()
  if (env !== undefined) return env
  try {
    const { loadGlobalConvoyConfig, loadMergedConvoyConfig } = await import("./config")
    const config = targetDir ? await loadMergedConvoyConfig(targetDir) : await loadGlobalConvoyConfig()
    const mode = config?.ui?.reducedMotion
    if (mode === "on") return true
    if (mode === "off") return false
  } catch {
    // A broken config degrades to the probe rather than blocking the transition.
  }
  return probeReducedMotion()
}

/** Session-level override; undefined means "no opinion". */
export function envReducedMotion(): boolean | undefined {
  const value = process.env.CONVOY_REDUCED_MOTION
  if (value === "1" || value === "true" || value === "on") return true
  if (value === "0" || value === "false" || value === "off") return false
  return undefined
}

/** Bounded wrapper: a slow or failing preference source degrades to "animate". */
async function resolveReducedMotion(options: LoadingTransitionOptions): Promise<boolean> {
  const preference = options.reducedMotion
  const resolved = (async () => {
    try {
      if (preference === undefined) return defaultReducedMotion(options.targetDir)
      if (typeof preference === "function") return await preference()
      return preference
    } catch {
      return false
    }
  })()
  return Promise.race([resolved, delay(motionResolveBoundMs).then(() => false)])
}

let probePromise: Promise<boolean> | undefined

/**
 * The OS reduce-motion accessibility setting, probed once per process and
 * killed after a short bound so it can never stall the transition. Platforms
 * without a probe answer "no preference".
 */
export function probeReducedMotion(): Promise<boolean> {
  probePromise ??= (async () => {
    if (process.platform !== "darwin") return false
    try {
      const proc = Bun.spawn(["defaults", "read", "com.apple.universalaccess", "reduceMotion"], { stdout: "pipe", stderr: "ignore" })
      const killer = setTimeout(() => proc.kill(), motionProbeKillMs)
      const text = await new Response(proc.stdout).text()
      await proc.exited
      clearTimeout(killer)
      return text.trim() === "1"
    } catch {
      return false
    }
  })()
  return probePromise
}

// ── the ripple field (pure model, unit-testable without a renderer) ────────

/** One expanding wave: a normalized origin, birth time, speed and lifespan. */
export type RippleSeed = {
  /** Origin in normalized grid coordinates, 0..1. */
  x: number
  y: number
  /** Birth time in ms (the same clock the animator renders against). */
  born: number
  /** Expansion speed in grid cells per second. */
  speed: number
  /** Lifespan in seconds, after which the seed respawns. */
  life: number
}

/** Small deterministic PRNG so tests can pin the field's geometry. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const waveSigmaCells = 1.4
const waveFadeInMs = 500
const seedMaxCount = 10
const seedMinCount = 3

/** Staggered ambient seeds, so even the first frame already shows waves. */
export function createRippleSeeds(random: () => number, count: number, now: number): RippleSeed[] {
  return Array.from({ length: count }, () => {
    const life = 3 + random() * 2
    return {
      x: random(),
      y: random(),
      born: now - random() * 1_800,
      speed: 5 + random() * 4,
      life,
    }
  })
}

/** Seeds live in normalized space so a resize never strands them off-grid. */
export function respawnSeed(seed: RippleSeed, random: () => number, now: number): RippleSeed {
  return {
    x: random(),
    y: random(),
    born: now + random() * 300,
    speed: 5 + random() * 4,
    life: 3 + random() * 2,
  }
}

export function seedCountFor(cols: number, rows: number): number {
  return Math.max(seedMinCount, Math.min(seedMaxCount, Math.round((cols * rows) / 1_000)))
}

/**
 * Per-cell brightness in [0,1]: the sum of every seed's expanding gaussian
 * ring, faded in at birth and decaying over its lifespan, clamped at 1.
 */
export function rippleIntensities(cols: number, rows: number, now: number, seeds: readonly RippleSeed[]): Float64Array {
  const field = new Float64Array(cols * rows)
  for (const seed of seeds) {
    const age = (now - seed.born) / 1_000
    if (age <= 0) continue
    const decay = 1 - age / seed.life
    if (decay <= 0) continue
    const radius = seed.speed * age
    const strength = decay * Math.min(1, age / (waveFadeInMs / 1_000))
    const cx = seed.x * cols
    const cy = seed.y * rows
    for (let y = 0; y < rows; y++) {
      const dy = y - cy
      for (let x = 0; x < cols; x++) {
        const dx = x - cx
        const ring = Math.exp(-((Math.sqrt(dx * dx + dy * dy) - radius) ** 2) / (2 * waveSigmaCells * waveSigmaCells))
        const index = y * cols + x
        field[index] = Math.min(1, field[index]! + ring * strength)
      }
    }
  }
  return field
}

export type RampTone = "faint" | "dim" | "text"

/**
 * Brightness quantized onto the theme's faint → dim → text ramp; undefined
 * cells stay blank. The wavefront reads bright, the tail fades out.
 */
export function intensityCell(intensity: number): { glyph: string; color: RampTone } | undefined {
  if (intensity >= 0.82) return { glyph: "·", color: "text" }
  if (intensity >= 0.55) return { glyph: ":", color: "dim" }
  if (intensity >= 0.28) return { glyph: "·", color: "dim" }
  if (intensity >= 0.08) return { glyph: "·", color: "faint" }
  return undefined
}

/**
 * The transition's sampling grid: one sample per two terminal columns and one
 * row (a cell is roughly square on screen), clamped so very large terminals
 * are never sampled per-cell. The painted output covers the full body anyway:
 * {@linkcode paintSpan} stretches each sample's run at paint time, so a clamped
 * grid means lower resolution, never a dead band at the screen's edge.
 */
export function transitionGrid(width: number, height: number): { cols: number; rows: number } {
  return {
    cols: Math.max(1, Math.min(110, Math.ceil(width / 2))),
    rows: Math.max(1, Math.min(60, height)),
  }
}

/**
 * Terminal slots (columns, or rows) that sampled index `i` of `count` paints
 * into `size`: proportional spans that sum to exactly `size`, so the field
 * fills the terminal edge to edge while the evaluated grid stays clamped.
 * `size >= count` keeps every sample painting at least one slot.
 */
export function paintSpan(i: number, count: number, size: number): number {
  return Math.floor(((i + 1) * size) / count) - Math.floor((i * size) / count)
}

// ── the scene (OpenTUI renderables over the shared session) ────────────────

type LoadingSceneOptions = {
  label?: string
  reducedMotion: boolean
  onInterrupt: () => void
}

/**
 * The mounted transition: a full-body glyph field plus a one-row status label.
 * Follows the repo's screen lifecycle — the scene stays painted until the next
 * scene mounts; {@linkcode stop} only detaches listeners and timers.
 */
class LoadingTransition {
  private finished = false
  private readonly t0 = performance.now()
  private seeds: RippleSeed[] | undefined
  private readonly random = mulberry32((Math.random() * 0xffffffff) >>> 0)
  private readonly ticker: ReturnType<typeof setInterval> | undefined
  private readonly fieldText: TextRenderable

  constructor(
    private readonly renderer: CliRenderer,
    private readonly scene: TuiScene,
    private readonly options: LoadingSceneOptions,
  ) {
    const shell = new BoxRenderable(renderer, {
      id: "convoy-loading-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
    })
    const fieldBox = new BoxRenderable(renderer, { id: "convoy-loading-field", width: "100%", flexGrow: 1 })
    this.fieldText = new TextRenderable(renderer, { content: "", width: "100%", height: "100%" })
    fieldBox.add(this.fieldText)
    const labelBox = new BoxRenderable(renderer, { id: "convoy-loading-label", width: "100%", height: 1, alignItems: "center" })
    const labelText = new TextRenderable(renderer, {
      content: `loading ${options.label ?? "destination"}…`,
      fg: theme.dim,
    })
    labelBox.add(labelText)
    shell.add(fieldBox)
    shell.add(labelBox)
    scene.root.add(shell)

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    // Reduced motion renders one developed static frame — informative, no motion.
    if (!options.reducedMotion) this.ticker = setInterval(this.tick, frameIntervalMs)
    this.render(this.t0)
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    const ctrlC = (key.ctrl && key.name === "c") || key.raw === "\u0003"
    if (!ctrlC) return
    key.preventDefault()
    key.stopPropagation()
    this.stop()
    // Flags the home session's interrupt (the route's handler), then tells the
    // helper to abandon the pending load.
    this.scene.requestInterrupt()
    this.options.onInterrupt()
  }

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.render(performance.now())
  }

  private readonly tick = () => {
    const now = performance.now()
    if (this.finished || this.scene.isClosed || this.renderer.isDestroyed) {
      this.stop()
      return
    }
    this.cullSeeds(now)
    this.render(now)
  }

  /** Detaches from the renderer; idempotent, safe to call from every exit path. */
  stop(): void {
    if (this.finished) return
    this.finished = true
    if (this.ticker) clearInterval(this.ticker)
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
  }

  private cullSeeds(now: number): void {
    if (!this.seeds) return
    this.seeds = this.seeds.map((seed) => (now - seed.born > seed.life * 1_000 ? respawnSeed(seed, this.random, now) : seed))
  }

  private render(now: number): void {
    if (this.finished || this.scene.isClosed || this.renderer.isDestroyed) return
    const width = this.renderer.width
    const bodyHeight = Math.max(1, this.renderer.height - 1)
    const { cols, rows } = transitionGrid(width, bodyHeight)
    this.seeds ??= createRippleSeeds(this.random, seedCountFor(cols, rows), now)
    this.fieldText.content = joinLines(this.fieldRows(cols, rows, rippleIntensities(cols, rows, now, this.seeds), width, bodyHeight))
    this.renderer.requestRender()
  }

  /**
   * One terminal row per body row: each sampled grid row paints every body row
   * its {@linkcode paintSpan} owns and each cell stretches across its column
   * span, so the clamped grid still covers the screen edge to edge.
   */
  private fieldRows(cols: number, rows: number, intensities: Float64Array, width: number, bodyHeight: number): StyledText[] {
    const lines: StyledText[] = []
    for (let y = 0; y < rows; y++) {
      const line = rippleRow(cols, intensities, y * cols, width)
      const span = paintSpan(y, rows, bodyHeight)
      for (let r = 0; r < span; r++) lines.push(line)
    }
    return lines
  }
}

/**
 * One painted field row: the row's cells quantized onto the theme ramp, each
 * cell's glyph repeated across its proportional column span so the runs fill
 * exactly `width` columns. Pure and renderer-free, like the ripple model.
 */
export function rippleRow(cols: number, intensities: Float64Array, offset: number, width: number): StyledText {
  const chunks: TextChunk[] = []
  let run = ""
  let runColor: RampTone | undefined
  const flush = () => {
    if (!run) return
    chunks.push(runColor ? fg(theme[runColor])(run) : raw(run))
    run = ""
  }
  for (let x = 0; x < cols; x++) {
    const cell = intensityCell(intensities[offset + x]!)
    const color = cell?.color
    const text = (cell?.glyph ?? " ").repeat(paintSpan(x, cols, width))
    if (color === runColor) {
      run += text
      continue
    }
    flush()
    runColor = color
    run = text
  }
  flush()
  return new StyledText(chunks.length > 0 ? chunks : [raw("")])
}
