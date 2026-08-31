import { expect, test } from "bun:test"
import { crc32, deflateSync } from "node:zlib"

import {
  base64Chunks,
  cellAspectRatioFromResponse,
  coverSourceRect,
  kittyGraphicsSupported,
  kittyPlacementCommand,
  pngBufferIsWellFormed,
  pngDimensions,
} from "../src/kitty-graphics"

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type)
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  typeBuf.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(data, crc32(typeBuf)) >>> 0, 8 + data.length)
  return out
}

function tinyPng(): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(1, 0)
  ihdr.writeUInt32BE(1, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ])
}

test("base64Chunks cuts at exact boundaries and carries the tail", () => {
  expect(base64Chunks("", 4)).toEqual([])
  expect(base64Chunks("abcdefgh", 4)).toEqual(["abcd", "efgh"])
  expect(base64Chunks("abcdef", 4)).toEqual(["abcd", "ef"])
  expect(base64Chunks("ab", 4)).toEqual(["ab"])
})

test("base64Chunks defaults to the protocol's 4096-byte control-data cap", () => {
  const data = "x".repeat(4096 * 2 + 17)
  const chunks = base64Chunks(data)
  expect(chunks).toHaveLength(3)
  expect(chunks[0]!.length).toBe(4096)
  expect(chunks[2]!.length).toBe(17)
})

test("CONVOY_KITTY overrides terminal sniffing in both directions", () => {
  const previous = process.env.CONVOY_KITTY
  try {
    process.env.KITTY_WINDOW_ID = "1"
    process.env.CONVOY_KITTY = "0"
    expect(kittyGraphicsSupported()).toBeFalse()
    process.env.CONVOY_KITTY = "1"
    expect(kittyGraphicsSupported()).toBeTrue()
  } finally {
    if (previous === undefined) delete process.env.CONVOY_KITTY
    else process.env.CONVOY_KITTY = previous
    delete process.env.KITTY_WINDOW_ID
  }
})

test("pngBufferIsWellFormed accepts a minimal PNG and rejects CRC holes", () => {
  const valid = tinyPng()
  expect(pngBufferIsWellFormed(valid)).toBeTrue()
  const damaged = Buffer.from(valid)
  // Flip a payload bit so the IHDR CRC no longer matches — the same class
  // of damage as the unreadable home photos (zeroed IDAT CRCs).
  damaged[19] ^= 1
  expect(pngBufferIsWellFormed(damaged)).toBeFalse()
  expect(pngBufferIsWellFormed(Buffer.from("not a png"))).toBeFalse()
})

test("pngDimensions reads the natural size from IHDR", () => {
  expect(pngDimensions(tinyPng())).toEqual({ width: 1, height: 1 })
  expect(pngDimensions(Buffer.from("not a png"))).toBeUndefined()
})

test("coverSourceRect crops the long axis and stays centered", () => {
  expect(coverSourceRect({ sourceWidth: 800, sourceHeight: 400, targetWidth: 100, targetHeight: 100 })).toEqual({
    x: 200,
    y: 0,
    width: 400,
    height: 400,
  })
  expect(coverSourceRect({ sourceWidth: 400, sourceHeight: 800, targetWidth: 100, targetHeight: 50 })).toEqual({
    x: 0,
    y: 300,
    width: 400,
    height: 200,
  })
  expect(coverSourceRect({ sourceWidth: 800, sourceHeight: 400, targetWidth: 200, targetHeight: 100 })).toEqual({
    x: 0,
    y: 0,
    width: 800,
    height: 400,
  })
})

test("kitty placement serializes the cover crop with its cell destination", () => {
  expect(
    kittyPlacementCommand({
      id: 7,
      cols: 120,
      rows: 24,
      source: { x: 40, y: 0, width: 720, height: 436 },
    }),
  ).toBe("\x1b_Ga=p,i=7,p=1,q=2,C=1,z=0,c=120,r=24,x=40,y=0,w=720,h=436;\x1b\\")
})

test("CSI 16 t cell dimensions provide the physical cell aspect ratio", () => {
  expect(cellAspectRatioFromResponse("noise\x1b[6;20;10tmore")).toBe(0.5)
  expect(cellAspectRatioFromResponse("\x1b[6;0;10t")).toBeUndefined()
  expect(cellAspectRatioFromResponse("no response")).toBeUndefined()
})
