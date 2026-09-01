## Why

The interactive `convoy close` flow currently looks stalled while it composes the squashed commit message, presents a vertical review menu that does not respond to vertical navigation, and forces edits through an external editor. Its cleanup footer also presents worktree and branch actions as permanently unavailable when close was launched from inside the feature worktree, without making clear that the current shell location is the blocker.

## What Changes

- Make the squash checklist report the message-composition, message-review, and commit-creation phases honestly, with animation that continues while asynchronous work is quiet.
- Make Accept, Edit, and Cancel a conventionally navigable selector while retaining direct keyboard shortcuts.
- Replace Close's external-editor-first flow with an inline multiline commit-message editor; saving returns to review, and only a subsequent acceptance lets the squash land.
- Distinguish cleanup actions that can run in the current session from cleanup that requires leaving the feature worktree. Do not present permanently blocked worktree and branch cleanup as runnable actions; show the reason and exact safe continuation instead.
- Preserve the existing safety ordering: push remains independent, and a branch cannot be deleted until its worktree is gone.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `feature-close`: Refine the interactive checklist, commit-message review and editing contract, keyboard navigation, and post-close cleanup presentation.

## Impact

- Affects the Close event contract and presentation reducer, the OpenTUI Close scene, interactive command orchestration, and Close TUI/integration tests.
- Reuses OpenTUI's existing multiline editing primitives; no new external dependency or CLI flag is required.
- Headless close semantics, squash selection, merge policy, and `convoy finish` editing remain unchanged.
