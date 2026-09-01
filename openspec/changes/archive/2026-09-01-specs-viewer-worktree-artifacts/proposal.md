# Specs Viewer Reads Worktree-Backed Artifacts

## Why

The specs viewer joins each Active Changes row to the control board, which resolves a change to the feature worktree that carries it — but the artifact inventory is still loaded from the launch checkout's `openspec/changes/` copy, and `mergeWorktreeChanges` only appends worktree entries for ids the launch checkout doesn't list at all. So when a change's files live uncommitted in its feature worktree and the launch checkout holds only a stale skeleton directory (empty husk) for the same id, the row renders with the worktree's stage ("proposing") and zero artifacts: the preview says "no markdown artifacts found" and Enter opens a blank pane. The operator must know to relaunch `convoy specs` from inside the worktree to read their own change — the exact friction this removes. Reading a change must work from wherever the browser was opened.

## What Changes

- A change id the board resolves to a feature worktree has its artifact inventory and title loaded **from that worktree**, addressed by absolute paths — regardless of what the launch checkout's `openspec/changes/` holds. This mirrors the precedence `assembleControlBoard` already applies to rows (worktree rows outrank same-id rows stranded on the base checkout).
- The worktree-backed entry **replaces** the launch-checkout entry for that id instead of being skipped: a stale or empty local skeleton can no longer shadow the real files.
- The row title comes from the worktree's `proposal.md`, so a husk without a proposal no longer degrades the title to the bare change id.
- Absolute paths make the reads working-directory independent: no checkout switch, no relaunch from the worktree, no new key or action — the same mechanism SC-1 already uses for spun-out changes.
- Board behavior (stages, runs, actions) is unchanged; only the specs view's artifact/title resolution changes.

## Capabilities

### New Capabilities

<!-- None. -->

### Modified Capabilities

- `specs-viewer`: adds a requirement for worktree-backed artifact resolution — which copy of a change supplies its artifacts and title when the board places the change in a feature worktree, and that reading works from any launch directory. Today's spec only governs discovery from the launch checkout's `openspec/` tree; nothing covers the shadowing failure.

## Impact

- `src/specs.ts`: `mergeWorktreeChanges` gains replace semantics for worktree-backed ids (load absolute-path artifacts from `row.worktreeDir`).
- `test/specs.test.ts`: new cases — stale empty skeleton on the launch checkout with real artifacts in the worktree; diverging copies (worktree wins); title from the worktree's proposal; SC-1 regression.
- No CLI, config, board, or launcher changes.
