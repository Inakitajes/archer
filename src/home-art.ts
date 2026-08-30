// Home hero: four floating sculptures, one per destination. The camera scale
// is computed once per canvas size and per kind, from that sculpture's
// worst-case bounds over a full yaw sweep — so nothing resizes while it spins;
// it stays centered with constant padding. Selection morphs the particle
// cloud; once settled, each destination draws its own geometry. Depth decides
// brightness: near marks keep their color, far ones fall to dim/faint, which
// is what makes the volumes read as 3D.

import { StyledText, bold, fg } from "@opentui/core"

import { joinLines, raw, theme } from "./tui-theme"

import type { TextChunk } from "@opentui/core"

export type HomeArtKind = "pipelines" | "specs" | "runs" | "config"

export type Vec3 = { x: number; y: number; z: number }

export const homeArtTickMs = 50
export const homeArtMorphFrames = 10
/** The art region never asks for more rows than this, even on huge terminals. */
export const homeArtMaxHeight = 24

const CHAR_ASPECT = 0.5
const CAM_DIST = 4.2
const FOCAL = 3.35
const TILT = 0.5
const SPIN = 0.03
const PAD = 0.12

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
  previous?: HomeArtKind
  from?: readonly Vec3[]
  morph: number
  tick: number
  width: number
  height: number
}): { content: StyledText; cloud: Vec3[] } {
  const width = Math.max(1, Math.floor(options.width))
  const height = Math.max(1, Math.floor(options.height))
  const morph = clamp(options.morph, 0, 1)
  const tick = options.tick
  const count = homeArtCount(width, height)
  const target = formPoints(options.kind, count, tick)
  const origin = resample(options.from ?? target, count)
  const eased = smoothstep(morph)
  const burst = 1 + 0.3 * Math.sin(morph * Math.PI)
  const cloud: Vec3[] = target.map((point, index) => {
    const prior = origin[index] ?? point
    return {
      x: (prior.x + (point.x - prior.x) * eased) * burst,
      y: (prior.y + (point.y - prior.y) * eased) * burst,
      z: (prior.z + (point.z - prior.z) * eased) * burst,
    }
  })

  // Pipelines never spins: its camera is the fixed isometric (a steeper
  // tilt than the orbiting kinds) the tetromino choreography needs.
  // Everything else orbits slowly. During a morph the camera eases from one
  // pose to the other alongside the flying cloud.
  const spinFor = (kind: HomeArtKind) => (kind === "pipelines" ? ISO_YAW : KIND_YAW[kind] + tick * SPIN)
  const yaw = lerp(spinFor(options.previous ?? options.kind), spinFor(options.kind), eased)
  const baseTilt = options.kind === "pipelines" ? ISO_TILT : TILT
  // The camera's idle nod is periodic over the tetris cycle so that loop (and
  // every other frame) closes seamlessly.
  const tilt = baseTilt + 0.03 * Math.sin((tick / TETRIS_TOTAL) * Math.PI * 4)
  const cells = new Array<Cell | undefined>(width * height)
  const view = stableView(width, height, options.kind)
  const project = (point: Vec3) => projectPoint(point, yaw, tilt, view)

  if (morph < 0.97) {
    for (const [index, point] of cloud.entries()) {
      const role = target[index]?.role ?? "form"
      plotParticle(cells, width, height, project(point), roleGlyph(role), roleColor(role), role === "live" ? 4 : 2, role === "live")
    }
  } else {
    paintSettled(cells, width, height, options.kind, tick, project)
  }

  return { content: cellsToStyled(cells, width, height), cloud }
}

export function homeArtPlain(content: StyledText) {
  return content.chunks.map((chunk) => chunk.text).join("")
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
  // Idle bob, phased per block but periodic over the whole cycle so the loop
  // closes seamlessly.
  const bob = Math.sin((phase / TETRIS_TOTAL) * Math.PI * 6 + index * 1.7) * 0.08
  const restY = TETRIS_FLOOR + TETRIS_SIZE / 2
  const depart = index * 0.05
  const duration = 0.26
  const landT = depart + duration
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
  let y = lerp(from.y, to.y, eased) + lift + bob
  // Landing bounce: a quick dip past the rest height and back — the thunk.
  if (flight >= 1 && within < landT + 0.14) {
    y -= Math.sin(((within - landT) / 0.14) * Math.PI) * 0.045
  }
  return { pos: { x: lerp(from.x, to.x, eased), y, z: lerp(from.z, to.z, eased) }, from, to, flight, restY }
}

function tetrisLocked(tick: number): boolean {
  const phase = ((tick % TETRIS_TOTAL) + TETRIS_TOTAL) % TETRIS_TOTAL
  const beat = Math.floor(phase / TETRIS_BEAT)
  if (beat >= TETRIS_SCATTER_BEATS) return false
  const within = (phase % TETRIS_BEAT) / TETRIS_BEAT
  return within > 0.54 && within < 0.7
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
  const within = (phase % TETRIS_BEAT) / TETRIS_BEAT
  const cubes = [0, 1, 2, 3].map((index) => tetrisCubeState(index, tick))

  // Blueprint floor: a wide, shallow dotted grid. No ring — a circle under
  // an isometric camera fights the diagonal perspective instead of grounding
  // it, and the grid's diamond shape IS the perspective.
  for (const gx of [-1.48, -0.74, 0, 0.74, 1.48]) {
    for (const gz of [-0.74, 0, 0.74]) {
      plotParticle(cells, width, height, project({ x: gx, y: TETRIS_FLOOR, z: gz }), "·", theme.faint, 0, false)
    }
  }

  // Lock shockwave: a ring races out from the piece's center across the
  // floor while the tetromino is locked — the landing's money shot.
  if (tetrisLocked(tick)) {
    const shockT = (within - 0.54) / 0.16
    const shape = tetrominoes[beat]!
    const cx = shape.reduce((sum, slot) => sum + slot.x, 0) / shape.length
    const cz = shape.reduce((sum, slot) => sum + slot.z, 0) / shape.length
    const radius = lerp(0.25, 1.65, easeOutCubic(shockT))
    plotFloorRing(cells, width, height, project, cx, cz, radius, shockT < 0.55 ? theme.yellow : theme.dim, 2)
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
    // Two fading ghost dots trail the flight path; anything more is noise.
    if (airborne) {
      for (let k = 1; k <= 2; k++) {
        const fk = clamp(cube.flight - 0.1 * k, 0, 1)
        const ek = easeOutCubic(fk)
        const ghost = {
          x: lerp(cube.from.x, cube.to.x, ek),
          y: lerp(cube.from.y, cube.to.y, ek) + Math.sin(fk * Math.PI) * 0.34,
          z: lerp(cube.from.z, cube.to.z, ek),
        }
        plotParticle(cells, width, height, project(ghost), "·", theme.faint, 1, false)
      }
    }
    // Landing dust: six sparks race outward along the floor from the slot.
    const landT = index * 0.05 + 0.26
    if (cube.flight >= 1 && within > landT && within < landT + 0.13) {
      const dt = (within - landT) / 0.13
      const spread = 0.12 + 0.5 * dt
      for (let d = 0; d < 6; d++) {
        const a = (d / 6) * Math.PI * 2 + index * 0.7
        plotParticle(
          cells,
          width,
          height,
          project({ x: cube.to.x + Math.cos(a) * spread * 0.85, y: TETRIS_FLOOR + 0.02, z: cube.to.z + Math.sin(a) * spread * 0.55 }),
          "·",
          dt < 0.5 ? theme.dim : theme.faint,
          1,
          false,
        )
      }
    }
  }

  const locked = tetrisLocked(tick)
  const colors = [theme.accent, theme.teal, theme.magenta, theme.cyan]
  for (const [index, cube] of cubes.entries()) {
    plotIsoCube(cells, width, height, project, cube.pos, TETRIS_SIZE, colors[index]!, locked)
  }
}

/** A dashed circle lying on the blueprint floor. */
function plotFloorRing(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  project: (point: Vec3) => Projected | undefined,
  cx: number,
  cz: number,
  radius: number,
  color: string,
  rank: number,
) {
  const steps = 22
  let prev: Vec3 | undefined
  for (let i = 0; i <= steps; i++) {
    if (i % 3 === 2) {
      prev = undefined
      continue
    }
    const a = (i / steps) * Math.PI * 2
    const point = { x: cx + Math.cos(a) * radius, y: TETRIS_FLOOR, z: cz + Math.sin(a) * radius }
    if (prev) plotLine(cells, width, height, project(prev), project(point), color, rank, "·")
    prev = point
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
      plotParticle(cells, width, height, project({ x: cx + dx * radius, y: TETRIS_FLOOR, z: cz + dz * radius * 0.8 }), "░", color, 1, false)
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

// The shared density ramp: solid glyph per orientation, so every sculpture
// reads its 3D the same way pipelines' blocks do. Tints stay on the palette.
function faceShade(facing: number): "▓" | "▒" | "░" {
  if (facing > 0.28) return "▓"
  if (facing > 0) return "▒"
  return "░"
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
  // Rings: solid bands whose density ramps ▓▒░ with the face — the same
  // shading language the tetris blocks speak, carried on a wire sculpture.
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
    if (tail) plotParticle(cells, width, height, tail, "•", theme[ring.hue], 3, false)
    plotSolidNode(cells, width, height, project, electron, theme[ring.hue], "●")
  }
  // Nucleus: a small solid core pulsing at the atom's heart.
  const beat = Math.sin(tick * 0.2) > 0 ? "◆" : "●"
  plotSolidNode(cells, width, height, project, { x: 0, y: ATOM_CY, z: 0 }, theme.cyan, beat)
}

function paintRuns(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  tick: number,
  project: (point: Vec3) => Projected | undefined,
) {
  // Main strand solid and shaded by face; the twin stays a dotted echo —
  // history behind the story — and rungs drop to faint ░ steps.
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
      if (a && b && a.facing > 0 && b.facing > 0) plotLine(cells, width, height, a, b, theme.faint, 1, "░")
    }
  }
  for (const [index, t] of runBeats.entries()) {
    if (index === liveBeat) continue
    plotSolidNode(cells, width, height, project, helixStrand(t, 0), theme.teal, "●")
  }
  const pulse = Math.sin(tick * 0.25) > 0 ? "◆" : "●"
  plotSolidNode(cells, width, height, project, helixStrand(runBeats[liveBeat]!, 0), theme.accent, pulse)
  const head = helixStrand(((tick * 0.01) % 1 + 1) % 1, 0)
  plotParticle(cells, width, height, project({ x: head.x, y: head.y + 0.14, z: head.z }), "✦", theme.yellow, 5, true)
}

function paintConfig(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  tick: number,
  project: (point: Vec3) => Projected | undefined,
) {
  // Outer shell: solid patches shaded by orientation — parallels in ▓,
  // meridians in ▒, dusk in ░ — so the orb reads as a volume, not a wire.
  for (const v of LATS) {
    const r = ORB_R * Math.sqrt(Math.max(0, 1 - v * v))
    const steps = 88
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const hit = project({ x: Math.cos(a) * r, y: ORB_CY + v * ORB_R, z: Math.sin(a) * r })
      if (!hit) continue
      const front = hit.facing > 0.02
      const ch = front ? (Math.abs(v) < 0.45 ? "▓" : "░") : "░"
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
      const ch = front ? "▒" : "░"
      plotParticle(cells, width, height, hit, ch, front ? theme.cyan : theme.faint, 2, false)
    }
  }
  // Inner shell: the settings core, a smaller accent wire inside the orb —
  // kept solid on its front arcs so it never dissolves into the shell.
  const inner = 0.45
  for (const v of [-0.5, 0, 0.5]) {
    const r = inner * Math.sqrt(Math.max(0, 1 - v * v))
    const steps = 52
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2
      const hit = project({ x: Math.cos(a) * r, y: ORB_CY + v * inner, z: Math.sin(a) * r })
      if (!hit) continue
      plotParticle(cells, width, height, hit, hit.facing > 0 ? "▒" : "░", hit.facing > 0 ? theme.accent : theme.dim, 3, false)
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
      plotParticle(cells, width, height, hit, hit.facing > 0 ? "▒" : "░", hit.facing > 0 ? theme.accent : theme.dim, 3, false)
    }
  }
  const pulse = Math.sin(tick * 0.15) > 0 ? "◆" : "●"
  // The core outranks the shell (rank 6 over 3): it must read as the bright
  // center of the orb, never as a dot lost behind its own wires.
  plotParticle(cells, width, height, project({ x: 0, y: ORB_CY, z: 0 }), pulse, theme.accent, 6, true)
}

// ── drawing primitives ───────────────────────────────────────────────────

type Projected = { col: number; row: number; depth: number; facing: number }
type CameraHit = { px: number; py: number; depth: number; facing: number }
type View = { scale: number; midX: number; midY: number; width: number; height: number }

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

function boundSamples(kind: HomeArtKind): readonly Vec3[] {
  const cached = sampleCache.get(kind)
  if (cached) return cached
  let samples: readonly Vec3[]
  if (kind === "pipelines") {
    // The tetromino choreography moves the blocks all over the playfield;
    // sweep the whole cycle so the fit never clips a flying block.
    const poses: Vec3[] = []
    for (let tick = 0; tick < TETRIS_TOTAL; tick += 8) poses.push(...formCloud(kind, 16, tick))
    samples = poses
  } else {
    const cloud = formCloud(kind, 72, 0)
    // The coil's climbing spark rides above the helix; give it headroom.
    samples = kind === "runs" ? [...cloud, ...cloud.map((point) => ({ x: point.x, y: point.y + 0.16, z: point.z }))] : cloud
  }
  sampleCache.set(kind, samples)
  return samples
}

function stableView(width: number, height: number, kind: HomeArtKind): View {
  const key = `${width}x${height}:${kind}`
  const cached = viewCache.get(key)
  if (cached) return cached
  const samples = boundSamples(kind)
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
  const spanX = Math.max(0.2, 2 * maxAbsX)
  const spanY = Math.max(0.2, maxY - minY)
  const scale = Math.min((width * (1 - 2 * PAD)) / spanX, (height * (1 - 2 * PAD)) / spanY)
  const view: View = {
    scale: Number.isFinite(scale) && scale > 0 ? scale : Math.min(width, height) * 0.4,
    midX: 0,
    midY: Number.isFinite(minY) ? (minY + maxY) / 2 : 0,
    width,
    height,
  }
  viewCache.set(key, view)
  return view
}

function projectPoint(point: Vec3, yaw: number, tilt: number, view: View): Projected | undefined {
  const hit = cameraPoint(point, yaw, tilt)
  if (!hit) return undefined
  const col = (view.width - 1) / 2 + (hit.px - view.midX) * view.scale
  const row = (view.height - 1) / 2 + (hit.py - view.midY) * view.scale
  return { col, row, depth: hit.depth, facing: hit.facing }
}

// An isometric solid block: three visible faces filled edge-to-edge with
// block-density glyphs in the cube's own color — █ on the lit top, ▓ on the
// lighter side, ▒ on the darker side. The terminal's background supplies the
// dark, so a single hue reads as three tones of one material. No outlines:
// stroked edges at this scale decay into diagonal noise, while solid faces
// plus the depth buffer keep even touching blocks crisp. During the lock
// flash the top face burns yellow.
function plotIsoCube(
  cells: Array<Cell | undefined>,
  width: number,
  height: number,
  project: (point: Vec3) => Projected | undefined,
  center: Vec3,
  size: number,
  color: string,
  flash: boolean,
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
  fillFace(cells, width, height, project, tD, tC, bC, bD, "▒", color, 4, false)
  fillFace(cells, width, height, project, tB, bB, bC, tC, "▓", color, 4, false)
  fillFace(cells, width, height, project, tA, tB, tC, tD, "█", flash ? theme.yellow : color, flash ? 6 : 5, flash)
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

function roleGlyph(role: Role) {
  if (role === "live") return "◆"
  if (role === "inner") return "•"
  if (role === "path") return "•"
  return "·"
}

function roleColor(role: Role) {
  if (role === "live") return theme.accent
  if (role === "inner") return theme.cyan
  if (role === "path") return theme.teal
  return theme.dim
}

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

function resample(points: readonly Vec3[], n: number): Vec3[] {
  if (points.length === n) return points.map((point) => ({ x: point.x, y: point.y, z: point.z }))
  if (points.length === 0) return Array.from({ length: n }, () => ({ x: 0, y: 0, z: 0 }))
  if (points.length > n) {
    return Array.from({ length: n }, (_, i) => {
      const point = points[Math.floor((i * points.length) / n)]!
      return { x: point.x, y: point.y, z: point.z }
    })
  }
  return Array.from({ length: n }, (_, i) => {
    const t = (i * points.length) / n
    const a = Math.floor(t) % points.length
    const b = (a + 1) % points.length
    return {
      x: lerp(points[a]!.x, points[b]!.x, t - Math.floor(t)),
      y: lerp(points[a]!.y, points[b]!.y, t - Math.floor(t)),
      z: lerp(points[a]!.z, points[b]!.z, t - Math.floor(t)),
    }
  })
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

function smoothstep(t: number) {
  const x = clamp(t, 0, 1)
  return x * x * (3 - 2 * x)
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
