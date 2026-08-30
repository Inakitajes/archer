import { stripControlBytes } from "./commit-message"
import type { CloseEvent, CloseResult, CloseStep } from "./feature-close"

/** Renderer-neutral state shared by the interactive close TUI and pure tests. */
export type CloseChecklistRowStatus = "pending" | "running" | "completed" | "skipped" | "failed"

export type CloseChecklistRow = {
  step: CloseStep
  status: CloseChecklistRowStatus
  detail?: string
}

export type CloseChecklistState = {
  preflight?: string
  preflightFailed?: readonly string[]
  rows: readonly CloseChecklistRow[]
  result?: CloseResult
}

const closeSteps: readonly CloseStep[] = ["sync", "archive", "squash", "merge"]

export function initialCloseChecklistState(): CloseChecklistState {
  return { rows: closeSteps.map((step) => ({ step, status: "pending" as const })) }
}

/** The pure reducer from close events to checklist state — one source of narration. */
export function applyCloseEvent(state: CloseChecklistState, event: CloseEvent): CloseChecklistState {
  const withRow = (step: CloseStep, update: Partial<CloseChecklistRow>): CloseChecklistState => ({
    ...state,
    rows: state.rows.map((row) =>
      row.step === step
        ? { ...row, ...update, detail: update.detail ?? (update.status === "running" ? undefined : row.detail) }
        : row,
    ),
  })
  switch (event.type) {
    case "preflight":
      return { ...state, preflight: event.summary }
    case "preflight-failed":
      return { ...state, preflightFailed: event.blockers.map((blocker) => blocker.message) }
    case "step-started":
      return withRow(event.step, { status: "running" })
    case "step-completed":
      return withRow(event.step, { status: "completed", detail: strip(event.detail) })
    case "step-skipped":
      return withRow(event.step, { status: "skipped", detail: strip(event.reason) })
    case "step-failed": {
      const line = firstLine(strip(event.message))
      const prefix = `${event.step}: `
      const detail = line.startsWith(prefix) ? line.slice(prefix.length) : line
      return withRow(event.step, { status: "failed", detail })
    }
    case "merge-shape":
      // The merge row's completed detail already narrates the shape.
      return state
    case "result":
      return { ...state, result: event.result }
  }
}

/** Plain lines remain useful for headless/presentation tests; the TUI styles the same state. */
export function renderCloseChecklist(state: CloseChecklistState): string[] {
  const lines: string[] = []
  if (state.preflightFailed) {
    lines.push("close preflight failed:")
    for (const message of state.preflightFailed) lines.push(`  ${message}`)
    return lines
  }
  if (state.preflight) lines.push(`preflight: ${state.preflight}`)
  for (const row of state.rows) {
    if (row.status === "pending") {
      lines.push(`  ○ ${row.step}`)
    } else if (row.status === "running") {
      lines.push(`  ▸ ${row.step}…`)
    } else if (row.status === "completed") {
      lines.push(`  ✓ ${row.step}${row.detail ? ` — ${row.detail}` : ""}`)
    } else if (row.status === "skipped") {
      lines.push(`  ⊘ ${row.step} — skipped: ${row.detail}`)
    } else {
      lines.push(`  ✗ ${row.step}${row.detail ? ` — ${row.detail}` : ""}`)
    }
  }
  if (state.result) {
    lines.push("")
    lines.push(`closed ${state.result.changeID}: ${state.result.branch} → ${state.result.baseRef}`)
  }
  return lines
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() ?? value
}

function strip(value: string | undefined): string {
  return stripControlBytes(value ?? "")
}
