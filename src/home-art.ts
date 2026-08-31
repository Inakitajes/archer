// Home hero: four floating sculptures, one per destination, drawn entirely in
// fine points — middle dots for volume, bullets only where light lands. The
// camera scale is computed once per canvas size and per kind, from that
// sculpture's worst-case bounds over a full yaw sweep — so nothing resizes
// while it spins; it stays centered with constant padding, deliberately
// undersized so the figure sits quietly instead of dominating the screen.
// Selecting a destination swaps the sculpture directly — no morph, no burst:
// the figure you asked for is the figure you get. Depth decides brightness:
// near marks keep their color, far ones fall to dim/faint, which is what
// makes the volumes read as 3D. Motion is contemplative: a slow orbit,
// brightness pulses — never glyph flips, flashes, or bursts. The wordmark is
// the single heavy element: square, bold, with a drop extrusion.

import { StyledText, bold, fg } from "@opentui/core"

import { joinLines, raw, theme } from "./tui-theme"

import type { TextChunk } from "@opentui/core"

export type HomeArtKind = "pipelines" | "specs" | "runs" | "config"

export type Vec3 = { x: number; y: number; z: number }

export const homeArtTickMs = 80
/** The art region never asks for more rows than this, even on huge terminals. */
export const homeArtMaxHeight = 24

const CHAR_ASPECT = 0.5
const CAM_DIST = 4.2
const FOCAL = 3.35
const TILT = 0.5
const SPIN = 0.012
const PAD = 0.18

const LATS = [-0.82, -0.5, -0.18, 0, 0.18, 0.5, 0.82]

const KIND_YAW: Record<Exclude<HomeArtKind, "pipelines">, number> = {
  specs: 0.72,
  runs: 0.28,
  config: 0.18,
}

// Each sculpture's camera fit comes from sweeping its own sampled geometry
// over a full rotation — exact worst-case, so the figure fills the canvas
// without ever resizing mid-spin.

type Role = "form" | "inner" | "live" | "path"
type FormPoint = Vec3 & { role: Role }

type Cell = { ch: string; color: string; depth: number; rank: number; strong: boolean }

const kinds: readonly HomeArtKind[] = ["pipelines", "specs", "runs", "config"]

export function isHomeArtKind(value: string): value is HomeArtKind {
  return (kinds as readonly string[]).includes(value)
}

export function homeArtCount(width: number, height: number) {
  const w = Math.max(1, width)
  const h = Math.max(1, height)
  if (h <= 4) return 36
  if (h <= 7) return 80
  return Math.min(280, Math.max(108, Math.floor((w * h) / 6)))
}

export function formCloud(kind: HomeArtKind, n: number, tick: number): Vec3[] {
  return formPoints(kind, n, tick).map(({ x, y, z }) => ({ x, y, z }))
}

export function renderHomeArt(options: {
  kind: HomeArtKind
  tick: number
  width: number
  height: number
  wordmark?: boolean
}): { content: StyledText } {
  const width = Math.max(1, Math.floor(options.width))
  const height = Math.max(1, Math.floor(options.height))
  const tick = options.tick
  // The wordmark owns a fixed band at the top of the canvas (glyphs, its
  // shadow extrusion, and one row of air); the sculpture view shrinks and
  // centers into what remains below it, so the mark never collides with the
  // art.
  const mark = options.wordmark === false ? undefined : pickWordmark(width, height)
  const band = mark ? TITLE_ROW + mark.length + MARK_SHADOW.dy + 1 : 0
  const artHeight = mark ? height - band : height
  const artOffset = band
  const count = homeArtCount(width, height)

  // Pipelines never spins: its camera is the fixed isometric (a steeper
  // tilt than the orbiting kinds) the tetromino choreography needs.
  // Everything else orbits slowly.
  const spinFor = (kind: HomeArtKind) => (kind === "pipelines" ? ISO_YAW : KIND_YAW[kind] + tick * SPIN)
  const yaw = spinFor(options.kind)
  const tilt = options.kind === "pipelines" ? ISO_TILT : TILT
  const cells = new Array<Cell | undefined>(width * height)
  const view = stableView(width, artHeight, options.kind, artOffset)
  const project = (point: Vec3) => projectPoint(point, yaw, tilt, view)

  if (mark) {
    paintWordmark(cells, width, height, mark)
  }
  paintSettled(cells, width, height, options.kind, tick, project)

  return { content: cellsToStyled(cells, width, height) }
}

export function homeArtPlain(content: StyledText) {
  return content.chunks.map((chunk) => chunk.text).join("")
}

// ── wordmark ───────────────────────────────────────────────────────────────

// "CONVOY" as a heavy 5-row block font — square proportions, 3-cell strokes —
// pinned to the top of the canvas. The sculpture owns the body; the wordmark
// owns the empty band above it that every kind leaves anyway. Each face cell
// extrudes a dim block two columns right and one row down: a drop shadow at
// terminal aspect (~2:1) reads as a 45° depth edge. Narrow canvases fall back
// to the old 5-row mark so the name always fits.
const TITLE_ROW = 1
const MARK_SHADOW = { dx: 2, dy: 1 }

const MARK_LETTERS: Readonly<Record<string, readonly string[]>> = {
  C: [
    " ███████ ",
    "█████████",
    "███      ",
    "███      ",
    " ███████ ",
  ],
  N: [
    "███   ███",
    "████  ███",
    "███ █ ███",
    "███  ████",
    "███   ███",
  ],
  O: [
    " ███████ ",
    "█████████",
    "███   ███",
    "███   ███",
    " ███████ ",
  ],
  V: [
    "███   ███",
    "███   ███",
    "███   ███",
    " ███████ ",
    "  █████  ",
  ],
  Y: [
    "███   ███",
    " ███████ ",
    "   ███   ",
    "   ███   ",
    "   ███   ",
  ],
}

const WORDMARK: readonly string[] = Array.from({ length: 5 }, (_, row) =>
  [..."CONVOY"].map((letter) => MARK_LETTERS[letter]![row]!).join(" "),
)

const WORDMARK_SMALL: readonly string[] = [
  " ###   ###  #   # #   #  ###  #   #",
  "#   # #   # ##  # #   # #   # #   #",
  "#     #   # # # #  # #  #   #  # # ",
  "#   # #   # #  ##  # #  #   #    #  ",
  " ###   ###  #   #   #    ###     #  ",
]

/** The wordmark this canvas can host — large when it fits, small when not. */
function pickWordmark(width: number, height: number): readonly string[] | undefined {
  // Every mark needs its band: TITLE_ROW + glyphs + shadow + 1 air, plus
  // room below for the sculpture to breathe (6 rows, as before).
  if (height < TITLE_ROW + WORDMARK.length + MARK_SHADOW.dy + 1 + 6) return undefined
  return width >= WORDMARK[0]!.length + 4 ? WORDMARK : WORDMARK_SMALL
}

function paintWordmark(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  rows: readonly string[],
) {
  const markWidth = Math.max(...rows.map((row) => row.length)) + MARK_SHADOW.dx
  const x0 = Math.max(0, Math.floor((width - markWidth) / 2))
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y]!
    for (let x = 0; x < row.length; x++) {
      const mark = row[x]
      // The large font encodes cells as █, the small fallback as #.
      if (mark !== "█" && mark !== "#") continue
      const col = x0 + x
      const rowFace = TITLE_ROW + y
      if (col >= width || rowFace >= height) continue
      // The extrusion goes down first (rank 4) so the face (rank 5) wins any
      // overlap: the shadow only survives at the mark's lower-right rim.
      plotCell(
        cells,
        width,
        height,
        { col: col + MARK_SHADOW.dx, row: rowFace + MARK_SHADOW.dy, depth: 0, facing: 1 },
        "█",
        theme.dim,
        4,
        false,
      )
      // Static accent, uniformly bold: the name is the one heavy element on
      // an otherwise fine-point canvas.
      plotCell(cells, width, height, { col, row: rowFace, depth: 0, facing: 1 }, "█", theme.accent, 5, true)
    }
  }
}

// ── sculpture geometry ───────────────────────────────────────────────────

function formPoints(kind: HomeArtKind, n: number, tick: number): FormPoint[] {
  switch (kind) {
    case "pipelines":
      return takeN(pipelinePoints(n, tick), n)
    case "specs":
      return takeN(specsPoints(n, tick), n)
    case "runs":
      return takeN(runsPoints(n), n)
    case "config":
      return takeN(spherePoints(n), n)
  }
}

// Pipelines — the "tetris run": four solid blocks fly in one at a time and
// snap tetrominoes onto a blueprint grid (I → T → L → S), flash on lock, then
// scatter home and loop. The camera is a fixed 45° isometric — the same trick
// the landing uses — so the blocks always read as blocks, never as smudged
// hexagons. All motion comes from the choreography, not from spinning.
const ISO_YAW = Math.PI / 4
// A camera low enough that the side faces get real height next to the lit
// top — the proportion that makes a solid block read as a block.
const ISO_TILT = 0.65
const TETRIS_FLOOR = -0.62
const TETRIS_SIZE = 0.56
const TETRIS_BEAT = 44
const TETRIS_SCATTER_BEATS = 4
/** One full tetris cycle in ticks: four piece beats plus the scatter home. */
export const TETRIS_TOTAL = TETRIS_BEAT * (TETRIS_SCATTER_BEATS + 1)

const tetrominoes: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>> = [
  [
    { x: -1.11, z: 0 },
    { x: -0.37, z: 0 },
    { x: 0.37, z: 0 },
    { x: 1.11, z: 0 },
  ],
  [
    { x: -0.74, z: 0 },
    { x: 0, z: 0 },
    { x: 0.74, z: 0 },
    { x: 0, z: 0.74 },
  ],
  [
    { x: -0.74, z: 0 },
    { x: 0, z: 0 },
    { x: 0.74, z: 0 },
    { x: 0.74, z: 0.74 },
  ],
  [
    { x: -0.37, z: 0 },
    { x: 0.37, z: 0 },
    { x: 0.37, z: 0.74 },
    { x: 1.11, z: 0.74 },
  ],
]

const tetrisHomes: ReadonlyArray<Vec3> = [
  { x: -1.22, y: 0.42, z: -0.5 },
  { x: 1.22, y: 0.3, z: -0.48 },
  { x: 1.05, y: 0.48, z: 0.55 },
  { x: -1.1, y: 0.26, z: 0.6 },
]

type TetrisCube = {
  pos: Vec3
  from: Vec3
  to: Vec3
  /** 0 resting, mid-flight otherwise; 1 exactly at the snap moment. */
  flight: number
  restY: number
}

function tetrisCubeState(index: number, tick: number): TetrisCube {
  const phase = ((tick % TETRIS_TOTAL) + TETRIS_TOTAL) % TETRIS_TOTAL
  const beat = Math.floor(phase / TETRIS_BEAT)
  const within = (phase % TETRIS_BEAT) / TETRIS_BEAT
  const restY = TETRIS_FLOOR + TETRIS_SIZE / 2
  const depart = index * 0.05
  const duration = 0.26
  const flight = clamp((within - depart) / duration, 0, 1)
  const eased = easeOutCubic(flight)
  const lift = Math.sin(flight * Math.PI) * 0.34
  let from: Vec3
  let to: Vec3
  if (beat >= TETRIS_SCATTER_BEATS) {
    const slot = tetrominoes[TETRIS_SCATTER_BEATS - 1]![index]!
    from = { x: slot.x, y: restY, z: slot.z }
    to = tetrisHomes[index]!
  } else {
    const shape = tetrominoes[beat]![index]!
    const prev = beat === 0 ? tetrisHomes[index]! : tetrominoes[beat - 1]![index]!
    from = { x: prev.x, y: beat === 0 ? tetrisHomes[index]!.y : restY, z: prev.z }
    to = { x: shape.x, y: restY, z: shape.z }
  }
  // No idle bob and no landing bounce: the blocks travel a clean arc and
  // settle. The assembly itself carries the motion; everything else is noise.
  return {
    pos: { x: lerp(from.x, to.x, eased), y: lerp(from.y, to.y, eased) + lift, z: lerp(from.z, to.z, eased) },
    from,
    to,
    flight,
    restY,
  }
}

function pipelinePoints(n: number, tick: number): FormPoint[] {
  const roles: readonly Role[] = ["live", "path", "form", "inner"]
  const per = Math.max(20, Math.floor(n / 4))
  const pts: FormPoint[] = []
  for (let index = 0; index < 4; index++) {
    const { pos } = tetrisCubeState(index, tick)
    pts.push(...cubePoints(pos.x, pos.y, pos.z, TETRIS_SIZE, per, roles[index]!))
  }
  return pts
}

// Specs: an atom — the spec's core with proposal, design, and tasks as three
// orbits at clearly different radii and inclinations (one flat, one diagonal,
// one steep), each carrying its own traveling mark. A gyroscope, not a disc.
const ATOM_CY = 0.15

type SpecsRing = { r: number; incl: number; yaw: number; hue: "teal" | "accent" | "magenta"; speed: number; phase: number }

const specsRings: ReadonlyArray<SpecsRing> = [
  { r: 1.26, incl: 0.24, yaw: 0.6, hue: "teal", speed: 0.016, phase: 0.1 },
  { r: 1.5, incl: 0.78, yaw: 2.4, hue: "accent", speed: 0.011, phase: 0.55 },
  { r: 1.64, incl: 1.32, yaw: 4.5, hue: "magenta", speed: 0.02, phase: 0.8 },
]

function ringPoint(a: number, ring: SpecsRing): Vec3 {
  const spun = rotX(rotY({ x: Math.cos(a) * ring.r, y: 0, z: Math.sin(a) * ring.r }, ring.yaw), ring.incl)
  return { x: spun.x, y: spun.y + ATOM_CY, z: spun.z }
}

function specsPoints(n: number, tick: number): FormPoint[] {
  const pts: FormPoint[] = []
  const perRing = Math.max(10, Math.floor(n * 0.3))
  for (const ring of specsRings) {
    for (let i = 0; i < perRing; i++) pts.push({ ...ringPoint((i / perRing) * Math.PI * 2, ring), role: "form" })
  }
  pts.push({ x: 0, y: ATOM_CY, z: 0, role: "live" })
  const electrons = Math.max(3, n - pts.length)
  for (let i = 0; i < electrons; i++) {
    const ring = specsRings[i % specsRings.length]!
    pts.push({ ...ringPoint((((tick * ring.speed + ring.phase) % 1) + 1) % 1 * Math.PI * 2, ring), role: "inner" })
  }
  return pts
}

// Runs: history as a rising double helix — one bright strand carrying the
// story, a quiet twin behind it, sparse rungs between them on the front side.
// The spiral read comes first: front arcs bright, back arcs faint, and never
// enough dots to close the tube into a blob.
const HELIX_TURNS = 2

function helixStrand(t: number, phase: number): Vec3 {
  const a = t * Math.PI * 2 * HELIX_TURNS + phase
  const radius = lerp(0.6, 0.98, t)
  return { x: Math.cos(a) * radius, y: lerp(-1.1, 1.15, t), z: Math.sin(a) * radius }
}

const runBeats: readonly number[] = [0.12, 0.34, 0.56, 0.78]
const liveBeat = 2
const HELIX_STEPS = 72
const RUNG_EVERY = 14

function runsPoints(n: number): FormPoint[] {
  const pts: FormPoint[] = []
  const coil = Math.max(24, n - runBeats.length)
  for (let i = 0; i < coil; i++) {
    const t = i / (coil - 1 || 1)
    pts.push({ ...helixStrand(t, i < coil / 2 ? 0 : Math.PI), role: "path" })
  }
  for (const [index, t] of runBeats.entries()) pts.push({ ...helixStrand(t, 0), role: index === liveBeat ? "live" : "form" })
  return pts
}

// Config: a dense orb — latitude and longitude wires, a bright inner shell,
// and a pulsing core.
const ORB_R = 1.15
const ORB_CY = 0.1

function spherePoints(n: number): FormPoint[] {
  const pts: FormPoint[] = []
  const weights = LATS.map((v) => Math.sqrt(Math.max(0.05, 1 - v * v)))
  const total = weights.reduce((sum, w) => sum + w, 0)
  for (const [index, v] of LATS.entries()) {
    const ringN = Math.max(3, Math.round((n * weights[index]!) / total))
    const r = ORB_R * weights[index]!
    for (let i = 0; i < ringN; i++) {
      const a = (i / ringN) * Math.PI * 2
      pts.push({ x: Math.cos(a) * r, y: ORB_CY + v * ORB_R, z: Math.sin(a) * r, role: "form" })
    }
  }
  return pts
}

// ── settled paintings ────────────────────────────────────────────────────

function paintSettled(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  kind: HomeArtKind,
  tick: number,
  project: (point: Vec3) => Projected | undefined,
) {
  switch (kind) {
    case "pipelines":
      paintPipeline(cells, width, height, tick, project)
      return
    case "specs":
      paintSpecs(cells, width, height, tick, project)
      return
    case "runs":
      paintRuns(cells, width, height, tick, project)
      return
    case "config":
      paintConfig(cells, width, height, tick, project)
      return
  }
}

function paintPipeline(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  tick: number,
  project: (point: Vec3) => Projected | undefined,
) {
  const phase = ((tick % TETRIS_TOTAL) + TETRIS_TOTAL) % TETRIS_TOTAL
  const beat = Math.floor(phase / TETRIS_BEAT)
  const cubes = [0, 1, 2, 3].map((index) => tetrisCubeState(index, tick))

  // Blueprint floor: a wide, shallow dotted grid. No ring — a circle under
  // an isometric camera fights the diagonal perspective instead of grounding
  // it, and the grid's diamond shape IS the perspective.
  for (const gx of [-1.48, -0.74, 0, 0.74, 1.48]) {
    for (const gz of [-0.74, 0, 0.74]) {
      plotParticle(cells, width, height, project({ x: gx, y: TETRIS_FLOOR, z: gz }), "·", theme.faint, 0, false)
    }
  }

  for (const [index, cube] of cubes.entries()) {
    const airborne = cube.flight > 0.02 && cube.flight < 0.98
    // Ghost footprint: the slot this block is about to snap into.
    if (airborne && beat < TETRIS_SCATTER_BEATS) {
      plotFootprint(cells, width, height, project, cube.to.x, cube.to.z, theme.dim)
    }
    // Contact shadow: a soft filled pool that shrinks and dims as the block
    // climbs — the single cue that sells height under a solid block.
    const h = clamp((cube.pos.y - cube.restY) / 0.5, 0, 1)
    plotShadow(cells, width, height, project, cube.pos.x, cube.pos.z, TETRIS_SIZE * (0.58 - 0.16 * h), h > 0.55 ? theme.faint : theme.dim)
  }

  // No lock flash, no shockwave, no dust, no ghost trails: the blocks arc in,
  // snap, and the scene holds. The assembly is the story.
  const colors = [theme.accent, theme.teal, theme.magenta, theme.cyan]
  for (const [index, cube] of cubes.entries()) {
    plotIsoCube(cells, width, height, project, cube.pos, TETRIS_SIZE, colors[index]!)
  }
}

/** A soft elliptical pool on the blueprint floor: the block's shadow. */
function plotShadow(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  project: (point: Vec3) => Projected | undefined,
  cx: number,
  cz: number,
  radius: number,
  color: string,
) {
  const n = 6
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const dx = (i / n) * 2 - 1
      const dz = (j / n) * 2 - 1
      if (dx * dx + dz * dz > 1) continue
      plotParticle(cells, width, height, project({ x: cx + dx * radius, y: TETRIS_FLOOR, z: cz + dz * radius * 0.8 }), "·", color, 1, false)
    }
  }
}

/** The slot outline a flying block is about to fill: eight faint dots. */
function plotFootprint(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  project: (point: Vec3) => Projected | undefined,
  cx: number,
  cz: number,
  color: string,
) {
  const r = TETRIS_SIZE * 0.62
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2
    plotParticle(cells, width, height, project({ x: cx + Math.cos(a) * r, y: TETRIS_FLOOR, z: cz + Math.sin(a) * r }), "·", color, 1, false)
  }
}

// The shared density ramp: a bullet where light lands, a middle dot on the
// rest — depth does the remaining work through color. Tints stay on the palette.
function faceShade(facing: number): "•" | "·" {
  return facing > 0.28 ? "•" : "·"
}

function plotSolidNode(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  project: (point: Vec3) => Projected | undefined,
  center: Vec3,
  color: string,
  ch: string,
) {
  const offsets: Vec3[] = [
    { x: 0, y: 0, z: 0 },
    { x: 0.06, y: 0, z: 0 },
    { x: -0.06, y: 0, z: 0 },
    { x: 0, y: 0.06, z: 0 },
    { x: 0, y: -0.06, z: 0 },
    { x: 0, y: 0, z: 0.06 },
    { x: 0, y: 0, z: -0.06 },
  ]
  for (const offset of offsets) {
    plotParticle(
      cells,
      width,
      height,
      project({ x: center.x + offset.x, y: center.y + offset.y, z: center.z + offset.z }),
      ch,
      color,
      5,
      true,
    )
  }
}

function paintSpecs(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  tick: number,
  project: (point: Vec3) => Projected | undefined,
) {
  // Rings: solid bands whose density rides the shared ·/• ramp — the same
  // shading language every sculpture speaks, carried on a wire sculpture.
  for (const ring of specsRings) {
    const steps = 120
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const hit = project(ringPoint(a, ring))
      if (!hit) continue
      const ch = faceShade(hit.facing)
      const color = hit.facing > 0 ? theme[ring.hue] : theme.faint
      plotParticle(cells, width, height, hit, ch, color, 2, false)
    }
    const t = (((tick * ring.speed + ring.phase) % 1) + 1) % 1
    const electron = ringPoint(t * Math.PI * 2, ring)
    const tail = project(ringPoint((((t - 0.03) % 1) + 1) % 1 * Math.PI * 2, ring))
    if (tail) plotParticle(cells, width, height, tail, "·", theme[ring.hue], 3, false)
    plotSolidNode(cells, width, height, project, electron, theme[ring.hue], "•")
  }
  // Nucleus: a small core at the atom's heart, pulsing in brightness only —
  // the glyph never changes shape.
  const lit = Math.sin(tick * 0.2) > 0
  plotSolidNode(cells, width, height, project, { x: 0, y: ATOM_CY, z: 0 }, lit ? theme.cyan : theme.dim, "•")
}

function paintRuns(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  tick: number,
  project: (point: Vec3) => Projected | undefined,
) {
  // Main strand dotted and shaded by face; the twin stays a sparse echo —
  // history behind the story — and rungs drop to faint · steps. No head
  // spark: the helix turns, that is all the theater it needs.
  for (let i = 0; i < HELIX_STEPS; i++) {
    const t = i / (HELIX_STEPS - 1)
    const front = project(helixStrand(t, 0))
    if (front) {
      plotParticle(cells, width, height, front, faceShade(front.facing), front.facing > 0 ? theme.teal : theme.faint, 2, false)
    }
    const back = project(helixStrand(t, Math.PI))
    if (back) plotParticle(cells, width, height, back, "·", back.facing > 0 ? theme.dim : theme.faint, 1, false)
    if (i % RUNG_EVERY === 7) {
      const a = project(helixStrand(t, 0))
      const b = project(helixStrand(t, Math.PI))
      if (a && b && a.facing > 0 && b.facing > 0) plotLine(cells, width, height, a, b, theme.faint, 1, "·")
    }
  }
  for (const [index, t] of runBeats.entries()) {
    if (index === liveBeat) continue
    plotSolidNode(cells, width, height, project, helixStrand(t, 0), theme.teal, "•")
  }
  const lit = Math.sin(tick * 0.25) > 0
  plotSolidNode(cells, width, height, project, helixStrand(runBeats[liveBeat]!, 0), lit ? theme.accent : theme.dim, "•")
}

function paintConfig(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  tick: number,
  project: (point: Vec3) => Projected | undefined,
) {
  // Outer shell: dotted patches shaded by orientation — the lit equator
  // carries bullets, the dusk bands fall to middle dots, the back hemisphere
  // to faint dots — so the orb reads as a volume, not a wire.
  for (const v of LATS) {
    const r = ORB_R * Math.sqrt(Math.max(0, 1 - v * v))
    const steps = 88
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const hit = project({ x: Math.cos(a) * r, y: ORB_CY + v * ORB_R, z: Math.sin(a) * r })
      if (!hit) continue
      const front = hit.facing > 0.02
      const ch = front && Math.abs(v) < 0.45 ? "•" : "·"
      const color = front ? (Math.abs(v) < 0.45 ? theme.teal : theme.cyan) : theme.faint
      plotParticle(cells, width, height, hit, ch, color, 2, false)
    }
  }
  for (const phi of [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4]) {
    const steps = 110
    for (let i = 0; i < steps; i++) {
      const theta = (i / steps) * Math.PI * 2
      const hit = project({
        x: ORB_R * Math.sin(theta) * Math.cos(phi),
        y: ORB_CY + ORB_R * Math.cos(theta),
        z: ORB_R * Math.sin(theta) * Math.sin(phi),
      })
      if (!hit) continue
      const front = hit.facing > 0.02
      plotParticle(cells, width, height, hit, "·", front ? theme.cyan : theme.faint, 2, false)
    }
  }
  // Inner shell: the settings core, a smaller accent wire inside the orb —
  // kept brighter on its front arcs so it never dissolves into the shell.
  const inner = 0.45
  for (const v of [-0.5, 0, 0.5]) {
    const r = inner * Math.sqrt(Math.max(0, 1 - v * v))
    const steps = 52
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const hit = project({ x: Math.cos(a) * r, y: ORB_CY + v * inner, z: Math.sin(a) * r })
      if (!hit) continue
      plotParticle(cells, width, height, hit, "·", hit.facing > 0 ? theme.accent : theme.dim, 3, false)
    }
  }
  for (const phi of [0, Math.PI / 2]) {
    const steps = 66
    for (let i = 0; i < steps; i++) {
      const theta = (i / steps) * Math.PI * 2
      const hit = project({
        x: inner * Math.sin(theta) * Math.cos(phi),
        y: ORB_CY + inner * Math.cos(theta),
        z: inner * Math.sin(theta) * Math.sin(phi),
      })
      if (!hit) continue
      plotParticle(cells, width, height, hit, "·", hit.facing > 0 ? theme.accent : theme.dim, 3, false)
    }
  }
  // The core outranks the shell (rank 6 over 3): it must read as the bright
  // center of the orb, never as a dot lost behind its own wires. It pulses
  // in brightness only — the glyph is a steady bullet.
  const lit = Math.sin(tick * 0.15) > 0
  plotParticle(cells, width, height, project({ x: 0, y: ORB_CY, z: 0 }), "•", lit ? theme.accent : theme.dim, 6, true)
}

// ── drawing primitives ───────────────────────────────────────────────────

type Projected = { col: number; row: number; depth: number; facing: number }
type CameraHit = { px: number; py: number; depth: number; facing: number }
type View = { scale: number; midX: number; midY: number; width: number; height: number; offsetY: number }

function cameraPoint(point: Vec3, yaw: number, tilt: number): CameraHit | undefined {
  const spun = rotX(rotY(point, yaw), tilt)
  const depth = CAM_DIST - spun.z
  if (depth < 0.35) return undefined
  return {
    px: (spun.x * FOCAL) / depth,
    py: (-(spun.y * FOCAL) / depth) * CHAR_ASPECT,
    depth,
    facing: spun.z,
  }
}

// The sculpture's projected bounding box over a full rotation, computed once
// per canvas size and kind. Constant scale, constant center: the figure holds
// its size at every yaw instead of breathing with the frame's bounding box.
const viewCache = new Map<string, View>()
const sampleCache = new Map<HomeArtKind, readonly Vec3[]>()
const centerCache = new Map<HomeArtKind, readonly Vec3[]>()

// Everything pipelines paints under the blocks — the blueprint grid, contact
// shadows, slot footprints, landing dust — lives on the floor plane inside
// this rect. The isometric tilt throws the plane's front edge far below the
// cube bottoms, so the fit has to see it or the scene crowds the bottom edge.
const tetrisFloorSamples: readonly Vec3[] = [-1.5, -0.75, 0, 0.75, 1.5].flatMap((x) =>
  [-1, -0.5, 0, 0.5, 1].map((z) => ({ x, y: TETRIS_FLOOR, z })),
)

function boundSamples(kind: HomeArtKind): readonly Vec3[] {
  const cached = sampleCache.get(kind)
  if (cached) return cached
  let samples: readonly Vec3[]
  if (kind === "pipelines") {
    // The tetromino choreography moves the blocks all over the playfield;
    // sweep every renderable tick (plus the floor they play over) so the fit
    // never clips a flying block — the flight lift peaks sharply, and a
    // coarser stride misses the apex between samples. n = 96 keeps every
    // sampled cube corner: smaller counts make takeN decimate the cloud.
    const poses: Vec3[] = [...tetrisFloorSamples]
    for (let tick = 0; tick < TETRIS_TOTAL; tick++) poses.push(...formCloud(kind, 96, tick))
    samples = poses
  } else {
    samples = formCloud(kind, 72, 0)
  }
  sampleCache.set(kind, samples)
  return samples
}

// What the camera centers on. For the spinning kinds this is the same
// worst-case set the scale comes from. Pipelines is the exception: its sweep
// reserves headroom for blocks in flight, so centering on the sweep's
// midpoint hangs the resting tetromino — the pose the scene dwells in —
// several rows below center. Center on the settled scene (locked blocks plus
// the floor under them) and let flight borrow the reserved headroom instead.
function centerSamples(kind: HomeArtKind): readonly Vec3[] {
  const cached = centerCache.get(kind)
  if (cached) return cached
  let samples: readonly Vec3[]
  if (kind === "pipelines") {
    const poses: Vec3[] = [...tetrisFloorSamples]
    // The hold phase of every build beat: all four blocks locked on the floor.
    for (let beat = 0; beat < TETRIS_SCATTER_BEATS; beat++) {
      poses.push(...formCloud(kind, 96, Math.floor((beat + 0.8) * TETRIS_BEAT)))
    }
    samples = poses
  } else {
    samples = boundSamples(kind)
  }
  centerCache.set(kind, samples)
  return samples
}

function stableView(width: number, height: number, kind: HomeArtKind, offsetY = 0): View {
  const key = `${width}x${height}:${kind}:${offsetY}`
  const cached = viewCache.get(key)
  if (cached) return cached
  const samples = boundSamples(kind)
  const centers = centerSamples(kind)
  let maxAbsX = 0
  let minY = Infinity
  let maxY = -Infinity
  // Pipelines renders from one fixed isometric pose, so its fit only needs
  // that one; the rest spin and need the full sweep.
  const yawSteps = kind === "pipelines" ? 1 : 48
  const tilt = kind === "pipelines" ? ISO_TILT : TILT
  for (let i = 0; i < yawSteps; i++) {
    const yaw = kind === "pipelines" ? ISO_YAW : (i / 48) * Math.PI * 2
    for (const point of samples) {
      const hit = cameraPoint(point, yaw, tilt)
      if (!hit) continue
      maxAbsX = Math.max(maxAbsX, Math.abs(hit.px))
      if (hit.py < minY) minY = hit.py
      if (hit.py > maxY) maxY = hit.py
    }
  }
  let centerMinY = minY
  let centerMaxY = maxY
  if (centers !== samples) {
    centerMinY = Infinity
    centerMaxY = -Infinity
    for (let i = 0; i < yawSteps; i++) {
      const yaw = kind === "pipelines" ? ISO_YAW : (i / 48) * Math.PI * 2
      for (const point of centers) {
        const hit = cameraPoint(point, yaw, tilt)
        if (!hit) continue
        if (hit.py < centerMinY) centerMinY = hit.py
        if (hit.py > centerMaxY) centerMaxY = hit.py
      }
    }
  }
  const spanX = Math.max(0.2, 2 * maxAbsX)
  const spanY = Math.max(0.2, maxY - minY)
  const scale = Math.min((width * (1 - 2 * PAD)) / spanX, (height * (1 - 2 * PAD)) / spanY)
  const view: View = {
    scale: Number.isFinite(scale) && scale > 0 ? scale : Math.min(width, height) * 0.4,
    midX: 0,
    midY: Number.isFinite(centerMinY) ? (centerMinY + centerMaxY) / 2 : 0,
    width,
    height,
    offsetY,
  }
  viewCache.set(key, view)
  return view
}

function projectPoint(point: Vec3, yaw: number, tilt: number, view: View): Projected | undefined {
  const hit = cameraPoint(point, yaw, tilt)
  if (!hit) return undefined
  const col = (view.width - 1) / 2 + (hit.px - view.midX) * view.scale
  const row = view.offsetY + (view.height - 1) / 2 + (hit.py - view.midY) * view.scale
  return { col, row, depth: hit.depth, facing: hit.facing }
}

// An isometric solid block: three visible faces dotted edge-to-edge — bullets
// on the lit top, middle dots on the sides — in the cube's own color. The
// terminal's background supplies the dark, so a single hue reads as three
// tones of one material. Equal-rank faces let the depth buffer decide
// overlaps, so neighbouring blocks z-sort correctly.
function plotIsoCube(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  project: (point: Vec3) => Projected | undefined,
  center: Vec3,
  size: number,
  color: string,
) {
  const s = size / 2
  const at = (dx: number, dy: number, dz: number): Vec3 => ({ x: center.x + dx * s, y: center.y + dy * s, z: center.z + dz * s })
  const tA = at(-1, 1, -1)
  const tB = at(-1, 1, 1)
  const tC = at(1, 1, 1)
  const tD = at(1, 1, -1)
  const bB = at(-1, -1, 1)
  const bC = at(1, -1, 1)
  const bD = at(1, -1, -1)
  fillFace(cells, width, height, project, tD, tC, bC, bD, "·", color, 4, false)
  fillFace(cells, width, height, project, tB, bB, bC, tC, "·", color, 4, false)
  fillFace(cells, width, height, project, tA, tB, tC, tD, "•", color, 5, true)
}

// Fills a 3D quad with a dense bilinear point grid, sampled finely enough for
// the projected size that no background peeks through. Equal-rank faces let
// the depth buffer decide overlaps, so neighbouring blocks z-sort correctly.
function fillFace(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  project: (point: Vec3) => Projected | undefined,
  a: Vec3,
  b: Vec3,
  c: Vec3,
  d: Vec3,
  ch: string,
  color: string,
  rank: number,
  strong: boolean,
) {
  const pa = project(a)
  const pb = project(b)
  const pc = project(c)
  const pd = project(d)
  if (!pa || !pb || !pc || !pd) return
  const spanX = Math.max(pa.col, pb.col, pc.col, pd.col) - Math.min(pa.col, pb.col, pc.col, pd.col)
  const spanY = Math.max(pa.row, pb.row, pc.row, pd.row) - Math.min(pa.row, pb.row, pc.row, pd.row)
  const n = clamp(Math.ceil(Math.max(spanX, spanY) * 1.6), 3, 16)
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      const u = i / n
      const v = j / n
      const point = {
        x: lerp(lerp(a.x, b.x, u), lerp(d.x, c.x, u), v),
        y: lerp(lerp(a.y, b.y, u), lerp(d.y, c.y, u), v),
        z: lerp(lerp(a.z, b.z, u), lerp(d.z, c.z, u), v),
      }
      plotParticle(cells, width, height, project(point), ch, color, rank, strong)
    }
  }
}
function plotLine(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  a: Projected | undefined,
  b: Projected | undefined,
  color: string,
  rank: number,
  ch: string,
) {
  if (!a || !b) return
  const steps = Math.max(1, Math.round(Math.max(Math.abs(b.col - a.col), Math.abs(b.row - a.row))))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    plotCell(
      cells,
      width,
      height,
      {
        col: lerp(a.col, b.col, t),
        row: lerp(a.row, b.row, t),
        depth: lerp(a.depth, b.depth, t),
        facing: lerp(a.facing, b.facing, t),
      },
      ch,
      color,
      rank,
      false,
    )
  }
}

function plotParticle(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  hit: Projected | undefined,
  ch: string,
  color: string,
  rank: number,
  strong: boolean,
) {
  plotCell(cells, width, height, hit, ch, color, rank, strong)
}

function plotCell(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  hit: Projected | undefined,
  ch: string,
  color: string,
  rank: number,
  strong: boolean,
) {
  if (!hit) return
  const col = Math.round(hit.col)
  const row = Math.round(hit.row)
  if (col < 0 || col >= width || row < 0 || row >= height) return
  const index = row * width + col
  const prev = cells[index]
  if (prev && (prev.rank > rank || (prev.rank === rank && prev.depth <= hit.depth))) return
  cells[index] = { ch, color, depth: hit.depth, rank, strong }
}

function cellsToStyled(cells: Array<Cell | undefined>, width: number, height: number) {
  const lines: StyledText[] = []
  for (let row = 0; row < height; row++) {
    const chunks: TextChunk[] = []
    let run = ""
    let color: string | undefined
    let strong = false
    const flush = () => {
      if (!run) return
      if (!color) chunks.push(raw(run))
      else chunks.push(strong ? bold(fg(color)(run)) : fg(color)(run))
      run = ""
    }
    for (let col = 0; col < width; col++) {
      const cell = cells[row * width + col]
      const nextColor = cell?.color
      const nextStrong = cell?.strong ?? false
      const nextCh = cell?.ch ?? " "
      if (nextColor !== color || nextStrong !== strong) {
        flush()
        color = nextColor
        strong = nextStrong
      }
      run += nextCh
    }
    flush()
    lines.push(new StyledText(chunks.length > 0 ? chunks : [raw(" ")]))
  }
  return joinLines(lines)
}

// ── small helpers ────────────────────────────────────────────────────────

function cubePoints(cx: number, cy: number, cz: number, size: number, n: number, role: Role): FormPoint[] {
  const h = size / 2
  const corners: Vec3[] = []
  for (const x of [-h, h]) {
    for (const y of [-h, h]) {
      for (const z of [-h, h]) corners.push({ x: cx + x, y: cy + y, z: cz + z })
    }
  }
  const edges: Array<[number, number]> = [
    [0, 1],
    [2, 3],
    [4, 5],
    [6, 7],
    [0, 2],
    [1, 3],
    [4, 6],
    [5, 7],
    [0, 4],
    [1, 5],
    [2, 6],
    [3, 7],
  ]
  const perEdge = Math.max(2, Math.ceil(n / edges.length))
  const pts: FormPoint[] = []
  for (const [a, b] of edges) {
    const start = corners[a]!
    const end = corners[b]!
    for (let i = 0; i < perEdge; i++) {
      const t = i / (perEdge - 1 || 1)
      pts.push({ x: lerp(start.x, end.x, t), y: lerp(start.y, end.y, t), z: lerp(start.z, end.z, t), role })
    }
  }
  return pts
}

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3)
}

function rotY(point: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: point.x * c - point.z * s, y: point.y, z: point.x * s + point.z * c }
}

function rotX(point: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: point.x, y: point.y * c - point.z * s, z: point.y * s + point.z * c }
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function takeN(points: FormPoint[], n: number): FormPoint[] {
  if (points.length === n) return points
  if (points.length === 0) return Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0, role: "form" }))
  if (points.length > n) {
    return Array.from({ length: n }, (_, i) => points[Math.floor((i * points.length) / n)]!)
  }
  return Array.from({ length: n }, (_, i) => {
    const t = (i * points.length) / n
    const a = Math.floor(t) % points.length
    const b = (a + 1) % points.length
    const f = t - Math.floor(t)
    const pa = points[a]!
    const pb = points[b]!
    return { x: lerp(pa.x, pb.x, f), y: lerp(pa.y, pb.y, f), z: lerp(pa.z, pb.z, f), role: pa.role }
  })
}
