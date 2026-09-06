# control-board Specification

## Purpose
One inferred surface — `convoy specs` — where every feature's stage is derived live from git, OpenSpec, run plans, and the repository-scoped feature registry, with the actions that move it along; registered features and explicit associations provide stable identity, while worktrees, branches, tasks, and run liveness stay derived from fresh evidence with one shared change resolver.

## Requirements

### Requirement: Control command is the single inferred board

`convoy specs` SHALL present the board, retaining `convoy control` as a compatibility alias, and use the shared feature resolver and lifecycle assessment. It SHALL persist explicit identity and associations but derive current worktrees, branches, task completion, run liveness, and integration eligibility from fresh evidence. Read-only OpenSpec task queries SHALL be permitted with filesystem fallback when the CLI is unavailable; unreadable evidence SHALL remain unknown. Historical run linkage SHALL use durable feature identity and frozen provenance, not the branch currently checked out at an old run path. Browsing SHALL NOT write the registry. The board SHALL distinguish unresolved legacy candidates from registered features.

#### Scenario: Deleting the worktree updates the board

- **WHEN** a feature's worktree is removed outside Convoy and the board is reopened
- **THEN** the feature remains visible without claiming a worktree and offers missing-context or remaining-cleanup guidance as appropriate

#### Scenario: One resolver everywhere

- **WHEN** a branch with any valid name is explicitly associated with a change
- **THEN** board and run selection use that association and show the same verified implementation context

### Requirement: Active change rows derive their lifecycle state

Each active change row SHALL show its derived stage and signals: tasks completed of total, linked runs (count and liveness), whether the proposal sits uncommitted, whether the feature branch contains the base branch's tip (synced), and merged-ness reported as probably merged at most. Rows SHALL render for changes on the base checkout (stranded), changes inside their worktrees (proposing, implementing when runs are linked), and completed-but-unarchived changes (ready to close, or probably merged).

#### Scenario: Implementing feature

- **WHEN** a change in a worktree has two runs recorded against its branch, one live
- **THEN** its row shows implementing with two runs and the live one marked

#### Scenario: Stranded change on main

- **WHEN** a change exists uncommitted on the base checkout with no worktree
- **THEN** its row shows stranded on main and offers spin out

### Requirement: Worktrees without spec get their own section

The board SHALL include a section listing worktrees that carry runs but no OpenSpec change, each linking to the runs browser for that branch. The section SHALL be a peer of the active-changes and canonical-specs sections, not a footnote. Empty peer sections SHALL be omitted entirely, including their titles. A non-empty worktrees-without-spec section SHALL make the interactive board non-empty even when no active changes or canonical specs exist.

#### Scenario: Plain isolated run appears

- **WHEN** an isolated run's worktree exists with no change directory
- **THEN** it is listed in the worktrees-without-spec section with its branch and run count

#### Scenario: Worktree-only board remains interactive

- **WHEN** worktrees carrying runs exist but there are no active changes or canonical specs
- **THEN** the interactive board opens with only Worktrees without spec, omitting the Active Changes and Canonical Specs titles

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

### Requirement: Change rows resolve to the owning worktree

When several feature worktrees list the same change id in their `openspec/changes/`, the board SHALL resolve the row's checkout by precedence rather than by first-listed worktree: the worktree whose branch matches the change id under the shared branch↔change resolver rule SHALL win over every other copy; among the remaining candidates, a copy carrying change markdown SHALL outrank a husk directory with none; remaining ties SHALL keep stable worktree-list order. Every derived fact of the row — branch, task counts, title, uncommitted-proposal marker — SHALL come from the resolved checkout, so stage derivation describes the copy that actually owns the change. Resolution SHALL never drop a row: when no candidate carries markdown and no branch matches, the row SHALL render from the first-listed candidate exactly as it does today.

#### Scenario: A husk in an earlier worktree cannot steal the row

- **WHEN** an unrelated feature worktree that `git worktree list` reports earlier contains only a husk directory for the id (no markdown inside), while the worktree whose branch matches the id carries the change with all tasks complete and runs recorded against that branch
- **THEN** the row resolves to the branch-matching worktree and shows its branch, its complete task counts, and the ready-to-close stage — leaving close and continue available

#### Scenario: Branch match outranks a fuller foreign copy

- **WHEN** two feature worktrees both carry markdown for the same change id but only one worktree's branch matches the id
- **THEN** the branch-matching worktree supplies the row, even when the other copy lists more files

#### Scenario: Husk-only candidates keep the row present

- **WHEN** every worktree listing the change id carries only husk directories and no branch matches the id
- **THEN** the row still renders from the first-listed candidate with no branch and no task counts, degraded but never absent
