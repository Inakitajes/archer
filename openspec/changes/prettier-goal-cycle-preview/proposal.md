## Why

The launcher's pipeline-selection preview already discloses a scored pipeline's goal cycle, but it reads as a faint caption plus two indented step trees. Target, measurement envelope, and plateau collapse into one dim sentence; improve rounds hide behind a derived "N measurements" count; and measure/improve look like stacked branches instead of `measure₀ → (improve → measure)*`. The operator is consenting to a bounded loop — the preview should look like one.

## What Changes

- Restyle the pipeline-selection goal-cycle preview (`goalLines`) so the cycle is a distinct section with scannable policy chips, fragment labels, and a loop affordance, while still showing each fragment's steps and resolved models.
- Present the stopping policy as three separate facts: the target score, the improvement-round cap (not a derived measurement count as the primary figure), and the plateau.
- Keep the preview read-only: no goal-mode toggle, no target adjustment, no new tokens or dependencies.
- Leave Review, the headless plan, the live dashboard header, Config TUI, and the Advisors count out of scope.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `goal-subflows`: the launcher pipeline-selection preview still discloses target, bounded envelope, plateau, fragments, steps, and models, but MUST present them as a scannable loop (distinct section, separate policy chips, improve rounds named as rounds, measure-then-improve-then-remeasure) rather than a single faint policy sentence.

## Impact

- `src/launch-tui.ts` — `goalLines` (and only the preview composition that calls it).
- `test/launch-tui.test.ts` — assertions on the preview's policy line and fragment headers.
- No CLI flags, run plan shape, dashboard header, Review TUI, or hook/advisor copy changes.
