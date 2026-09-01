## 1. Truthful Squash Progress

- [x] 1.1 Extend the Close event model with typed squash phases and emit composition, review-wait, and commit-creation transitions around the corresponding awaits; verify `bun test test/feature-close.test.ts` covers their exact order for model, fallback, cancellation, and accepted-message paths.
- [x] 1.2 Teach the shared Close presentation reducer and formatters to render phase-specific detail without changing headless final output; verify reducer and command presentation assertions pass in `bun test test/feature-close.test.ts test/feature-close-command.test.ts`.
- [x] 1.3 Add a lifecycle-safe Close TUI render ticker that runs only for active progress, pauses with the renderer, and is disposed on completion or destruction; verify fake-clock tests in `test/close-tui.test.ts` observe changing spinner frames during a deferred writer and no ticks after teardown.

## 2. Navigable Review and Inline Editing

- [x] 2.1 Align the vertical Accept/Edit/Cancel selector with Up/Down and `j`/`k`, retain compatible aliases and direct shortcuts, and update footer hints; verify parser-driven key tests move the visible selection and activate each choice in `bun test test/close-tui.test.ts`.
- [x] 2.2 Add the centered OpenTUI textarea overlay with reviewed-message and draft state, focus-aware key routing, multiline paste/cursor behavior, save validation and sanitation, and discard semantics; verify `test/close-tui.test.ts` covers save-to-review, discard, empty-subject rejection, multiline paste, and teardown.
- [x] 2.3 Change the interactive message resolver to return only an explicitly accepted final string or cancellation, removing `$EDITOR` from Close while leaving `convoy finish` unchanged; verify `bun test test/feature-close-command.test.ts test/feature-close.test.ts` proves edits do not imply acceptance, cancellation does not squash, and the accepted edited value reaches `applySquash` without launching an external editor.

## 3. Actionable and Deferred Cleanup

- [x] 3.1 Refactor follow-up resolution to distinguish selectable actions, same-session blocked dependencies, and ordered deferred cleanup guidance while preserving explicit `git -C` commands; verify `bun test test/feature-close-command.test.ts` covers both process locations, missing upstream, worktree-removal failure/retry, and branch unlocking.
- [x] 3.2 Render deferred worktree and branch cleanup as a reason plus commands rather than permanently unavailable choices, while keeping push and outside-worktree cleanup keyboard-selectable; verify `bun test test/close-tui.test.ts` covers selection boundaries, explanatory copy, command order, and the removal-to-branch state transition.

## 4. Documentation and End-to-End Verification

- [x] 4.1 Update Close help and user documentation to describe live composition state, inline review editing controls, and why cleanup launched inside a feature worktree must continue from outside it; verify the documented keys and commands match the tested TUI behavior.
- [x] 4.2 Run `bun test test/feature-close.test.ts test/feature-close-command.test.ts test/close-tui.test.ts`, `bun test`, `bun run typecheck`, and `openspec validate improve-close-tui-flow --strict`; verify every command completes successfully.
