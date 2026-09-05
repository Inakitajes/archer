# Fix goal phases in the pipeline tree

## Why

Attached dashboards render a goal cycle's phases as flat, structure-less rows: the tree shows raw invocation-qualified physical ids (`goal-measure-0-score__openrouter-x-ai-grok-4-6-high…`) truncated into unreadable labels, with no nesting for fan-outs, no iteration boundaries between measure/improve rounds, and no rows at all for phases that have not started yet (so the progress counter undercounts). The root cause is `attach.ts` reconstructing every phase not in `pipeline.steps` from its bare name, discarding the `groupId`, `stepName`, `plannedModel`, and read-only flags the resolved goal fragments already carry.

## What Changes

- Goal fragment phases are reconstructed structurally for dashboards: from the frozen `pipeline.goalPlan` fragments plus the deterministic `goal-<stage>-<n>-<name>` qualification rule, the attach layer rebuilds each invocation's phases with their real `stepName`, `plannedModel`, `plannedVariant`, advisor, and read-only metadata instead of anonymous `{ name }` rows.
- Each goal invocation becomes its own tree group via a per-invocation display `groupId` (`goal-measure-0`, `goal-improve-1`), so fan-outs nest under their step and two rounds never merge. Execution-side grouping (`qualifyInvocation`, `planBatches`) is untouched — this is display-layer synthesis only.
- The pipeline tree labels goal groups by iteration (`measure #0`, `improve #1`) instead of the literal `parallel`, always renders an invocation header even for single-step fragments, and labels leaf rows by logical step name (`score-report`) rather than the qualified physical id.
- The in-flight invocation (from the durable goal record's `stage`/`iteration`) is pre-seeded as pending rows on a live attach, so phases that start after the dashboard opens receive their events instead of being silently dropped, and the progress counter reflects the real phase total.

## Capabilities

### New Capabilities

### Modified Capabilities

- `goal-subflows`: adds a requirement alongside "Goal state and reports are durable and reconstructable" — live attach and stopped-run reconstruction SHALL rebuild the goal phases of the pipeline panel with nesting, model labels, and iteration structure derived from durable state, and SHALL include the in-flight invocation's pending phases.

## Impact

- `src/attach.ts` — replaces the bare `extras` reconstruction with structural goal-phase rebuilding (pre-hook extras handling unchanged).
- New helper (next to `progressPhases` in `src/runner.ts` or a small `src/goal-phases.ts`) — maps qualified invocation steps to `ProgressPhase` rows; reuses `qualifyInvocation` from `src/goal-scheduler.ts`.
- `src/tui.ts` — `pipelineContent` group labeling (goal invocation headers, `stepLabel` leaf labels, single-member goal groups) and the group-selection path stays compatible (qualified group ids flow through the existing `GroupSelection` shape).
- `test/tui.test.ts` / attach tests — new cases for tree rendering and reconstruction.
- No changes to execution semantics: batching, resume, reports, and metadata stay as-is.
