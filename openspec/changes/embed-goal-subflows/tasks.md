## 1. Lock the new pipeline contract

- [ ] 1.1 Add parser and resolver tests for one valid terminal `goal` step, required target bounds, default cap/plateau values, and pipelines without goals; verify the focused config and pipeline tests fail for the missing implementation and encode every success case from the delta spec.
- [ ] 1.2 Add rejection tests for multiple, non-terminal, and nested goals plus empty fragments, human fragment members, missing/ambiguous `briefStep`, writable measurement, and missing/non-final quality-score deliverables; verify each assertion requires a path-specific diagnostic.
- [ ] 1.3 Add tests proving `goal-fix` is absent from CLI/plan-only, launcher choices, config-TUI built-ins, retry, and resume, and that the name is reserved for configuration migration errors; verify the focused CLI, launcher, config, and runs tests cover every entry point.
- [ ] 1.4 Add tests for retired goal flags and legacy scalar/top-level configuration that assert failure occurs before plan review, worktree creation, or run startup and includes a copyable migration skeleton; verify no test permits silent normalization.
- [ ] 1.5 Port the existing brief-hardening, target/plateau/cap/no-score, best-state restore, abort, and scorer-blindness expectations into implementation-independent goal policy/fragment tests; verify the old behavioral coverage remains represented before deleting child-run fixtures.

## 2. Add the embedded goal DSL and fragment resolver

- [ ] 2.1 Introduce `GoalStepSpec`, improve/measure fragment specs, and resolved goal/fragment types in the pipeline and runtime type model; verify TypeScript exhaustiveness tests distinguish agent, human, parallel, and goal nodes without string-name inference.
- [ ] 2.2 Extend config validation and materialization for the nested goal shape, including terminal placement, positive defaults, fragment restrictions, and `briefStep` resolution inputs; verify the focused config tests pass and serialization round-trips a materialized goal pipeline.
- [ ] 2.3 Extract a reusable fragment resolver from pipeline resolution so improve and measure retain model fan-out, grouping, advisors, read-only boundaries, deliverable contracts, and local report selectors; verify pipeline tests cover sequential, parallel, and fanned-out fragments.
- [ ] 2.4 Enforce independent report namespaces for every fragment invocation and reject outer/cross-round report references; verify tests prove measure cannot resolve prefix, improve, or previous-measurement reports while consensus receives only current scorer reports.
- [ ] 2.5 Resolve `briefRecipient` by configured step reference and `scoreProducer` by the unique final quality-score deliverable contract rather than reserved names; verify a custom arbitrarily named repair/consensus goal passes and malformed role assignments fail.
- [ ] 2.6 Convert the built-in `ship` definition, shipped config examples, and repository fixtures to the embedded goal step without changing its target, models, advisors, rubric, or bounded policy; verify built-in pipeline shape tests and config generation snapshots pass.

## 3. Make the reviewed plan authoritative

- [ ] 3.1 Route and freeze prefix, improve, and measure recursively into one `RunPlan`, preserving gateway overrides and maximum concurrency; verify run-plan tests prove the exact reviewed models/advisors are the ones stored for later iterations.
- [ ] 3.2 Update text and TUI plan review to display target, plateau, cap, brief recipient, improve template, measurement template, and maximum invocation envelope; verify review snapshots expose the full mutation/cost boundary without naming a standalone `goal-fix` pipeline.
- [ ] 3.3 Update preflight validation to traverse all embedded fragment models and advisors once before execution; verify an unavailable improve-only or later-measurement model rejects the parent plan before any phase starts.
- [ ] 3.4 Remove scalar goal policy and `goalFixPipeline` from run options, launch selection/files, and coordinator dispatch so execution branches only on `RunPlan.goal`; verify coordinator tests demonstrate one normal runner invocation and reject deliberately divergent option/plan fixtures.
- [ ] 3.5 Restrict `--only` and `--skip` resolution to ordinary prefix steps and reject names that target goal control or internal fragment phases; verify CLI/run-plan tests cover a valid skipped prefix and every forbidden partial-goal filter.

## 4. Execute the goal scheduler in one run context

- [ ] 4.1 Extract reusable phase-group execution from `run()` without changing phase attempts, commits, permissions, advisors, failure gates, read-only baselines, or usage accounting; verify existing runner, hosted-runner, and parallel-group suites remain green before adding repetition.
- [ ] 4.2 Add the embedded scheduler that runs prefix once, measurement zero, and bounded improve/measure rounds using the existing goal policy and safe snapshot/restore logic; verify focused integration tests cover goal, plateau, cap, no-score, fragment failure, lower-score restoration, and restoration refusal.
- [ ] 4.3 Generate deterministic invocation-qualified physical phase IDs with separate logical display names and dynamically register their progress/metadata entries; verify two measurements cannot collide in phase state, sessions, diffs, logs, or report paths.
- [ ] 4.4 Deliver each canonical score-derived brief only to the configured improve recipient and preserve sanitization/capping; verify execution-level attachment tests prove no scorer, consensus, sibling improve step, or later round receives forbidden score narration.
- [ ] 4.5 Write iteration-qualified improve/measure reports and atomically promote only a validated authoritative consensus to `reports/score-report.md`; verify interrupted or malformed score attempts preserve the previous authoritative report and every completed round remains browsable.
- [ ] 4.6 Consolidate shutdown, controller ownership, pre/post hooks, notifications, finish hold, and run-directory cleanup around the single parent lifecycle; verify hooks run once with final goal variables, abort performs no destructive restore, and both configured and controller-requested retention are honored.

## 5. Persist and resume complete goal state

- [ ] 5.1 Add the next metadata schema with frozen goal policy, active iteration/stage, complete `QualityScore` objects, trajectory, best score/state, outcome, and restore result while retaining schema-v3 readers; verify metadata round-trip and backward-compatibility tests pass.
- [ ] 5.2 Flush goal checkpoints after phase completion, score validation/promotion, stage transitions, best-state capture, and final settlement; verify fault-injection tests at each boundary leave an unambiguous resumable next action.
- [ ] 5.3 Resume an interrupted parent run from its pending improve or measure group without repeating completed work or losing the previous canonical brief; verify resume tests cover interruption before/after improve, during scorer fan-out, after consensus, and after outcome persistence.
- [ ] 5.4 Extend run history and summaries with current/final score, trajectory, target, stage, outcome, and restoration status; verify one multi-iteration goal run produces one history entry under the parent pipeline and no synthetic child entries.
- [ ] 5.5 Carry quality score and goal state through finish/control serialization and historical reconstruction; verify live controller, observer, coordinator-loss, and stopped-run dashboard tests render the same score and verdict from durable metadata.

## 6. Update launcher, dashboard, and config presentation

- [ ] 6.1 Remove launcher goal toggles/target adjustment and classify pipelines directly by the presence of a valid goal step; verify launcher navigation, option counts, flags summary, and review snapshots contain no goal-mode switch.
- [ ] 6.2 Render runtime goal iterations as nested/qualified groups under the parent pipeline while preserving trajectory, pending marker, delta, goal/plateau/cap/no-score verdicts, and auto-follow; verify TUI tests cover live growth, narrow layouts, completion, failure, and historical replay.
- [ ] 6.3 Replace control resets that swap run/pipeline identity with active goal-stage updates for the same run; verify controller and observer remain attached across iterations without rebinding to a new run ID or server identity.
- [ ] 6.4 Add config-TUI inspection/editing and built-in materialization for the terminal goal node and its two fragments, with invalid edits surfaced before save; verify config-TUI tests cover expand/collapse, fragment step edits, defaults, and the absence of a customizable `goal-fix` built-in.

## 7. Remove legacy execution and provide strict migration errors

- [ ] 7.1 Remove `--goal`, `--goal-max-iterations`, and `--goal-plateau` from normal parsing, help, launcher output, and option types while retaining targeted retired-flag diagnostics; verify CLI regression tests assert no supported invocation or generated command includes them.
- [ ] 7.2 Implement aggregated configuration diagnostics for scalar `goal`, `goalMaxIterations`, `goalPlateau`, and top-level/reserved `goal-fix`, including a non-mutating embedded-step skeleton; verify multiple legacy paths are reported together and operator-owned files remain byte-identical.
- [ ] 7.3 Remove the public `goal-fix` built-in, hard-coded lookup/rejection branches, separate plan rebuilding, child-run orchestration, PRD-history child entries, and obsolete lifecycle fields such as `KeptWorkspaces`, `goalContinues`, and `deferPostHooks`; verify source searches and typecheck find no remaining executable legacy path.
- [ ] 7.4 Preserve schema-v3 historical `goal-fix` runs as independently readable legacy records without offering retry/resume as unbriefed improvements; verify old metadata fixtures open safely and expose a clear legacy limitation.

## 8. Documentation and end-to-end verification

- [ ] 8.1 Rewrite README pipeline, quality scoring, goal execution, configuration, CLI, report-layout, hooks, resume, and run-history sections with the embedded syntax and breaking migration examples; verify documentation contains no instruction to run or configure `goal-fix` or any retired goal flag.
- [ ] 8.2 Run focused suites for config, pipeline, CLI, run plan, goal policy/runtime, runner, metadata, hooks, coordinator/control, attach, runs, launcher, config TUI, and dashboard; verify every command exits zero and newly added contract scenarios are exercised.
- [ ] 8.3 Run `bun run typecheck` and `bun test`; verify both exit zero with no skipped failure attributable to embedded goal execution.
- [ ] 8.4 Run `bun run test:coverage:check` and `bun run build`; verify coverage thresholds pass and the production bundle succeeds without modifying tracked source artifacts.
- [ ] 8.5 Run `openspec validate embed-goal-subflows --strict`; verify the proposal, goal-subflows delta, design, and completed task state satisfy strict OpenSpec validation before archive review.
