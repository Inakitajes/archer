# Design: preflight-dirty-tree-in-launcher

## Context

The launcher (`src/launch-tui.ts`) walks five modes — pipelines → prompt → options → branch → review — and its only dirty-tree gate runs in `launchInteractiveRun` *after* the TUI exits (`ensureRepoReady` at cli.ts:619), where a refusal costs the whole session. Two building blocks already exist: `statusPorcelain`/`dirtyFilesPreview` in `src/git.ts`, and the async-git-in-TUI pattern (`prepareReview` already awaits `repoBootstrapStatus`, `checkBranchName` does per-keystroke git, `prepareRun` is an injected callback). The gate's own semantics define what matters: `executionDir = presetFeature?.worktreeDir ?? targetDir`, `allowDirty: options.worktree` — dirt in the source checkout is irrelevant when a fresh isolated worktree will be created, and continue handoffs always execute in the feature's existing worktree with `isolateWorktree` false. See proposal.md for motivation and `specs/run-launcher/spec.md` for the behavior contract.

## Goals / Non-Goals

**Goals**

- All three layers (options notice, review warning, accept-time choice) derive from one dirt computation whose "matters" predicate mirrors the cli.ts:619 gate exactly, so warning and gate can never disagree about what counts.
- Every failure surface keeps the session alive: each layer lands inside the TUI, where one keystroke fixes the cause.
- Explicit consent only: nothing enables `--include-dirty` without the operator choosing it.

**Non-Goals**

- Board-row badges for dirty worktrees (the board's `statusCache` already has the data; a separate change if wanted).
- Stash/commit/fix actions inside the choice modal — the modal only flips the toggle or navigates; operators stash in their own terminal.
- Any change to the non-interactive `convoy run` path or to `--include-dirty` semantics.
- Polling or file-watching the tree mid-session; the design accepts a staleness window and keeps the gate as the backstop.

## Decisions

### D1. One computation, one predicate, injected like the other git seams

A single helper computes `{ files: number; blocked: boolean }` for the session: `porcelain(executionDir)` non-empty AND `!includeDirty` AND `matters`, where `matters = presetFeature ? true : !toggleState.worktree` — the exact mirror of `allowDirty` at the gate. The porcelain read is injected through `LaunchRunTuiOptions` (alongside `prepareRun`/`checkBranchName`) so tests script it without fixture git repos. Rationale: the bug this change fixes was born from knowledge and gate drifting apart; a second, slightly-different predicate would recreate it in subtler form. *Alternative considered*: reuse the control board's `statusCache` — rejected: different surface, different lifetime, and it couples the launcher to board internals.

### D2. Compute at options-entry and at review-preparation — no cache, no startup check

Dirt is read when the options step opens (for the notice + toggle count) and again inside `prepareReview` (for the warning line and the accept-block flag), both moments that already do async git work. Each read is fresh; nothing is carried across steps, so a tree that gets dirty mid-session is caught at review prep. Rationale: sessions are short and `git status --porcelain` is milliseconds; a TTL cache buys nothing and reintroduces staleness. *Alternative considered*: one read at TUI startup — rejected as stale by review time, exactly the class of staleness the spec's "rechecks rather than trusting" scenario forbids.

### D3. Options step: notice row + counted toggle, hidden when dirt doesn't matter

The notice rides the existing notice-row pattern (`pushHistoryNotice`/`pushOpenSpecNotice` shape: faint label, colored truncated headline): `tree  7 files uncommitted — enable 'Include dirty tree' or stash`. The "Include dirty tree" toggle label appends the live count while dirty. Both vanish when `!matters` (fresh worktree isolation) so irrelevant dirt never nags. Rationale: the toggle exists today but is mute; situating it in actual state is the cheapest possible fix — information the operator already needs, at the moment they can still act on it. *Alternative considered*: auto-enable the toggle when dirt is detected — rejected: `--include-dirty` has commit semantics (dirt lands in the first phase commit); that consequence needs an explicit yes.

### D4. Accept-time choice modal: three keys, re-prepare on consent

Review accept with `blocked` computed at prep opens a choice modal instead of exiting toward refusal. Body uses `dirtyFilesPreview` (the same preview the gate's error prints). Keys: **[i]** — set `toggleState.includeDirty = true` and re-run `prepareReview`, which rebuilds the selection (the flags line now shows `--include-dirty`, and the dirt status refreshes); **[o]** — `mode = "options"` (session state untouched); **esc** — dismiss, stay in review (a later accept re-offers). Rationale: an interactive surface's whole point is asking instead of refusing; the resume flow's `confirmRecovery` established this pattern for interrupted-phase leftovers. *Alternative considered*: make `prepareReview` throw on blocked dirt via the existing "can't prepare the review" modal — rejected as a dead end: it strands the operator with the session still alive but no one-key remedy, and treats a static precondition as an error.

### D5. The gate stays, untouched and authoritative

cli.ts:619 is not modified. After D2–D4 it fires only when dirt appeared after review preparation — a genuine anomaly where failing late is correct because it is surprising. The non-interactive `convoy run` path shares `ensureRepoReady`, so its behavior is unchanged by construction. Rationale: the lateness was never the sin; being the *only* check was. *Alternative considered*: relax the gate once the modal exists — rejected: it would let mid-session dirt through silently and diverge interactive from non-interactive semantics.

### D6. The accept check lives in the review key handler, not a new mode

`prepareReview` stores `blocked` on `prepared`; the review mode's accept case (the `reviewActionForKey` switch) consults it before resolving. No new mode, no flow change, `LaunchRunTuiResult` unchanged (`options.includeDirty` already flows through it). Rationale: smallest possible surface; the flag rides the data the review already renders from. *Alternative considered*: a dedicated "confirm dirty" mode between review and exit — rejected: adds a sixth mode to guard a boolean.

## Risks / Trade-offs

- [Dirt status goes stale between review prep and accept] → accepted by design; the gate (D5) catches it, and the spec pins that path as today's behavior.
- [Porcelain read fails (not a repo, permissions)] → the injected reader resolves to "clean"; the gate reports the real problem at execution time — same spirit as the board's `statusPorcelain(dir).catch(() => "")`.
- [Extra git spawns add latency] → two spawns per session, at moments already awaiting git; imperceptible.
- [Narrow terminals squeeze the notice] → reuse the truncation helpers the other notice rows already use.

## Migration Plan

None — purely additive UX inside the launcher; no flags, config, or persisted state change. Rollback is a revert.

## Open Questions

- Modal key for "back to options": **[o]** vs **[b]** — bikeshed-level, safe to pick during implementation.
