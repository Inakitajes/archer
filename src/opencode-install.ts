import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { homedir } from "node:os"

import { builtInOpenCodePayload, type BuiltInOpenCodePayloadFile } from "./built-in-opencode"
import { shortVersion } from "./version"

/**
 * `convoy opencode install|status|uninstall`
 *
 * Deploys Convoy's OpenSpec-native OpenCode payload — the `/spin` and `/convoy`
 * slash commands and the `convoy-run` helper — into OpenCode's config directory
 * so they sit next to `/opsx:propose`. The payload is embedded at bundle time
 * from `opencode/commands/*.md` and `opencode/bin/*`, so a standalone binary
 * installs the same files a source checkout would.
 *
 * Resolution order for the destination dir: `--dir <path>` (explicitly supplied
 * to the CLI), else `OPENCODE_CONFIG_DIR` (the same variable Convoy already
 * feeds its own server at runtime), else `~/.config/opencode`.
 *
 * Uninstall removes only Convoy-owned files (exactly the payload it installs),
 * never the rest of the directory, so another tool's files are left alone.
 */

export type OpenCodeInstallOptions = {
  /** Where to resolve the OpenCode config dir. `OPENCODE_CONFIG_DIR` or `~/.config/opencode` otherwise. */
  dir?: string
}

export type OpenCodePayloadFile = BuiltInOpenCodePayloadFile

export function openCodeConfigDir(options: OpenCodeInstallOptions = {}): string {
  if (options.dir) return resolve(options.dir)
  if (process.env.OPENCODE_CONFIG_DIR) return resolve(process.env.OPENCODE_CONFIG_DIR)
  return join(homedir(), ".config", "opencode")
}

/** Lists the payload Convoy owns, relative to the config dir, sorted for determinism. */
export function openCodePayloadFiles(): OpenCodePayloadFile[] {
  return builtInOpenCodePayload.map((file) => ({ ...file }))
}

export type OpenCodeInstallResult = {
  dir: string
  /** relPaths written (or refreshed). */
  installed: string[]
}

export async function installOpenCode(options: OpenCodeInstallOptions = {}): Promise<OpenCodeInstallResult> {
  const dir = openCodeConfigDir(options)
  const files = openCodePayloadFiles()
  for (const file of files) {
    const dest = join(dir, file.relPath)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, file.content, "utf8")
    if (file.mode !== undefined) await chmod(dest, file.mode)
  }
  return { dir, installed: files.map((file) => file.relPath) }
}

export type OpenCodeStatusRecord = {
  relPath: string
  installed: boolean
  /** The installed copy byte-for-byte matches the bundled payload (only meaningful when installed). */
  matchesBundled: boolean
}

export type OpenCodeStatusResult = {
  dir: string
  version: string
  records: OpenCodeStatusRecord[]
}

export async function openCodeStatus(options: OpenCodeInstallOptions = {}): Promise<OpenCodeStatusResult> {
  const dir = openCodeConfigDir(options)
  const files = openCodePayloadFiles()
  const records: OpenCodeStatusRecord[] = []
  for (const file of files) {
    const dest = join(dir, file.relPath)
    if (!existsSync(dest)) {
      records.push({ relPath: file.relPath, installed: false, matchesBundled: false })
      continue
    }
    const same = (await readFile(dest, "utf8").catch(() => "")) === file.content
    records.push({ relPath: file.relPath, installed: true, matchesBundled: same })
  }
  return { dir, version: shortVersion(), records }
}

export type OpenCodeUninstallResult = {
  dir: string
  /** Convoy-owned payload files removed. */
  removed: string[]
  /** Payload files that were not installed, so present only in the bundled copy. */
  kept: string[]
}

export async function uninstallOpenCode(options: OpenCodeInstallOptions = {}): Promise<OpenCodeUninstallResult> {
  const dir = openCodeConfigDir(options)
  const files = openCodePayloadFiles()
  const removed: string[] = []
  const kept: string[] = []
  for (const file of files) {
    const dest = join(dir, file.relPath)
    if (existsSync(dest)) {
      await rm(dest, { force: true })
      removed.push(file.relPath)
    } else {
      kept.push(file.relPath)
    }
  }
  // Tidy empty Convoy-owned subdirectories left behind, but never one the user
  // has put files in.
  for (const kind of ["commands", "bin"]) {
    const dirPath = join(dir, kind)
    if (!(await dirExists(dirPath))) continue
    if ((await readdir(dirPath)).length === 0) await rm(dirPath, { force: true }).catch(() => undefined)
  }
  return { dir, removed, kept }
}

export async function runOpenCodeCommand(action: "install" | "status" | "uninstall", options: OpenCodeInstallOptions = {}) {
  switch (action) {
    case "install": {
      const result = await installOpenCode(options)
      process.stdout.write(`installed /spin, /convoy, and convoy-run into ${result.dir}\n`)
      for (const rel of result.installed) process.stdout.write(`  ${rel}\n`)
      return
    }
    case "status": {
      const result = await openCodeStatus(options)
      process.stdout.write(`convoy OpenCode files (${result.version}) in ${result.dir}:\n`)
      const width = result.records.reduce((max, record) => Math.max(max, record.relPath.length), 0)
      for (const record of result.records) {
        const state = !record.installed
          ? "not installed"
          : record.matchesBundled
            ? "installed"
            : "installed — differs from this copy"
        process.stdout.write(`  ${record.relPath.padEnd(width)}  ${state}\n`)
      }
      return
    }
    case "uninstall": {
      const result = await uninstallOpenCode(options)
      process.stdout.write(`removed convoy files from ${result.dir}\n`)
      for (const rel of result.removed) process.stdout.write(`  ${rel}\n`)
      if (result.kept.length > 0) process.stdout.write(`  already absent: ${result.kept.join(", ")}\n`)
      return
    }
  }
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await readdir(dir)
    return true
  } catch {
    return false
  }
}
