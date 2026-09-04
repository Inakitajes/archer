// Kitty graphics protocol: transmit-and-display a PNG at an exact cell
// rectangle, and delete placements again. The home uses this to paint a
// centered poster card above the destination dock, falling back to the
// navigation-only layout when the terminal can't speak the protocol.
//
// Support detection uses environment hints plus a terminal query before the
// TUI renderer owns stdin. CONVOY_KITTY=1 forces the protocol on,
// CONVOY_KITTY=0 forces it off — the escape hatch for terminals we fail to
// detect correctly.

import { readFileSync } from "node:fs"
import { crc32 } from "node:zlib"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Base64 payload per graphics escape; the spec caps control data at 4 KiB. */
const CHUNK_BYTES = 4096

/** Typical terminal cells are twice as tall as they are wide. */
const DEFAULT_CELL_ASPECT_RATIO = 0.5
let detectedCellAspectRatio = DEFAULT_CELL_ASPECT_RATIO

export type KittySourceRect = { x: number; y: number; width: number; height: number }

export function terminalCellAspectRatio(): number {
  return detectedCellAspectRatio
}

/** Parses the CSI 16 t response: CSI 6 ; cell-height ; cell-width t. */
export function cellAspectRatioFromResponse(data: string): number | undefined {
  const match = data.match(/\x1b\[6;(\d+);(\d+)t/)
  if (!match) return undefined
  const height = Number(match[1])
  const width = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return width / height
}

export function kittyGraphicsSupported(): boolean {
  const override = process.env.CONVOY_KITTY
  if (override === "1") return true
  if (override === "0") return false
  return envSniffsSupported()
}

function envSniffsSupported(): boolean {
  const term = process.env.TERM ?? ""
  return Boolean(
    process.env.KITTY_WINDOW_ID ||
      process.env.KITTY_PID ||
      term.includes("kitty") ||
      term.includes("ghostty") ||
      process.env.WEZTERM_EXECUTABLE ||
      process.env.TERM_PROGRAM === "WezTerm" ||
      process.env.GHOSTTY_RESOURCES_DIR ||
      process.env.GHOSTTY_BIN_DIR ||
      process.env.KONSOLE_VERSION,
  )
}

/**
 * Capability probe for terminals that don't advertise themselves in the
 * environment — the common case over SSH, where the client's env stays on the
 * local machine. Ask the terminal itself: a kitty graphics query followed by
 * a Primary DA as a response barrier. Only graphics-capable terminals parse
 * the query at all, so ANY APC reply for our image id — an OK, an error, a
 * deprecation notice — proves support. Must run before a TUI renderer takes
 * over stdin.
 */
export async function probeKittyGraphics(timeoutMs = 800): Promise<boolean> {
  const override = process.env.CONVOY_KITTY
  if (override === "0") return false
  const forced = override === "1"
  const advertised = envSniffsSupported()
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") return forced || advertised

  const stdin = process.stdin
  const wasRaw = stdin.isRaw === true
  if (!wasRaw) stdin.setRawMode(true)
  return await new Promise<boolean>((resolve) => {
    let data = ""
    let settled = false
    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      stdin.off("data", onData)
      if (!wasRaw) stdin.setRawMode(false)
      resolve(result)
    }
    const onData = (chunk: Buffer | string) => {
      // latin1 keeps escape bytes byte-aligned no matter what else arrives.
      data += typeof chunk === "string" ? chunk : chunk.toString("latin1")
      const aspectRatio = cellAspectRatioFromResponse(data)
      if (aspectRatio) detectedCellAspectRatio = aspectRatio
      // The DA1 reply is the barrier: by the time it lands, the terminal has
      // said everything it is going to say about the graphics query.
      if (/\x1b\[\?[0-9;]*c/.test(data)) {
        finish(forced || /_Gi=31;/.test(data))
      }
    }
    const timer = setTimeout(() => finish(forced), timeoutMs)
    stdin.on("data", onData)
    // CSI 16 t reports the exact cell size in pixels. That lets cover-cropped
    // placements account for non-square terminal cells instead of guessing.
    process.stdout.write("\x1b[16t")
    // Probe even when the environment advertises support: tmux or another
    // intermediary may still block graphics passthrough. In that case the
    // home must retain its ASCII fallback instead of becoming a blank canvas.
    process.stdout.write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\")
    process.stdout.write("\x1b[c")
  })
}

/**
 * Walks a PNG's chunks and verifies magic, CRCs, IHDR-first, at least one
 * IDAT, and a terminating IEND. Ghostty (and libpng) reject files that fail
 * this; a lenient viewer may still show a sliver of pixels. Used to keep
 * corrupt photos from blanking the home — better the ASCII sculpture than
 * a black rectangle.
 */
export function pngIsWellFormed(path: string): boolean {
  try {
    return pngBufferIsWellFormed(readFileSync(path))
  } catch {
    return false
  }
}

export function pngBufferIsWellFormed(buf: Buffer): boolean {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return false
  let offset = 8
  let index = 0
  let sawIdat = false
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.subarray(offset + 4, offset + 8)
    if (offset + 12 + length > buf.length) return false
    const typeStr = type.toString("latin1")
    if (!/^[A-Za-z]{4}$/.test(typeStr)) return false
    const payload = buf.subarray(offset + 8, offset + 8 + length)
    const got = buf.readUInt32BE(offset + 8 + length)
    const expected = crc32(payload, crc32(type)) >>> 0
    if (got !== expected) return false
    if (index === 0 && typeStr !== "IHDR") return false
    if (typeStr === "IDAT") sawIdat = true
    offset += 12 + length
    index += 1
    if (typeStr === "IEND") return sawIdat && offset === buf.length
  }
  return false
}

/** Reads the natural pixel dimensions from a PNG's IHDR. */
export function pngDimensions(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return undefined
  if (buf.readUInt32BE(8) !== 13 || buf.subarray(12, 16).toString("latin1") !== "IHDR") return undefined
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * Returns the centered source crop whose aspect matches the physical target.
 * Scaling this rect to the target is the graphics-protocol equivalent of
 * object-fit: cover: the image fills the area without being distorted.
 */
export function coverSourceRect(options: {
  sourceWidth: number
  sourceHeight: number
  targetWidth: number
  targetHeight: number
}): KittySourceRect {
  const sourceWidth = Math.max(1, Math.floor(options.sourceWidth))
  const sourceHeight = Math.max(1, Math.floor(options.sourceHeight))
  const targetWidth = Math.max(Number.EPSILON, options.targetWidth)
  const targetHeight = Math.max(Number.EPSILON, options.targetHeight)
  let width = sourceWidth
  let height = sourceHeight

  if (sourceWidth * targetHeight > sourceHeight * targetWidth) {
    width = Math.max(1, Math.min(sourceWidth, Math.round((sourceHeight * targetWidth) / targetHeight)))
  } else {
    height = Math.max(1, Math.min(sourceHeight, Math.round((sourceWidth * targetHeight) / targetWidth)))
  }

  return {
    x: Math.floor((sourceWidth - width) / 2),
    y: Math.floor((sourceHeight - height) / 2),
    width,
    height,
  }
}

/**
 * The largest cell rect that shows the WHOLE image without distortion:
 * contain-fit instead of cover-crop, bounded by the available space and the
 * poster caps, centered by the caller. `cellAspect` is cell width/height, so
 * the image's pixel aspect maps to `colsPerRow = aspect / cellAspect` cells
 * per row; rounding keeps the rect within one cell of the true aspect.
 * Always returns at least 1x1.
 */
export function containCard(options: {
  sourceWidth: number
  sourceHeight: number
  availableCols: number
  availableRows: number
  cellAspect: number
  maxCols: number
  maxRows: number
}): { cols: number; rows: number } {
  const sourceWidth = Math.max(1, Math.floor(options.sourceWidth))
  const sourceHeight = Math.max(1, Math.floor(options.sourceHeight))
  const cellAspect = options.cellAspect > 0 ? options.cellAspect : DEFAULT_CELL_ASPECT_RATIO
  const colsLimit = Math.max(1, Math.min(Math.floor(options.maxCols), Math.floor(options.availableCols)))
  const rowsLimit = Math.max(1, Math.min(Math.floor(options.maxRows), Math.floor(options.availableRows)))
  const colsPerRow = sourceWidth / sourceHeight / cellAspect
  const rows = Math.max(1, Math.min(rowsLimit, Math.floor(colsLimit / colsPerRow)))
  const cols = Math.max(1, Math.min(colsLimit, Math.round(rows * colsPerRow)))
  return { cols, rows }
}

function readPng(path: string): Buffer | undefined {
  try {
    const buf = readFileSync(path)
    return pngBufferIsWellFormed(buf) ? buf : undefined
  } catch {
    return undefined
  }
}

/** Splits base64 into spec-sized chunks (pure, so tests can pin the cut points). */
export function base64Chunks(data: string, size = CHUNK_BYTES): string[] {
  const chunks: string[] = []
  for (let i = 0; i < data.length; i += size) chunks.push(data.slice(i, i + size))
  return chunks
}

/**
 * Transmits a PNG and displays it scaled over the cell rect (col,row) ..
 * (col+cols, row+rows). z=0 keeps the image above the text layer — a TUI
 * that paints every cell (opentui does, with an explicit background) would
 * otherwise composite its cells over a negative-z image. C=1 leaves the real
 * cursor alone, q=2 silences every protocol response. Returns false when
 * there is nothing to draw (missing or unreadable file). Capability gating is
 * the caller's job — env sniffing is unreliable over SSH, so the probe result
 * travels as a decision, not as a re-check here.
 */
export function displayKittyImage(options: {
  id: number
  path: string
  col: number
  row: number
  cols: number
  rows: number
  source?: KittySourceRect
}): boolean {
  const png = readPng(options.path)
  if (!png) return false
  const chunks = base64Chunks(png.toString("base64"))
  const out = process.stdout
  // Position first: the placement anchors at the cursor's cell. Save/restore
  // the cursor so the TUI renderer never notices we were here.
  out.write("\x1b7")
  out.write(`\x1b[${options.row + 1};${options.col + 1}H`)
  chunks.forEach((chunk, index) => {
    const more = index < chunks.length - 1
    if (index === 0) {
      out.write(
        `\x1b_Ga=T,f=100,q=2,C=1,z=0,i=${options.id},c=${options.cols},r=${options.rows}${sourceRectControls(options.source)}${more ? ",m=1" : ""};${chunk}\x1b\\`,
      )
    } else {
      // Continuation chunks must carry only m (and optionally q) per spec.
      out.write(`\x1b_Gq=2,m=${more ? 1 : 0};${chunk}\x1b\\`)
    }
  })
  out.write("\x1b8")
  return true
}

/**
 * Transmits a PNG into the terminal's image store WITHOUT displaying it.
 * Pair with placeKittyImage: transmit once per image, re-place cheaply on
 * every frame. `png` (already-tinted bytes) wins over `path`. Returns false
 * when there is nothing to send.
 */
export function transmitKittyImage(options: { id: number; path?: string; png?: Buffer }): boolean {
  const png = options.png ?? (options.path ? readPng(options.path) : undefined)
  if (!png) return false
  const chunks = base64Chunks(png.toString("base64"))
  const parts: string[] = []
  chunks.forEach((piece, index) => {
    const more = index < chunks.length - 1
    if (index === 0) {
      // First chunk carries the full command: a=t transmit-and-store.
      parts.push(`\x1b_Ga=t,f=100,q=2,i=${options.id}${more ? ",m=1" : ""};${piece}\x1b\\`)
    } else {
      // Continuation chunks must carry only m (and optionally q) per spec.
      parts.push(`\x1b_Gq=2,m=${more ? 1 : 0};${piece}\x1b\\`)
    }
  })
  // One write: many small writes over SSH turn into many packets.
  process.stdout.write(parts.join(""))
  return true
}

/**
 * Displays a previously transmitted image over the cell rect (col,row) ..
 * (col+cols, row+rows). Placement id 1 is fixed, so re-placing replaces the
 * old rect in place — the documented way to move/resize without flicker and
 * without re-sending pixel data. z=0 keeps the image above the text layer: a
 * TUI that paints every cell (opentui does, with an explicit background)
 * would otherwise composite its cells over a negative-z image.
 */
export function kittyPlacementCommand(options: {
  id: number
  cols: number
  rows: number
  source?: KittySourceRect
}): string {
  return `\x1b_Ga=p,i=${options.id},p=1,q=2,C=1,z=0,c=${options.cols},r=${options.rows}${sourceRectControls(options.source)};\x1b\\`
}

function sourceRectControls(source: KittySourceRect | undefined): string {
  if (!source) return ""
  return `,x=${source.x},y=${source.y},w=${source.width},h=${source.height}`
}

export function placeKittyImage(options: {
  id: number
  col: number
  row: number
  cols: number
  rows: number
  source?: KittySourceRect
}): void {
  const out = process.stdout
  out.write("\x1b7")
  out.write(`\x1b[${options.row + 1};${options.col + 1}H`)
  out.write(kittyPlacementCommand(options))
  out.write("\x1b8")
}

/**
 * Deletes placements by image id — pass free=true to also release the stored
 * pixel data (lowercase d=i keeps the data so the image can be re-placed
 * without re-transmission). Deleting an unknown id is a no-op.
 */
export function deleteKittyImages(ids: readonly number[], free = false): void {
  for (const id of ids) process.stdout.write(`\x1b_Ga=d,d=${free ? "I" : "i"},i=${id},q=2\x1b\\`)
}
