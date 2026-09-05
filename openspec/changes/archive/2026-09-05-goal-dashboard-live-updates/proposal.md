# Goal dashboard live updates

## Why

An attached dashboard does not follow an embedded goal cycle in real time. When the scheduler starts the next improve/measure invocation, the pipeline panel keeps showing every visible step completed (a finished-looking pipeline that is still running), the header never shows the goal target or the scores measured so far, the reports panel claims completed scoring steps "wrote no report", and re-attaching shows empty session transcripts. Today the only way to see the truth is to detach and re-enter, which also destroys any chance of reading the sessions that ran while detached.

The root cause is a display-layer gap: the dashboard's phase list, header goal view, report resolution, and session transcripts are all built once at attach time (or derived from phase names alone), while the goal scheduler executes each fragment invocation under invocation-qualified phase identities and report paths. Durable run state already carries everything needed to follow the cycle; nothing delivers it to a dashboard that is already open.

## What Changes

- A live attached dashboard grows its pipeline panel in real time: when the goal scheduler starts a new invocation, the invocation's phase rows (grouped by stage and round) appear without detaching, and phase events (start, session, usage, completion) land on them. Previously the rows only appeared after a re-attach.
- The dashboard header's goal segments (target, iteration, measured trajectory) update live on an attached dashboard, derived from the durable goal record the attach already polls, instead of appearing only on the finish screen.
- A goal invocation phase's report resolves in the reports panel through its iteration-qualified report path (`reports/goal/iteration-N/<stage>/<step>.md`) instead of a name-derived path that never exists, so scoring steps show their consensus report instead of "this step wrote no report".
- An attached dashboard reconstructs a phase's session transcript from the run's live OpenCode server when the dashboard starts following that session — including phases that already completed before the attach — instead of showing "no streamed messages captured for this step" forever.
- No execution-side behavior changes: scheduling, qualification, report writing, checkpoints, and the control channel's gates stay as they are.

## Capabilities

### New Capabilities

- `session-transcripts`: What a dashboard's session tab shows for a phase — the live stream while the step runs, and reconstruction from the run's live server for sessions the dashboard did not watch from the start.

### Modified Capabilities

- `goal-subflows`: Adds requirements for an already-attached dashboard to follow new goal invocations live (extending today's attach-time seeding), for the header's goal view to update live from durable goal state, and for report panels to resolve invocation-qualified report paths.

## Impact

- `src/attach-runtime.ts` (`LiveAttach`): derive the expected phase rows and goal header view from metadata each poll, and backfill transcripts when following sessions.
- `src/tui.ts` / `src/progress.ts` (`ProgressUI`): a narrow, additive way to introduce new phase rows into a running dashboard (no destructive reset), and report resolution through a row's report path when present.
- `src/goal-phases.ts` / `src/attach.ts` (`goalProgressPhases`, `reconstructedPhases`): emit report paths on reconstructed goal rows.
- `src/runner.ts` (`watchSession`): a session-history backfill seam usable by the attach path.
- Tests: `test/` attach-runtime, goal-phases, and TUI phase-list/report-path coverage.
