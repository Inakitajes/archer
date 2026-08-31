// Recolor a home photo so the paper follows the TUI accent and the ink
// disappears. The illustrations are two-tone dithers (blue on white); light
// samples become the accent, dark samples become transparent. Decode/encode
// stay local — no extra dependency — and only have to handle the 8-bit PNG
// flavors we actually ship (palette, RGB, RGBA). Caps width so a 2816px
// photo does not block the home for seconds over SSH.

import { crc32, deflateSync, inflateSync } from "node:zlib"

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export type RgbaImage = { width: number; height: number; rgba: Buffer }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function parseHex(hex: string): [number, number, number] {
  const n = hex.startsWith("#") ? hex.slice(1) : hex
  if (!/^[0-9a-fA-F]{6}$/.test(n)) return [0x7a, 0xa2, 0xf7]
  return [Number.parseInt(n.slice(0, 2), 16), Number.parseInt(n.slice(2, 4), 16), Number.parseInt(n.slice(4, 6), 16)]
}

function readChunks(buf: Buffer): Array<{ type: string; data: Buffer }> | undefined {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_MAGIC)) return undefined
  const out: Array<{ type: string; data: Buffer }> = []
  let offset = 8
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const typeBuf = buf.subarray(offset + 4, offset + 8)
    const type = typeBuf.toString("latin1")
    if (offset + 12 + length > buf.length) return undefined
    if (!/^[A-Za-z]{4}$/.test(type)) return undefined
    const data = buf.subarray(offset + 8, offset + 8 + length)
    const got = buf.readUInt32BE(offset + 8 + length)
    if (got !== (crc32(data, crc32(typeBuf)) >>> 0)) return undefined
    out.push({ type, data })
    offset += 12 + length
    if (type === "IEND") return offset === buf.length ? out : undefined
  }
  return undefined
}

function unfilter(inflated: Buffer, width: number, height: number, bpp: number): Buffer | undefined {
  const stride = width * bpp
  const row = stride + 1
  if (inflated.length !== height * row) return undefined
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * row]!
    const src = y * row + 1
    const dst = y * stride
    const prev = dst - stride
    for (let i = 0; i < stride; i++) {
      const raw = inflated[src + i]!
      const left = i >= bpp ? out[dst + i - bpp]! : 0
      const up = y > 0 ? out[prev + i]! : 0
      const upLeft = y > 0 && i >= bpp ? out[prev + i - bpp]! : 0
      let value = raw
      switch (filter) {
        case 0:
          break
        case 1:
          value = (raw + left) & 255
          break
        case 2:
          value = (raw + up) & 255
          break
        case 3:
          value = (raw + ((left + up) >> 1)) & 255
          break
        case 4:
          value = (raw + paeth(left, up, upLeft)) & 255
          break
        default:
          return undefined
      }
      out[dst + i] = value
    }
  }
  return out
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type)
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(data, crc32(typeBuf)) >>> 0, 8 + data.length)
  return out
}

export function decodePngToRgba(buf: Buffer): RgbaImage | undefined {
  const chunks = readChunks(buf)
  if (!chunks || chunks[0]?.type !== "IHDR") return undefined
  const ihdr = chunks[0].data
  if (ihdr.length < 13) return undefined
  const width = ihdr.readUInt32BE(0)
  const height = ihdr.readUInt32BE(4)
  const bitDepth = ihdr[8]
  const colorType = ihdr[9]
  const interlace = ihdr[12]
  if (bitDepth !== 8 || interlace !== 0 || width === 0 || height === 0) return undefined
  if (colorType !== 2 && colorType !== 3 && colorType !== 6) return undefined

  let palette: Buffer | undefined
  let transparency: Buffer | undefined
  const idat: Buffer[] = []
  for (const entry of chunks) {
    if (entry.type === "PLTE") palette = entry.data
    else if (entry.type === "tRNS") transparency = entry.data
    else if (entry.type === "IDAT") idat.push(entry.data)
  }
  if (idat.length === 0) return undefined
  if (colorType === 3 && (!palette || palette.length < 3 || palette.length % 3 !== 0)) return undefined

  let inflated: Buffer
  try {
    inflated = inflateSync(Buffer.concat(idat))
  } catch {
    return undefined
  }
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : 1
  const samples = unfilter(inflated, width, height, bpp)
  if (!samples) return undefined

  const rgba = Buffer.alloc(width * height * 4)
  const pixels = width * height
  if (colorType === 6) {
    samples.copy(rgba)
  } else if (colorType === 2) {
    for (let i = 0, p = 0; i < pixels; i++, p += 3) {
      const o = i * 4
      rgba[o] = samples[p]!
      rgba[o + 1] = samples[p + 1]!
      rgba[o + 2] = samples[p + 2]!
      rgba[o + 3] = 255
    }
  } else {
    const swatches = palette!.length / 3
    for (let i = 0; i < pixels; i++) {
      const index = samples[i]!
      if (index >= swatches) return undefined
      const o = i * 4
      const p = index * 3
      rgba[o] = palette![p]!
      rgba[o + 1] = palette![p + 1]!
      rgba[o + 2] = palette![p + 2]!
      rgba[o + 3] = transparency && index < transparency.length ? transparency[index]! : 255
    }
  }
  return { width, height, rgba }
}

export function encodeRgbaPng(image: RgbaImage): Buffer {
  const { width, height, rgba } = image
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const src = y * stride
    const dst = y * (stride + 1)
    raw[dst] = 0
    rgba.copy(raw, dst + 1, src, src + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([PNG_MAGIC, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 3 })), chunk("IEND", Buffer.alloc(0))])
}

/** Terminal cells are ~8px; 800px already fills a wide window 1:1. */
export const homePhotoMaxWidth = 800
const LIGHT_FLOOR = 160

function downscaleMask(width: number, height: number, mask: Buffer, maxWidth: number): { width: number; height: number; mask: Buffer } {
  if (width <= maxWidth) return { width, height, mask }
  const nextWidth = maxWidth
  const nextHeight = Math.max(1, Math.round((height * maxWidth) / width))
  const out = Buffer.alloc(nextWidth * nextHeight)
  for (let y = 0; y < nextHeight; y++) {
    const sourceY = Math.min(height - 1, Math.floor((y * height) / nextHeight))
    for (let x = 0; x < nextWidth; x++) {
      const sourceX = Math.min(width - 1, Math.floor((x * width) / nextWidth))
      out[y * nextWidth + x] = mask[sourceY * width + sourceX]!
    }
  }
  return { width: nextWidth, height: nextHeight, mask: out }
}

function encodeStencilPng(width: number, height: number, mask: Buffer, accent: [number, number, number]): Buffer {
  const stride = width
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1)
    raw[dst] = 0
    mask.copy(raw, dst + 1, y * stride, y * stride + stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 3
  const palette = Buffer.from([0, 0, 0, accent[0], accent[1], accent[2]])
  const transparency = Buffer.from([0])
  return Buffer.concat([
    PNG_MAGIC,
    chunk("IHDR", ihdr),
    chunk("PLTE", palette),
    chunk("tRNS", transparency),
    chunk("IDAT", deflateSync(raw, { level: 3 })),
    chunk("IEND", Buffer.alloc(0)),
  ])
}

/**
 * Recolor a two-tone photo as a stencil: light paper becomes the accent,
 * dark ink becomes transparent so the terminal background shows through.
 * Caps width at `homePhotoMaxWidth` — the protocol scales to the cell rect
 * anyway, and 2816px photos were taking seconds to decode and ship over SSH.
 * Returns the original bytes when the PNG can't be decoded.
 */
export function tintPngToAccent(png: Buffer, accentHex: string): Buffer {
  const decoded = decodePngToRgba(png)
  if (!decoded) return png
  const accent = parseHex(accentHex)
  const { width, height, rgba } = decoded
  const mask = Buffer.alloc(width * height)
  for (let i = 0, pixel = 0; i < rgba.length; i += 4, pixel++) {
    // JPEG-quantized paper peaks around 249, never 255. Light → accent (1),
    // dark blue ink → a hole (0).
    mask[pixel] = Math.min(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!) >= LIGHT_FLOOR ? 1 : 0
  }
  const scaled = downscaleMask(width, height, mask, homePhotoMaxWidth)
  return encodeStencilPng(scaled.width, scaled.height, scaled.mask, accent)
}
