## MODIFIED Requirements

### Requirement: Spin moves the uncommitted change into the worktree

Spin SHALL move the uncommitted `openspec/changes/<id>/` files from the base checkout into the new worktree and SHALL NOT commit anything on either side: committing the proposal is the operator's next step, in the worktree. After moving the files, spin SHALL remove every directory in the selected source change tree that became empty, including intermediate artifact directories and `openspec/changes/<id>/` itself. Cleanup SHALL NOT remove paths outside the selected change tree or directories that still contain any filesystem entry. Changes already committed on the base branch SHALL be left exactly where they are — no reverts, no cleanup commits — because the worktree's base ref carries them along and any overlap resolves at merge time. If the base checkout's working tree is dirty outside `openspec/`, spin SHALL refuse rather than interact with unrelated changes.

#### Scenario: Uncommitted change travels

- **WHEN** spin succeeds on an uncommitted change
- **THEN** `openspec/changes/<id>/` no longer exists physically in the base checkout and exists untracked in the worktree, and `git status` on the base checkout shows no trace of it

#### Scenario: Nested artifact directories are removed

- **WHEN** an uncommitted change contains artifacts below nested directories such as `specs/<capability>/spec.md` and spin succeeds
- **THEN** every now-empty source directory from the artifact's former parent through `openspec/changes/<id>/` no longer exists in the base checkout

#### Scenario: Cleanup is isolated to the selected change

- **WHEN** the operator uses `--change <id>` to spin one of several uncommitted changes
- **THEN** spin removes only the selected change's emptied source directories and leaves every other active change in the base checkout intact

#### Scenario: Committed change on main is untouched

- **WHEN** the target change's files are already committed on the base branch
- **THEN** spin creates the worktree (the files arrive via the base ref) and reports that nothing was moved, leaving the base branch's history and change directory untouched
