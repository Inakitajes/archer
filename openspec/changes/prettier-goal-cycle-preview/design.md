## Context

See proposal.md (Why). The pipeline-selection preview composes `goalLines(goal, width)` after the prefix `stepTree` and the Advisors summary. Today that helper emits one faint `goal cycle  · target N/100 · up to M measurements · plateau P` row, then two indented branches that reuse `stepTree`. Palette, truncation, and tree chrome already live in `tui-theme.ts` and `stepTree`; this change restyles `goalLines` only.

## Goals / Non-Goals

**Goals:**
- Make the goal cycle scannable as a loop using existing TUI tokens and the existing `stepTree` language.
- Keep `goalLines` a pure, width-aware, unit-tested helper.

**Non-Goals:**
- No shared renderer with Review, the headless plan, Config TUI, or the live dashboard header.
- No Advisors-count fix (prefix-only today; the improve fragment's advisor is out of scope).
- No new palette keys, icon sets, or box-drawing spines that nest inside `stepTree`.

## Decisions

**Decision: Option A — section + policy chips + fragment labels, not a nested tree or ASCII loop.**
- Header: faint `goal` (same weight as `steps` / `hooks`).
- Policy row: target in `theme.text` (`85/100`), then dim chips `↺ ≤N rounds` and `plateau P`. `N` is `maxIterations` (improve rounds), not `1 + maxIterations`.
- Fragments: teal `measure` / `improve` labels (same role as hook stages). Measure first. Improve carries a dim `then re-measure` (or `↺` when the row is too narrow).
- Role tags stay on the fragment header (`score ← scoreProducer`, `brief → briefRecipient`) so `stepTree` does not need a new annotation channel.
- Nested fragment bodies stay `stepTree` indented by two spaces, as today.
- Alternative rejected: Option B (○ goal inside the prefix tree) — implies a selectable/filterable step, which goal is not. Alternative rejected: Option C (ASCII loop diagram) — collides with `stepTree` chrome and fails at ~50 columns.

**Decision: Narrow width degrades chips, not trees.**
- Policy collapses to `goal  · 85/100 · ↺N · pP` on one row when the three chips cannot share the width.
- Fragment headers drop the role clause before dropping the label.
- Step trees keep using `stepTree`'s existing truncation.

**Decision: Existing tokens only.**
- `theme.faint` section chrome, `theme.text` target, `theme.dim` chips and models, `theme.teal` fragment labels. No new colors.

## Risks / Trade-offs

- **Tests lock the old policy sentence** → Mitigation: rewrite the `goalLines` and pipeline-detail assertions to the new chips/headers; keep the no-goal-section case unchanged.
- **Operators who learned "up to 4 measurements"** → Mitigation: the envelope is still bounded and visible; naming rounds matches `maxIterations` and the Review screen's "improve rounds" concept.
- **Two-space indent plus `stepTree` can still overflow a very narrow panel** → Mitigation: unchanged from today; `stepTree` already truncates to `width - indent`.

## Migration Plan

Single implementation on the feature branch; rollback is revert. No on-disk format or CLI migration.

## Open Questions

None.
