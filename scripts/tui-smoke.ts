/**
 * Visual smoke test for the run dashboard: drives a real TuiProgress in this
 * terminal with fake phases and a synthetic model stream, so the animation and
 * the session transcript can be checked by eye without spending tokens.
 *
 *   bun run scripts/tui-smoke.ts
 *
 * What to look for:
 *   - the spinners on the running steps rotate smoothly, with no visible
 *     stutter or skipped frames (they step every 100ms, painted every 80ms),
 *   - the session tab shows one "✻ reasoning" label with one "·" bullet per
 *     summary, never two summaries glued into one line.
 *
 * Press q (or ctrl+c) to leave; it exits on its own after the fake run ends.
 */
import { createTuiProgress } from "../src/tui"

import type { ProgressPhase } from "../src/progress"

const phases: ProgressPhase[] = [
  { name: "scope", description: "map the diff" },
  { name: "bugs", description: "hunt regressions" },
  { name: "design", description: "polish the UI" },
]

const summaries = [
  "Planning diff scope inspection",
  "Inspecting rules and loading skills",
  "Planning source inspection for diffs",
  "Identifying architectural patterns and test fixture changes",
  "Inspecting session and DI configurations",
  "Assessing session canonical inconsistencies",
]

const progress = await createTuiProgress(phases)
progress.start("smoke-run", process.cwd(), "/tmp/convoy-smoke")
progress.serverReady("http://127.0.0.1:0")

for (const phase of phases) progress.phaseStarted(phase.name, phase.description)
progress.phaseSession("scope", "ses_smoke_scope")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// One reasoning summary per part, streamed a few characters at a time — the
// shape the real event stream produces.
for (const [index, summary] of summaries.entries()) {
  const partID = `reasoning:${index + 1}`
  for (let cursor = 0; cursor < summary.length; cursor += 7) {
    progress.phaseMessage("scope", { channel: "reasoning", text: summary.slice(cursor, cursor + 7), partID })
    await sleep(40)
  }
  progress.phaseActivity("scope", `thinking… (${summary.length} chars)`, "think", true)
  await sleep(300)
}

progress.phaseMessage("scope", { channel: "tool", text: "read: src/tui.ts" })
await sleep(600)
progress.phaseMessage("scope", { channel: "response", text: "The dashboard repaints on an 80ms animation ticker.", partID: "text:1" })
await sleep(1_500)

progress.phaseCompleted("scope", "smoke complete")
progress.phaseCompleted("bugs", "smoke complete")
progress.phaseCompleted("design", "smoke complete")
// The finish screen stays up until the reader presses q, exactly as in a run.
await progress.runFinished?.({ status: "completed", runDir: "/tmp/convoy-smoke" })
progress.stop()
