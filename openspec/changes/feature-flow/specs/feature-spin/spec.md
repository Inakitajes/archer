## Purpose

Deterministically materialize a working context — isolated worktree, conventional branch — for an OpenSpec change proposed on the base checkout, and hand the operator's existing OpenCode session over to it without summarizing, forking, or persisting any registry state.

## ADDED Requirements

### Requirement: Spin creates a worktree with a deterministically named branch

`convoy spin` run inside a repository checkout with an uncommitted OpenSpec change SHALL create an isolated worktree and a branch whose name is `<prefix>/<change-id>`: the change id verbatim, prefixed by a conventional-commit type inferred deterministically from the change's own delta specs — `feat` when any requirement is ADDED, `change` when every requirement is MODIFIED, `fix` when requirements are only REMOVED — falling back to `feat` when the change has no delta specs yet. The operator SHALL be able to override the prefix (`--prefix`) and the change (`--change <id>`) and, when several uncommitted changes exist without `--change`, spin SHALL list them and stop for a choice rather than guessing. The worktree location SHALL follow the repository's documented worktree convention, exactly as launcher-isolated runs do.

#### Scenario: Happy path spin

- **WHEN** the base checkout holds exactly one uncommitted change `specs-viewer-tabbed-reading` whose delta spec adds a requirement, and the operator runs `convoy spin`
- **THEN** a worktree exists at the location the repository convention dictates, on branch `feat/specs-viewer-tabbed-reading`, and the branch's base is the base ref a launcher-isolated run would use

#### Scenario: Prefix follows the delta operations

- **WHEN** a change's delta spec contains only `MODIFIED Requirements`
- **THEN** the proposed branch is `change/<change-id>`; and when it contains only `REMOVED Requirements`, `fix/<change-id>`

#### Scenario: Ambiguity stops instead of guessing

- **WHEN** two uncommitted changes exist and spin runs without `--change`
- **THEN** spin lists both ids and exits non-zero without creating any worktree

### Requirement: Spin moves the uncommitted change into the worktree

Spin SHALL move the uncommitted `openspec/changes/<id>/` files from the base checkout into the new worktree and SHALL NOT commit anything on either side: committing the proposal is the operator's next step, in the worktree. Changes already committed on the base branch SHALL be left exactly where they are — no reverts, no cleanup commits — because the worktree's base ref carries them along and any overlap resolves at merge time. If the base checkout's working tree is dirty outside `openspec/`, spin SHALL refuse rather than interact with unrelated changes.

#### Scenario: Uncommitted change travels

- **WHEN** spin succeeds on an uncommitted change
- **THEN** `openspec/changes/<id>/` no longer exists in the base checkout and exists untracked in the worktree, and `git status` on the base checkout shows no trace of it

#### Scenario: Committed change on main is untouched

- **WHEN** the target change's files are already committed on the base branch
- **THEN** spin creates the worktree (the files arrive via the base ref) and reports that nothing was moved, leaving the base branch's history untouched

### Requirement: Spin hands the session over via /move

On success spin SHALL print the worktree path, the branch, the state of the moved change, and an instruction to run OpenCode's `/move` and pick that worktree — the operator's current session relocates there with its history. Spin SHALL NOT fork, copy, summarize, or otherwise touch any OpenCode session itself; the session belongs to OpenCode.

#### Scenario: Output tells the operator exactly what to do next

- **WHEN** spin completes
- **THEN** the output names the worktree directory, the branch, what moved, and says to continue the same conversation by running `/move` and selecting that worktree

### Requirement: The global /convoy-spin OpenCode command is opt-in

`convoy opencode install` SHALL install and keep updated a single global OpenCode command file (`~/.config/opencode/commands/convoy-spin.md`, the `/convoy-spin` command) that instructs the agent to run `convoy spin` in the repository and relay its output — nothing more: no branch inference, no pipeline selection, no summaries. No other convoy path SHALL write into the operator's global OpenCode config: `convoy spin` and config saves SHALL NOT install or refresh the command as a side effect. The installer SHALL be idempotent, overwrite only its own file, leave any operator-authored command files (including an operator-authored `spin.md` or `convoy-spin.md` without the convoy marker) untouched, and remove a convoy-owned legacy `spin.md` left by the pre-rename install.

#### Scenario: Opt-in install, no side effects

- **WHEN** `convoy spin` completes without `convoy opencode install` ever having been run
- **THEN** no file has been written into `~/.config/opencode/commands/`

#### Scenario: Install then reinstall

- **WHEN** the install runs twice
- **THEN** exactly one convoy-owned `convoy-spin.md` exists with the current template, and any other command files in the directory are byte-identical to before

#### Scenario: Legacy convoy-owned /spin is migrated away

- **WHEN** the install runs on a machine with a convoy-owned legacy `spin.md` (pre-rename)
- **THEN** `convoy-spin.md` is written and the legacy `spin.md` is removed; an operator-authored `spin.md` without the convoy marker is left untouched

#### Scenario: The command is a thin wrapper

- **WHEN** `/convoy-spin` runs in an OpenCode session
- **THEN** the agent runs `convoy spin` via the shell and reports its output verbatim instead of performing git operations or naming branches itself
