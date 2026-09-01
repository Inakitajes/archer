# control-board Delta

## ADDED Requirements

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
