## Context

See proposal.md (Why) and the `worktree-location` delta spec for the target behavior.

Today every worktree is placed by a single function, `worktreeDirFor(branch)` in `src/worktree.ts`, which returns the fixed path `~/.convoy/worktrees/<branch-slug>`. That function is used by four callers that must agree on the same path:

- `createIsolatedWorktree` — actual creation (has the repo `targetDir`).
- `branchNameTaken` / `ensureFreeBranchName` — the collision check that appends `-2`, `-3`, … (has `targetDir`).
- `cli.ts` `checkInteractiveBranchName` — the launcher preview shown before confirmation (has `targetDir`).
- `finish-command.ts` `resolveFinishDir` — resolves a worktree from a branch name alone, with **no** `targetDir`.

This change generalizes location resolution while keeping all four callers consistent.

## Goals / Non-Goals

**Goals:**
- A single deterministic resolution order: documented repo convention → `defaults.worktreeLocation` → built-in default.
- Template support with `{repo}` / `{branch}` placeholders and `~` expansion.
- A machine-recognizable convention marker in repo docs; loose prose is ignored.
- Every caller computes the identical resolved path, including collision suffixing.

**Non-Goals:**
- No change to conventional branch naming (already implemented; this work only verifies it).
- No interpretation of arbitrary prose documentation via a model — only an explicit marker counts.
- No renaming or relocation of existing worktrees; the change affects newly created ones only.

## Decisions

### 1. Centralize location resolution in `src/worktree.ts`
Introduce a single resolver, e.g. `resolveWorktreeDir(branch, targetDir, ctx)`, that returns the final absolute path. Keep `worktreeDirFor(branch)` as a thin wrapper over the built-in default (`~/.convoy/worktrees/<slug>`) for the legacy fallback path.

**Rationale:** one function keeps creation, collision-checking, preview, and lookups aligned; that is precisely what the change is meant to guarantee.
**Alternative:** spreading the logic across the call sites — rejected because the four callers would drift.

### 2 — Resolution order with a usability guard
`resolveWorktreeDir` tries, in order: (1) the documented marker, (2) `config.defaults.worktreeLocation`, (3) the built-in default. For each, it expands the template and checks usability before accepting it; unusable candidates are skipped for the next one.

**Usability check:** resolve the expanded path, ensure its parent exists (`mkdir -p` of the parent) and is a writable directory. If it cannot be made usable, try the next candidate. The built-in `~/.convoy/worktrees` is never skipped unless it is itself unusable.

**Alternative considered:** trusting the marker or config blindly. Rejected — a stale `AGENTS.md` could point worktrees into an unusable location with no recovery.

### 3 — Documented convention marker
Scan the repo root's `AGENTS.md`, then `README.md`, for an explicit recognized line, e.g. a line matching:

`/^\s*(?:worktrees?|worktree[ _-]?location)\s*[:=:-]\s*(.+)$/i`

whose captured value is a template (contains `{repo}` or `{branch}`) or a path. `~` in the value expands to the home directory. The first match wins; no traversal and no prose interpretation.

**Rationale:** cheap and deterministic — a regex over two files — which matches the "recognized, machine-readable marker" requirement.
**Alternative:** asking the naming model to interpret the docs. More flexible but non-deterministic; rejected for the primary path (a possible later enhancement).

### 4 — `finish --branch` resolves via `git worktree list`
`resolveFinishDir` no longer reconstructs a fixed path from the branch name. It queries `git worktree list` in the repository's main checkout and matches the entry whose branch name matches. Only when absent does it fall back to `worktreeDirFor(branch)`.

**Reason:** with variable locations, the branch name alone cannot determine the path; the worktree list is the source of truth.
**Alternative:** matching a template in reverse — impossible because the creating template is not recorded.

### 5 — Config plumbing
- `defaults.worktreeLocation` added to `src/config.ts` as an optional path (validated), and surfaced in `src/config-tui.ts` with a description.
- Config is passed into the resolver's context.

## Risks / Trade-offs

- **Callers drift again** → the single `resolveWorktreeDir` is the only place paths are derived; tests assert creation, collision, and preview resolve identically.
- **Template path lands inside the repo or a nested worktree** → `git worktree add` refuses such a path. Guard: if the resolved path is inside `targetDir` (or its worktrees), fall back to the next candidate.
- **Writability check races with another run** → the existing suffix mechanism and a final `stat` in `branchNameTaken` still guard collisions; a failed create falls back to the next location.
- **Two repos with the same directory name** (two `calisteniapp`) collide in a `{repo}`-based layout → the existing `-2`, `-3`… suffixing already picks a free branch/path.

## Migration Plan

- Additive: with no config and no marker, behavior is byte-for-byte the current `~/.convoy/worktrees/<slug>`. Existing worktrees do not move; only new ones are affected.
- Rollback: remove `defaults.worktreeLocation` (or the doc marker); resolution returns to current behavior with no data migration.

## Open Questions

None — the decisions above are settled and do not require user input.