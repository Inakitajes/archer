## Why

Goal mode is split between scalar pipeline settings, optional CLI flags, and a separately selectable `goal-fix` pipeline even though that pipeline is meaningful only as an internal continuation of a scored run. This creates contradictory launcher behavior, duplicates plan state, exposes unbriefed fix runs, fragments one logical operation across run history, and makes score recovery unreliable.

## What Changes

- Add a terminal `goal` control step to pipeline definitions. The step owns its target, stopping policy, improvement subflow, and measurement subflow.
- Execute the pipeline prefix once, measure iteration zero, and then alternate improvement and fresh measurement rounds until the target, plateau, iteration cap, failure, or missing-score condition stops the loop.
- Resolve improvement and measurement as internal fragments of the reviewed parent plan rather than as separately named pipelines; preserve scorer blindness by isolating report namespaces and delivering the prior score only to the configured improvement brief recipient.
- Represent the complete loop as one logical run with the parent pipeline identity, one hook lifecycle, persisted scores and trajectory, resumable stage state, grouped reports, and reconstructable live and historical presentation.
- Remove `goal-fix` from the public pipeline registry, launcher, config editor, retry, resume, and plan-only surfaces.
- **BREAKING** Remove `--goal`, `--goal-max-iterations`, and `--goal-plateau`. A pipeline enters goal mode exclusively by declaring a `goal` step; CLI flags no longer create or alter goal behavior.
- **BREAKING** Reject legacy scalar `goal`, `goalMaxIterations`, `goalPlateau`, and top-level `pipelines.goal-fix` configuration with a targeted migration error that shows the equivalent embedded `goal` structure. Do not silently normalize or execute legacy behavior.

## Capabilities

### New Capabilities

- `goal-subflows`: Defines embedded goal control steps, their validation and execution semantics, scorer-isolation guarantees, logical-run lifecycle, persistence, presentation, and legacy migration errors.

### Modified Capabilities

- None.

## Impact

- Pipeline schema, validation, materialization, config TUI, built-in `ship` configuration, and project-defined scored pipelines.
- Plan resolution, model routing and preflight, CLI parsing and help, coordinator dispatch, goal-loop orchestration, hooks, workspace cleanup, resume/retry, run metadata, report layout, summaries, run history, attach protocol, and dashboard rendering.
- Existing users of goal flags or legacy goal configuration must migrate before running; dependencies and quality-scoring models remain unchanged.
- Historical-report selection remains outside this change, although durable goal metadata will make a later “continue toward goal” action possible.
