import { expect, test } from "bun:test"
import { crc32, deflateSync } from "node:zlib"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { pngBufferIsWellFormed } from "../src/kitty-graphics"
import { decodePngToRgba, encodeRgbaPng, homePhotoMaxWidth, tintPngToAccent } from "../src/png-tint"

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type)
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(data, crc32(typeBuf)) >>> 0, 8 + data.length)
  return out
}

function rgbPng(width: number, height: number, pixels: number[]): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc(height * (width * 3 + 1))
  let p = 0
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    for (let x = 0; x < width * 3; x++) raw[y * (width * 3 + 1) + 1 + x] = pixels[p++]!
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

test("tintPngToAccent paints light paper with the accent and punches dark ink to alpha 0", () => {
  // One white pixel, one pure-blue pixel — the two tones of the home photos.
  const source = rgbPng(2, 1, [255, 255, 255, 0, 0, 255])
  const tinted = tintPngToAccent(source, "#7AA2F7")
  expect(pngBufferIsWellFormed(tinted)).toBeTrue()
  const decoded = decodePngToRgba(tinted)
  expect(decoded?.width).toBe(2)
  expect(decoded?.rgba.subarray(0, 4)).toEqual(Buffer.from([0x7a, 0xa2, 0xf7, 255]))
  expect(decoded?.rgba.subarray(4, 8)).toEqual(Buffer.from([0, 0, 0, 0]))
})

test("tintPngToAccent treats near-white as accent and mid-gray as a hole", () => {
  const paper = rgbPng(1, 1, [200, 200, 200])
  expect(decodePngToRgba(tintPngToAccent(paper, "#2E7DE9"))?.rgba.subarray(0, 4)).toEqual(Buffer.from([0x2e, 0x7d, 0xe9, 255]))
  const ink = rgbPng(1, 1, [100, 100, 100])
  expect(decodePngToRgba(tintPngToAccent(ink, "#2E7DE9"))?.rgba.subarray(0, 4)).toEqual(Buffer.from([0, 0, 0, 0]))
})

test("encodeRgbaPng round-trips through the decoder", () => {
  const rgba = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])
  const decoded = decodePngToRgba(encodeRgbaPng({ width: 2, height: 1, rgba }))
  expect(decoded?.rgba).toEqual(rgba)
})

test("home pipeline photo tints to accent ink over a transparent field", () => {
  const path = join(import.meta.dir, "..", "assets", "home", "pipelines.png")
  const tinted = tintPngToAccent(readFileSync(path), "#7AA2F7")
  expect(pngBufferIsWellFormed(tinted)).toBeTrue()
  const decoded = decodePngToRgba(tinted)
  expect(decoded).toBeDefined()
  let transparent = 0
  let ink = 0
  const rgba = decoded!.rgba
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) transparent++
    else if (rgba[i] === 0x7a && rgba[i + 1] === 0xa2 && rgba[i + 2] === 0xf7) ink++
  }
  const pixels = decoded!.width * decoded!.height
  expect(decoded!.width).toBeLessThanOrEqual(homePhotoMaxWidth)
  expect(transparent).toBeGreaterThan(pixels * 0.15)
  expect(ink).toBeGreaterThan(pixels * 0.15)
})
