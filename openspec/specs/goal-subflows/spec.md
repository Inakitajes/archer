# goal-subflows Specification

## Purpose
Define pipeline-owned quality-goal loops whose improvement and measurement behavior is explicit, bounded, independently measurable, and represented as one durable Convoy run.

## Requirements

### Requirement: A terminal goal step exclusively enables goal execution
A pipeline SHALL enter goal execution if and only if its definition contains one terminal `goal` step. The step MUST declare a target from 1 through 100, MAY declare positive `maxIterations` and `plateau` values, and MUST contain non-empty `improve.steps` and `measure.steps` fragments. Omitted `maxIterations` and `plateau` values SHALL use the documented defaults of three improvement iterations and three score points. A pipeline MUST NOT contain more than one goal step, nest a goal step inside another control fragment, or place ordinary steps after its goal step.

#### Scenario: Selecting a pipeline with a goal step
- **WHEN** an operator launches a valid pipeline whose terminal goal step targets 90
- **THEN** Convoy runs that pipeline's goal cycle automatically with target 90, without asking whether goal mode is enabled

#### Scenario: Selecting a pipeline without a goal step
- **WHEN** an operator launches a pipeline that has no goal step
- **THEN** Convoy executes it once as an ordinary pipeline and does not synthesize any improvement or re-measurement behavior

#### Scenario: Structurally invalid goal placement
- **WHEN** a pipeline contains two goal steps, a nested goal step, or a step after a goal step
- **THEN** configuration validation fails before plan review with a path-specific explanation of the invalid structure

### Requirement: Goal policy is defined only by pipeline configuration
Convoy SHALL NOT expose `--goal`, `--goal-max-iterations`, or `--goal-plateau`, and run-launch surfaces SHALL NOT contain a goal-mode toggle or target adjustment. Every run-launch surface that shows a pipeline's shape — pipeline-selection preview, options, and plan review — SHALL disclose the goal cycle's target, stopping policy, and improve/measure fragments as immutable parts of that pipeline rather than as optional run flags. Supplying a retired goal flag MUST fail before repository or run-workspace side effects and SHALL explain that the target and stopping policy belong in a terminal goal step.

#### Scenario: Retired goal flag is supplied
- **WHEN** an operator invokes Convoy with `--goal 92`
- **THEN** the command exits non-zero before plan confirmation or worktree creation and identifies the embedded goal-step configuration as the migration path

#### Scenario: Launcher previews a goal pipeline
- **WHEN** the launcher's pipeline-selection preview renders a pipeline with a terminal goal step
- **THEN** the preview discloses the goal cycle's policy — target, bounded measurement envelope, and plateau — together with the improve and measure fragments, their steps, and their resolved models, before the operator reaches options or plan review

#### Scenario: Launcher previews a pipeline without a goal step
- **WHEN** the launcher's pipeline-selection preview renders a pipeline that has no goal step
- **THEN** the preview shows only the pipeline's ordinary steps and no goal-cycle section

#### Scenario: Launcher reviews a goal pipeline
- **WHEN** the launcher reaches options or plan review for a pipeline with a goal step
- **THEN** it presents the configured target, cap, plateau, improvement fragment, and measurement fragment as immutable parts of that pipeline rather than as optional run flags

### Requirement: Goal fragments have explicit validated roles
The `improve` fragment SHALL name exactly one `briefStep` among its resolved agent steps, and at least one improve step MUST be able to modify the repository. The `measure` fragment SHALL be read-only with respect to repository-visible changes and MUST end in exactly one step whose deliverable contract is a machine-readable quality score. Human steps and nested goal steps SHALL be rejected inside both fragments. Validation MUST use declared structure and deliverable contracts rather than reserved agent or step names.

#### Scenario: Valid custom goal fragments
- **WHEN** a custom pipeline names an arbitrary writable agent step `repair` as `briefStep` and ends measurement with an arbitrarily named quality-score deliverable
- **THEN** the pipeline resolves without requiring the names `goal-fixer`, `score-report`, or `goal-fix`

#### Scenario: Brief recipient does not exist
- **WHEN** `improve.briefStep` does not resolve to exactly one improve agent step
- **THEN** validation fails and identifies the invalid brief-step reference

#### Scenario: Measurement lacks an authoritative score
- **WHEN** measurement is empty, contains a repository-writing step, or does not end in exactly one machine-readable quality-score deliverable
- **THEN** validation fails before the run is reviewed or preflighted

### Requirement: Goal execution measures before improving and remains bounded
Convoy SHALL execute all ordinary prefix steps once, execute measurement as iteration zero, and compare its authoritative score with the target. While the score remains below target, Convoy SHALL execute one improvement fragment followed by one fresh measurement fragment, stopping when the target is met, improvement is lower than the plateau, the improvement-iteration cap is exhausted, a fragment fails, or an authoritative score is unavailable. `maxIterations` SHALL count improvement rounds after iteration-zero measurement.

#### Scenario: Initial measurement already reaches the target
- **WHEN** iteration-zero measurement scores 94 against target 90
- **THEN** Convoy completes without running the improvement fragment

#### Scenario: One improvement reaches the target
- **WHEN** iteration zero scores 81 and the first post-improvement measurement scores 91 against target 90
- **THEN** Convoy executes the prefix once, measurement twice, improvement once, and finishes with a reached-goal outcome

#### Scenario: Improvement plateaus
- **WHEN** the previous score is 81, the next score is 83, and plateau is 3
- **THEN** Convoy stops after that measurement with a plateau outcome and does not start another improvement round

#### Scenario: Iteration cap is exhausted
- **WHEN** all permitted improvement rounds produce valid scores below the target without triggering the plateau condition
- **THEN** Convoy stops after the final permitted measurement with a cap outcome

### Requirement: Each measurement is independent of previous scoring narration
The score object, gaps, and findings from a completed measurement SHALL be converted into a sanitized work brief delivered only to the configured improve `briefStep`. Measurement steps MUST NOT receive that brief, any previous measurement report, any improvement report, or reports from the outer pipeline prefix. Report selectors within `improve` and `measure` SHALL resolve only against earlier reports in the same fragment invocation, and the authoritative measurement step SHALL consume only reports from its current measurement round. A measurement that needs additional evidence MUST collect it inside its own fragment.

#### Scenario: Improvement receives directed work
- **WHEN** iteration zero produces a score with gaps and must-fix findings below the target
- **THEN** the next improve brief recipient receives the sanitized score, gaps, findings, and target while other improve steps receive only their declared same-round inputs

#### Scenario: Re-scorers stay blind
- **WHEN** measurement runs after an improvement round
- **THEN** its scorer steps receive the current PRD/spec contract and current repository diff but receive neither the prior score nor the improvement report

#### Scenario: Report selector attempts to cross round boundaries
- **WHEN** a goal fragment declares an input that would resolve to a previous measurement or improvement invocation
- **THEN** validation rejects the cross-round dependency instead of attaching the historical report

### Requirement: A goal cycle is one logical run
The prefix and every goal-fragment invocation SHALL share the parent pipeline name and one logical run identity. The cycle SHALL have one plan-review consent boundary, one preflight covering all possible fragment models and advisors, one controller, one run-history entry, and one pre/post-hook lifecycle. Internal fragments MUST NOT be selectable, retryable, resumable, or hook-addressable as standalone pipelines. Run-directory retention requested by configuration or the controller SHALL apply to the complete logical run.

#### Scenario: Goal cycle spans multiple measurements
- **WHEN** a goal pipeline performs two improvement rounds
- **THEN** the runs browser contains one run under the parent pipeline with the complete trajectory rather than separate child runs named `goal-fix`

#### Scenario: Hooks surround the whole cycle
- **WHEN** a goal pipeline completes after one improvement round
- **THEN** parent/global pre-hooks run once before the prefix and parent/global post-hooks run once after the final goal outcome with the final score and goal variables

#### Scenario: Models are reviewed once
- **WHEN** improve or measure uses a model unavailable through the selected gateway
- **THEN** preflight rejects the parent plan before any run phase starts, including when the unavailable model would only be used in a later iteration

### Requirement: Goal state and reports are durable and reconstructable
Convoy SHALL persist after every completed goal stage the configured policy, current iteration and stage, every complete authoritative quality score, numeric trajectory, best measured state, and final outcome when known. Reports from each fragment invocation MUST have stable iteration-qualified identities, while the final authoritative score SHALL remain available at the run's conventional score-report location. Live attach, stopped-run reconstruction, summaries, and run history SHALL derive the same target, trajectory, current stage, final score, and outcome from durable run state.

#### Scenario: Historical run retains its score
- **WHEN** a goal run completes at 93 and is reopened after its coordinator and model server have stopped
- **THEN** the historical dashboard and runs browser show 93, the complete trajectory, and the same final outcome shown live

#### Scenario: Resume after an improvement stage
- **WHEN** a run stops after persisting a completed improvement but before its following measurement completes
- **THEN** resume continues with the pending measurement in the same logical run without repeating the completed improvement or losing the prior score brief

#### Scenario: Reports from multiple rounds remain auditable
- **WHEN** a goal run performs more than one measurement
- **THEN** each round's scorer and consensus reports remain separately browsable and the conventional final score report resolves to the last authoritative measurement used for the outcome

### Requirement: Goal stopping preserves the best safely measured state
Convoy SHALL track the repository state associated with each authoritative score. If a no-score or lower-scoring terminal round leaves the repository behind a better measured state, Convoy SHALL restore the best measured state only when repository cleanliness and head-identity guards prove that doing so cannot discard concurrent work. The final outcome SHALL disclose the best score, whether restoration occurred, and when restoration was refused.

#### Scenario: Final unmeasured mutation is safely reversible
- **WHEN** an improvement changes the repository, its measurement produces no authoritative score, and no concurrent work is detected
- **THEN** Convoy restores the best previously measured state and records a no-score outcome with restoration disclosed

#### Scenario: Concurrent work prevents restoration
- **WHEN** restoration would discard an unexpected commit or dirty working-tree change
- **THEN** Convoy leaves the repository untouched, records that restoration was refused, and preserves the best score in the outcome

### Requirement: Legacy goal configuration fails with actionable migration
The public built-in pipeline registry and every pipeline-selection surface SHALL omit `goal-fix`, and the name `goal-fix` SHALL be reserved from project pipeline definitions. Legacy pipeline-level scalar `goal`, `goalMaxIterations`, `goalPlateau`, and top-level `pipelines.goal-fix` entries MUST NOT be executed or silently converted. Configuration loading SHALL fail with an actionable diagnostic that identifies every legacy path and presents an equivalent terminal goal-step skeleton preserving its target, stopping values, and embedded improve/measure steps where available.

#### Scenario: Legacy scalar goal is loaded
- **WHEN** configuration contains `pipelines.ship.goal: 85`
- **THEN** loading fails before launcher selection with a migration diagnostic showing target 85 inside a terminal goal step

#### Scenario: Legacy goal-fix override is loaded
- **WHEN** configuration defines a top-level `pipelines.goal-fix`
- **THEN** loading fails with a migration diagnostic that embeds its steps under the owning pipeline's goal fragments and `goal-fix` is not offered as a runnable pipeline

#### Scenario: Goal-fix is requested directly
- **WHEN** an operator requests `goal-fix` through CLI, launcher, plan-only, retry, or resume
- **THEN** Convoy reports that no public pipeline by that name exists and never starts an unbriefed improvement flow

### Requirement: Step filters cannot disable goal control invariants
`--only` and `--skip` MAY filter ordinary prefix steps according to existing pipeline rules, but MUST NOT select, omit, or partially execute the goal step or its internal improve and measure fragments. A filter that names an internal goal phase or would prevent mandatory goal measurement SHALL fail before execution with a path-specific explanation.

#### Scenario: Prefix step is skipped
- **WHEN** an operator skips an eligible ordinary step before the terminal goal step
- **THEN** Convoy applies the existing skip semantics to that prefix step and still executes the complete goal cycle

#### Scenario: Internal measurement is targeted by a filter
- **WHEN** an operator uses `--skip` or `--only` to target an internal scorer, consensus, improve step, or the terminal goal control step
- **THEN** plan validation fails rather than creating a partial or unmeasurable goal cycle
