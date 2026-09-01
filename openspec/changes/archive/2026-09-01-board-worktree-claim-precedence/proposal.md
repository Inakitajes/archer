# Proposal: board-worktree-claim-precedence

## Why

A stale husk of a change directory (`openspec/changes/<id>/` with no markdown — e.g. a leftover empty `specs/` subtree) inside an *unrelated* feature worktree steals that change's row in the control board: `assembleControlBoard` walks worktrees in `git worktree list` order and the first worktree listing the id wins. The real worktree's copy is skipped, so the row resolves to the wrong worktree, loses its branch (`branchForChange` requires the worktree's branch to match the change id), reads tasks from the husk (0/0), and links runs only through the shared-id fallback — producing stage "implementing" for a change whose tasks are all complete, and hiding the `c continue` / `x close` actions, which are gated on `worktreeDir && branch`, not on stage. Observed live: `specs-viewer-worktree-artifacts` claimed by `feat-preflight-dirty-tree-in-launcher`'s husk while its own worktree sat at 6/6 tasks done, uncloseable from the board.

## What Changes

- Change-id claiming across worktrees in `assembleControlBoard` becomes precedence-based instead of first-listed-wins: the worktree whose branch matches the change id (the same resolver rule `branchForChange` applies) outranks any other copy; among the rest, a copy bearing markdown artifacts outranks a husk; remaining ties keep today's worktree-list order.
- Derived row facts (branch, tasks, title, uncommitted marker) always come from the winning worktree's copy, so stage derivation ("ready to close" vs "implementing") sees the real `tasks.md`.
- The join still never drops a row: when only husks exist, the row degrades exactly as today (wrong-but-present beats absent).
- No UI changes, no new actions, no persisted state — the fix lives entirely in the board's derivation.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `control-board`: the "Active change rows derive their lifecycle state" requirement gains a precedence rule for which checkout supplies a row when several worktrees list the same change id, so derived stage, branch, and task counts describe the copy that actually owns the change.

## Impact

- `src/control-board.ts` — the worktree loop in `assembleControlBoard` (claim resolution); no change to `BoardReads`' shape beyond what precedence needs (e.g. an artifact-bearing check per candidate dir).
- `test/specs-board.test.ts` (or the board's fixture home) — precedence scenarios: husk-in-earlier-worktree, two-real-copies, husk-only degradation, branch-match priority.
- Follows `specs-viewer-worktree-artifacts` (viewer half, D1–D4) which deliberately scoped the board join out; no overlap with its `src/specs.ts` edits.
