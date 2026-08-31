# Tasks: preflight-dirty-tree-in-launcher

## 1. Dirt computation and injection seam (`src/launch-tui.ts`)

- [ ] 1.1 Add an injected porcelain reader to `LaunchRunTuiOptions` (sibling of `prepareRun`/`checkBranchName`; default implementation wraps `statusPorcelain` from `src/git.ts`, resolving to `""` on failure) and a pure helper computing `{ files, matters, blocked }` with the D1 predicate: `executionDir = presetFeature?.worktreeDir ?? targetDir`, `matters = presetFeature ? true : !toggleState.worktree`, `blocked = matters && porcelain non-empty && !includeDirty`; verify with unit tests over the full predicate matrix (preset/plain × worktree on/off × dirty/clean × toggle on/off)
- [ ] 1.2 Compute dirt when the options step opens (notice data) and inside `prepareReview` (store `blocked` on `prepared`), each read fresh per D2; verify with tests driving the picker through mode transitions with a scripted reader asserting each step recomputes instead of reusing the earlier result

## 2. Options step surface

- [ ] 2.1 Render the dirt notice row in the options step following the `pushHistoryNotice`/`pushOpenSpecNotice` pattern (faint label, warning-tone truncated headline naming the file count and the "Include dirty tree" toggle), hidden when the tree is clean or `!matters`; verify with scripted-render tests for all three visibility cases (dirty plain run, clean run, worktree-isolated dirty source)
- [ ] 2.2 Enrich the "Include dirty tree" toggle label with the live file count while the execution tree is dirty (standard label when clean or `!matters`); verify with a render test asserting the counted label appears and disappears with the injected reader's answer

## 3. Review warning and accept-time choice

- [ ] 3.1 Show a warning line in the review when `blocked` is set on `prepared`, and nothing when the toggle is on or the tree is clean; verify with review-render tests covering dirty+off, dirty+on, and clean
- [ ] 3.2 Intercept review accept when `blocked`: open a choice modal (message modal extended or a new kind) whose body uses `dirtyFilesPreview`, with keys **[i]** include · **[o]** back to options · **esc** stay (per D4; the design's open question resolves to **[o]**); verify with key-driver tests for all three keys, including that esc keeps the session in review and a repeated accept re-offers the modal
- [ ] 3.3 Implement the **[i]** path: set `toggleState.includeDirty = true`, re-run `prepareReview`, land back in review with the flags line showing `--include-dirty` and no warning; verify with an interaction test asserting the second accept resolves the TUI with `includeDirty: true` in the selection and no second modal
- [ ] 3.4 Implement the **[o]** path: return to the options step with prompt, pipeline, toggles, and branch name intact; verify with an interaction test asserting session state survives the round trip

## 4. Continue handoff and gate parity

- [ ] 4.1 Cover the `presetFeature` continue handoff: dirt in the feature worktree drives the same notice, warning, and modal (execution dir is the worktree per D1); verify with tests in `test/launch-feature.test.ts` using a scripted dirty reader on the preset worktree
- [ ] 4.2 Assert parity with the real gate: a test proving the helper's `blocked` predicate is equivalent to what `ensureRepoReady(executionDir, { allowDirty: options.worktree })` would refuse, across the predicate matrix from 1.1, so warning and gate cannot drift; confirm `src/cli.ts`'s gate call site is untouched by this change
