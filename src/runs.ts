import { connect } from "node:net"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { stdin, stdout } from "node:process"

import { readControlFile } from "./control-client"
import type { PendingSnapshot } from "./control-server"
import { readRunMetadata, type GoalRunState, type PhaseMetadataStatus, type RunMetadata } from "./metadata"
import { isValidRunID, runsRoot } from "./workspace"
import { readAdvisorSplit } from "./advisor-report"
import type { TuiRoute } from "./tui-session"

export type RunStatusKind = "completed" | "failed" | "incomplete" | "empty" | "unknown"

export type RunPhaseInfo = {
  name: string
  status: PhaseMetadataStatus
  durationMs?: number
  cost?: number
  advisorCost?: number
  model?: string
}

export type RunEntry = {
  runID: string
  dir: string
  title: string
  targetDir?: string
  status: string
  statusKind: RunStatusKind
  /** The run's opencode server is still up (its process is alive and the port answers): attach shows it live. */
  live: boolean
  /** The live server URL, present only when `live`. */
  serverUrl?: string
  /** A live coordinated run is parked on a gate nobody answered yet. */
  waiting?: "permission" | "review"
  cost?: number
  executorCost?: number
  advisorCost?: number
  createdAt?: number
  phases: RunPhaseInfo[]
  /** The durable goal-cycle record exposed to run history (schema-v4 goal runs only). */
  goal?: RunEntryGoal
}

/** The goal-cycle facts run history presents, derived from the durable metadata record. */
export type RunEntryGoal = {
  target: number
  /** The measurement round the run is in (0 for the opening measurement). */
  iteration: number
  stage: string
  /** The most recent authoritative score. */
  score?: number
  /** Numeric trajectory of every completed measurement, oldest first. */
  trajectory?: number[]
  outcome?: string
  restored?: boolean
}

export type RunsResolution =
  | { type: "exit" }
  | { type: "resume"; runID: string; targetDir?: string }
  // Re-enter a run's dashboard: attach to it live if its server is up, else
  // reconstruct the finish screen from metadata + reports.
  | { type: "open"; runID: string; targetDir?: string }
  // Retry: start a brand-new run from step 0 using the selected run's original
  // prompt and pipeline config — a fresh copy, not a resume of the old run.
  | { type: "retry"; runID: string; targetDir?: string }

export async function listRuns(root = runsRoot()): Promise<RunEntry[]> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  // Run IDs start with the wall-clock timestamp, so lexicographic order is chronological.
  const ids = names.filter(isValidRunID).sort().reverse()
  return Promise.all(ids.map((runID) => loadRunEntry(root, runID)))
}

/** Interactive run-history browser: pick a run, then resume it, read its reports, or open a subshell in its dir. */
export async function browseRuns(initialRunID?: string, route?: TuiRoute): Promise<RunsResolution> {
  const runs = await listRuns()
  if (runs.length === 0) {
    if (route) {
      const { showNoticeTui } = await import("./notice-tui")
      await showNoticeTui(route, { title: "runs", message: `No runs found in ${runsRoot()}` })
      return { type: "exit" }
    }
    stdout.write(`no runs found in ${runsRoot()}\n`)
    return { type: "exit" }
  }

  let initialIndex = 0
  if (initialRunID) {
    initialIndex = runs.findIndex((run) => run.runID === initialRunID)
    if (initialIndex === -1) throw new Error(`run ${initialRunID} doesn't exist in ${runsRoot()}`)
  }

  // Pipes and CI get the plain listing; the browser needs a real terminal.
  if (!stdin.isTTY || !stdout.isTTY) {
    printRunList(runs)
    return { type: "exit" }
  }

  // Dynamic import keeps opentui out of non-interactive invocations (same
  // reason progress.ts lazy-loads the run TUI).
  const { browseRunsTui } = await import("./runs-tui")
  return browseRunsTui(runs, initialIndex, route)
}

/** SUMMARY.md when the run finished; otherwise whatever phase reports landed before it died. */
export async function loadRunSummary(run: RunEntry): Promise<string> {
  const summary = await readIfExists(join(run.dir, "SUMMARY.md"))
  if (summary !== undefined) return summary

  let reports: string[] = []
  try {
    // Forensic copies of rejected deliverables (persistInvalidPhaseReport) end
    // in .raw.md; they must never render as phase reports in the summary.
    reports = (await readdir(join(run.dir, "reports"))).filter((name) => name.endsWith(".md") && !name.endsWith(".raw.md")).sort()
  } catch {
    // no reports dir
  }
  if (reports.length === 0) return "no summary or reports for this run"

  const sections: string[] = []
  for (const name of reports) {
    const body = await readIfExists(join(run.dir, "reports", name))
    if (body !== undefined) sections.push(`## reports/${name}\n\n${body.trim()}`)
  }
  return sections.join("\n\n")
}

async function loadRunEntry(root: string, runID: string): Promise<RunEntry> {
  const dir = join(root, runID)
  const metadata = await readRunMetadata(join(dir, "metadata.json"))
  const summary = statusSummary(metadata)
  const serverLive = await isServerLive(metadata?.server)
  const control = await readControlFile(runID, root)
  const coordinatorLive = control ? await isControlLive(control) : false
  const live = serverLive || coordinatorLive
  const split = await readAdvisorSplit(dir)
  const executorCost = totalCost(metadata, split.executorPhases) ?? (split.executor.cost > 0 ? split.executor.cost : undefined)
  const advisorCost = split.advisor.cost
  const goal = metadata?.goal
  return {
    runID,
    dir,
    title: await runTitle(dir),
    targetDir: metadata?.targetDir,
    status: summary.label,
    statusKind: summary.kind,
    live,
    serverUrl: serverLive ? metadata?.server?.url : undefined,
    // Coordinated runs stay live through the control server even when the
    // per-iteration OpenCode server is down between goal-loop iterations;
    // only then is the waiting probe worth paying for.
    waiting: live ? await probeRunWaiting(runID, root) : undefined,
    cost: executorCost === undefined && advisorCost === 0 ? undefined : (executorCost ?? 0) + advisorCost,
    executorCost,
    advisorCost,
    createdAt: metadata?.createdAt,
    phases: phaseInfos(metadata),
    ...(goal ? { goal: goalInfo(goal) } : {}),
  }
}

/** A goal run's history facts, all derived from the durable record. */
function goalInfo(goal: GoalRunState): RunEntryGoal {
  return {
    target: goal.target,
    iteration: goal.iteration,
    stage: goal.stage,
    ...(goal.scores.length > 0
      ? {
          score: goal.scores[goal.scores.length - 1]!.score,
          trajectory: goal.scores.map((entry) => entry.score),
        }
      : {}),
    ...(goal.outcome ? { outcome: goal.outcome } : {}),
    ...(goal.restored !== undefined ? { restored: goal.restored } : {}),
  }
}

/** What a live run is parked on, for the runs browser's "waiting" details line. */
export async function probeRunWaiting(runID: string, root = runsRoot()): Promise<"permission" | "review" | undefined> {
  const control = await readControlFile(runID, root)
  if (!control) return undefined
  try {
    const response = await fetch(`${control.url}/pending`, {
      headers: { authorization: `Bearer ${control.token}` },
      // A wedged-but-listening coordinator must not stall the run list.
      signal: AbortSignal.timeout(500),
    })
    if (!response.ok) return undefined
    const snapshot = (await response.json()) as PendingSnapshot
    if (snapshot.permission) return "permission"
    if (snapshot.human) return "review"
    return undefined
  } catch {
    return undefined
  }
}

/** Re-probes a live run's pending gate so an open browser can show waiting state as it changes. */
export async function refreshRunWaiting(run: RunEntry, root = runsRoot()): Promise<void> {
  if (!run.live) {
    run.waiting = undefined
    return
  }
  run.waiting = await probeRunWaiting(run.runID, root)
}

// A run is live if its recorded server process is still alive and its port
// answers. The pid check is instant and rules out crashed runs (whose stale
// server entry outlived them); the TCP probe confirms the port is really up
// and guards against the rare pid reuse. Only runs that recorded a server —
// and cleared it on clean shutdown — ever reach the probe.
export async function isServerLive(server: RunMetadata["server"]): Promise<boolean> {
  if (!server || !pidAlive(server.pid)) return false
  return tcpReachable(server.url, 250)
}

/**
 * Whether a coordinated run is live through its control server. The
 * coordinator outlives every per-iteration OpenCode server, so this (not
 * `isServerLive`) is what "the run is still going" means mid-goal-loop.
 */
export async function isControlLive(control: { url: string; pid: number }, timeoutMs = 250): Promise<boolean> {
  return pidAlive(control.pid) && (await tcpReachable(control.url, timeoutMs))
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to another user — still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function tcpReachable(url: string, timeoutMs: number): Promise<boolean> {
  let host: string
  let port: number
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80)
  } catch {
    return Promise.resolve(false)
  }
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const settle = (ok: boolean) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => settle(true))
    socket.once("timeout", () => settle(false))
    socket.once("error", () => settle(false))
  })
}

async function runTitle(dir: string) {
  const prd = await readIfExists(join(dir, "prd.md"))
  if (prd === undefined) return "(no prd)"
  const line = prd
    .split("\n")
    .map((raw) => raw.replace(/^#+\s*/, "").trim())
    .find(Boolean)
  return truncate(line ?? "(empty prd)", 60)
}

// Only phases that started get an entry, so the totals describe what the run
// recorded, not the full pipeline. Pre-metadata runs show "-".
function statusSummary(metadata: RunMetadata | undefined): { label: string; kind: RunStatusKind } {
  if (!metadata) return { label: "-", kind: "unknown" }
  const statuses = Object.values(metadata.phases).map((phase) => phase.status)
  if (statuses.length === 0) return { label: "empty", kind: "empty" }
  const done = statuses.filter((status) => status === "completed" || status === "skipped").length
  if (statuses.some((status) => status === "failed")) return { label: `failed (${done}/${statuses.length} ok)`, kind: "failed" }
  if (done === statuses.length) return { label: "completed", kind: "completed" }
  return { label: `incomplete (${done}/${statuses.length})`, kind: "incomplete" }
}

function totalCost(metadata: RunMetadata | undefined, loggedPhaseCosts: Record<string, number> | undefined) {
  if (!metadata && !loggedPhaseCosts) return undefined
  let cost = 0
  let seen = false
  for (const [name, phase] of Object.entries(metadata?.phases ?? {})) {
    if (typeof phase.cost === "number") {
      cost += phase.cost
      seen = true
    }
  }
  for (const [name, costFromLogs] of Object.entries(loggedPhaseCosts ?? {})) {
    // Metadata holds the authoritative total for phases it has recorded. Its
    // attempt logs would otherwise count that phase twice.
    if (typeof metadata?.phases[name]?.cost === "number") continue
    cost += costFromLogs
    seen = true
  }
  return seen ? cost : undefined
}

function phaseInfos(metadata: RunMetadata | undefined): RunPhaseInfo[] {
  if (!metadata) return []
  return Object.entries(metadata.phases).map(([name, phase]) => ({
    name,
    status: phase.status,
    durationMs: phase.durationMs,
    cost: phase.cost,
    advisorCost: phase.advisor?.cost,
    model: phase.model,
  }))
}

function printRunList(runs: RunEntry[]) {
  const statusText = (run: RunEntry) =>
    run.live ? (run.waiting ? `running · waiting for a ${run.waiting === "permission" ? "permission" : "review"}` : "running") : run.status
  const goalText = (run: RunEntry) => {
    if (!run.goal) return ""
    const trajectory = run.goal.trajectory ? ` · ${run.goal.trajectory.join(" → ")}` : ""
    return ` · goal ${run.goal.target}${run.goal.outcome ? ` ${run.goal.outcome}` : ` ${run.goal.stage}`}${trajectory}`
  }
  const numberWidth = String(runs.length).length
  const statusWidth = Math.max(...runs.map((run) => statusText(run).length))
  stdout.write(`\nruns in ${runsRoot()}:\n`)
  for (const [index, run] of runs.entries()) {
    const number = String(index + 1).padStart(numberWidth)
    const cost = (run.cost !== undefined ? `$${run.cost.toFixed(2)}${run.advisorCost ? ` (${run.executorCost?.toFixed(2) ?? "0.00"}+${run.advisorCost.toFixed(2)} adv)` : ""}` : "").padStart(8)
    const marker = run.live ? "●" : " "
    stdout.write(`  ${number}. ${marker} ${run.runID}  ${statusText(run).padEnd(statusWidth)}${goalText(run)}  ${cost}  ${run.title}\n`)
  }
}

async function readIfExists(path: string) {
  try {
    return await readFile(path, "utf8")
  } catch {
    return undefined
  }
}

function truncate(value: string, max: number) {
  const singleLine = value.replace(/\s+/g, " ").trim()
  if (singleLine.length <= max) return singleLine
  return `${singleLine.slice(0, Math.max(0, max - 3))}...`
}
