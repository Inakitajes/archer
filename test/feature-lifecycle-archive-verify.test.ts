import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  capabilityFromDeltaPath,
  composeContractEffects,
  effectsForDeltas,
  parseCanonicalRequirements,
  parseDeltaSpec,
  verifyEffects,
} from "../src/feature-lifecycle/archive-verify"

/**
 * Task 2.4: deterministic archive-effect verification — ADDED/MODIFIED/
 * REMOVED/RENAMED parsing over full capability paths, canonical presence/
 * absence proof by structural Markdown comparison, and overlapping-contract
 * composed-effect ordering with retained per-contract evidence.
 */

const addedDelta = `## ADDED Requirements

### Requirement: Worktree location resolution order

Convoy SHALL resolve the directory.

#### Scenario: Repo convention wins over config

- **WHEN** documentation declares a convention
- **THEN** Convoy uses it
`

const modifiedDelta = `## MODIFIED Requirements

### Requirement: Built-in default location

Updated prose.

#### Scenario: No convention or config

- **WHEN** nothing configured
- **THEN** default used
`

const removedDelta = `## REMOVED Requirements

### Requirement: Legacy finish lookup
`

const renamedDelta = `## RENAMED Requirements

- FROM: \`### Requirement: Old name\`
- TO: \`### Requirement: New name\`

### Requirement: New name

#### Scenario: Renamed scenario

- **WHEN** renamed
- **THEN** both sides verified
`

const canonicalBody = `# spec

## Requirements

### Requirement: Worktree location resolution order

Convoy SHALL resolve the directory.

#### Scenario: Repo convention wins over config

- **WHEN** documentation declares a convention
- **THEN** Convoy uses it

### Requirement: Built-in default location

Updated prose.

#### Scenario: No convention or config

- **WHEN** nothing configured
- **THEN** default used

### Requirement: Old name

Legacy prose.
`

const renamedCanonicalBody = `# spec

## Requirements

### Requirement: New name

#### Scenario: Renamed scenario

- **WHEN** renamed
- **THEN** both sides verified
`

const dirs: string[] = []

/** Builds a real <dir>/openspec/specs/<capability>/spec.md tree for verification. */
async function specTree(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-archive-verify-"))
  dirs.push(dir)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(dir, "openspec", "specs", relative)
    await mkdir(path.replace(/\/spec\.md$/, ""), { recursive: true })
    await writeFile(path, content)
  }
  return dir
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("delta parsing (task 2.4)", () => {
  test("parses operations with names and scenarios per section", () => {
    const deltas = parseDeltaSpec(`${addedDelta}\n${removedDelta}`)
    expect(deltas.map((delta) => delta.operation)).toEqual(["ADDED", "REMOVED"])
    expect(deltas[0]!.name).toBe("Worktree location resolution order")
    expect(deltas[0]!.scenarios).toEqual(["Repo convention wins over config"])
    expect(deltas[1]!.name).toBe("Legacy finish lookup")
  })

  test("RENAMED entries carry their FROM source", () => {
    const deltas = parseDeltaSpec(renamedDelta)
    expect(deltas).toHaveLength(1)
    expect(deltas[0]!.operation).toBe("RENAMED")
    expect(deltas[0]!.renamedFrom).toBe("Old name")
  })

  test("multiple requirement blocks per section are all captured", () => {
    const body = `## ADDED Requirements\n\n### Requirement: One\n\n#### Scenario: A\n\n### Requirement: Two\n\n#### Scenario: B\n`
    const deltas = parseDeltaSpec(body)
    expect(deltas.map((delta) => delta.name)).toEqual(["One", "Two"])
  })

  test("capability path extraction", () => {
    expect(capabilityFromDeltaPath("control-board/spec.md")).toBe("control-board")
    expect(capabilityFromDeltaPath("specs/cli/spec.md")).toBe("specs/cli")
    expect(capabilityFromDeltaPath("proposal.md")).toBeUndefined()
  })
})

describe("canonical effect verification (task 2.4)", () => {
  test("ADDED/MODIFIED presence is proven when canonical carries name + scenarios", async () => {
    const target = await specTree({ "control-board/spec.md": canonicalBody })
    const effects = effectsForDeltas([
      { capability: "control-board", operations: parseDeltaSpec(addedDelta) },
      { capability: "control-board", operations: parseDeltaSpec(modifiedDelta) },
    ])
    const verification = await verifyEffects(target, effects)
    expect(verification.unproven.map((entry) => entry.reason)).toEqual([])
    expect(verification.proven).toHaveLength(2)
  })

  test("missing scenario names are unproven, not assumed", async () => {
    const target = await specTree({ "control-board/spec.md": canonicalBody })
    const effects = effectsForDeltas([
      { capability: "control-board", operations: [{ operation: "ADDED", name: "Worktree location resolution order", scenarios: ["Repo convention wins over config", "New scenario"], body: "" }] },
    ])
    const verification = await verifyEffects(target, effects)
    expect(verification.proven).toEqual([])
    expect(verification.unproven[0]!.reason).toMatch(/missing scenario/)
  })

  test("REMOVED absence is proven when the requirement is gone or the file is missing", async () => {
    const target = await specTree({ "control-board/spec.md": "# spec\n\n## Requirements\n\n### Requirement: Something else\n" })
    const verification = await verifyEffects(target, effectsForDeltas([
      { capability: "control-board", operations: parseDeltaSpec(removedDelta) },
    ]))
    expect(verification.unproven).toEqual([])

    const absentFile = await verifyEffects(target, effectsForDeltas([
      { capability: "never-written", operations: parseDeltaSpec(removedDelta) },
    ]))
    expect(absentFile.unproven).toEqual([])
  })

  test("REMOVED with the requirement still present is unproven", async () => {
    const target = await specTree({ "control-board/spec.md": canonicalBody })
    const verification = await verifyEffects(target, effectsForDeltas([
      { capability: "control-board", operations: parseDeltaSpec(removedDelta.replace("Legacy finish lookup", "Worktree location resolution order")) },
    ]))
    expect(verification.unproven[0]!.reason).toMatch(/still contains/)
  })

  test("RENAMED proves source absence plus destination presence", async () => {
    const target = await specTree({ "control-board/spec.md": renamedCanonicalBody })
    const verification = await verifyEffects(target, effectsForDeltas([{ capability: "control-board", operations: parseDeltaSpec(renamedDelta) }]))
    expect(verification.unproven).toEqual([])
  })
})

describe("overlapping-contract composition (task 2.4/D7)", () => {
  test("later contracts dominate per requirement key, with per-contract evidence retained", () => {
    const first = new Map([["cap", { capability: "cap", operations: [{ operation: "MODIFIED" as const, name: "Shared requirement", scenarios: ["S1"], body: "" }] }]])
    const second = new Map([["cap", { capability: "cap", operations: [{ operation: "REMOVED" as const, name: "Shared requirement", scenarios: [], body: "" }] }]])
    const { composed, perContract } = composeContractEffects([
      { changeId: "first", deltas: first },
      { changeId: "second", deltas: second },
    ])
    expect(composed.some((effect) => effect.kind === "requirement-absent" && effect.name === "Shared requirement")).toBe(true)
    expect(composed.some((effect) => effect.kind === "requirement-present" && effect.name === "Shared requirement")).toBe(false)
    expect(perContract).toHaveLength(2)
    expect(perContract[0]!.effects[0]!.kind).toBe("requirement-present")
    expect(perContract[1]!.effects[0]!.kind).toBe("requirement-absent")
  })

  test("canonical requirement block parsing keeps names unique", () => {
    const body = `### Requirement: A\n\nbody a\n\n### Requirement: B\n\nbody b\n`
    const parsed = parseCanonicalRequirements(body)
    expect([...parsed.keys()]).toEqual(["A", "B"])
    expect(parsed.get("A")).toMatch(/body a/)
  })
})
