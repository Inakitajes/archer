# Tasks: feature-flow

## 1. Spikes and foundations

- [ ] 1.1 Spike: verify OpenCode 1.18.x's `/move` dialog lists a worktree created by plain `git worktree add` (create one in a scratch repo, open `opencode`, run `/move`, confirm it appears after the dialog's refresh); record the outcome in the run report — if absent, the spin output falls back to printing the path plus `opencode <dir>` per D4
- [x] 1.2 Implement prefix inference in `src/worktree.ts` (or a sibling): scan a change's delta specs for `ADDED`/`MODIFIED`/`REMOVED` requirement headers → `feat`/`change`/`fix`, default `feat` when no deltas; verify with unit tests covering the three markers, the no-delta fallback, and mixed operations resolving to `feat`
- [x] 1.3 Implement the board join as pure assembly over injected reads (worktrees, per-dir changes + task counts, run plans filtered by frozen branch, per-worktree status, ancestry/patch-equivalence checks); verify with unit tests using fixture dirs and plan files, including the rename-orphan degradation case from D1

## 2. Spin

- [x] 2.1 Implement `convoy spin` in `src/spin.ts`: resolve the uncommitted change (single auto, multiple list-and-stop, `--change` override), derive `<prefix>/<change-id>`, create the worktree through `createIsolatedWorktree` on the base ref, refuse dirty-outside-openspec trees; verify with integration tests in a temp repo asserting branch name, worktree location per convention, and the refusal paths
- [x] 2.2 Move the uncommitted `openspec/changes/<id>/` into the worktree (fs move, nothing committed on either side); committed-on-base changes skip the move and report that the base ref carries them; verify with tests covering the move, the already-committed case, and that base `git status` ends clean of the change
- [x] 2.3 Print the handoff (worktree path, branch, what moved, `/move` instruction per the spike outcome); verify the output format with a snapshot-style test
- [x] 2.4 Reborn `src/opencode-install.ts`: idempotent install/update of `~/.config/opencode/commands/spin.md` with the thin-run-the-CLI template, touching nothing else; verify with tests against a fake config dir including the double-run and foreign-file-untouched cases, and wire the install into `convoy spin`'s completion or config save path per implementation review

## 3. Control board

- [x] 3.1 Rename the surface: `convoy control` opens the board, `convoy specs` stays as an alias, help text updated; verify with CLI parser tests for both entry points
- [x] 3.2 Render Active Changes rows from the join: derived stage, tasks done/total, run count with liveness, uncommitted-proposal marker, synced marker, probably-merged marker; verify with browser frame tests over fixture repos covering stranded-on-main, proposing, implementing-with-live-run, and complete-unarchived rows
- [x] 3.3 Add the Worktrees without spec section (worktrees with runs but no change, linking to the runs browser) as a peer section; verify with a frame test listing one such worktree and none when absent
- [x] 3.4 Route row actions: spin out (calls spin with the row's change), continue (launcher handoff per task 4.1), close (per section 5), archive on main (per task 5.5); verify with resolution-routing tests asserting each action returns the right handoff payload

## 4. Launcher reuse

- [x] 4.1 Feature-row continue: preselect the feature's existing worktree as `targetDir` and freeze its branch in the run plan, skipping the namer and `ensureFreeBranchName`; verify with tests asserting the second run's plan names the same branch/worktree and no new worktree appears
- [x] 4.2 Nested-isolation warning: when the launcher runs inside a worktree and isolation is enabled manually, show the informational warning naming the current branch as the fork point; verify default-off behavior stays intact and the warning renders only in that combination (frame test)

## 5. Close

- [x] 5.1 Implement `convoy close` preflight in `src/feature-close.ts` (clean tree, tasks complete, no live runs on the branch) with per-condition remediation messages; verify with tests for each blocking condition
- [x] 5.2 Sync step: merge the base branch into the feature branch inside the worktree; conflicts stop with the conflict listed; `close --resume` continues from the first incomplete step; verify with tests for clean sync, conflicting sync, and resume-after-resolution
- [x] 5.3 Archive step: shell out to the OpenSpec CLI in the worktree, commit the result under the operator identity, hard-stop on non-zero exit before squash/merge; verify with a test double for the CLI covering success, failure-abort, and the resume skip when the change dir is already gone
- [x] 5.4 Squash and merge: reuse `resolveSquashRange` so operator commits survive and convoy commits collapse to one conventional commit, then merge into the base branch from the main checkout; offer push, branch delete, and worktree removal separately; verify with integration tests in a temp repo asserting final base history (conventional commit + surviving operator commits) and that the worktree still exists until accepted
- [x] 5.5 Archive on main remediation for probably-merged changes (patch-equivalence via `git cherry`): archive in the main checkout with no sync/squash/merge; verify with a test fixture reproducing a squash-merged-but-unarchived change

## 6. Tabbed reading (absorbed from specs-viewer-tabbed-reading)

- [x] 6.1 Merge delta artifacts into one "Delta Specs" group in `src/specs.ts` with capability headings injected into the shared source string; verify with unit tests asserting exactly Proposal/Design/Tasks/Delta Specs groups in order for a multi-capability fixture
- [x] 6.2 Tabbed detail level in `src/specs-browser.ts`: full-width reading pane, tab strip as content rows, hidden strip for single groups, `←/→`/`h`/`l`/digits switch tabs, `↑/↓`/`j`/`k` line-scroll; verify with frame tests (four tabs for a full change, no strip for a canonical spec) and key-driver tests (tab move, scroll within tall content, digit jump)
- [x] 6.3 Fullscreen reader `v` (detail level only) via `.visible` toggling and title bar without scroll hints; verify with key-driver tests: toggle preserves the active tab, root-level `v` is a no-op
- [x] 6.4 Copy the active tab `c` through the injected clipboard pipeline (frontmatter-stripped, headings included on Delta Specs) with title-bar status; verify with fake-clipboard tests for success, multi-capability payload, and no-mechanism failure
- [x] 6.5 Lean chrome: drop the static header line (height 4→3) and obvious-navigation footer hints, keep hint overflow; verify with frame tests asserting one header content line and the footer hint set

## 7. Wrap-up

- [x] 7.1 Update `README.md` and `convoy --help` for control/spin/close and the `/spin` command; verify help output contains all three surfaces and the alias
- [x] 7.2 Full suite green (`npm test` or the repo's runner) with no coverage regression on the touched modules; run `openspec validate feature-flow` and fix any drift before apply
