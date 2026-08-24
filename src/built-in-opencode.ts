import convoyMd from "../opencode/commands/convoy.md" with { type: "text" }
import spinMd from "../opencode/commands/spin.md" with { type: "text" }
import convoyRun from "../opencode/bin/convoy-run" with { type: "text" }

/**
 * OpenCode install payload embedded as text at bundle time, so a standalone
 * `convoy` binary can run `convoy opencode install` without a source checkout.
 * Every file under opencode/commands/ and opencode/bin/ must have an import
 * above and an entry here (a test in opencode-install.test.ts enforces this).
 */
export type BuiltInOpenCodePayloadFile = {
  /** Path relative to the OpenCode config dir (e.g. `commands/convoy.md`). */
  relPath: string
  content: string
  /** Unix mode applied after write. Set for helpers invoked as commands. */
  mode?: number
}

export const builtInOpenCodePayload: readonly BuiltInOpenCodePayloadFile[] = [
  { relPath: "commands/convoy.md", content: convoyMd },
  { relPath: "commands/spin.md", content: spinMd },
  { relPath: "bin/convoy-run", content: convoyRun, mode: 0o755 },
]
