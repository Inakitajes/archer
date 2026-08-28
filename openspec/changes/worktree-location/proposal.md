## Why

Convoy (`spin`) always creates isolated git worktrees under the fixed global path `~/.convoy/worktrees/<branch-slug>`. When a project wants its worktrees co-located with the source (or in any other declared location), there is no way to express that convention, so Convoy silently ignores the team's preference. We want Convoy to resolve where a worktree lives through an explicit, deterministic priority order, and to honor a convention a repository documents about itself.

## What Changes

- Add a new configuration key, `defaults.worktreeLocation`, that accepts a path template with `{repo}` and `{branch}` placeholders (e.g. `~/dev/worktrees/{repo}/{branch}`).
- When a repo documents its own worktree convention (an explicit template marker in `AGENTS.md` or `README.md`), honor it; otherwise fall back to the configured default and finally to the existing fixed path.
- Keep the current behavior as the fallback: if no convention or config is present, or the resolved location cannot be used, worktrees go under `~/.convoy/worktrees/<branch-slug>`.
- Ensure all decision points agree on the same resolved path: creation, collision/suffix checks (`-2`, `-3`, …), the launcher preview, and `convoy finish --branch` lookups (via `git worktree list`).
- Keep branch naming conventional (`feat/…`, `fix/…`, `refactor/…`, `chore/…`, …). This already works today and is only verified, not changed.

## Capabilities

### New Capabilities
- `worktree-location`: how Convoy resolves and creates the directory for an isolated git worktree, including config override, documented repository convention, the deterministic fallback, and the guard that keeps every caller on the same path.

### Modified Capabilities
<!-- No existing capabilities exist yet (openspec/specs is empty); this is a new capability. -->

## Impact

- **`src/worktree.ts`**: `worktreeDirFor`, `branchNameTaken`, `ensureFreeBranchName`, `createIsolatedWorktree` — location resolution and collision checks.
- **`src/config.ts` / `src/config-tui.ts`**: new `defaults.worktreeLocation` key with validation and TUI description.
- **`src/cli.ts`**: launcher preview of the resolved worktree directory; `--worktree` help text.
- **`src/finish-command.ts`**: resolve a worktree by branch via `git worktree list` when it is not at the default location.
- **Docs/help text** that currently hard-codes `~/.convoy/worktrees`.
- **Tests**: `test/worktree*.test.ts` and new coverage for template resolution, convention detection, and fallback.