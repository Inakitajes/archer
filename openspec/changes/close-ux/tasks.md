# Tasks: close-ux

## 1. Writer foundations

- [ ] 1.1 Switch `defaultCommitMessageModel` to `openrouter/z-ai/glm-5.3-flash` in `src/commit-message.ts`; verify the id passes the existing model parsing/resolution path and a unit test proves `finish` inherits the default with no other flow change
- [ ] 1.2 Extend `CommitMessageInput` with optional proposal excerpt and scope-candidate inputs, and include both plus the omit-scope-when-broad instruction in `commitMessagePrompt`; verify with unit tests over single-, multi-, and zero-capability prompt text
- [ ] 1.3 Add post-writer normalization that replaces scope with the sole touched capability, removes it for zero/multiple capabilities, and injects `change <change-id>` into composed-message bodies; verify a writer that returns an invalid broad scope is corrected
- [ ] 1.4 Add the deterministic close fallback (normalized branch type, the same scope rule, D1's type→verb mapping plus normalized proposal title, change-id body and collapsed summaries); verify single/multiple/no-capability, missing-proposal, and all verb-map branches

## 2. Close core

- [ ] 2.1 Snapshot proposal excerpt, change id, touched capabilities, and collapsible commit subjects before `openspec archive` mutates the change path; verify with an integration test that archive moves the live change but later message composition still receives the captured inputs
- [ ] 2.2 Define the one-way close event interface (`step-started`, `step-completed`, `step-skipped(reason)`, `step-failed(step, remediation)`, merge shape and final result) and thread an optional subscriber through `runClose`; verify exact event sequences for clean close, skipped sync, archive failure, and resume
- [ ] 2.3 Add the separate async message resolver gate: compose via `proposeCommitMessage` after archive and before `applySquash`, then await the resolver; headless accepts unchanged and `--message` bypasses writer, normalization, and resolver; verify model, fallback, edited, and override paths with test doubles
- [ ] 2.4 Record merge shape in `CloseResult` from the pre/post merge SHAs and resulting parent count (`fast-forward`, `merge-commit`, `already-up-to-date`); verify each shape in temporary-repo integration tests

## 3. Surface and cleanup

- [ ] 3.1 Build the headless formatter over the close event stream in `src/feature-close-command.ts`, including skips, failures, merge shape, and safe follow-up commands; verify captured stdout for success, mid-sequence stop, configured upstream, and missing upstream (no `git push main` or other invalid push command)
- [ ] 3.2 Build the TTY checklist renderer: preflight as one line, sync/archive/squash/merge rows with running/completed/skipped/failed states, and the completed follow-up footer; verify frame tests for running, completed fast-forward, skipped sync, and stopped states
- [ ] 3.3 Implement TTY message accept/edit through the resolver using `editMessageInEditor` verbatim; verify key-driver tests for accept, edit-then-accept, editor cancellation, and that no commit lands before resolution
- [ ] 3.4 Implement cleanup follow-up state: resolve the base upstream to an explicit push refspec, disable push with remediation when absent, keep push independent, require successful worktree removal before enabling branch deletion, and retain failed actions for retry; verify success/failure/retry tests and that branch deletion never runs while its worktree exists
- [ ] 3.5 Render resume state from detected close events so previously completed/skipped rows appear checked before work continues; verify stop → `--resume` → completion in a key-driver test
- [ ] 3.6 Route the board's `close-change` handoff in `src/cli.ts` to the checklist when TTY and to the headless formatter otherwise; verify resolution-routing and mode-selection tests

## 4. Wrap-up

- [ ] 4.1 Update `closeHelp()` and README.md for the checklist, message confirmation, merge-shape narration, upstream-aware push, and ordered cleanup offers; verify help-output tests contain the interactive and headless contracts
- [ ] 4.2 Run `bun run test:coverage` with no coverage regression on touched modules, then run `openspec validate close-ux --strict` and fix any planning drift before apply
