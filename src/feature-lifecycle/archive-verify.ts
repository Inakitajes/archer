import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import type { RequiredEffect } from "./records"

/**
 * Deterministic archive-effect verification (capability `feature-lifecycle`,
 * design D7, task 2.4): proves that a change's delta specs are represented in
 * the canonical specs — ADDED/MODIFIED requirement blocks present with their
 * scenarios, REMOVED blocks absent, RENAMED sources gone and destinations
 * present — over full capability paths, by structural Markdown comparison
 * only. No LLM guesses, no "looks archived" heuristics: unprovable effects
 * are reported, never assumed.
 *
 * This is verification only; the OpenSpec CLI remains the artifact writer.
 */

export type DeltaOperation = "ADDED" | "MODIFIED" | "REMOVED" | "RENAMED"

export type DeltaRequirement = {
  operation: DeltaOperation
  /** The full requirement name, e.g. `Worktree location resolution order`. */
  name: string
  /** The requirement's `#### Scenario:` names, for ADDED/MODIFIED presence checks. */
  scenarios: string[]
  /** RENAMED only: the requirement's former name. */
  renamedFrom?: string
  /** The whole requirement block, normalized for comparison. */
  body: string
}

export type DeltaSpec = {
  /** The capability path relative to the change's specs/ dir, e.g. `control-board`. */
  capability: string
  operations: DeltaRequirement[]
}

/** A canonical-spec effect a delta demands (design D7 item 3). */
export type CanonicalEffect =
  | { kind: "requirement-present"; capability: string; name: string; scenarios: readonly string[] }
  | { kind: "requirement-absent"; capability: string; name: string }
  | { kind: "no-effect"; capability: string }

/**
 * Parses one delta spec body into its requirement operations. Recognizes the
 * OpenSpec delta layout: `## ADDED Requirements`, `## MODIFIED Requirements`,
 * `## REMOVED Requirements`, `## RENAMED Requirements`, each containing
 * `### Requirement: <name>` blocks with `#### Scenario:` subsections. RENAMED
 * blocks may carry `- FROM: <old>` / `- TO: <new>` lines.
 */
export function parseDeltaSpec(body: string): DeltaRequirement[] {
  const operations: DeltaRequirement[] = []
  const sectionPattern = /^##\s+(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements\s*$/gim
  const sections: Array<{ operation: DeltaOperation; start: number; headerEnd: number }> = []
  let match: RegExpExecArray | null
  while ((match = sectionPattern.exec(body)) !== null) {
    sections.push({ operation: match[1] as DeltaOperation, start: match.index, headerEnd: match.index + match[0].length })
  }
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index]!
    const nextStart = index + 1 < sections.length ? sections[index + 1]!.start : body.length
    const sectionBody = body.slice(section.headerEnd, nextStart)
    const requirementPattern = /^###\s+Requirement:\s*(.+)$/gm
    const requirements: Array<{ name: string; start: number; headerEnd: number }> = []
    let requirementMatch: RegExpExecArray | null
    while ((requirementMatch = requirementPattern.exec(sectionBody)) !== null) {
      requirements.push({ name: requirementMatch[1]!.trim(), start: requirementMatch.index, headerEnd: requirementMatch.index + requirementMatch[0].length })
    }
    // RENAMED sections may declare the FROM/TO bullets in the section
    // preamble, before the first requirement header (OpenSpec's layout).
    const preamble = sectionBody.slice(0, requirements[0]?.start ?? sectionBody.length)
    const preambleFrom = section.operation === "RENAMED" ? preamble.match(/^[-*]\s+FROM:\s*(.+)$/m)?.[1] : undefined
    for (let rIndex = 0; rIndex < requirements.length; rIndex += 1) {
      const requirement = requirements[rIndex]!
      const rNextStart = rIndex + 1 < requirements.length ? requirements[rIndex + 1]!.start : sectionBody.length
      const requirementBody = sectionBody.slice(requirement.headerEnd, rNextStart)
      const scenarios = [...requirementBody.matchAll(/^#{2,4}\s+Scenario:\s*(.+)$/gm)].map((entry) => entry[1]!.trim())
      let renamedFrom: string | undefined
      if (section.operation === "RENAMED") {
        const from = requirementBody.match(/^[-*]\s+FROM:\s*(.+)$/m)?.[1] ?? preambleFrom
        if (from) renamedFrom = normalizeRenamedName(from.trim())
      }
      operations.push({
        operation: section.operation,
        name: requirement.name,
        scenarios,
        ...(renamedFrom ? { renamedFrom } : {}),
        body: normalizeBlock(requirementBody),
      })
    }
  }
  return operations
}

/** `- FROM: \`### Requirement: Old name\`` → `Old name` (backticks and heading prefix stripped). */
function normalizeRenamedName(raw: string): string {
  return raw
    .replace(/^`+|`+$/g, "")
    .replace(/^#+\s*Requirement:\s*/i, "")
    .trim()
}

/** Normalizes a block for structural comparison: strip headings, blank runs, trailing space. */
function normalizeBlock(block: string): string {
  return block
    .split("\n")
    .filter((line) => !/^#{2,4}\s+(Requirement:|Scenario:)/i.test(line))
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Splits a canonical spec's requirements into named blocks with their raw bodies (scenario headings intact). */
export function parseCanonicalRequirements(body: string): Map<string, string> {
  const out = new Map<string, string>()
  const pattern = /^###\s+Requirement:\s*(.+)$/gm
  const requirements: Array<{ name: string; headerEnd: number; start: number }> = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(body)) !== null) {
    requirements.push({ name: match[1]!.trim(), start: match.index, headerEnd: match.index + match[0].length })
  }
  for (let index = 0; index < requirements.length; index += 1) {
    const requirement = requirements[index]!
    const nextStart = index + 1 < requirements.length ? requirements[index + 1]!.start : body.length
    // Raw slice: scenario headings must survive so presence checks can read them.
    out.set(requirement.name, body.slice(requirement.headerEnd, nextStart).trim())
  }
  return out
}

/** Reads a change's delta specs into parsed operations, walking `specs/<capability>/spec.md`. */
export async function readDeltaSpecs(changeDir: string): Promise<Map<string, DeltaSpec>> {
  const { collectDirRelativeMarkdown } = await import("../openspec")
  const specsRoot = join(changeDir, "specs")
  const files = await collectDirRelativeMarkdown(specsRoot, ".")
  const out = new Map<string, DeltaSpec>()
  for (const file of files) {
    const capability = capabilityFromDeltaPath(file)
    if (!capability) continue
    const body = await readFile(join(specsRoot, file), "utf8").catch(() => undefined)
    if (body === undefined) continue
    const existing = out.get(capability)
    const operations = parseDeltaSpec(body)
    out.set(capability, { capability, operations: existing ? [...existing.operations, ...operations] : operations })
  }
  return out
}

/** `specs/<capability>/spec.md` (possibly nested) → the capability path. */
export function capabilityFromDeltaPath(relativePath: string): string | undefined {
  const normalized = relativePath.split("\\").join("/")
  const match = normalized.match(/^(.+)\/spec\.md$/)
  if (!match) return undefined
  return match[1]!
}

/**
 * Expands parsed deltas into the canonical effects they demand, per
 * capability, in the order the deltas declare them (design D7: ADDED /
 * MODIFIED blocks and scenarios must appear; REMOVED must be absent; RENAMED
 * must have the source absent and destination present).
 */
export function effectsForDeltas(deltas: Iterable<DeltaSpec>): CanonicalEffect[] {
  const effects: CanonicalEffect[] = []
  for (const delta of deltas) {
    for (const operation of delta.operations) {
      if (operation.operation === "ADDED" || operation.operation === "MODIFIED") {
        effects.push({ kind: "requirement-present", capability: delta.capability, name: operation.name, scenarios: operation.scenarios })
      } else if (operation.operation === "REMOVED") {
        effects.push({ kind: "requirement-absent", capability: delta.capability, name: operation.name })
      } else if (operation.operation === "RENAMED") {
        if (operation.renamedFrom) effects.push({ kind: "requirement-absent", capability: delta.capability, name: operation.renamedFrom })
        effects.push({ kind: "requirement-present", capability: delta.capability, name: operation.name, scenarios: operation.scenarios })
      }
    }
  }
  return effects
}

export type EffectVerification = {
  proven: CanonicalEffect[]
  unproven: Array<{ effect: CanonicalEffect; reason: string }>
}

/**
 * Verifies effects against the canonical spec files under
 * `<targetDir>/openspec/specs/` (task 2.4): a present-effect is proven when
 * the canonical spec carries the requirement with every declared scenario
 * name; an absent-effect is proven when the requirement is gone (or the
 * whole capability file is gone). Structural only — body text differences
 * within a requirement are not proof of anything either way.
 */
export async function verifyEffects(targetDir: string, effects: readonly CanonicalEffect[]): Promise<EffectVerification> {
  const { stripYamlFrontmatter } = await import("../openspec")
  const canonicalCache = new Map<string, Map<string, string> | undefined>()
  const loadCanonical = async (capability: string): Promise<Map<string, string> | undefined> => {
    const cached = canonicalCache.get(capability)
    if (cached) return cached
    const path = join(targetDir, "openspec", "specs", capability, "spec.md")
    const body = await readFile(path, "utf8").catch(() => undefined)
    if (body === undefined) {
      canonicalCache.set(capability, undefined)
      return undefined
    }
    const parsed = parseCanonicalRequirements(stripYamlFrontmatter(body))
    canonicalCache.set(capability, parsed)
    return parsed
  }

  const proven: CanonicalEffect[] = []
  const unproven: EffectVerification["unproven"] = []
  for (const effect of effects) {
    if (effect.kind === "no-effect") {
      proven.push(effect)
      continue
    }
    const canonical = await loadCanonical(effect.capability)
    if (effect.kind === "requirement-absent") {
      if (canonical === undefined || !canonical.has(effect.name)) proven.push(effect)
      else unproven.push({ effect, reason: `canonical spec ${effect.capability} still contains requirement "${effect.name}"` })
      continue
    }
    if (canonical === undefined) {
      unproven.push({ effect, reason: `canonical spec ${effect.capability}/spec.md is missing` })
      continue
    }
    const block = canonical.get(effect.name)
    if (block === undefined) {
      unproven.push({ effect, reason: `canonical spec ${effect.capability} lacks requirement "${effect.name}"` })
      continue
    }
    const canonicalScenarios = new Set([...block.matchAll(/^#{2,4}\s+Scenario:\s*(.+)$/gm)].map((entry) => entry[1]!.trim()))
    const missing = effect.scenarios.filter((scenario) => !canonicalScenarios.has(scenario))
    if (missing.length > 0) {
      unproven.push({ effect, reason: `canonical requirement "${effect.name}" is missing scenario(s): ${missing.join(", ")}` })
      continue
    }
    proven.push(effect)
  }
  return { proven, unproven }
}

/**
 * Composes overlapping contracts' effects (design D7: when several contracts
 * touch the same requirement, verification is applied over the ordered
 * composed effect with retained per-contract evidence). Composition rule:
 * for one capability+requirement key, later contracts' operations dominate —
 * REMOVED after MODIFIED wins (absent), MODIFIED/ADDED after REMOVED wins
 * (present with scenarios). Composition happens per key; the caller keeps
 * the per-contract evidence for the receipt.
 */
export function composeContractEffects(ordered: Array<{ changeId: string; deltas: Map<string, DeltaSpec> }>): { composed: CanonicalEffect[]; perContract: Array<{ changeId: string; effects: CanonicalEffect[] }> } {
  const perContract = ordered.map(({ changeId, deltas }) => ({ changeId, effects: effectsForDeltas(deltas.values()) }))
  const composedByKey = new Map<string, CanonicalEffect>()
  for (const { effects } of perContract) {
    for (const effect of effects) {
      if (effect.kind === "no-effect") continue
      // One key per requirement identity (capability + name): a later
      // contract's operation — present or absent — replaces the earlier
      // contract's effect on the same requirement.
      const key = `${effect.capability}\0${effect.name}`
      composedByKey.set(key, effect)
    }
  }
  return { composed: [...composedByKey.values()], perContract }
}

/** Reads the canonical requirement block for inspection surfaces (remediation text). */
export async function canonicalRequirementExcerpt(targetDir: string, capability: string, name: string): Promise<string | undefined> {
  const path = join(resolve(targetDir), "openspec", "specs", capability, "spec.md")
  const body = await readFile(path, "utf8").catch(() => undefined)
  if (body === undefined) return undefined
  const requirements = parseCanonicalRequirements(body)
  const block = requirements.get(name)
  return block ? block.split("\n").slice(0, 8).join("\n") : undefined
}

/** The directory a capability's canonical spec lives in (for remediation hints). */
export function canonicalSpecDir(targetDir: string, capability: string): string {
  return dirname(join(targetDir, "openspec", "specs", capability, "spec.md"))
}

/**
 * Converts canonical effects into the persistable required-effect snapshot
 * the attempt journal records before the archive mutation (task 7.2): resume
 * validates against this snapshot, never against the archived copy.
 */
export function toRequiredEffects(effects: readonly CanonicalEffect[]): RequiredEffect[] {
  const out: RequiredEffect[] = []
  for (const effect of effects) {
    if (effect.kind === "no-effect") continue
    if (effect.kind === "requirement-present") {
      out.push({ kind: "present", capability: effect.capability, name: effect.name, scenarios: [...effect.scenarios] })
    } else {
      out.push({ kind: "absent", capability: effect.capability, name: effect.name, scenarios: [] })
    }
  }
  return out
}

/** The inverse of `toRequiredEffects`: a persisted snapshot back into verifiable canonical effects. */
export function fromRequiredEffects(required: readonly RequiredEffect[]): CanonicalEffect[] {
  return required.map((effect) =>
    effect.kind === "present"
      ? { kind: "requirement-present" as const, capability: effect.capability, name: effect.name, scenarios: effect.scenarios }
      : { kind: "requirement-absent" as const, capability: effect.capability, name: effect.name },
  )
}
