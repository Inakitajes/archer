# control-board Specification

## Purpose
One inferred surface — `convoy control` — where every feature's stage is derived live from git, OpenSpec, and run plans, with the actions that move it along; no persisted registry, one shared change resolver.

## Requirements

### Requirement: Control command is the single inferred board

`convoy control` SHALL present the board (with `convoy specs` retained as an alias) and derive every displayed fact at render time from the filesystem: worktrees and branches from git, task completion from the OpenSpec CLI, run linkage from run plans' frozen branch field, and change identity from the same resolver the launcher and runs use for branch↔change matching. Convoy SHALL NOT persist any feature registry — a row's existence in the world is its existence on the board.

#### Scenario: Deleting the worktree updates the board

- **WHEN** a feature's worktree is removed outside convoy and the board is reopened
- **THEN** the row no longer claims a worktree, without any cache to invalidate

#### Scenario: One resolver everywhere

- **WHEN** a branch named `feat/add-foo` exists while a change `add-foo` is active
- **THEN** the board links them by the same matching rule a run's spec bundle would use

### Requirement: Active change rows derive their lifecycle state

Each active change row SHALL show its derived stage and signals: tasks completed of total, linked runs (count and liveness), whether the proposal sits uncommitted, whether the feature branch contains the base branch's tip (synced), and merged-ness reported as probably merged at most. Rows SHALL render for changes on the base checkout (stranded), changes inside their worktrees (proposing, implementing when runs are linked), and completed-but-unarchived changes (ready to close, or probably merged).

#### Scenario: Implementing feature

- **WHEN** a change in a worktree has two runs recorded against its branch, one live
- **THEN** its row shows implementing with two runs and the live one marked

#### Scenario: Stranded change on main

- **WHEN** a change exists uncommitted on the base checkout with no worktree
- **THEN** its row shows stranded on main and offers spin out

### Requirement: Worktrees without spec get their own section

The board SHALL include a section listing worktrees that carry runs but no OpenSpec change, each linking to the runs browser for that branch. The section SHALL be a peer of the active-changes and canonical-specs sections, not a footnote.

#### Scenario: Plain isolated run appears

- **WHEN** an isolated run's worktree exists with no change directory
- **THEN** it is listed in the worktrees-without-spec section with its branch and run count

### Requirement: Continue reuses the feature's worktree and branch

Launching a run from a feature row SHALL preselect that feature's existing worktree and branch — the run executes in the worktree on the feature branch with the base ref as base — instead of creating a new worktree or minting a new branch name. Isolation SHALL be on by default in this path, and the launcher SHALL proceed without invoking the branch namer.

#### Scenario: Second run lands on the same branch

- **WHEN** a feature already ran once and continue launches another run
- **THEN** the run's plan freezes the existing feature branch and worktree directory, and no new worktree is created

### Requirement: The launcher warns on nested isolation

When the launcher detects it is running inside a worktree, isolation SHALL remain off by default (today's behavior), and enabling it manually SHALL display a warning that the operator is already on a branch inside a worktree and should fork only deliberately. The warning SHALL be informational, not blocking.

#### Scenario: Warning on deliberate fork

- **WHEN** the operator enables isolate-in-a-worktree while the launcher runs inside a worktree
- **THEN** the options step shows that the new worktree will be forked from the current worktree's branch, in addition to the existing default-off behavior
