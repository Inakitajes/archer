# Tasks: specs-viewer-worktree-artifacts

## 1. Merge precedence (`src/specs.ts`)

- [x] 1.1 Rework `mergeWorktreeChanges` per D1: for each board row with `location === "worktree"`, load the entry via `loadSpecsChange(join(row.worktreeDir, openspecDirName, "changes"), row.id, { absolute: true })` and **replace** the launch-checkout entry for that id (ids the launch checkout never listed keep being appended; final order stays the alphabetical sort); verify with a `loadSpecsView` fixture test where the launch checkout carries a stale husk for the id and the worktree carries the real files — the returned entry's artifacts are non-empty and absolute into the worktree, and its title comes from the worktree's `proposal.md` (the "stale skeleton" scenario)
- [x] 1.2 Add the D3 guard: when a worktree row has no `worktreeDir`, or the worktree's copy yields no markdown artifacts, keep the launch-checkout entry unchanged instead of replacing it (a husk listing beats no listing; the merge never drops a row); verify with fixture tests for both guard cases (row without a directory; worktree whose change dir has no `.md` files)

## 2. Behavior coverage (`test/specs.test.ts`)

- [x] 2.1 Reproduce the reported incident end-to-end in the SC-1 fixture style: base checkout with `openspec/changes/<id>/specs/` present but empty (no markdown anywhere), feature worktree created via `git worktree add` carrying `proposal.md`/`design.md`/`tasks.md`/`specs/<cap>/spec.md` untracked; verify `loadSpecsView(baseRepo)` returns the change with the worktree's title and artifact set, every artifact path contains the worktree directory and resolves via `readFile` from an unrelated cwd (cwd-independence), and no entry reports zero artifacts
- [x] 2.2 Diverging copies: both the base checkout and the worktree carry markdown for the same id; verify the worktree copy wins — artifact paths point into the worktree and the title is the worktree proposal's heading (D4)
- [x] 2.3 Regressions: the existing SC-1 test ("a change living in a feature worktree still appears in Active Changes from main") passes unmodified, and a non-worktree (stranded) change still lists with repo-relative paths from the launch checkout

## 3. Verification

- [x] 3.1 Run `bun test test/specs.test.ts` (full file green, including the board-join tests) and `bun run typecheck`; confirm no changes to `src/control-board.ts`, `src/specs-browser.ts`, or any launcher file (the diff touches only `src/specs.ts` and `test/specs.test.ts`)
