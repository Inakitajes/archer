## MODIFIED Requirements

### Requirement: Goal policy is defined only by pipeline configuration
Convoy SHALL NOT expose `--goal`, `--goal-max-iterations`, or `--goal-plateau`, and run-launch surfaces SHALL NOT contain a goal-mode toggle or target adjustment. Every run-launch surface that shows a pipeline's shape — pipeline-selection preview, options, and plan review — SHALL disclose the goal cycle's target, stopping policy, and improve/measure fragments as immutable parts of that pipeline rather than as optional run flags. The pipeline-selection preview SHALL present that cycle as a distinct section whose policy is three separate facts (target score, improvement-round cap, plateau), whose fragments read in execution order (measure first, then improve that leads to re-measurement), and whose fragment steps and resolved models remain visible. Supplying a retired goal flag MUST fail before repository or run-workspace side effects and SHALL explain that the target and stopping policy belong in a terminal goal step.

#### Scenario: Retired goal flag is supplied
- **WHEN** an operator invokes Convoy with `--goal 92`
- **THEN** the command exits non-zero before plan confirmation or worktree creation and identifies the embedded goal-step configuration as the migration path

#### Scenario: Launcher previews a goal pipeline
- **WHEN** the launcher's pipeline-selection preview renders a pipeline with a terminal goal step
- **THEN** the preview shows a goal-cycle section distinct from the prefix steps, discloses the target score separately from the improvement-round cap and the plateau, names the cap as improvement rounds rather than as a derived measurement count, shows measure before improve with an indication that improve re-measures, and still lists each fragment's steps and resolved models, before the operator reaches options or plan review

#### Scenario: Launcher previews a pipeline without a goal step
- **WHEN** the launcher's pipeline-selection preview renders a pipeline that has no goal step
- **THEN** the preview shows only the pipeline's ordinary steps and no goal-cycle section

#### Scenario: Launcher reviews a goal pipeline
- **WHEN** the launcher reaches options or plan review for a pipeline with a goal step
- **THEN** it presents the configured target, cap, plateau, improvement fragment, and measurement fragment as immutable parts of that pipeline rather than as optional run flags
