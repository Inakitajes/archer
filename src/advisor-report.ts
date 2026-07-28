import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { aggregateAdvisorEvents, readAdvisorEvents, type AdvisorEvent, type AdvisorPhaseAggregate } from "./advisor-events"

/**
 * The executor/advisor token split, read back from a run's attempt logs.
 *
 * This is the number the pattern lives or dies by. Its economic claim is that
 * the expensive model emits a few hundred tokens of guidance while all the
 * volume is billed at the cheap executor's rate — so if the advisor's share of
 * output is not small, the pattern is wired backwards and any quality result
 * measured on top of it is measuring something else. Reporting only the total
 * cost would hide exactly that.
 */

export type AdvisorSplit = {
  executor: { cost: number; outputTokens: number }
  /** Executor spend grouped by phase when attempt logs are available. */
  executorPhases?: Record<string, number>
  advisor: { cost: number; outputTokens: number; inputTokens: number; calls: number }
  phases?: Record<string, AdvisorPhaseAggregate>
  /** Advisor share of output tokens, 0-1. Undefined when nothing was emitted. */
  advisorOutputShare?: number
}

/**
 * Below this much executor output the share is not informative: a one-step
 * change that emits a hundred tokens makes any advisor look dominant, and
 * warning about it would be crying wolf on exactly the runs where the pattern
 * was never under test.
 */
const meaningfulExecutorOutput = 2_000

type AttemptLog = {
  cost?: unknown
  tokens?: unknown
  advisor?: { calls?: unknown; cost?: unknown; outputTokens?: unknown; inputTokens?: unknown }
  advisorEvents?: unknown
}

export async function readAdvisorSplit(runDir: string): Promise<AdvisorSplit> {
  const split: AdvisorSplit = { executor: { cost: 0, outputTokens: 0 }, advisor: { cost: 0, outputTokens: 0, inputTokens: 0, calls: 0 } }
  const events = await readAdvisorEvents(runDir)
  const executorPhases: Record<string, number> = {}

  let names: string[]
  try {
    names = await readdir(join(runDir, "logs"))
  } catch {
    // A missing/unreadable logs dir must not silence the journal: it is the
    // authoritative record and may hold the run's only advisor accounting.
    names = []
  }

  const seenEventIds = new Set(events.map((event) => event.id))
  const attemptsWithEvents = new Set(events.map((event) => `${event.phase}\0${event.attempt}`))
  const legacyLogs: { phase: string; attempt: number; advisor: NonNullable<AttemptLog["advisor"]> }[] = []

  for (const name of names) {
    // Attempt logs only: the claude-code runner also writes <step>.<n>.claude.jsonl.
    if (!name.endsWith(".json") || name.endsWith(".claude.json")) continue
    let log: AttemptLog
    try {
      log = JSON.parse(await readFile(join(runDir, "logs", name), "utf8")) as AttemptLog
    } catch {
      continue
    }
    split.executor.cost += finite(log.cost)
    split.executor.outputTokens += outputTokensOf(log.tokens)
    const stem = name.slice(0, -".json".length)
    const separator = stem.lastIndexOf(".")
    const phase = separator > 0 ? stem.slice(0, separator) : stem
    const attempt = separator > 0 ? Number(stem.slice(separator + 1)) : 0
    executorPhases[phase] = (executorPhases[phase] ?? 0) + finite(log.cost)

    // Attempt logs carry the same lifecycle events as a fallback for failed
    // journal appends. Merge them (id-deduplicated, scoped to this log's own
    // phase attempt) before deciding what the legacy `advisor` block must
    // still account for — otherwise a partial journal could erase cost.
    if (Array.isArray(log.advisorEvents)) {
      for (const candidate of log.advisorEvents as AdvisorEvent[]) {
        if (!candidate || typeof candidate !== "object") continue
        if (typeof candidate.id !== "string" || typeof candidate.type !== "string" || !candidate.type.startsWith("advisor.")) continue
        if (candidate.phase !== phase || candidate.attempt !== attempt || seenEventIds.has(candidate.id)) continue
        seenEventIds.add(candidate.id)
        attemptsWithEvents.add(`${phase}\0${attempt}`)
        events.push(candidate)
      }
    }
    if (log.advisor) legacyLogs.push({ phase, attempt, advisor: log.advisor })
  }

  for (const { phase, attempt, advisor } of legacyLogs) {
    if (attemptsWithEvents.has(`${phase}\0${attempt}`)) continue
    split.advisor.calls += finite(advisor.calls)
    split.advisor.cost += finite(advisor.cost)
    split.advisor.outputTokens += finite(advisor.outputTokens)
    split.advisor.inputTokens += finite(advisor.inputTokens)
  }

  if (Object.keys(executorPhases).length > 0) split.executorPhases = executorPhases

  if (events.length > 0) {
    const phases: Record<string, AdvisorPhaseAggregate> = {}
    for (const phase of new Set(events.map((event) => event.phase))) phases[phase] = aggregateAdvisorEvents(events.filter((event) => event.phase === phase))
    split.phases = phases
    for (const phase of Object.values(phases)) {
      split.advisor.calls += phase.attempted
      split.advisor.cost += phase.cost
      split.advisor.inputTokens += phase.tokens.input + phase.tokens.cacheRead + phase.tokens.cacheWrite
      split.advisor.outputTokens += phase.tokens.output + phase.tokens.reasoning
    }
  }

  const output = split.executor.outputTokens + split.advisor.outputTokens
  if (output > 0) split.advisorOutputShare = split.advisor.outputTokens / output
  return split
}

/** Renders the split for SUMMARY.md, or nothing when the run used no advisor. */
export function renderAdvisorSplit(split: AdvisorSplit): string | undefined {
  if (split.advisor.calls === 0) return undefined

  const share = split.advisorOutputShare === undefined ? "n/a" : `${(split.advisorOutputShare * 100).toFixed(1)}%`
  const lines = [
    "## Advisor",
    "",
    `- Consultations: ${split.advisor.calls}`,
    `- Executor: ${formatCost(split.executor.cost)} · ${tokens(split.executor.outputTokens)} output tokens`,
    `- Advisor: ${formatCost(split.advisor.cost)} · ${tokens(split.advisor.outputTokens)} output tokens · ${tokens(split.advisor.inputTokens)} input tokens`,
    `- Advisor share of output: ${share}`,
    "",
  ]

  if (split.phases && Object.keys(split.phases).length > 0) {
    lines.push(
      "### Activity by phase",
      "",
      "| Phase | Attempted | Succeeded | Failed | Exhausted | Triggers | Cost | Tokens in/out |",
      "|---|---:|---:|---:|---:|---|---:|---:|",
    )
    for (const [phase, activity] of Object.entries(split.phases)) {
      const triggers = Object.entries(activity.byTrigger).map(([trigger, count]) => `${trigger}:${count}`).join(", ") || "—"
      const input = activity.tokens.input + activity.tokens.cacheRead + activity.tokens.cacheWrite
      const output = activity.tokens.output + activity.tokens.reasoning
      lines.push(`| ${escapeCell(phase)} | ${activity.attempted} | ${activity.succeeded} | ${activity.failed} | ${activity.exhausted} | ${triggers} | ${formatCost(activity.cost)} | ${tokens(input)} / ${tokens(output)} |`)
    }
    lines.push("")
  }

  if (split.executor.outputTokens < meaningfulExecutorOutput) {
    // Measured on a real run: a trivial one-step change emitted 95 executor
    // tokens against 206 advisor tokens, which reads as 68% and means nothing.
    lines.push(
      `This run is too small to judge the split — the executor emitted under ${tokens(meaningfulExecutorOutput)} output`,
      "tokens, so the ratio says more about the task's size than about the pattern.",
      "",
    )
  } else if ((split.advisorOutputShare ?? 0) > 0.25) {
    lines.push(
      "The advisor's share of output is high. The advising model should emit guidance,",
      "not the deliverable — check the output cap and whether steps are over-consulting.",
      "",
    )
  }

  // Advisor cost is driven by input, not output: each consultation re-sends the
  // executor's transcript. A cheap executor against an expensive advisor can
  // therefore cost more on the advisor side while the split still looks right.
  if (split.advisor.cost > split.executor.cost) {
    lines.push(
      "Advisor spend exceeded executor spend. That is usually the transcript, not the",
      "advice: every consultation re-sends it, so consultation *frequency* is the lever.",
      "",
    )
  }

  return lines.join("\n")
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|")
}

function tokens(value: number): string {
  return value.toLocaleString("en-US")
}

function formatCost(value: number): string {
  return `$${value.toFixed(4)}`
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function outputTokensOf(tokens: unknown): number {
  if (!tokens || typeof tokens !== "object") return 0
  const record = tokens as { output?: unknown; reasoning?: unknown }
  return finite(record.output) + finite(record.reasoning)
}
