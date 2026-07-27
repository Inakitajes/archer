import type { OpencodeClient } from "@opencode-ai/sdk/v2"

import {
  advisorFallbackText,
  advisorSelectionFor,
  consultAdvisor,
  defaultAdvisorMaxCalls,
  type AdvisorReason,
  type AdvisorResult,
  type AdvisorUsage,
} from "./advisor"
import { log } from "./log"
import type { AdvisorCheckpoint, AdvisorGateDecision } from "./permissions"
import type { AgentStep } from "./types"

/**
 * Per-run advisor policy: which phase owns which live session, how many
 * consultations each attempt has left, and what the permission gate should do
 * with a phase's first write.
 *
 * The registry exists because the two places that trigger a consultation — the
 * permission gate and the session watcher — only know a sessionID, while the
 * advising model, the budget, and the usage tally belong to a phase attempt.
 */

export type AdvisorConsultation = { reason: AdvisorReason; result: AdvisorResult }

/**
 * `text` is always safe to hand the executor — degradation guidance when the
 * consultation failed. `ok` distinguishes the two, because a caller that would
 * spend a turn delivering the advice should not spend it on "no advice".
 */
export type AdvisorAdvice = { text: string; ok: boolean }

export type AdvisorPhaseHandle = {
  /** Consultations attempted by this phase attempt, successful or not. */
  readonly calls: number
  /** Usage of the successful ones, for the attempt log's executor/advisor split. */
  readonly usage: readonly AdvisorUsage[]
  consult(reason: AdvisorReason, question?: string): Promise<AdvisorAdvice>
  end(): void
}

export type AdvisorRuntimeOptions = {
  client: OpencodeClient
  directory: string
  signal?: AbortSignal
  /** Injected in tests; defaults to the real consultation. */
  consult?: typeof consultAdvisor
}

export type AdvisorRuntime = {
  /** Registers a phase attempt's live session. Returns undefined for steps with no advisor. */
  begin(sessionID: string, step: AgentStep): AdvisorPhaseHandle | undefined
  /** Wired into the permission gate for the first-write checkpoint. */
  checkpoint: AdvisorCheckpoint
  /** Looks up a live phase by session, for the completion checkpoint and the on-demand tool. */
  handleFor(sessionID: string): AdvisorPhaseHandle | undefined
}

export function createAdvisorRuntime(options: AdvisorRuntimeOptions): AdvisorRuntime {
  const consultFn = options.consult ?? consultAdvisor
  const phases = new Map<string, PhaseState>()

  type PhaseState = {
    step: AgentStep
    calls: number
    usage: AdvisorUsage[]
  }

  const handleOf = (sessionID: string, state: PhaseState): AdvisorPhaseHandle => ({
    get calls() {
      return state.calls
    },
    get usage() {
      return state.usage
    },
    consult: (reason, question) => consultFor(sessionID, state, reason, question),
    end: () => {
      phases.delete(sessionID)
    },
  })

  async function consultFor(sessionID: string, state: PhaseState, reason: AdvisorReason, question?: string): Promise<AdvisorAdvice> {
    const model = advisorSelectionFor(state.step)
    if (!model) {
      return degraded({ kind: "error", code: "unavailable", message: "no advisor configured for this phase" })
    }

    const budget = state.step.advisorMaxCalls ?? defaultAdvisorMaxCalls
    if (state.calls >= budget) {
      log.info(`[advisor] ${state.step.name} exhausted its budget of ${budget} consultations`)
      return degraded({ kind: "error", code: "max_uses_exceeded", message: `budget of ${budget} reached` })
    }

    // Counted before the call, not after: a failing advisor must not be retried
    // on every edit, and the budget is a cost ceiling, not a success quota.
    state.calls += 1
    const result = await consultFn({
      client: options.client,
      sessionID,
      directory: options.directory,
      model,
      reason,
      ...(question ? { question } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })

    if (result.kind === "error") return degraded(result)
    if (result.usage) state.usage.push(result.usage)
    log.info(`[advisor] ${state.step.name} consulted ${model.providerID}/${model.modelID} (${reason}), ${result.text.length} chars`)
    return { text: result.text, ok: true }
  }

  function degraded(result: Extract<AdvisorResult, { kind: "error" }>): AdvisorAdvice {
    return { text: advisorFallbackText(result), ok: false }
  }

  return {
    begin(sessionID, step) {
      if (!step.resolvedAdvisor) return undefined
      const state: PhaseState = { step, calls: 0, usage: [] }
      phases.set(sessionID, state)
      return handleOf(sessionID, state)
    },

    handleFor(sessionID) {
      const state = phases.get(sessionID)
      return state ? handleOf(sessionID, state) : undefined
    },

    async checkpoint({ sessionID }): Promise<AdvisorGateDecision> {
      const state = phases.get(sessionID)
      // Unknown session, or a phase whose agent is advised in some *other* step:
      // allowing rather than deferring is what keeps `edit: "ask"` from
      // surfacing a human prompt that never existed before.
      if (!state) return { action: "defer" }
      if (!state.step.resolvedAdvisor) return { action: "allow" }
      if (state.calls > 0) return { action: "allow" }

      const advice = await consultFor(sessionID, state, "first-write")
      // A failed consultation must not cost the executor a turn: nothing useful
      // would come back, so let the write through and let it proceed.
      if (!advice.ok) return { action: "allow" }
      return { action: "advise", message: firstWriteMessage(advice.text) }
    },
  }
}

/**
 * The advice reaches the executor as a denied-permission message, so it has to
 * explain the denial too — otherwise the model reads a bare rejection as "not
 * allowed to edit" and starts working around it instead of acting on the advice.
 */
export function firstWriteMessage(advice: string): string {
  return [
    "Convoy held this first edit to consult the advisor. You may proceed: repeat the edit and it will go through.",
    "",
    "Advice:",
    advice,
  ].join("\n")
}

/** Totals across a phase attempt's consultations, for the attempt log and SUMMARY. */
export function totalAdvisorUsage(usage: readonly AdvisorUsage[]): { calls: number; cost: number; inputTokens: number; outputTokens: number; model?: string } {
  let cost = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const entry of usage) {
    cost += entry.cost
    inputTokens += entry.tokens.input + entry.tokens.cacheRead + entry.tokens.cacheWrite
    outputTokens += entry.tokens.output + entry.tokens.reasoning
  }
  return { calls: usage.length, cost, inputTokens, outputTokens, ...(usage[0]?.model ? { model: usage[0].model } : {}) }
}
