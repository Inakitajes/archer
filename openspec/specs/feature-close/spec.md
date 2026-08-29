# feature-close Specification

## Purpose
Close a feature in one orchestrated sequence — sync, archive, squash, merge, optional cleanup — so canonical specs are produced against a fresh base branch and no drift window or stale-change state can survive.

## Requirements

### Requirement: Close preflights before touching anything

`convoy close` SHALL refuse to start unless the feature worktree's tree is clean, the change's tasks are all complete, and no live convoy run is attached to the worktree's branch. Each blocking condition SHALL be reported with the concrete remediation (`commit or stash`, finish the tasks, or wait for/stop the run) instead of a generic failure.

#### Scenario: Incomplete tasks stop the sequence

- **WHEN** close runs on a change with 8 of 11 tasks complete
- **THEN** nothing has changed on any branch and the message names the missing task count

### Requirement: Close syncs the base branch before archiving

Close SHALL merge the base branch into the feature branch inside the feature worktree as its first mutation. When that merge conflicts, close SHALL stop with the conflict state left for the operator to resolve and SHALL support resuming the sequence after resolution (`close --resume`) without redoing completed steps.

#### Scenario: Clean sync

- **WHEN** the base branch has advanced and the merge applies cleanly
- **THEN** the feature branch contains the base branch's tip before any archive step runs

#### Scenario: Conflicting sync pauses the sequence

- **WHEN** the sync merge conflicts
- **THEN** close stops with the conflict listed, and `close --resume` after the operator resolves it continues from the archive step

### Requirement: Close archives through the OpenSpec CLI

Close SHALL archive the change by running the OpenSpec CLI's archive command inside the feature worktree — convoy never edits `openspec/` itself — and SHALL commit the archive result on the feature branch under the operator's identity. Archive failures SHALL abort the sequence before any squash or merge happens.

#### Scenario: Archive then commit

- **WHEN** the sync step completed cleanly
- **THEN** the OpenSpec CLI archives the change inside the worktree, the change directory moves to the archive layout, canonical specs gain the merged deltas, and the result is committed on the feature branch

### Requirement: Close squashes and merges into the base branch

After archiving, close SHALL collapse the run's commits into one conventional commit under the operator's identity using the same authorship-anchored walk `convoy finish` uses, then merge the feature branch into the base branch from the main checkout. The merge SHALL be performed only when the squash left a single clean commit; the operator's own commits on the branch (for example the proposal commit) SHALL survive the squash. Pushing the base branch, deleting the feature branch, and removing the worktree SHALL each be offered separately and never happen automatically.

#### Scenario: One conventional commit lands

- **WHEN** close completes through the merge
- **THEN** the base branch gains the squashed conventional commit plus any operator-authored commits, the canonical specs reflect the archived change, and the feature worktree still exists until the operator accepts its removal

### Requirement: Merged detection reports probability, not certainty

For a change whose branch content appears in the base branch only via patch equivalence, the board and close SHALL report *probably merged* — never *merged* — because squash merges erase ancestry. Certainty comes from the close sequence itself, which archives and merges as one unit. When a change is complete and its content is probably merged but it remains unarchived, the board SHALL offer *archive on main*: archive in the main checkout without sync, squash, or merge, since there is nothing left to merge.

#### Scenario: Squash-merged change shows honestly

- **WHEN** a change's branch was squash-merged into the base branch and never archived
- **THEN** the board row reads probably merged and offers archive on main

#### Scenario: Archive on main

- **WHEN** the operator accepts archive on main for such a change
- **THEN** the OpenSpec CLI archives it in the main checkout, the result is committed on the base branch, and no merge or worktree step runs
