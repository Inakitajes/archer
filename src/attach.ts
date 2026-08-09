import { join } from "node:path"
import { stdout } from "node:process"

import { LiveAttach, overallStatus, reconcileAdvisorJournal, replayHistory } from "./attach-runtime"
import { readRunMetadata } from "./metadata"
import { connectOpencode } from "./opencode"
import { isServerLive } from "./runs"
import { progressPhases } from "./runner"
import { stepRunnerFor } from "./step-runners"
import { createTuiProgress } from "./tui"
import { runsRoot } from "./workspace"

/**
 * Re-enters a run's convoy dashboard from `convoy runs`, without resuming it:
 * - a **live** run (its server is still up) is *attached* — history is replayed
 *   from metadata and the running phase's opencode events are mirrored into the
 *   dashboard in real time, read-only. Ctrl+C detaches without touching the run.
 * - a **stopped** run (completed, failed, or interrupted) is *reconstructed*
 *   from metadata + on-disk reports and shown as the browsable finish screen.
 *   `[o]` opens a phase's stored session standalone from disk.
 */
export async function openRunDashboard(runID: string): Promise<void> {
  const dir = join(runsRoot(), runID)
  const metaPath = join(dir, "metadata.json")
  const metadata = await readRunMetadata(metaPath)
  if (!metadata?.pipeline) {
    stdout.write(`run ${runID}: no replayable metadata, nothing to open\n`)
    return
  }
  // The append-only journal is authoritative and can be newer than the last
  // debounced metadata write after a crash. Merge it before reconstruction.
  await reconcileAdvisorJournal(metadata, dir)
  const targetDir = metadata.targetDir || process.cwd()
  const phases = progressPhases(metadata.pipeline)
  // Hook phases aren't part of the frozen pipeline but were recorded as they
  // ran; re-add them as rows so replayHistory has somewhere to restore them.
  const known = new Set(phases.map((phase) => phase.name))
  const extras = Object.keys(metadata.phases).filter((name) => !known.has(name))
  phases.unshift(...extras.filter((name) => name.startsWith("pre-hook")).map((name) => ({ name, description: "" })))
  phases.push(...extras.filter((name) => !name.startsWith("pre-hook")).map((name) => ({ name, description: "" })))
  // Re-checked here: the browser's liveness snapshot may be a couple of seconds
  // stale, and the run may have ended (or started) since it was listed.
  const server = (await isServerLive(metadata.server)) ? metadata.server : undefined

  // Ctrl+C detaches (onAbort). It must never abort the underlying run — this is
  // a read-only observer of someone else's process.
  let userDetached = false
  let resolveDetached!: () => void
  const detached = new Promise<void>((resolve) => {
    resolveDetached = resolve
  })
  // [f] is offered only for a stopped run: squashing the branch out from under a
  // process that is still running steps in it would rewrite history mid-run.
  const { createFinishSeam } = await import("./finish")
  const tui = await createTuiProgress(
    phases,
    () => {
      userDetached = true
      resolveDetached()
    },
    undefined,
    {
      offlineSessions: !server,
      observer: true,
      mode: server ? "live" : "historical",
      ...(server ? {} : { finish: createFinishSeam({ cwd: targetDir, runDir: dir }) }),
    },
  )
  tui.start(runID, targetDir, dir)

  if (!server) {
    replayHistory(tui, metadata)
    await Promise.race([tui.runFinished?.({ status: overallStatus(metadata), runDir: dir }) ?? Promise.resolve(), detached])
    tui.stop()
    return
  }

  tui.serverReady(server.url)
  const phasesWithoutLiveAttach = new Set(phases.filter((phase) => !stepRunnerFor(phase.runner).capabilities.liveAttach).map((phase) => phase.name))
  const attach = new LiveAttach(connectOpencode(server.url), tui, targetDir, metaPath, phasesWithoutLiveAttach)
  await attach.start()

  await Promise.race([detached, attach.serverGone])
  await attach.stop()

  if (!userDetached) {
    const latest = (await readRunMetadata(metaPath)) ?? metadata
    await reconcileAdvisorJournal(latest, dir)
    replayHistory(tui, latest)
    await Promise.race([tui.runFinished?.({ status: overallStatus(latest), runDir: dir }) ?? Promise.resolve(), detached])
  }
  tui.stop()
}
