import { createHash } from "node:crypto"
import { appendFile, mkdir, readFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import type { AdvisorErrorCode, AdvisorReason, AdvisorUsage } from "./advisor"
import { log } from "./log"
import type { Workspace } from "./workspace"

export type AdvisorAuditPolicy = "summary" | "redacted" | "full"
export type AdvisorFeedbackOutcome = "adopted" | "partially-adopted" | "rejected"

type AdvisorEventBase = {
  id: string
  timestamp: string
  callId: string
  phase: string
  attempt: number
  trigger: AdvisorReason
  budget: { used: number; max: number }
}

export type AdvisorEvent =
  | (AdvisorEventBase & { type: "advisor.requested"; model: string; question?: string; questionHash?: string; questionChars?: number })
  | (AdvisorEventBase & { type: "advisor.completed"; model: string; latencyMs: number; usage?: AdvisorUsage; advice?: string; adviceHash?: string; adviceChars: number; transcript?: string; transcriptHash?: string; transcriptChars?: number })
  | (AdvisorEventBase & { type: "advisor.failed"; model: string; latencyMs: number; transcript?: string; transcriptHash?: string; transcriptChars?: number; error: { code: AdvisorErrorCode; message?: string; messageHash?: string; messageChars?: number } })
  | (AdvisorEventBase & { type: "advisor.delivered"; delivery: "permission" | "tool" | "follow-up" })
  | (AdvisorEventBase & { type: "advisor.budget_exhausted" })
  | (AdvisorEventBase & { type: "advisor.feedback"; outcome: AdvisorFeedbackOutcome; note?: string; noteHash?: string; noteChars?: number })

export type AdvisorPhaseAggregate = {
  attempted: number
  succeeded: number
  failed: number
  exhausted: number
  delivered: number
  byTrigger: Partial<Record<AdvisorReason, number>>
  cost: number
  tokens: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }
  feedback: Partial<Record<AdvisorFeedbackOutcome, number>>
  callIds: string[]
  lastAt?: string
}

export function emptyAdvisorAggregate(): AdvisorPhaseAggregate {
  return {
    attempted: 0,
    succeeded: 0,
    failed: 0,
    exhausted: 0,
    delivered: 0,
    byTrigger: {},
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
    feedback: {},
    callIds: [],
  }
}

export function aggregateAdvisorEvents(events: readonly AdvisorEvent[]): AdvisorPhaseAggregate {
  const aggregate = emptyAdvisorAggregate()
  const callIds = new Set<string>()
  for (const event of events) {
    aggregate.lastAt = event.timestamp
    if (event.type === "advisor.requested") {
      aggregate.attempted++
      aggregate.byTrigger[event.trigger] = (aggregate.byTrigger[event.trigger] ?? 0) + 1
      callIds.add(event.callId)
    } else if (event.type === "advisor.completed") {
      aggregate.succeeded++
      if (event.usage) {
        aggregate.cost += event.usage.cost
        for (const key of Object.keys(aggregate.tokens) as (keyof AdvisorUsage["tokens"])[]) aggregate.tokens[key] += event.usage.tokens[key]
      }
    } else if (event.type === "advisor.failed") aggregate.failed++
    else if (event.type === "advisor.budget_exhausted") aggregate.exhausted++
    else if (event.type === "advisor.delivered") aggregate.delivered++
    else if (event.type === "advisor.feedback") aggregate.feedback[event.outcome] = (aggregate.feedback[event.outcome] ?? 0) + 1
  }
  aggregate.callIds = [...callIds]
  return aggregate
}

export function auditText(value: string | undefined, policy: AdvisorAuditPolicy, field: "question" | "advice" | "note" | "transcript" | "message"): Record<string, string | number> {
  if (!value) return {}
  if (policy === "full") return { [field]: value, [`${field}Chars`]: value.length }
  if (policy === "redacted") return { [`${field}Chars`]: value.length }
  return { [`${field}Hash`]: createHash("sha256").update(value).digest("hex"), [`${field}Chars`]: value.length }
}

export type AdvisorEventJournal = {
  path: string
  append(event: AdvisorEvent): Promise<void>
}

/** Append-only, private audit journal. A failed write is logged and never blocks the executor. */
export async function createAdvisorEventJournal(workspace: Workspace): Promise<AdvisorEventJournal> {
  const path = join(workspace.dir, "events", "advisor.jsonl")
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await appendFile(path, "", { mode: 0o600 })
  let writes = Promise.resolve()
  return {
    path,
    async append(event) {
      // Update `writes` atomically in a single expression: chain the appendFile
      // onto the current writes promise, then replace writes with the caught
      // result — all before the next concurrent caller can capture the old
      // value. The previous two-statement form (`const write = ...; writes =
      // write.catch(...)`) let two racing callers both chain on the same base
      // promise and interleave their appendFile calls (HN-001).
      writes = writes
        .then(() => appendFile(path, `${JSON.stringify(event)}\n`, { mode: 0o600 }))
        .catch((error) => log.warn(`couldn't write advisor event: ${error instanceof Error ? error.message : String(error)}`))
      await writes
    },
  }
}

export async function readAdvisorEvents(runDir: string): Promise<AdvisorEvent[]> {
  let body: string
  try {
    body = await readFile(join(runDir, "events", "advisor.jsonl"), "utf8")
  } catch {
    return []
  }
  const events: AdvisorEvent[] = []
  for (const line of body.split("\n")) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as AdvisorEvent
      if (typeof event.type === "string" && event.type.startsWith("advisor.") && typeof event.phase === "string") events.push(event)
    } catch {
      // Preserve all earlier valid events when a process died during the final append.
    }
  }
  return events
}
