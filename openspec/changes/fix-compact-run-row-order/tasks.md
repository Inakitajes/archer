# Tasks — Fix Compact Run Row Order

## 1. Pin the invariant in tests (red first)

- [ ] 1.1 Update the two payload expectations in `test/attach-follow.test.ts` (lines ~149 and ~171) to the canonical order — `[...prefixNames, ...measure0, compactRunRowName]` and `[...prefixNames, ...measure0, ...improve1, compactRunRowName]` — and verify they fail against the current `LiveAttach.syncPhases` with `bun test test/attach-follow.test.ts`
- [ ] 1.2 Add a `syncPhases` case to `test/tui.test.ts` (existing `describe("syncPhases")`): build a dashboard whose phase list ends with the `Compact run` row, sync the live payload order (`[...prefix, compactRun, ...goalRows]`), and assert the final row order ends with `Compact run` with the goal rows above it; verify it fails before the TUI change with `bun test test/tui.test.ts`
- [ ] 1.3 Extend the new case (or `test/dashboard-compact-run-row.test.ts`, per design D5) to assert that a repeat sync is a no-op and that a `Compact run` row already carrying terminal state (e.g. completed with a produced SHA) keeps its state and terminal position; verify with `bun test test/tui.test.ts test/dashboard-compact-run-row.test.ts`

## 2. Implementation

- [ ] 2.1 In `src/attach-runtime.ts` `syncPhases`, emit rows in canonical order — pipeline prefix without the compact row, then goal invocation rows, then the compact row last (mirror `reconstructedPhases`' SC-2 closure; reuse the exported `compactRunRowName`) — and verify `bun test test/attach-follow.test.ts` passes
- [ ] 2.2 In `src/tui.ts` `syncPhases`, after appending additions, move an already-known `Compact run` row to the terminal position by partitioning `this.phases` into non-compact rows (current order) + the compact row, preserving the row objects; if `this.selected` pointed at the compact row's old index, repoint it at the new index (design D4) — and verify `bun test test/tui.test.ts` passes
- [ ] 2.3 Document the terminal-row contract on `ProgressUI.syncPhases` in `src/progress.ts` (rows arrive in display order with the lifecycle row last; the dashboard upholds the invariant regardless) and verify `bun run typecheck` passes

## 3. Full verification

- [ ] 3.1 Run the targeted suites (`bun test test/attach-follow.test.ts test/tui.test.ts test/dashboard-compact-run-row.test.ts test/attach.test.ts`) and confirm all pass, including the existing reconstruction-order pins in `test/attach.test.ts`
- [ ] 3.2 Run the full suite and typecheck (`bun test` and `bun run typecheck`) and confirm no regressions; sanity-check by hand that a goal run's dashboard shows goal invocation groups above the pending `Compact run` row
