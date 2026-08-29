import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

import { log } from "./log"

/**
 * The reborn `opencode-install`: exactly one file (design D8). Convoy writes a
 * single global OpenCode command — `~/.config/opencode/commands/spin.md` —
 * whose template tells the agent to run `convoy spin` and relay its output.
 * No plugin, no bin shim, no per-repo artifacts; the old install's scope was
 * its failure. Idempotent, versioned, and touches nothing it does not own.
 */

/** Bumped when the template changes so a re-install refreshes stale copies. */
const spinCommandVersion = 1

/** The marker line identifying the file as convoy-owned and versioned. */
const spinCommandMarker = `<!-- convoy:spin v${spinCommandVersion} -->`

const spinCommandBody = `${spinCommandMarker}
---
description: Spin the current OpenSpec change out into an isolated worktree
---

Run \`convoy spin\` in the repository with the shell and report its output verbatim.

Do not run git commands yourself, do not infer or name branches, and do not create
worktrees — convoy owns all of that. If the output lists several changes to pick
from, ask me which one and run \`convoy spin --change <id>\`. If it reports a
refusal (dirty tree, no change), relay the message as-is.`

/** The absolute path of the command file Convoy owns, given the commands dir. */
export function spinCommandPath(commandsDir?: string): string {
  return join(commandsDir ?? defaultOpencodeCommandsDir(), "spin.md")
}

function defaultOpencodeCommandsDir(): string {
  // Relocatable for tests and exotic setups; production resolves to the
  // user's global OpenCode config.
  return process.env.CONVOY_OPENCODE_COMMANDS_DIR || join(homedir(), ".config", "opencode", "commands")
}

export type SpinCommandInstall = {
  path: string
  /** true = written/refreshed; false = already current, nothing written. */
  updated: boolean
  /**
   * true when `spin.md` exists at the install path without the convoy marker
   * (an operator-authored command) and was deliberately left untouched.
   */
  skipped?: boolean
}

/**
 * Installs or refreshes the global `/spin` command. Only `spin.md` is ever
 * written; any other command file in the directory is never
 * read-modified-or-deleted. A missing file, a stale convoy version, or an
 * edited copy that still carries the convoy marker is refreshed to the
 * current template — the file is convoy-owned once it carries the marker. A
 * file present *without* the marker is the operator's own command: it is
 * never overwritten (SC-3), the install backs off with a warning, and `/spin`
 * stays whatever the operator wrote.
 */
export async function installSpinCommand(commandsDir?: string): Promise<SpinCommandInstall> {
  const dir = commandsDir ?? defaultOpencodeCommandsDir()
  const path = spinCommandPath(dir)
  await mkdir(dir, { recursive: true })

  let current: string | undefined
  try {
    current = await readFile(path, "utf8")
  } catch {
    // First install.
  }
  if (current !== undefined) {
    // Any prior convoy-owned file carries the `convoy:spin` marker regardless
    // of its version number, so a stale copy is recognized (and refreshed) even
    // when its version tag differs from the current one.
    if (current.includes("convoy:spin")) {
      // Already owned and current. A stale copy (older version) is refreshed
      // below; anything else in the directory stays byte-identical to before.
      if (current === spinCommandBody) return { path, updated: false }
    } else {
      // An operator-authored spin.md. Never clobber their file.
      log.warn(
        `opencode-install: ${path} exists without the convoy marker — leaving the operator's command untouched and skipping the /spin install`,
      )
      return { path, updated: false, skipped: true }
    }
  }

  await writeFile(path, spinCommandBody, "utf8")
  log.info(`opencode-install: wrote ${path}`)
  return { path, updated: true }
}

/** Diagnostics for tests: the command file names Convoy leaves untouched. */
export async function listCommandFiles(commandsDir: string): Promise<string[]> {
  try {
    return (await readdir(commandsDir)).sort()
  } catch {
    return []
  }
}
