# Preflight Dirty Tree in the Launcher

## Why

The launcher's only dirty-tree gate runs in `launchInteractiveRun` *after* the review's Enter is accepted (`ensureRepoReady`, cli.ts:619) — so an operator who picked a pipeline, typed a prompt, set toggles, and named a branch loses the whole session to a refusal about a condition that was knowable at launch time for the cost of one `git status --porcelain`. The knowledge and the affordance already exist, disconnected: the options step ships an "Include dirty tree" toggle that stays mute about actual dirt, and the control board already caches porcelain per checkout to paint "uncommitted" badges. A static precondition is checked at the moment of maximum user investment. The same bite hits the board's continue handoff: a feature worktree left dirty by an interrupted run fails after Enter, even though the launcher executes inside that very worktree.

## What Changes

- The launcher computes the execution tree's dirt (`git status --porcelain` on `presetFeature.worktreeDir ?? targetDir`) and whether that dirt *matters* — it does not for a fresh isolated-worktree run, mirroring the `allowDirty` semantics of the existing post-review gate.
- The options step surfaces a dirt notice row (file count + pointer to the toggle) and enriches the "Include dirty tree" toggle label with the live file count, only when dirt matters; clean trees and worktree-isolated runs show nothing new.
- The review step shows a warning line when the execution tree is dirty and "Include dirty tree" is off.
- Accepting the review in that state opens an in-TUI choice modal instead of letting the post-exit gate throw: **[i]** flip "Include dirty tree" and re-prepare the review, **[o]** back to the options step, **esc** stay in the review. The session is never lost to a knowable precondition; nothing is ever auto-enabled without explicit consent.
- The existing `ensureRepoReady` gate after the TUI exits is unchanged and remains authoritative — after these layers it only fires when dirt appeared *during* the session, which is a genuine anomaly.
- Both entry paths benefit (fresh launcher and control-board continue) because they share the launcher machinery; the board itself is unchanged.

## Capabilities

### New Capabilities

- `run-launcher`: The interactive run launcher flow (pipelines → prompt → options → branch → review). This change introduces its first requirements: dirty-tree awareness in the options step, warning in the review, and an explicit accept-time choice instead of a post-session failure.

### Modified Capabilities

<!-- None: control-board's continue requirement is untouched (the board's rows and
     handoff are unchanged); the fix lives entirely in the launcher machinery both
     entry paths share. -->

## Impact

- `src/launch-tui.ts`: dirt computation and caching per entry path, options-step notice row + toggle enrichment, review warning line, accept-time choice modal, re-prepare on consent.
- `src/cli.ts`: no behavior change — the gate at line 619 stays as the final authority.
- `src/git.ts`: reuse `statusPorcelain` and `dirtyFilesPreview` as-is; no new git plumbing.
- Tests: `test/launch-tui.test.ts` (dirt notice, review warning, modal choices, worktree-exempt paths) and the continue-handoff path in `test/launch-feature.test.ts`.
- No flags, config, or CLI surface changes; `--include-dirty` semantics unchanged.
