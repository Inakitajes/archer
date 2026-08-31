## Context

See proposal.md — Why for motivation. Today each home-session destination draws its own header anatomy: `launch-tui.ts` (`convoy <version>` border title, 3 rows), `specs-browser.ts` (`convoy specs <version>` title, 3 rows), `runs-browser.ts` (`convoy <version>` title, 4 rows) and `config-tui.ts` (4 rows, `◆ convoy <version> · config` branding line) all use bordered `panel()` boxes whose borders participate in the vertical budget math of their bodies. The home launcher is out of scope: its top chrome is the `home-launcher` masthead (see `refine-home-masthead-and-fallback`), which intentionally differs from the destination screens' minimal row and keeps its own build line.

## Goals / Non-Goals

**Goals:**
- Give all four home-session destination screens the same one-row, border-less header anatomy.
- Standardize header content as `label  value` with per-screen context labels, and move screen-local tooling (tabs, breadcrumb) to the right end of that single line,
- Remove every convoy version tag from these headers and reclaim the freed rows for the body panels.

**Non-Goals:**
- No change to footer chrome, list/detail panel titles, modals, or the run dashboard/attach/close/review screens (all live outside the home session)..
- No shared header-rendering abstraction or theming refactor;keep each screen's existing `headerContent()` composer and change only the anatomy/style surrounding it.

## Decisions

**Decision: Replace bordered header panels with bare one-row TextRenderable rows, mirroring home.**
- Rationale: home already conforms to the target look (this change predates the home masthead redesign); the border/title variety is exactly what reads as incoherent; removing it visually unifies without a new abstraction. The headerText content is already set per frame; only the container changes.
- Alternative rejected: a bordered panel unlike home — the user explicitly picked the minimal single line in the design questions.

**Decision: Each screen keeps composing its own header line; no shared component.**
- Rationale: the per-screen content differs materially (project path vs stats vs config path vs breadcrumb); a shared component would force abstraction over five small call sites. The shared contract lives in the spec, not in a shared renderer.
- Alternative rejected: a centralized `buildHeader()` helper — premature generalization over five similar-but-different rows.

**Decision: Label vocabulary = `project` for project-anchored screens, `runs`/`config` for the data screens.**
- Rationale: home's `project` label is what the user called "the good pattern"; specs (per request) and the pipelines launcher (for consistency) anchor the same project, while runs/config anchor elsewhere. The pipelines launcher's "target" label becomes "project" so all project-anchored screens read identically.


**Decision: Runs stats become the header's value text, left-anchored.**
- Rationale:the pre-existing totals (N runs · ✓ X · ✗ Y · $cost) carry the only useful info that header had; they move from right-aligned line 1 onto the new line as the value, so no info is lost.. The runs-root path line and the "run history" caption drop entirely per user request. Right segment stays reserved for interactive context (tabs, breadcrumb), so a plain stats label sits left like the project lines do.. Note: the existing stats formatMoney/color usage is preserved verbatim.


**Decision: Version tags removed from all four destination headers; `shortVersion` imports dropped where unused.**
- Rationale:the version appears in four different styles today (convoy vX, convoy specs vX, ◆ convoy vX · config); keeping it only on some screens perpetuates the inconsistency the user flagged. Version remains available via `convoy version` and other surfaces, and the home launcher's masthead keeps its own build line per the `home-launcher` capability.

**Decision: Vertical budgets shift by exactly the header delta;floors stay.**
- Each screen's header shrinks from 3 or 4 rows to 1 row, so constant budget expressions update once:
  - specs-browser: `bodyHeight = max(8, H-6)` → `max(8, H-4)`; wide `listHeight = max(3, H-8)` → `max(3, H-6)`. Compact and canonical-full-list branches derive from `bodyHeight`/panel borders, so they follow automatically.
  - runs-browser: `bodyHeight = max(8, H-7)` → `max(8, H-4)`; wide `listHeight = max(3, H-9)` → `max(3, H-6)`.
  - config-tui: `listHeight = max(3, H-9)` → `max(3, H-6)`.
  - launch-tui: `bodyHeight = max(8, H-6)` → `max(8, H-4)`; `compactBodyHeight = max(8, H-8)` → `max(8, H-6)`; `listHeight = max(3, H-8)` → `max(3, H-6)`.
- Rationale: exactly one header row means each former header row returns to the body; no other layout policy changes.

## Risks / Trade-offs

- **Height recalcs on very short terminals could over/under-shoot** → Mitigation: the existing `Math.max(...)` floors and the layout tests (which lock frame geometry at multiple widths) catch regressions; final verification renders a short (20-row) terminal and confirms no overlap.
- **`config  <path>` plus tabs could crowd on narrow widths** → Mitigation:the existing `padBetween` overflow behavior and truncation helpers already handle narrow widths;the config list already lives under the same header width today..
- **Renaming the launcher label "target" → "project" changes a visible string** → Mitigation:no test asserts the old label;the unified vocabulary is the point of the change;the spec contracts the new label.


## Migration Plan

Single atomic commit; rollback = revert the commit (no schema/data migration; the only persistent surface is the rendered header text, which rolls back with the code).

## Open Questions

None — the design decisions above resolved all ambiguity that would change specs, approach, or tasks;the per-screen details defer to the spec contract and the existing implementation patterns..