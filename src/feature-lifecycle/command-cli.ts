import { lifecycleCommonDir, readRepositoryRecord } from "./store"
import { featureAdopt, featureBind, featureNewWork, featureRecover, featureRevise, featureShow, operationError } from "./commands"

/**
 * The CLI surface of `convoy feature <subcommand>` (design D3's planned
 * commands, tasks 3.1–3.6). Argv parsing stays here; the operations live in
 * `commands.ts` so the TUI and tests consume the same functions.
 */

export function featureHelp(): string {
  return `convoy feature — stable feature lifecycle operations

Usage:
  convoy feature show [<feature-id>] [--json]
  convoy feature adopt --branch <name> --change <id> [--change <id> ...] --base <local-ref>
                      [--archive-path <path>] [--archive-source <change-id>=<path>]...
  convoy feature bind <feature-id> --branch <name> --worktree <path>
  convoy feature revise <feature-id> --change <id> [--change <id> ...] --base <local-ref>
  convoy feature recover <feature-id> [--legacy]
  convoy feature new-work --branch <name> --worktree <path> [--change <id> ...] --base <local-ref>

Feature identities are opaque ids shown by \`convoy feature show\`. Adoption and
rebinding are explicit consent operations; browsing never creates records.
`
}

export type FeatureCommandSpec =
  | { action: "show"; featureId?: string; json: boolean }
  | { action: "adopt"; branch: string; changes: string[]; base: string; displayName?: string; archivePath?: string; archiveSources: Array<{ changeId: string; path: string }> }
  | { action: "bind"; featureId: string; branch: string; worktree: string }
  | { action: "revise"; featureId: string; changes: string[]; base: string }
  | { action: "recover"; featureId?: string; legacy: boolean; changeId?: string }
  | { action: "new-work"; branch: string; worktree: string; changes: string[]; base: string }

export function parseFeatureArgs(argv: string[]): FeatureCommandSpec {
  const sub = argv[0]
  const rest = argv.slice(1)
  if (sub === undefined || sub === "--help" || sub === "-h") throw new Error(featureHelp())

  const flags = new Map<string, string[]>()
  let positionals: string[] = []
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]!
    if (arg === "--json") {
      flags.set("--json", [])
      continue
    }
    if (arg.startsWith("--")) {
      const name = arg
      const value = rest[index + 1]
      if (value === undefined || value.startsWith("--")) {
        flags.set(name, flags.get(name) ?? [])
        continue
      }
      flags.set(name, [...(flags.get(name) ?? []), value])
      index += 1
      continue
    }
    positionals = [...positionals, arg]
  }

  const repeated = (name: string): string[] => flags.get(name) ?? []
  const single = (name: string): string | undefined => flags.get(name)?.[0]
  const requireSingle = (name: string): string => {
    const value = single(name)
    if (value === undefined) throw operationError(`missing required flag ${name}`, "missing")
    return value
  }

  switch (sub) {
    case "show": {
      if (flags.has("--json") === false && rest.length > 1 && !positionals.length) throw operationError(`usage: convoy feature show [<feature-id>] [--json]`, "missing")
      return { action: "show", ...(positionals[0] ? { featureId: positionals[0] } : {}), json: flags.has("--json") }
    }
    case "adopt": {
      const changes = repeated("--change")
      const archiveSources = repeated("--archive-source").map((entry) => {
        const eq = entry.indexOf("=")
        if (eq <= 0) throw operationError(`--archive-source expects <change-id>=<path>, got "${entry}"`, "missing")
        return { changeId: entry.slice(0, eq), path: entry.slice(eq + 1) }
      })
      if (changes.length === 0) throw operationError("adopt requires at least one --change <id>", "missing")
      return {
        action: "adopt",
        branch: requireSingle("--branch"),
        changes,
        base: requireSingle("--base"),
        ...(single("--name") ? { displayName: single("--name") } : {}),
        ...(single("--archive-path") ? { archivePath: single("--archive-path") } : {}),
        archiveSources,
      }
    }
    case "bind": {
      const featureId = positionals[0]
      if (!featureId) throw operationError("usage: convoy feature bind <feature-id> --branch <name> --worktree <path>", "missing")
      return { action: "bind", featureId, branch: requireSingle("--branch"), worktree: requireSingle("--worktree") }
    }
    case "revise": {
      const featureId = positionals[0]
      if (!featureId) throw operationError("usage: convoy feature revise <feature-id> --change <id> [--change <id> ...] --base <local-ref>", "missing")
      const changes = repeated("--change")
      if (changes.length === 0) throw operationError("revise requires at least one --change <id>", "missing")
      return { action: "revise", featureId, changes, base: requireSingle("--base") }
    }
    case "recover": {
      return { action: "recover", ...(positionals[0] ? { featureId: positionals[0] } : {}), legacy: flags.has("--legacy"), ...(single("--change") ? { changeId: single("--change") } : {}) }
    }
    case "new-work": {
      const changes = repeated("--change")
      return {
        action: "new-work",
        branch: requireSingle("--branch"),
        worktree: requireSingle("--worktree"),
        changes,
        base: requireSingle("--base"),
      }
    }
    default:
      throw new Error(featureHelp())
  }
}

/** Executes a parsed feature command; returns process exit code semantics via thrown errors. */
export async function runFeatureCommand(spec: FeatureCommandSpec): Promise<void> {
  const cwd = process.cwd()
  switch (spec.action) {
    case "show": {
      const { output, text } = await featureShow({ cwd, ...(spec.featureId ? { featureId: spec.featureId } : {}), json: spec.json })
      process.stdout.write(`${spec.json ? JSON.stringify(output, null, 2) : text}\n`)
      return
    }
    case "adopt": {
      const { feature } = await featureAdopt({
        cwd,
        branch: spec.branch,
        changeIds: spec.changes,
        base: spec.base,
        ...(spec.displayName ? { displayName: spec.displayName } : {}),
        ...(spec.archivePath ? { archivePath: spec.archivePath } : {}),
        ...(spec.archiveSources.length > 0 ? { archiveSources: spec.archiveSources } : {}),
      })
      process.stdout.write(`adopted feature ${feature.displayName} (${feature.featureId})\n`)
      process.stdout.write(`  branch ${feature.context?.branch ?? spec.branch} · base ${feature.intendedBaseRef}\n`)
      for (const contract of feature.contracts) process.stdout.write(`  contract ${contract.changeId} (${contract.kind})\n`)
      return
    }
    case "bind": {
      const feature = await featureBind({ cwd, featureId: spec.featureId, branch: spec.branch, worktree: spec.worktree })
      process.stdout.write(`bound feature ${feature.displayName} (${feature.featureId}) to ${feature.context?.branch}\n`)
      return
    }
    case "revise": {
      const feature = await featureRevise({ cwd, featureId: spec.featureId, changeIds: spec.changes, base: spec.base })
      process.stdout.write(`revised feature ${feature.displayName} (${feature.featureId}) to revision ${feature.associationRevision}\n`)
      for (const contract of feature.contracts) process.stdout.write(`  contract ${contract.changeId} (${contract.kind})\n`)
      return
    }
    case "recover": {
      const feature = await featureRecover({ cwd, ...(spec.featureId ? { featureId: spec.featureId } : {}), legacy: spec.legacy, ...(spec.changeId ? { changeId: spec.changeId } : {}) })
      process.stdout.write(`recovered feature ${feature.displayName} (${feature.featureId}) from landing evidence\n`)
      return
    }
    case "new-work": {
      const feature = await featureNewWork({ cwd, branch: spec.branch, worktree: spec.worktree, changeIds: spec.changes, base: spec.base })
      process.stdout.write(`created new feature ${feature.displayName} (${feature.featureId}) on ${feature.context?.branch}\n`)
      return
    }
  }
}

/** True when the store has never been initialized (helps CLI diagnostics). */
export async function storeIsUninitialized(cwd: string): Promise<boolean> {
  const commonDir = await lifecycleCommonDir(cwd)
  if (!commonDir) return true
  return (await readRepositoryRecord(commonDir)).status === "missing"
}
