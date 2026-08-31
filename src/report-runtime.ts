import { mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"

import { renderQualityScoreReport, type QualityDimension } from "./quality-score"
import { isScoringAgent, validateWriteReportPayload, type ValidatedWriteReportPayload } from "./report"
import { writeCommitSidecar } from "./step-commit"
import type { AgentStep, DeliverableContract } from "./types"

export type ReportPhaseHandle = {
  /** The latest successful tool report for this session, if one exists. */
  readonly candidate: string | undefined
  write(payload: unknown): Promise<{ markdown: string } | { error: string }>
  end(): void
}

export type ReportRuntime = {
  begin(
    sessionID: string,
    phase: AgentStep,
    contract: DeliverableContract,
    weights: Record<QualityDimension, number>,
  ): ReportPhaseHandle
  handleFor(sessionID: string): ReportPhaseHandle | undefined
  /** Keeps the final successful write available until the attempt resolves it. */
  candidateFor(sessionID: string): string | undefined
}

/**
 * Keeps the session-to-phase mapping in Convoy. The OpenCode custom tool never
 * receives a report path; it can only ask the owning phase to save its report.
 */
export function createReportRuntime(workspaceDir: string): ReportRuntime {
  const phases = new Map<string, PhaseState>()
  const completedCandidates = new Map<string, string>()

  type PhaseState = {
    phase: AgentStep
    contract: DeliverableContract
    weights: Record<QualityDimension, number>
    reportPath: string
    candidate?: string
    writes: Promise<unknown>
  }

  const handleOf = (sessionID: string, state: PhaseState): ReportPhaseHandle => ({
    get candidate() {
      return state.candidate
    },
    write: (payload) => {
      // Read-only phases cannot create a step commit, so commit metadata is
      // rejected for them at the same boundary that validates the report.
      const validated = validateWriteReportPayload(payload, isScoringAgent(state.phase.agentName), !state.phase.readOnly)
      if ("error" in validated) return Promise.resolve(validated)
      return enqueueWrite(state, validated)
    },
    end: () => {
      if (state.candidate !== undefined) completedCandidates.set(sessionID, state.candidate)
      phases.delete(sessionID)
    },
  })

  async function enqueueWrite(state: PhaseState, payload: ValidatedWriteReportPayload): Promise<{ markdown: string } | { error: string }> {
    let result: { markdown: string } | { error: string } = { error: "report write did not run" }
    // Serialize accepted writes in call order so a late filesystem completion
    // cannot make an earlier tool call overwrite the report from a later one.
    state.writes = state.writes.then(async () => {
      try {
        const markdown = payload.scoring
          ? renderQualityScoreReport(payload.markdown, payload.scoring, state.weights)
          : payload.markdown
        await mkdir(dirname(state.reportPath), { recursive: true, mode: 0o700 })
        const tmpPath = `${state.reportPath}.${crypto.randomUUID()}.tmp`
        await writeFile(tmpPath, markdown, { mode: 0o600 })
        await rename(tmpPath, state.reportPath)
        state.candidate = markdown
        // The report-bound sidecar records the envelope on every successful
        // write — even without commit metadata — so an older description can
        // never survive a later report revision (design D3). Its failure fails
        // the tool call, keeping "every accepted write has an envelope" true.
        await writeCommitSidecar(state.reportPath, payload.commit)
        result = { markdown }
      } catch (error) {
        result = { error: `could not save report: ${error instanceof Error ? error.message : String(error)}` }
      }
    })
    await state.writes
    return result
  }

  return {
    begin(sessionID, phase, contract, weights) {
      const reportPath = reportPathFor(workspaceDir, phase.reportPath)
      const state: PhaseState = { phase, contract, weights, reportPath, writes: Promise.resolve() }
      phases.set(sessionID, state)
      return handleOf(sessionID, state)
    },
    handleFor(sessionID) {
      const state = phases.get(sessionID)
      return state ? handleOf(sessionID, state) : undefined
    },
    candidateFor(sessionID) {
      return phases.get(sessionID)?.candidate ?? completedCandidates.get(sessionID)
    },
  }
}

function reportPathFor(workspaceDir: string, reportPath: string): string {
  const root = resolve(workspaceDir)
  const path = resolve(root, reportPath)
  const fromRoot = relative(root, path)
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`report path outside workspace: ${reportPath}`)
  return join(root, fromRoot)
}
