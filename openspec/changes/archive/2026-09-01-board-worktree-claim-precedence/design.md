# Design: board-worktree-claim-precedence

## Context

`assembleControlBoard` (`src/control-board.ts`) walks feature worktrees in `git worktree list` order and lets the first worktree listing a change id claim it via the `seen` set; later copies — including the owning worktree's — are skipped. The claim assumes each id exists in at most one worktree, which merges and leftover tooling state break: an unrelated worktree can carry an untracked husk (`openspec/changes/<id>/specs/` with no markdown) that claims the id first. `buildRow` then derives everything from the wrong checkout: `branchForChange` returns no branch (the foreign worktree's branch doesn't match the id), `taskCounts` reads the husk (0/0), and runs link only through the shared-id fallback — stage "implementing" instead of "ready", and the browser's `worktreeDir && branch` gate hides `c continue` / `x close`. The sibling fix `specs-viewer-worktree-artifacts` made the *viewer* replace husk listings with the row's worktree copy but deliberately left this join untouched (its task 3.1 pins `src/control-board.ts` unchanged); this change is that half. `listChangeIds` counting husk dirs is what keeps such rows visible at all today — see D3 before "fixing" it.

## Goals / Non-Goals

**Goals:**

- Claim resolution that ranks candidates for one id: branch-matching worktree first, artifact-bearing copy next, `git worktree list` order as the stable tie-break.
- Row facts (branch, tasks, title, uncommitted marker) always read from the winning checkout, so stage and available actions describe the owning copy.
- Keep the join pure over `BoardReads` — precedence lives in `assembleControlBoard`, testable with fixture reads.

**Non-Goals:**

- No UI changes in `specs-browser.ts` (the `worktreeDir && branch` gate is correct once rows resolve rightly).
- No cleanup of husk directories on disk; leftovers become harmless once they cannot win a claim (same stance as the viewer change's non-goal).
- No change to the stranded-on-main vs worktree ranking (worktree rows still outrank base-checkout husks), to `mergeWorktreeChanges`, or to `branchForChange`'s shared resolver rule.
- No freshness comparison between copies (mtime/diff) — precedence replaces comparison, mirroring the viewer change's D1 stance.

## Decisions

### D1. Two-pass resolution over the worktree walk, branch match as the top rank

Instead of claiming ids inline during the walk (`seen.add` on first sight), collect each id's candidate worktrees in one pass, then resolve per id: rank 1 = `branchForChange(id, worktree.branch)` returns a branch; rank 2 = the worktree's `openspec/changes/<id>/` contains at least one markdown file; rank 3 = earliest in worktree-list order. Build the row from the winner only. Rationale: branch identity is the strongest ownership signal the system already has — it is the same rule runs and the launcher match on — and it is cheap (no filesystem read). *Alternative considered*: keep first-wins but skip husks when claiming — rejected: it fixes the empty-husk case but still lets a *markdown-bearing* foreign copy (dragged in by a merge) outrank the branch-matching owner, which is the same bug one shape later.

### D2. "Artifact-bearing" means any markdown in the change dir, checked through a new memoized read

Rank 2 needs to know whether `join(dir, openspecDirName, "changes", id)` holds any `.md` file. Add one `BoardReads` method (e.g. `changeHasMarkdown(dir, id)`) implemented with a single recursive readdir, memoized per adapter instance like `taskCounts`/`status` so the N-worktree cost stays one read per candidate dir. Reuse `collectDirRelativeMarkdown`'s traversal stance rather than `listChangeIds` (which counts directories, not files). Rationale: `BoardReads` is the established injection point for world reads; fixture tests then cover precedence without a repo on disk, and the memo keeps design D1's "one spawn per directory" bound intact.

### D3. Never drop a row — husk-only fields degrade exactly as today

If every candidate is a husk and none is branch-matching, the row still renders from the first-listed candidate: `worktreeDir` set, no branch, no tasks, runs via the shared-id fallback, stage "implementing" when runs exist. Rationale: same "a husk listing beats no listing" discipline as the viewer change's D3 — the board reports the world, and an unreachable row would hide the very state the operator needs to clean up. This also preserves today's behavior for the stranded-on-main leftovers path untouched.

### D4. Tasks, title, and status read the winner; `seen` semantics stay for main's leftovers

`buildRow` already takes the directory to read from; resolution only changes *which* worktree is passed. The stranded-on-main loop keeps consuming `seen` so a worktree-resolved id never duplicates as a base-checkout row. Rationale: the fix stays confined to candidate selection; every downstream derivation (`deriveStage`, `hasUncommittedProposal`, `worktreeRunsFor`) is reused verbatim.

## Risks / Trade-offs

- [Worktree vanishes between `git worktree list` and the directory read] → D3's degrade path plus the existing try/catch stance in the adapter; no row is lost.
- [Two worktrees both branch-match the id (same branch checked out twice)] → git forbids one branch in two worktrees; detached-HEAD worktrees return no branch and fall to rank 2, so the ambiguity cannot arise through supported states.
- [Foreign markdown-bearing copy wins rank 2 over an earlier husk] → intended: with no branch match anywhere, any readable copy is strictly more truthful than a husk; ties inside rank 2 stay deterministic by list order.
- [One extra readdir per candidate change dir] → memoized per assembly (D2); bounded by worktree × change count, the same order `taskCounts` already pays.

## Migration Plan

None — a derivation fix inside `assembleControlBoard` plus one injected read; no flags, config, or persisted state. Rollback is a revert.

## Open Questions

None.
