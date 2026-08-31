## 1. Header anatomy: specs browser

- [x] 1.1 Replace the specs-browser bordered header panel (the `this.panel(...)` block titled `convoy specs <version>`) with a bare one-row `BoxRenderable` + `TextRenderable` mirroring home-tui's header, and update `paletteTargets`, `shell` wiring, and `headerBox.visible` handling so the fullscreen reader still hides it. Verify the specs TUI frame shows one bare header row and no `convoy specs` version string.
- [x] 1.2 Rewrite `headerContent` to `project  <shortPath(view.targetDir)>` (faint label, text path)and drop the unused `shortVersion` import. Verify a rendered frame contains `project  /repo` and no version string in the header.
- [x] 1.3 Adjust specs vertical budgets: header goes from 3 rows to 1, so `bodyHeight = max(8, H-4)` and wide `listHeight = max(3, H-6)` (compact and canonical-full-list branches follow via `bodyHeight`).Verify the existing specs layout tests still pass at wide, compact, and canonical-full-list widths.



## 2. Header anatomy: runs browser

- [x] 2.1 Replace the runs-browser bordered header panel (title `convoy <version>`)with a bare one-row header, updating `paletteTargets` and shell wiring. Verify the runs TUI frame shows one bare header row and no `convoy <version>` title.
- [x] 2.2 Rewrite `headerContent` to a single left-anchored line `runs  <stats>` where `<stats>` reuses today's totals chunks (`N runs · ✓ X · ✗ Y · $cost`)with the same colors, dropping the "run history" caption line and the `runsRoot()` path line; drop the unused `shortVersion` and `runsRoot` imports if no longer used. Verify a rendered frame at 120x40 with the sample runs contains `runs  3 runs` and neither `run history` nor a runs-root path.
- [x] 2.3 Adjust runs vertical budgets: header goes from 4 rows to 1, so `bodyHeight = max(8,H-4)` and wide `listHeight = max(3,H-6)`.Verify the wide and compact layout tests pass and the summary modal geometry is unchanged.



## 3. Header anatomy: config editor

- [x] 3.1 Replace the config-editor bordered header panel with a bare one-row header, updating `paletteTargets` and shell wiring. Verify the existing `bun test test/config-tui.test.ts` suite still passes.
- [x] 3.2 Rewrite `headerContent` to a single line: left `config  <shortenPath(active tab path)>`, right the Global/Project tab strip via `padBetween` (active tab emphasized exactly as today), dropping the `◆ convoy <version> · config` branding and the old second line. Drop the unused `shortVersion` import. Verify a rendered frame at 120x40 shows `config` + the active tab's path with the tabs right-aligned.
- [x] 3.3 Adjust config vertical budget: header goes from 4 rows to 1, so `listHeight = max(3,H-6)`.Verify scrolling and pagination behavior tests still pass.

## 4. Header anatomy: run launcher and home

- [x] 4.1 Replace the launch-tui bordered header panel (title `convoy <version>`) with a bare one-row header, update `paletteTargets` and shell wiring, and switch the label from `target ` to `project `. Adjust budgets: `bodyHeight = max(8,H-4)`, `compactBodyHeight = max(8,H-6)`, `listHeight = max(3,H-6)`. Verify `bun test test/launch-tui.test.ts` passes and the header shows `project  <name>` followed by the step breadcrumb.
- [x] 4.2 Confirm the home launcher header needs no change (already a bare `project  <path>` row) and that no convoy version string remains in any of the five headers. Verify `grep -rn "convoy specs\|convoy \${shortVersion\|◆ convoy" src` only matches non-header surfaces (e.g. the run dashboard footer).
- [x] 4.3 Update the header-content assertions in `test/home-tui.test.ts`, `test/specs-board.test.ts`, `test/specs-reader.test.ts`, `test/tui-session.test.ts`, and `test/runs-tui.test.ts` from the old border titles (`convoy ${shortVersion()}`, `convoy specs`) to the unified header content (`project  <dir>`, `runs  <stats>`), removing the now-unused `shortVersion` imports. Verify the five files pass individually.

## 5. Integration verification

- [x] 5.1 Run the full TUI-related suite (`bun test test/home-tui.test.ts test/launch-tui.test.ts test/specs-board.test.ts test/specs-reader.test.ts test/tui-session.test.ts test/runs-tui.test.ts test/config-tui.test.ts`) and verify all pass with the new header anatomy and content.
- [x] 5.2 Render each screen at a short terminal (about 20 rows) through the test renderer and verify no panel overlaps the header row or leaves dead vertical stripes; fix any budget drift from tasks 1-4 if a fixture catches it.
- [x] 5.3 Re-read the delta specs (`specs/tui-header/spec.md`, `specs/specs-viewer/spec.md`) and verify the implemented frames satisfy every scenario (labels, runs stats, no version strings, fullscreen reader hiding the header, config tabs right-aligned).