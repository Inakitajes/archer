# Design: feature-flow

## Context

Convoy already owns every mechanical piece this change composes: `createIsolatedWorktree` + location conventions (`src/worktree.ts`), the authorship-anchored squash (`src/finish.ts`), the branch↔change resolver (`src/openspec.ts`, selection order shared by launcher and runs), run plans that freeze `branch` (`src/run-plan.ts`), and a specs browser with action resolutions (`src/specs-browser.ts`, `src/specs.ts`). OpenCode 1.18 ships the session half natively: the TUI `/move` command relocates a session to another project directory with its history, and its picker lists project directories after a project-copy refresh (which scans git worktrees). See proposal.md — Why for the lifecycle gap.

## Goals / Non-Goals

**Goals**

- Every board fact derived at render time; zero convoy-persisted feature state anywhere.
- Deterministic spin: no LLM in the orchestration path; the operator's session moves itself via `/move`.
- Close as one resumable sequence that produces canonical specs against a fresh base and leaves one clean conventional commit.
- Absorb the tabbed-reading redesign so the board's reading level lands at dashboard conventions from day one.

**Non-Goals**

- No convoy writes to `openspec/` — archive goes through the OpenSpec CLI; spin only moves the operator's uncommitted files (a file move, not state authoring).
- No session forking, transcript reading, or summarization anywhere in the flow.
- No team/PR workflow changes: the optional push and the existing `finish --branch` PR path remain the escape hatches; close merges locally by default.
- Not tracking explorations: they are OpenCode sessions; they surface only when the operator chooses to spin.

## Decisions

### D1. The feature is a view, not an entity

The board is a live join: `git worktree list` + per-worktree `openspec/changes/` + `openspec list` task counts + run plans joined on the frozen branch name + `git status` per worktree + ancestry checks against the base ref. A registry would be a cache of this join, and every cache goes stale — the join cannot. Signals and their sources are fixed: stage = runs linked (proposing/implementing), readiness = tasks complete + clean tree + no live runs, merged-ness = patch equivalence (D6). *Alternative considered*: `~/.convoy/features/<id>.json` entries written by spin/close — rejected in exploration: it recreates the drift the board exists to cure.

### D2. One resolver, reused verbatim

Board rows link worktree/branch to change through the existing `resolveChange` selection order rather than a board-local matcher. If the board and a run's spec bundle ever disagreed about which change a branch carries, the board would lie about the contract the next run will attach. Cost: the resolver stays pure/free-of-I/O (its contract today) and the board wraps it with the filesystem reads.

### D3. Branch prefix from the change's own delta operations

`<prefix>/<change-id>` where prefix is derived by scanning the change's delta specs: any `ADDED` requirement → `feat`; all `MODIFIED` → `change`; only `REMOVED` → `fix`; no delta specs yet → `feat`. This is deterministic, needs no model, and encodes information the author already wrote. `--prefix` overrides; `--change` disambiguates; multiple uncommitted changes without a choice stop with a list. The branch namer LLM is untouched — it still serves the spec-less isolated-run path where no change id exists.

### D4. Handoff is `/move`, not a fork

Spin ends by telling the operator to run OpenCode's `/move` and pick the fresh worktree. Convoy never calls `session.fork`, never reads transcripts, never summarizes: the conversation is the operator's state and OpenCode moves it natively, complete with its own cwd-change system reminder. One deliberate human keypress is accepted as the price of not guessing. The worktree must therefore appear in `/move`'s picker: the dialog refreshes project directories (project-copy refresh scans git worktrees) before listing, so a convoy-created worktree should appear; a spike task verifies this against 1.18.x before the rest of the handoff is built. *Alternative considered*: `POST /session/{id}/fork?directory=<worktree>` — works today, but leaves a stale twin of the conversation on main and duplicates state; abandoned for the native path.

### D5. Close is a resumable pipeline: sync → archive → squash → merge

Steps run in exactly this order because each one de-risks the next: sync brings the freshest canonical specs in before archive merges deltas into them; archive (via the OpenSpec CLI, then a user-identity commit) is the only step that writes OpenSpec state; squash reuses `resolveSquashRange`'s authorship-anchored walk so operator commits (the proposal commit) survive while convoy's collapse into one conventional commit; merge then lands on the base branch from the main checkout, clean by construction. Conflict at sync stops the pipeline mid-state and `close --resume` continues from the first incomplete step (each step checks its own precondition — e.g. archive already done means the change dir is gone). Push/branch-delete/worktree-removal are offered separately, mirroring `finish`'s follow-ups. *Alternative considered*: rebase instead of merge for sync — rejected: no history rewrite under any path, and the squash makes the final history identical either way.

### D6. Merged-ness: patch equivalence, reported as probability

Squash merges erase ancestry, so `isAncestor` under-reports; `git cherry <base> <branch>` (patch equivalence) over-reports nothing but still cannot prove intent. The board therefore renders *probably merged* and offers *archive on main* — archive in the main checkout, no sync/squash/merge — as the remediation for merged-but-unarchived changes. Full certainty is intentionally reserved to the close sequence itself.

### D7. Continue reuses; the launcher stops double-isolating

A run launched from a feature row points `targetDir` at the feature's existing worktree and freezes its branch, skipping both the namer and `ensureFreeBranchName` (which today mints `-2` suffixed new branches and is the reason multi-run features are currently impossible). Complementarily, when the launcher starts inside a worktree, isolation stays default-off (today's behavior) and gains an informational warning on manual enable, naming the current worktree's branch as the fork point. The spec-less isolated path keeps today's namer flow unchanged.

### D8. The install owns exactly one file, and the trigger is opt-in

The reborn `src/opencode-install.ts` runs only behind the explicit `convoy opencode install` and writes a single global `~/.config/opencode/commands/convoy-spin.md` (the `/convoy-spin` command) whose template instructs the agent to run `convoy spin` and relay output. Opt-in is deliberate: writing into the operator's global config is a decision the operator makes, not a side effect of spinning — no path through spin or config save installs it. The `convoy-` prefix keeps the command from colliding with an operator-authored `/spin`; a `convoy-spin.md` without the convoy marker is never clobbered (the opt-in requirement's "operator-authored command files untouched" clause), a convoy-owned legacy `spin.md` is removed as part of the rename, and an operator-authored `spin.md` is left alone. Idempotent, versioned template, no plugin, no bin shim, no per-repo artifacts — the old plugin's scope was its failure. *Alternative considered*: riding the install on every successful spin (self-healing distribution) — rejected: an implicit write to the user's global config is exactly the kind of unrequested scope the removal stood for.

### D9. Tabbed reading per the superseded change's design

The absorbed `specs-viewer-tabbed-reading` design carries over as written: tab strip as the reading pane's first content rows (no new boxes), one merged Delta Specs group with capability headings injected into the single source string shared by render and copy, fullscreen via a state flag with `.visible` toggling of header/footer, and clipboard deps constructor-injected exactly like the dashboard's `copyReport`. No revisiting; its alternatives-considered record stands.

## Risks / Trade-offs

- [/move's picker may not list a convoy-created worktree if the refresh semantics differ from what the binary shows] → the spike (first implementation task) verifies listing a hand-created `git worktree add` directory on 1.18.x; fallback is printing the path and continuing in a fresh session in that directory, which loses nothing permanently.
- [Branch renames orphan run linkage] → accepted: the join degrades to showing the change without runs; recovery is renaming back. Renaming a branch that carries runs is deliberate operator action.
- [OpenSpec CLI archive output/flags drift across versions] → close shells out through a thin wrapper and treats any non-zero exit as a hard stop before squash/merge; the board's task counts already depend on the CLI and pin the same version behavior.
- [The inferred board's cost per render (worktree scans + CLI calls)] → bounded: worktrees per repo are few; `openspec list` is called once per worktree with changes; the runs join is an in-memory filter over `~/.convoy/runs` plan files, the same data the runs browser already loads.
- [Opt-in install means `/convoy-spin` may never be installed] → accepted: discoverability rides on `convoy --help` and the README; an implicit global write is the worse failure.

## Migration Plan

Purely additive surfaces (`control` alias keeps `specs` working; spin/close and the opt-in `opencode install` are new commands). No repo state to migrate — by construction. The one global-state migration: a convoy-owned legacy `spin.md` is removed by the first `convoy opencode install`; an operator-authored `spin.md` is never touched. Rollback is removing the commands (for `/convoy-spin`, deleting the single file — or never installing it).

## Open Questions

- Whether bare `convoy` (no arguments) should open the control board instead of the launcher once this lands — a launcher-default decision that does not affect this change's contracts; decide at implementation review.
