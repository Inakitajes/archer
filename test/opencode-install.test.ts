import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { installOpenCode, openCodeConfigDir, openCodePayloadFiles, openCodeStatus, uninstallOpenCode } from "../src/opencode-install"

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function withOpenCodeConfigDir<T>(body: (configDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-opencode-config-"))
  dirs.push(dir)
  const configDir = join(dir, "config", "opencode")
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = configDir
  try {
    return await body(configDir)
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = previous
  }
}

describe("convoy opencode install", () => {
  test("writes the three payload files into OPENCODE_CONFIG_DIR, byte-for-byte from the bundled payload", async () => {
    await withOpenCodeConfigDir(async (configDir) => {
      const result = await installOpenCode()
      expect(result.dir).toBe(configDir)
      expect([...result.installed].sort()).toEqual(["bin/convoy-run", "commands/convoy.md", "commands/spin.md"])

      expect(existsSync(join(configDir, "commands", "spin.md"))).toBe(true)
      expect(existsSync(join(configDir, "commands", "convoy.md"))).toBe(true)
      expect(existsSync(join(configDir, "bin", "convoy-run"))).toBe(true)

      const bundled = await openCodePayloadFiles()
      for (const file of bundled) {
        expect(await readFile(join(configDir, file.relPath), "utf8")).toBe(await readFile(file.source, "utf8"))
      }
    })
  })

  test("re-running install is idempotent and refreshes a tampered copy", async () => {
    await withOpenCodeConfigDir(async (configDir) => {
      const first = await installOpenCode()
      const payload = await openCodePayloadFiles()
      const spinDest = join(configDir, "commands", "spin.md")
      const spinSource = payload.find((file) => file.relPath === "commands/spin.md")!.source

      await writeFile(spinDest, "# tampered\n")
      const second = await installOpenCode()
      expect(second.installed).toEqual(first.installed)
      expect(await readFile(spinDest, "utf8")).toBe(await readFile(spinSource, "utf8"))
    })
  })

  test("status reports installed payload files and their convoy version", async () => {
    await withOpenCodeConfigDir(async (configDir) => {
      expect(openCodeConfigDir()).toBe(configDir)
      const missing = await openCodeStatus()
      expect(missing.records.every((record) => !record.installed)).toBe(true)

      await installOpenCode()
      const present = await openCodeStatus()
      expect(present.dir).toBe(configDir)
      expect(present.version).toContain("v")
      const installed = present.records.filter((record) => record.installed)
      expect(installed.map((record) => record.relPath).sort()).toEqual(["bin/convoy-run", "commands/convoy.md", "commands/spin.md"])
      expect(installed.every((record) => record.matchesBundled)).toBe(true)
    })
  })

  test("uninstall removes only Convoy-owned files and leaves a sentinel alone", async () => {
    await withOpenCodeConfigDir(async (configDir) => {
      await installOpenCode()
      const sentinel = join(configDir, "user-file.txt")
      await writeFile(sentinel, "keep me\n")

      const result = await uninstallOpenCode()
      expect(result.removed.sort()).toEqual(["bin/convoy-run", "commands/convoy.md", "commands/spin.md"])
      expect(result.kept).toEqual([])
      expect(existsSync(join(configDir, "commands", "spin.md"))).toBe(false)
      expect(existsSync(sentinel)).toBe(true)
      expect(await readFile(sentinel, "utf8")).toBe("keep me\n")

      // A second uninstall has nothing left to remove.
      const again = await uninstallOpenCode()
      expect(again.removed).toEqual([])
    })
  })

  test("--dir resolves the destination directly, independent of OPENCODE_CONFIG_DIR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-opencode-dir-"))
    dirs.push(dir)
    const target = join(dir, "custom")
    const result = await installOpenCode({ dir: target })
    expect(result.dir).toBe(target)
    expect(existsSync(join(target, "commands", "convoy.md"))).toBe(true)
  })
})
