## 1. Regression Coverage

- [ ] 1.1 Strengthen the spin happy-path test to assert that the selected `openspec/changes/<id>/` path and its nested `specs/` ancestry no longer exist physically in the base checkout, and verify the new assertion fails against the current one-level cleanup.
- [ ] 1.2 Extend targeted-change coverage to assert that spinning one change leaves another active change intact, and add a non-empty-source case proving retained or ignored content prevents directory deletion; verify both cases with `bun test test/spin.test.ts`.

## 2. Bounded Directory Cleanup

- [ ] 2.1 Update the spin move cleanup to collect every former parent directory from each moved artifact through the explicit selected change root, deduplicate the candidates, and process them deepest first; verify the nested-directory regression test passes.
- [ ] 2.2 Replace check-then-recursive deletion with atomic empty-directory removal, treating absent and non-empty directories as benign while surfacing unexpected filesystem errors; verify the preservation tests and the complete `test/spin.test.ts` suite pass.

## 3. Verification

- [ ] 3.1 Run `bun run typecheck` and `bun test test/spin.test.ts`, and verify both commands complete successfully.
- [ ] 3.2 Run `bun test` and verify the full test suite completes without regressions.
