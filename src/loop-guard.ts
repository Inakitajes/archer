/**
 * Circuit breaker for an OpenCode phase that is going nowhere.
 *
 * OpenCode's own `permission.doom_loop` only inspects the *current* assistant
 * message, so the loop that actually burns money — one identical tool call per
 * turn, the Kimi/GLM pattern — never trips it. `agent.steps` is a prompt, not a
 * hard stop: tools stay advertised and the model can ignore it forever.
 *
 * This guard watches the live event stream across turns and aborts the session
 * when a phase repeats itself, fails the same tool over and over, blows a step
 * ceiling, or crosses a dollar cap.
 */

export type LoopGuardConfig = {
  enabled: boolean
  /** Consecutive calls of the same tool with the same arguments. */
  identicalCalls: number
  /** Consecutive failures of the same tool, even when the arguments drift. */
  sameToolFailures: number
  /** Model round-trips in one phase attempt. Hard abort; OpenCode is asked to stop a few steps earlier. */
  maxSteps: number
  /**
   * USD spent by the executor in one phase attempt. `undefined` means no cost
   * fuse. `false` in user config resolves to `undefined`.
   */
  maxPhaseCost?: number
}

/** What a config file may set; missing keys keep the built-in defaults. */
export type LoopGuardSettings = Partial<{
  enabled: boolean
  identicalCalls: number
  sameToolFailures: number
  maxSteps: number
  /** Number to cap, `false` to disable the cost fuse even when the default is on. */
  maxPhaseCost: number | false
}>

export const defaultLoopGuard: LoopGuardConfig = {
  enabled: true,
  identicalCalls: 4,
  sameToolFailures: 6,
  maxSteps: 80,
  maxPhaseCost: 20,
}

export function resolveLoopGuard(settings?: LoopGuardSettings): LoopGuardConfig {
  return {
    enabled: settings?.enabled ?? defaultLoopGuard.enabled,
    identicalCalls: settings?.identicalCalls ?? defaultLoopGuard.identicalCalls,
    sameToolFailures: settings?.sameToolFailures ?? defaultLoopGuard.sameToolFailures,
    maxSteps: settings?.maxSteps ?? defaultLoopGuard.maxSteps,
    maxPhaseCost: resolveCostCap(settings?.maxPhaseCost),
  }
}

function resolveCostCap(value: number | false | undefined): number | undefined {
  if (value === false) return undefined
  if (typeof value === "number") return value
  return defaultLoopGuard.maxPhaseCost
}

/**
 * Soft OpenCode `agent.steps` value: inject the "stop and summarize" prompt a
 * few turns before the hard abort, so a model that obeys it can still write a
 * report. Tools stay advertised on current OpenCode — this is a request, not a
 * disable — which is why the hard abort still exists.
 */
export function softAgentSteps(maxSteps: number): number {
  return Math.max(1, maxSteps - 5)
}

export type LoopGuardReason = "identical-calls" | "same-tool-failures" | "max-steps" | "max-cost"

export type LoopGuardTrip = {
  reason: LoopGuardReason
  message: string
  count: number
  tool?: string
}

export class LoopGuardError extends Error {
  readonly trip: LoopGuardTrip

  constructor(trip: LoopGuardTrip) {
    super(trip.message)
    this.name = "LoopGuardError"
    this.trip = trip
  }
}

export type LoopGuardObservation =
  | { kind: "call"; name: string; input?: unknown }
  | { kind: "result"; name: string; failed: boolean }
  | { kind: "step" }
  | { kind: "cost"; cost: number }

export class LoopGuard {
  private identicalSignature = ""
  private identicalCount = 0
  private failedTool = ""
  private failedCount = 0
  private steps = 0

  constructor(private readonly config: LoopGuardConfig) {}

  observe(observation: LoopGuardObservation): LoopGuardTrip | undefined {
    if (!this.config.enabled) return undefined
    switch (observation.kind) {
      case "call":
        return this.observeCall(observation.name, observation.input)
      case "result":
        return this.observeResult(observation.name, observation.failed)
      case "step":
        return this.observeStep()
      case "cost":
        return this.observeCost(observation.cost)
    }
  }

  private observeCall(name: string, input: unknown): LoopGuardTrip | undefined {
    const signature = `${name}\0${canonicalInput(input)}`
    if (signature === this.identicalSignature) this.identicalCount++
    else {
      this.identicalSignature = signature
      this.identicalCount = 1
    }
    if (this.identicalCount < this.config.identicalCalls) return undefined
    return trip(
      "identical-calls",
      `${name} called ${this.identicalCount} times in a row with the same arguments${targetHint(name, input)}. The phase was aborted to stop a runaway session.`,
      this.identicalCount,
      name,
    )
  }

  private observeResult(name: string, failed: boolean): LoopGuardTrip | undefined {
    if (!failed) {
      this.failedTool = ""
      this.failedCount = 0
      return undefined
    }
    if (name === this.failedTool) this.failedCount++
    else {
      this.failedTool = name
      this.failedCount = 1
    }
    if (this.failedCount < this.config.sameToolFailures) return undefined
    return trip(
      "same-tool-failures",
      `${name} failed ${this.failedCount} times in a row. The phase was aborted to stop a runaway session.`,
      this.failedCount,
      name,
    )
  }

  private observeStep(): LoopGuardTrip | undefined {
    this.steps++
    if (this.steps < this.config.maxSteps) return undefined
    return trip(
      "max-steps",
      `phase reached ${this.steps} model steps without finishing (cap ${this.config.maxSteps}). The phase was aborted to stop a runaway session.`,
      this.steps,
    )
  }

  private observeCost(cost: number): LoopGuardTrip | undefined {
    const cap = this.config.maxPhaseCost
    if (cap === undefined || !Number.isFinite(cost) || cost < cap) return undefined
    return trip(
      "max-cost",
      `phase cost reached $${cost.toFixed(2)} (cap $${cap}). The phase was aborted to stop a runaway session.`,
      cost,
    )
  }
}

function trip(reason: LoopGuardReason, message: string, count: number, tool?: string): LoopGuardTrip {
  return { reason, message, count, ...(tool ? { tool } : {}) }
}

/** Stable fingerprint so key order and trivial whitespace don't reset the streak. */
export function canonicalInput(input: unknown): string {
  return JSON.stringify(canonicalize(input))
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim()
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

function targetHint(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of ["command", "cmd", "filePath", "path", "pattern", "query", "url"]) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) {
      const text = value.trim().replace(/\s+/g, " ")
      const clipped = text.length > 80 ? `${text.slice(0, 77)}...` : text
      return ` (${clipped})`
    }
  }
  return ""
}

/**
 * Turns an OpenCode session event into a guard observation. Unknown events are
 * ignored so the watcher can feed the stream through without knowing the shape.
 */
export function observationFromSessionEvent(type: string, properties: Record<string, unknown>): LoopGuardObservation | undefined {
  switch (type) {
    case "session.next.tool.called":
      return { kind: "call", name: toolName(properties), input: properties.input }
    case "session.next.tool.failed":
      return { kind: "result", name: toolName(properties), failed: true }
    case "session.next.tool.success":
      return { kind: "result", name: toolName(properties), failed: false }
    case "session.next.step.started":
      return { kind: "step" }
    default:
      return undefined
  }
}

function toolName(properties: Record<string, unknown>): string {
  if (typeof properties.tool === "string" && properties.tool) return properties.tool
  if (typeof properties.name === "string" && properties.name) return properties.name
  return "tool"
}
