## Why

The home launcher's four destinations — pipelines, specs, runs, config — each draw their top header with a different anatomy: bordered panels of different heights, different border titles (`convoy specs vX`, `convoy vX`, `◆ convoy vX · config`, or none), different content semantics (a project path, a data-root path, a stats row, tabs), and different version styling. The result reads incoherent: the specs screen drops the "project" label home has, "Runs History" words a screen title no other screen shows, the runs browser displays an absolute `~/.convoy/runs` path that is useful nowhere, and the version tag looks different on every screen. Navigating between destinations gives no consistent mental model of "where am I".

## What Changes

- **Unified header anatomy**: every home-destination screen (run launcher "pipelines", specs browser, runs browser, config editor) draws a single bare content row at the top — no border box, no panel title. The home launcher itself keeps its own masthead, governed by the `home-launcher` capability.
- **Header content pattern**: left = a faint context label + a text value: `project` + the target project path (pipelines launcher, specs browser), `runs` + a run-stats summary (runs browser), `config` + the active tab's config file path (config editor). A right segment keeps only screen-local context (tab strip for config, step breadcrumb for the run launcher).
- **Runs header drops the data-root**: the absolute `runsRoot()` path and the "Runs History" caption leave the runs header; the useful stats (`N runs · ✓ X · ✗ Y · $cost`) become the header's value.
- **Version removed from every destination header**: no `convoy vX`-style border titles or branding lines anywhere in the top chrome; none of the four destination screens shows the version anymore. (The home launcher's masthead build line is governed by `home-launcher`.)
- **Layout reclaim**: the freed rows reflow into the body panels; each screen's body/list budgets shift by exactly the header-height delta. Headers that were 3–4 rows shrink to 1 row, so the browse/review areas gain 2–3 rows on common terminal sizes without any behavior change.

## Capabilities

### New Capabilities

- `tui-header`: Defines the unified single-line header chrome shared by every destination screen of the home session: one bare content row, a `label  value` pattern, per-screen context labels, optional right-aligned contextual segments, and no convoy version tag.

### Modified Capabilities

- `specs-viewer`: The "Minimal chrome" requirement's header half changes from "exactly one content line containing the normalized target project directory" to the unified `project  <directory>` labeled line; the no-counts constraint stays.

## Impact

- `src/home-tui.ts` — out of scope: the home launcher's masthead is governed by the `home-launcher` capability (`refine-home-masthead-and-fallback`); no code change expected.
- `src/launch-tui.ts` — header becomes bare single row, loses its `convoy <version>` border title, the label changes from "target" to "project", heights adjust.
- `src/specs-browser.ts` — header panel becomes bare single row, content becomes `project  <shortPath(view.targetDir)>`, heights adjust.
- `src/runs-browser.ts` — header panel becomes bare single row, content becomes `runs <stats>`; the runs-root path and "run history" wording drop, heights adjust.
- `src/config-tui.ts` — header panel becomes bare single row, content becomes `config <active tab path>` with the tab strip right-aligned, heights adjust.
- Tests asserting border-titled headers update in `test/home-tui.test.ts`, `test/specs-board.test.ts`, `test/specs-reader.test.ts`, `test/tui-session.test.ts`, and `test/runs-tui.test.ts`.

No CLI surface, dependencies, or on-disk behavior changes.