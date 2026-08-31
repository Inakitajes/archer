# Tasks: board-worktree-claim-precedence

## 1. Read layer (`src/control-board.ts`)

- [ ] 1.1 Add the `changeHasMarkdown(dir, id)` method to `BoardReads` (contract) and implement it in `createBoardReads` as one recursive readdir over `join(dir, openspecDirName, "changes", id)` matching the traversal stance of `collectDirRelativeMarkdown` — true when any `.md` file exists, false on error or empty; memoize per adapter instance like `taskCounts`; verify with a unit test against temp dirs (a husk with only empty subdirs → false; a dir with `specs/<cap>/spec.md` → true)
- [ ] 1.2 Rework the feature-worktree walk in `assembleControlBoard` into the two-pass resolve of design D1: collect per-id candidate worktrees during the walk, then rank candidates (branch-match via `branchForChange` > `changeHasMarkdown` > worktree-list order) and call `buildRow` once per id with the winner; keep the `seen` set feeding the stranded-on-main leftovers loop unchanged (D4); verify the husk-only case still produces a row from the first-listed candidate (D3)

## 2. Behavior coverage (`test/specs-board.test.ts` and/or the board's fixture home)

- [ ] 2.1 Reproduce the reported incident with fixture reads ordered like the real `git worktree list`: an earlier foreign worktree whose branch id ≠ change id carries only a husk dir for the id; the later worktree's branch matches the id and carries `proposal.md`/`tasks.md` with all boxes checked, plus a recorded run on the branch; verify the row's `worktreeDir`/`branch`/`tasks` come from the owning worktree and `stage` reads `ready` (the delta spec's first scenario)
- [ ] 2.2 Precedence edges: branch-match outranks a foreign copy with *more* markdown (delta spec scenario 2), and among two non-branch-matching candidates the markdown-bearing one wins over an earlier husk; verify rows' derived facts follow the winner in both
- [ ] 2.3 Regressions: with a single worktree per id the rows are byte-identical to today (worktree rows still outrank stranded-on-main husks; `worktreesWithoutSpec` untouched); a change stranded only on main still lists from the main checkout with repo-relative facts

## 3. Verification

- [ ] 3.1 Run `bun test` for the board and specs suites (`test/specs-board.test.ts`, `test/specs.test.ts`, `test/specs-reader.test.ts`) and `bun run typecheck`; confirm the diff touches only `src/control-board.ts` and board tests — no changes to `src/specs-browser.ts`, `src/specs.ts`, or launcher files
