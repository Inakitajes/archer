## Context

The goal cycle runs inside one logical run: the prefix executes through `executePhaseGroups(pipeline.steps)`, then `runGoalCycle` re-executes the resolved fragments per invocation through the same machinery, with `qualifyInvocation` (`src/goal-scheduler.ts`) renaming each step to `goal-<stage>-<n>-<name>` while preserving `stepName`/`groupId`. Production dashboards are always attach clients (`src/attach.ts` `openRunDashboard`): they build the phase list from `progressPhases(metadata.pipeline)` (prefix + hooks only) and append every other recorded phase as a bare `{ name, description: "" }` row. The TUI (`src/tui.ts`) builds its tree from `groupId` runs (`groupPhases`) split by `stepLabel` (`chunkByStepName`); unknown phases get no-op'd by `setPhase`/`phaseSession`/`phaseRestored`, so nothing can appear after attach unless it is in the initial list.

Durable state available at reconstruction time: `metadata.pipeline.goalPlan.measure/improve.steps` (resolved, routed, frozen), `metadata.phases` (recorded qualified phase names with snapshots), and `metadata.goal` (target, current `stage`/`iteration`, scores, outcome).

## Goals / Non-Goals

**Goals:**

- Goal phases appear in the pipeline panel with the same fidelity as prefix phases: nested fan-outs, model labels, read-only/advisor badges, correct per-phase meta.
- Each invocation is a visually distinct, labelled group (`measure #0`, `improve #1`).
- Phases of the in-flight invocation exist on the dashboard before they start, so live events land.
- Reconstruction stays a pure display-layer concern derived from durable state.

**Non-Goals:**

- No change to `qualifyInvocation`, `planBatches`, resume, report paths, or metadata schema.
- No new tree nesting depth in the TUI renderer — the existing parallel→step→model three-level shape is reused.
- No changes to the header's goal readout (target/iter/trajectory), which already works.
- No dynamic mid-session upsert API for unknown phases; the in-flight seed covers the live case.

## Decisions

### 1. Reconstruct from `goalPlan` + the qualification rule, not from phase names

A helper (new `src/goal-phases.ts`, imported by `attach.ts`) enumerates the invocation sequence deterministically — measure 0; then improve n, measure n for n = 1..maxIterations — re-derives each invocation's steps with `qualifyInvocation(stage, n, plan[stage].steps)`, and maps them to `ProgressPhase` rows the same way `progressPhases` does (`plannedModel` via `stepRunnerFor(...).modelLabel(step.model)`, `plannedVariant`, `plannedAdvisor`, `readOnly`). Only invocations with at least one recorded phase in `metadata.phases` are emitted — except the in-flight one (decision 3).

Alternative considered: persisting the expanded phase list into metadata at run start. Rejected — it duplicates what the frozen plan already encodes, costs a schema-shaped migration, and the qualification rule is already a documented invariant (`goal-subflows` spec: "stable iteration-qualified identities").

### 2. Per-invocation display `groupId` = the qualified invocation id

Reconstructed rows carry `groupId: "goal-measure-0"` (i.e. the shared `goal-<stage>-<n>` prefix) instead of the fragment's positional `measure-g1`. This makes every invocation one `groupPhases` run: `chunkByStepName` then splits it into the fan-out (header `score ×2` + model rows) and singleton steps (`score-report`). Two invocations can never merge because their group ids differ, even if a resume makes two measure invocations adjacent. Selection plumbing needs no changes — `GroupSelection` just carries the qualified id, and `pipelineSelectionTargets`/`autoFollowGroup` keep working off the same shapes.

Alternative considered: also qualifying `groupId` inside `qualifyInvocation` so execution state matches display state. Rejected for now — it touches batching/resume code paths and their tests for zero observable gain; the synthesis is invertible (a qualified name always yields its invocation id), so execution-side alignment can come later if a need appears.

### 3. Seed only the in-flight invocation, gated on a live run

`openRunDashboard` emits reconstructed groups for invocations with recorded phases, plus the invocation matching `metadata.goal.stage`/`iteration` when the run is live (`server` or `control` live) and the goal record has no outcome. Settled/historical runs emit only recorded invocations, so no phantom pending rows. This also fixes the undercounting progress bar (6/7 → 6/8 in the reported screenshot) without a pending-row lifecycle problem.

Alternative considered: pre-seeding all invocations up to `1 + maxIterations` and skipping the unrun ones when the outcome settles. Rejected — it needs a new skip-marking event path and temporary wrong counters live; the in-flight seed delivers the observable behavior the specs require with none of that.

### 4. Renderer: goal-aware labels, no structural changes

- Group header label: when a group's first phase has a `goal-` qualified group id, `pipelineContent` labels it `measure #0` / `improve #1` (parsed from the id) instead of the literal `"parallel"`; the existing teal parallel styling is reused.
- Goal groups of one member (e.g. `improve #1` with only `fix`) still render header + child, so the iteration label is always visible; prefix behavior (singleton → flat row) is unchanged.
- Leaf labels switch from `phase.name` to `stepLabel(phase)` in `emitRow`'s singleton branch — identical output for all existing phases (`stepName === name` outside fan-outs) and it turns `goal-measure-0-score-report` into `score-report` for goal rows.
- `phaseDisplayName` needs no change: with `stepName` restored, pane titles read `score · grok-4-6#high` again.

## Risks / Trade-offs

- [A future rename of the `goal-<stage>-<n>-<name>` rule silently breaks reconstruction] → Export one shared helper for both directions (qualify + parse) from `goal-scheduler.ts` and use it in the reconstruction; add a unit test asserting round-trip on the built-in pipelines.
- [Legacy runs whose metadata predates some shape] → Reconstruction is best-effort: unknown names simply fall back to today's bare-extras row, so old runs degrade to the current behavior instead of failing.
- [Group ids synthesized for display leak into selection state persisted across resets] → Selection targets are transient UI state rebuilt on every render; the qualified ids are also exactly what the tree renders, so there is no mapping to drift.
- [Two measure invocations adjacent after a partial improve] → Distinct qualified group ids keep them separate by construction (decision 2).
