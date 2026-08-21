import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { waitForServerUrl } from "../src/attach-runtime"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-attach-follow-"))
  dirs.push(dir)
  return dir
}

const never = new Promise<unknown>(() => {})

describe("waitForServerUrl", () => {
  test("returns immediately when the run already recorded its server", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "metadata.json"), JSON.stringify({ schemaVersion: 3, phases: {}, server: { url: "http://127.0.0.1:4321", pid: 1, startedAt: 1 } }))
    expect(await waitForServerUrl(join(dir, "metadata.json"), never)).toBe("http://127.0.0.1:4321")
  })

  test("waits until the server entry appears", async () => {
    const dir = await scratch()
    const metaPath = join(dir, "metadata.json")
    await writeFile(metaPath, JSON.stringify({ schemaVersion: 3, phases: {} }))
    const waiting = waitForServerUrl(metaPath, never, 10)
    await Bun.sleep(40)
    await writeFile(metaPath, JSON.stringify({ schemaVersion: 3, phases: {}, server: { url: "http://127.0.0.1:8765", pid: 2, startedAt: 2 } }))
    expect(await waiting).toBe("http://127.0.0.1:8765")
  })

  test("gives up when the caller leaves (coordinator died or user detached)", async () => {
    const dir = await scratch()
    const metaPath = join(dir, "metadata.json")
    await writeFile(metaPath, JSON.stringify({ schemaVersion: 3, phases: {} }))
    const abort = Promise.resolve("gone")
    expect(await waitForServerUrl(metaPath, abort, 10)).toBeUndefined()
  })

  test("tolerates missing metadata (a run dir that never got one)", async () => {
    const dir = await scratch()
    // A missing file must poll, not throw — the workspace may not exist yet.
    const waiting = waitForServerUrl(join(dir, "none", "metadata.json"), never, 10)
    await mkdir(join(dir, "none"), { recursive: true })
    await writeFile(join(dir, "none", "metadata.json"), JSON.stringify({ schemaVersion: 3, phases: {}, server: { url: "http://127.0.0.1:9", pid: 3, startedAt: 3 } }))
    expect(await waiting).toBe("http://127.0.0.1:9")
  })
})
