# Tasks — goal dashboard live updates

## 1. Foundations: rows carry report paths and the TUI can grow additively

- [ ] 1.1 Add optional `reportPath?: string` to `ProgressPhase` (src/progress.ts) and map it in `progressPhases` (src/runner.ts) from each agent step's `reportPath`; verify `goal-phases.test.ts` still passes and a new assertion shows qualified goal rows carry `reports/goal/iteration-N/<stage>/<step>.md`
- [ ] 1.2 Add `syncPhases(rows)` to `ProgressUI` (src/progress.ts) with a noop default, implemented in `TuiProgress` (src/tui.ts) as append-only merge by phase name (existing rows untouched, missing rows appended in given order, no state cleared), and verify with unit tests: idempotent re-sync, invocation groups append whole, earlier rows keep status/cost/transcripts
- [ ] 1.3 Resolve report loading through the row: `loadReport` (src/tui.ts) uses `phase.reportPath ?? reports/<name>.md` for the inline panel and the fullscreen reader; verify with a test that a goal row with a qualified reportPath reads its file and a prefix row still reads `reports/<step>.md`

## 2. LiveAttach follows invocations and the goal header

- [ ] 2.1 In `LiveAttach.tick` (src/attach-runtime.ts), compute the expected row list each poll — `progressPhases(pipeline)` prefix + `goalProgressPhases(pipeline, recorded, { live: true, goal })` from the polled metadata — and call `tui.syncPhases(...)`; verify with a follow test (extend test/attach-follow.test.ts) that a dashboard attached at measurement zero gains improve-one rows when metadata records them, without re-attach
- [ ] 2.2 Derive the live `GoalLoopView` from `metadata.goal` per design D2 (`iteration = record.iteration + 1` while incomplete; settled records via `goalLoopViewFrom`) and call `tui.setGoalLoop` on change in the same tick; verify with a test that the header view after measurement zero's checkpoint shows target + trajectory, and that a mid-cycle attach shows the accumulated scores on first tick
- [ ] 2.3 Pin derivation parity: table test mapping each scheduler stage-boundary (`stage`/`iteration`/`scores` checkpoints from src/goal-scheduler.ts) to the view the scheduler publishes via `onView`; verify both paths produce identical views for measure-zero, improve-N, measure-N, and settled outcomes

## 3. Session transcript backfill

- [ ] 3.1 Add a backfill mode to `watchSession` (src/runner.ts): subscribe and buffer live transcript chunks, fetch `session.messages`, emit history blocks in order through the same chunk mapping, drop buffered chunks whose message identity was already emitted, then release the buffer; verify with a fake-client test that history + live merge without duplicates and in order
- [ ] 3.2 Enable eager backfill for running phases in `LiveAttach.watch` (src/attach-runtime.ts); verify a re-attach mid-stream test shows pre-attach messages followed by the continuing live stream
- [ ] 3.3 Add lazy one-shot backfill for completed/failed phases with a sessionID, triggered on first session-tab view while the server is reachable (mirroring `loadReport`'s laziness; skip for runners without live attach and when the server is gone); verify a test that a completed measurement step's session renders after viewing it post-attach, once per phase, and that a stopped run keeps the "no streamed messages captured" placeholder
- [ ] 3.4 Verify the transcript cap holds under backfill (long history trims from the top via the existing 24k cap) with a test feeding an oversized history

## 4. Integration and regression

- [ ] 4.1 End-to-end attach follow test: coordinator-style metadata evolving across two goal iterations; assert rows appear live, events land on them, counter reflects them, earlier rows/report paths survive, and the header trajectory updates — extend test/attach-follow.test.ts or add a focused case
- [ ] 4.2 Observer parity: run the same follow scenario through an observer dashboard (reset follower only, no controller) and assert identical row/header growth; extend test/attach-pollers.test.ts or attach-follow.test.ts
- [ ] 4.3 Regression sweep for existing behavior: `bun test test/attach.test.ts test/attach-controller.test.ts test/attach-regression.test.ts test/goal-phases.test.ts test/goal-scheduler.test.ts test/tui.test.ts test/progress.test.ts` all pass unchanged (except where extended above)
- [ ] 4.4 Manual smoke on a real short goal pipeline: attach from run start, confirm no detach needed across one improve/measure round, header shows target + score after measurement zero, scoring step's report renders, and completed step sessions are readable; record findings in the change notes
