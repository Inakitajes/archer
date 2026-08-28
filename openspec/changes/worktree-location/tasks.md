## 1. Location resolver in src/worktree.ts

- [ ] 1.1 Add a template expansion helper (`expandLocationTemplate`) that substitutes `{repo}`, `{branch}`, and a leading `~`; verify with unit tests for `~/dev/worktrees/{repo}/{branch}`, missing placeholders, and `~` expansion.
- [ ] 1.2 Implement `resolveWorktreeDir(branch, targetDir, ctx)` applying the resolution order (documented marker → `defaults.worktreeLocation` → built-in default) with a usability guard (parent made writable via `mkdir -p`); verify unit tests cover the priority order and fallback on an unusable candidate.
- [ ] 1.3 Add the recognized marker scan of repo-root `AGENTS.md` then `README.md` (regex-based) and verify tests for a matched marker, a non-matching prose-only doc, and a marker with an invalid template falling through.
- [ ] 1.4 Add a guard rejecting a resolved path that is inside `targetDir` (or its worktrees), falling back to the next candidate; verify with a unit test for a self-nested template.
- [ ] 1.5 Keep `worktreeDirFor(branch)` as a thin wrapper over the built-in default and verify existing `slugifyBranch`/`worktreeDirFor` tests still pass.

## 2. Collision checks on the resolved path

- [ ] 2.1 Update `branchNameTaken` / `ensureFreeBranchName` to check collisions on the *resolved* location rather than only the default, so suffixes `-2`, `-3`, … apply to declared layouts; verify with tests that a taken resolved path yields a suffixed branch/path.
- [ ] 2.2 Ensure `createIsolatedWorktree` creates the resolved location (and parent dirs) before `addWorktree`; verify an integration test that a worktree lands at the resolved path.

## 3. Config plumbing

- [ ] 3.1 Add `defaults.worktreeLocation` to `src/config.ts` with validation (optional path/template) and verify config parsing/validation tests pass.
- [ ] 3.2 Surface the key in `src/config-tui.ts` with a description and verify the config TUI renders it.
- [ ] 3.3 Wire the config value into the resolver context in `src/cli.ts` and verify a run with `defaults.worktreeLocation` set creates the worktree at the resolved path.

## 4. Launcher preview and finish

- [ ] 4.1 Update `checkInteractiveBranchName` in `src/cli.ts` to preview the resolved directory (not just the default) and verify the preview matches the created path.
- [ ] 4.2 Update `resolveFinishDir` in `src/finish-command.ts` to locate the worktree via `git worktree list`, falling back to the built-in default only when absent; verify with a test for a non-default worktree.
- [ ] 4.3 Update `--worktree` help text and any strings hard-coding `~/.convoy/worktrees`; verify the help output reflects configurable locations.

## 5. Tests and validation

- [ ] 5.1 Add/update unit tests in `test/worktree*.test.ts` covering template expansion, marker detection, resolution order, fallback, and collision suffixing; verify `bun test` passes.
- [ ] 5.2 Add integration coverage for `finish --branch` on a non-default worktree; verify the command locates and finishes the correct worktree.
- [ ] 5.3 Run `bun run typecheck` and the full test suite; verify no regressions in existing worktree behavior.