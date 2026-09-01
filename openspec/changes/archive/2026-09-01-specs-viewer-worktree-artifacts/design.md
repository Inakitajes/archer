# Design: specs-viewer-worktree-artifacts

## Context

`loadSpecsView` (`src/specs.ts`) assembles the browser's data in two halves that disagree about precedence: the artifact half lists changes from the launch checkout's `openspec/changes/` (repo-relative paths), while the board half (`assembleControlBoard`, `src/control-board.ts`) builds rows over every `git worktree` and deliberately lets a feature-worktree row outrank a same-id row stranded on the base checkout. `mergeWorktreeChanges` is supposed to reconcile the halves, but it only *appends* worktree-loaded entries for ids the launch checkout doesn't list at all (`seen.has(row.id) → continue`). A change whose files live uncommitted in its feature worktree while the launch checkout keeps a stale husk directory for the same id therefore renders as a worktree-staged row ("proposing") over an empty artifact inventory: "no markdown artifacts found" and a blank reader. The absolute-path mechanism already exists (`loadSpecsChange(dir, id, { absolute: true })`), proven by SC-1's spun-out test — it just never runs when a husk shadows the id. See proposal.md for the incident and `specs/specs-viewer/spec.md` for the contract.

## Goals / Non-Goals

**Goals**

- One precedence rule everywhere: the copy the board chose for a row (the worktree) also supplies that row's artifacts and title.
- Working-directory-independent reads: worktree-backed artifacts carry absolute paths; no relaunch, no checkout switch, no new UI action.
- Confine the fix to the merge step — `loadSpecsChange`, the board, and the browser stay untouched.

**Non-Goals**

- No UI change: no "switch to worktree" action or new hints. The operator's switch idea is unnecessary once reads resolve in place; if a future change wants a jump action, it builds on the same resolution.
- No change to the board, spin, launcher, or archive flows.
- No freshness comparison between copies (mtime, diff) — precedence replaces comparison.
- Not cleaning up stale husks on the base checkout (spin already prunes emptied dirs; leftovers become harmless once they cannot shadow).

## Decisions

### D1. Replace, don't append: worktree rows own their id

`mergeWorktreeChanges` walks the board's worktree-backed rows and, for each, loads the entry from `row.worktreeDir` with `absolute: true` and **replaces** whatever entry the launch checkout produced for that id (ordering stays the final alphabetical sort). Appending remains the special case: ids the launch checkout never listed. Rationale: `assembleControlBoard` already resolves this exact conflict with the same `seen`-set rule (worktree rows first, base checkout gets leftovers) — the viewer mirroring the board is the missing invariant, and any append-only rule reintroduces shadowing under some husk shape. *Alternative considered*: replace only when the launch-checkout entry has zero artifacts — rejected: partial husks (a stale `proposal.md`, an outdated delta) would still shadow the copy the row actually describes, and "empty enough" is a threshold every reader relitigates.

### D2. Reuse the SC-1 absolute-path mechanics unchanged

Replacement entries come from `loadSpecsChange(worktreeChangesDir, row.id, { absolute: true })` exactly as appended ones do; the browser's `loadBody` reads absolute paths from any cwd and `artifactDisplayPath` already trims them for display. Rationale: this is the path SC-1 specified and tested for spun-out changes; the fix only widens when it applies, so reading, copy, and display behavior stay one discipline. *Alternative considered*: rebase relative paths at read time — rejected: a second path discipline beside the proven one buys nothing.

### D3. Degrade to the launch-checkout entry, never drop a row

When a worktree row lacks a usable directory, or the worktree's `openspec/changes/<id>/` yields no markdown, the launch-checkout entry stands (a husk listing beats no listing — the row stays reachable and "no artifacts" stays honest). Rationale: the merge may upgrade entries but must never delete one; this also covers a worktree vanishing between the board's `git worktree list` and the directory read, mirroring how the board join already tolerates stale worktree output.

### D4. Title follows the artifacts

No separate title logic: the replacement entry's title comes from the worktree's `proposal.md` in the same `loadSpecsChange` read, so a husk without a proposal can no longer degrade the row to its bare id while the worktree names it. *Alternative considered*: keep the launch-checkout title when one exists — rejected: title and inventory must describe the same copy, or the row lies about one of them.

## Risks / Trade-offs

- [Copies diverge; the launch checkout's committed copy is newer than a stale worktree checkout] → accepted: the board already declares the worktree the row's home, and one consistent copy beats two disagreeing halves; close/archive ends the ambiguity.
- [Worktree disappears mid-assembly] → D3 keeps the launch-checkout entry; no row is ever lost.
- [Iterate handoff on worktree-backed changes lists absolute worktree paths in the prompt] → same shape SC-1 already produces for spun-out changes; if the standalone session asks before reading outside its root, that is the session's normal defaults, unchanged by this change.
- [Absolute paths widen the `bodies` cache keys] → keys were already mixed (relative and absolute); no collision risk since the sets are disjoint by construction.

## Migration Plan

None — a data-loading fix inside `loadSpecsView`; no flags, config, or persisted state. Rollback is a revert.

## Open Questions

None.
