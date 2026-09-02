## 1. Lock the preview contract

- [x] 1.1 Rewrite `goalLines` unit tests to expect a distinct `goal` section, target `N/100` separate from `↺ ≤maxIterations rounds` and `plateau P`, measure-before-improve headers with score/brief roles, an improve re-measure affordance, and intact fragment step trees; verify the focused `test/launch-tui.test.ts` assertions fail against the current renderer.
- [x] 1.2 Update the pipeline-detail integration test to the same contract and keep the no-goal-pipeline case asserting the absence of a goal-cycle section; verify both detail tests fail or pass for the right reason before changing production code.

## 2. Restyle `goalLines`

- [x] 2.1 Implement Option A in `goalLines`: faint `goal` header, text target plus dim round/plateau chips, teal measure/improve labels, measure first, improve `then re-measure` (narrow: `↺`), existing `stepTree` bodies, existing palette only; verify the `goalLines` unit test passes.
- [x] 2.2 Degrade the policy row to `goal  · N/100 · ↺N · pP` when the chips cannot share the width, and drop fragment role clauses before labels; verify a narrow-width `goalLines` test still fits inside the panel and keeps target, rounds, plateau, and both fragments.
- [x] 2.3 Run `bun test test/launch-tui.test.ts` and verify the suite exits zero, including the no-goal detail preview and the scored pipeline's fragment models.
