## 1. Shared qualification helpers

- [ ] 1.1 Export an invocation-id parser from `src/goal-scheduler.ts` (inverse of `qualifyInvocation`'s naming rule: `goal-<stage>-<n>-<name>` → `{ stage, iteration, stepName }`), and add round-trip unit tests against `qualifyInvocation` for the built-in `ship` pipeline's fragments. Verify: `bun test test/goal-scheduler` (or the project's equivalent) passes with the new cases.
- [ ] 1.2 Create `src/goal-phases.ts` with `goalProgressPhases(pipeline, recorded, opts)` that enumerates the invocation sequence (measure 0; improve n + measure n for n ≤ maxIterations), re-derives steps via `qualifyInvocation`, maps them to `ProgressPhase` rows (planned model/variant/advisor/read-only, display `groupId` = qualified invocation id), and returns groups only for invocations with recorded phases. Verify: unit tests cover fan-out nesting, singleton fragment, and unknown-name fallback.

## 2. Attach reconstruction

- [ ] 2.1 In `src/attach.ts`, replace the bare goal-phase `extras` push with `goalProgressPhases` output (pre-hook extras handling unchanged), merging recorded-but-unrecognized names through the old path as fallback. Verify: existing attach tests still pass; new test asserts a metadata fixture with `goal-measure-0-*` phases reconstructs grouped rows.
- [ ] 2.2 Seed the in-flight invocation: when the run is live and `metadata.goal` has stage/iteration and no outcome, include that invocation's phases even with no recorded phases; settled/historical runs include only recorded invocations. Verify: unit tests for both branches (live mid-cycle attach; completed run stopped at measure 0).

## 3. Pipeline tree rendering

- [ ] 3.1 In `src/tui.ts` `pipelineContent`, label groups whose `groupId` parses as a goal invocation as `measure #0` / `improve #1` (reusing the parallel header styling), always rendering header + child for goal groups even with a single member, and switch the singleton `emitRow` label from `phase.name` to `stepLabel(phase)`. Verify: `test/tui.test.ts` additions render a fixture phase list into the expected tree lines (header, `score ×2`, model rows, `score-report`, `fix`).
- [ ] 3.2 Confirm selection/click targets and `autoFollowGroup` still resolve for qualified group ids (keyboard walk + `pipelineSelectionTargets` over a goal fixture). Verify: unit test asserting the target list contains the invocation group and its step group.

## 4. End-to-end verification

- [ ] 4.1 Add an integration-style test: build metadata for a goal run with one fanned measurement plus an improvement round, run `openRunDashboard`'s phase reconstruction, and assert the rendered panel matches the structured tree (no qualified ids visible, iterations labelled, counter equals real phase total). Verify: the new test passes.
- [ ] 4.2 Run the full suite and lint. Verify: `bun test` (or project equivalent) and the project's lint/typecheck commands pass.
