# Design — goal dashboard live updates

## Context

The production dashboard is always an attach client (`cli.ts` → `openRunDashboard`): the coordinator runs headless with `ControlProgress` (all phase methods are no-ops) and the terminal view is rebuilt from durable state. Four display-layer seams assume "built once at attach time" or "derivable from the phase name", and the embedded goal cycle breaks all four:

1. The TUI's phase list is fixed at construction (`findPhase` searches only it); goal invocations execute under qualified physical names (`goal-improve-1-…`), so every event for later invocations is silently dropped. Rows appear only because a re-attach re-runs `reconstructedPhases`.
2. The header's goal segments render only from `TuiProgress.goalLoop`, set exclusively via `applyReset` — but the coordinator's `ControlProgress.setGoalLoop` only stores the view (it reaches a client only piggybacked on a `reset`, which the embedded cycle publishes once at boot, and that one is deduped away by `lastResetRunID`). `LiveAttach` polls metadata every second but never reads `metadata.goal`.
3. The reports panel derives the path from the phase name (`reports/<name>.md`), while `qualifyInvocation` writes invocation reports to `reports/goal/iteration-N/<stage>/<step>.md`.
4. Transcripts are in-memory and live-event-fed only (`watchSession` subscribes to the event hub; `session.messages` is used solely for completion verification). Nothing reconstructs a session the dashboard did not watch from the start.

Constraints: the coordinator's control wire (`/pending`, resets, gates) is settled and should not grow; `resetPipeline` is destructive by design (clears feed, transcripts, reports) and is the wrong tool for per-iteration growth; observers must benefit identically to controllers; metadata.json is already the shared source of truth polled every 1s by `LiveAttach`.

## Goals / Non-Goals

**Goals:**
- A dashboard already attached to a live goal run gains each new invocation's rows as it starts, with events landing on them, additively (no history cleared, no destructive reset).
- The header's goal segments on an attached dashboard derive live from the durable goal record.
- Goal invocation rows carry their qualified report path so the reports panel resolves them.
- A dashboard following a session reconstructs its history from the live OpenCode server (running phases eagerly, completed phases when first viewed) and merges it with the live stream without duplication.

**Non-Goals:**
- Persisting transcripts to disk; historical (server-gone) runs keep placeholders and today's `[o]` stored-session reopening.
- Changing the control wire protocol, gate flow, or `resetPipeline` semantics (the hosted child-run loop keeps using resets).
- Coordinator-side push of goal views; the scheduler's `onView` → `ControlProgress.setGoalLoop` path stays as-is.
- Growing the phase list of an *in-process* runner TUI (production dashboards are attach clients; tests inject their own progress).
- Changing scheduling, qualification, report writing, checkpoints, or phase naming.

## Decisions

### D1 — Client-side phase sync in `LiveAttach`, surfaced through a new additive `ProgressUI.syncPhases`
Every `LiveAttach.tick()` already reads metadata; extend it to compute the expected dashboard row list exactly the way `reconstructedPhases` does at open time — `progressPhases(pipeline)` prefix + `goalProgressPhases(pipeline, recorded, { live: true, goal })` — and push it through a new `ProgressUI.syncPhases(rows)`. The TUI merges by phase name: rows already present are left untouched (their state continues to be driven by phase events); missing rows are appended in the given order; nothing is cleared. Because invocations only ever start later in the sequence, appends preserve invocation order and never split a group.

Why not the alternatives:
- *Coordinator publishes a `reset` per iteration*: resets are destructive (wipe feed/transcripts/reports) and the sticky one-shot dedupe in `/pending` was designed around hosted child-run iteration boundaries. Wrong tool, and it would leave observers and controllers with different rebuild timing.
- *TUI auto-creates a row on unknown `phaseStarted`*: duplicates the reconstruction logic (grouping, labels, fan-out members) in the TUI and loses the deterministic ordering `goalProgressPhases` owns.

`syncPhases` is idempotent and one-way (client state never feeds back), so there is no loop. The first tick runs immediately at `start()`, which also covers open-time seeding — no separate seed in `attach.ts` is needed.

### D2 — Header goal view derived from `metadata.goal` in the same tick
`LiveAttach.tick()` derives a live `GoalLoopView` from the durable record and calls `tui.setGoalLoop(view)` when it changed (cheap structural compare). Mapping (must reproduce the scheduler's `viewFor` semantics, where `iteration` names the measurement about to run, 1-based):
- incomplete record (`outcome` absent): `iteration = record.iteration + 1` (floor 1), `scores`, `target`, `plateau`, `maxRuns = 1 + maxIterations` — this matches `scores.length + 1` at every stage boundary the scheduler checkpoints;
- settled record: today's `goalLoopViewFrom` (iteration = `max(1, scores.length)`, outcome attached).

Why not publish `GoalLoopView` over the control channel (`/status` or a new event): metadata is already polled every second by both controllers and observers, is authoritative, and needs no wire changes or role-dependent paths. The reset-carried `goalLoop` (`applyReset`) stays for hosted child runs; when both fire, the metadata-derived view is at least as fresh (checkpoints precede `onView` publishes in the scheduler).

### D3 — Report path travels on the phase row
Add optional `reportPath?: string` to `ProgressPhase`. `progressPhases` maps it from the step (always present on agent steps; canonical for prefix, qualified for goal fragments), so `goalProgressPhases` — which reuses `progressPhases` on qualified steps — carries it for free, as do `reconstructedPhases` and `resetPipeline` rows. `TuiProgress.loadReport` resolves `phase.reportPath ?? reports/<name>.md`; the inline panel and fullscreen reader share that resolution. Existing cache invalidation on `phaseCompleted`/`phaseRestored` already handles late-appearing files.

Why not teach the TUI the `goal-<stage>-<n>-<name>` → path rule: that duplicates a scheduler invariant in display code. The row carrying data (not logic) survives future path-scheme changes.

### D4 — Transcript backfill in the session-following seam (`watchSession` option)
Extend `watchSession` with a backfill mode used by the attach path (the runner's own watchers don't need it — they hold the session from birth). Mechanics: subscribe to the hub first but buffer live transcript chunks; fetch `session.messages` for the session; emit history as transcript blocks in order (same channel mapping the live chunk extractor uses); drop buffered/live chunks whose message identity was already emitted from history; then release the buffer. The session tab's existing 24k `capTranscript` bounds memory, so long histories trim from the top naturally.

- *Running phases*: backfill rides the existing watch start (eager) — the watcher must be live anyway.
- *Completed/failed phases*: backfill lazily on first session-tab view of that phase, mirroring `loadReport`'s lazy pattern, one fetch per phase per dashboard session, only while the run's server is reachable. This satisfies "readable when viewed" without an N-phases burst of fetches at attach.
- Only OpenCode sessions backfill (server-held history); runners without live attach keep today's behavior.

Why not persist transcripts: metadata churn and privacy for data the server already holds while it lives; historical runs are explicitly out of scope.

## Risks / Trade-offs

- [Derivation drift between scheduler `onView` and metadata-derived header view] → tests pin both paths against the same stage-boundary fixtures; the mapping rule is documented in D2.
- [A sub-second transcript gap between history snapshot and buffer release] → subscribe-first buffering closes the overlap window; any residual race degrades to a missing line, never a duplicate (dedupe is by message identity, history wins).
- [Backfill burst on phases completed while attached but never viewed] → lazy-on-first-view bounds fetches to what the operator actually opens.
- [`syncPhases` misuse as a general mutation channel] → keep it append-and-align only (no status changes, no removals); `resetPipeline` remains the only destructive rebuild.
- [Observers and controllers now paint identical trees] → intended; role stays relevant for gates and controls only.

## Migration Plan

Purely additive display-layer change; no persisted-format or wire changes. Ship normally; revert to roll back. No data migration.

## Open Questions

None material. Exact buffering internals of D4 (buffer-vs-dedupe ordering) may be tuned during implementation as long as the no-duplicates requirement holds.
