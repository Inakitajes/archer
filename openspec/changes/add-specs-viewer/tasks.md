# Tasks: add-specs-viewer

## 1. Data layer (`src/specs.ts`)

- [ ] 1.1 Define `SpecsEntry` / view types and the section-classification function (proposal/design/tasks/delta-per-capability, fallback groups for unmatched files); verify with unit tests covering each artifact name, nested capability paths, and unmatched-file placement in `test/specs.test.ts`
- [ ] 1.2 Implement `loadSpecsView(targetDir)`: reuse `isOpenSpecChangeId`, `listOpenSpecChanges`/`titleFromProposal` and symlink-skipping walk conventions from `openspec.ts`; verify with tests against fixture trees (archive excluded, dotfiles excluded, missing `openspec/` returns empty view, unreadable file tolerated)
- [ ] 1.3 Implement plain-listing printer `printSpecsList(view)` (active changes with id + artifact inventory, then canonical specs); verify by capturing output in a non-TTY test

## 2. TUI browser (`src/specs-browser.ts`)

- [ ] 2.1 Scaffold `browseSpecsTui` modeled on `RunsBrowser`: two-section root list (Active Changes above Canonical Specs), master-detail panes, theme/palette handling from `tui-theme`, compact stacked layout below ~84 columns; verify it renders both sections on a small scripted terminal harness
- [ ] 2.2 Implement navigation keys consistent with runs-browser (up/down within and across sections, Enter into a change, back/Esc/q, scrolling in the detail pane); verify with key-event driver tests
- [ ] 2.3 Render change detail grouped by section (Proposal / Design / Tasks / Delta Specs · capability) using `markdown-render`; strip frontmatter via existing helpers; verify sections render for a full fixture change
- [ ] 2.4 Handle edge cases: change without `proposal.md` lists by id with placeholder detail; unreadable file shows placeholder while others render; empty repo state message path; verify with dedicated test cases
- [ ] 2.5 Implement the **Apply this spec** action producing `{ type: "apply-change", changeID }` and the **Iterate on this plan** action producing `{ type: "iterate-change", changeID }` in a `SpecsResolution` union alongside `{ type: "exit" }`; verify each action resolves with the selected id in an interaction test
- [ ] 2.6 Build the iterate prompt (lists proposal/design/tasks/delta specs as context, sibling of `tui.ts` `iteratePrompt`) and open the standalone session via `openIterateOpencodeWindow` rooted at the repo dir; verify with a test that the prompt lists the change's planning files and the open call targets the repo dir

## 3. CLI wiring (`src/cli.ts`)

- [ ] 3.1 Add `convoy specs` case to `parseCommand` (rejects extra positionals with usage error) and register dispatch: TTY → `browseSpecs()`, non-TTY → listing + exit, no-openspec → message + exit 0; extend help text with one line; verify via `cli-parser.test.ts` additions
- [ ] 3.2 Route resolution `{ type: "apply-change" }` into the launcher path from D5 (call `launchInteractiveRun`-equivalent with preset change); verify by asserting the handoff passes the preset to `launchRunTui`
- [ ] 3.3 Route resolution `{ type: "iterate-change" }` to open the standalone OpenCode session from D7 rooted at the repo dir; verify by asserting the session opener is invoked with the repo dir and the change's files

## 4. Launcher preset (`src/launch-tui.ts`)

- [ ] 4.1 Add optional `presetChange` to `launchRunTui` options; initialize `selectedChangeId` from it before first render and skip auto-detect pinning when set; verify launcher-with-preset test pins the row and preloads the OpenSpec prompt
- [ ] 4.2 Regression-test that zero-argument launch behavior is unchanged (auto-detection notice, no pin); run full suite

## 5. End-to-end verification

- [ ] 5.1 Manual smoke in this repo: `bun run src/main.ts specs` renders sections for this repo's own changes (including `add-specs-viewer` itself), pipes cleanly to a file with exit 0, Apply-this-spec lands on the launcher with `--change add-specs-viewer` shown in its flag preview, and Iterate-this-plan opens a standalone OpenCode session rooted at the repo dir with the change's files in the prompt; record results
- [ ] 5.2 Run `bun run typecheck && bun test && bun run test:coverage` and fix any coverage-gate or regression failures
