## ADDED Requirements

### Requirement: Successful spin registers an explicit feature association

Spin SHALL durably register a stable feature identity linking the selected change, resolved base, actual created branch, and registered worktree before reporting success. Conventional initial naming and documented worktree allocation SHALL remain unchanged; the name SHALL not become identity authority for subsequent operations. Spin SHALL continue to transfer proposal files without committing them or modifying OpenCode sessions. Record persistence failure SHALL prevent a success handoff and expose any created context and transferred files with recovery guidance, preserving operator work. Retrying or adopting that partial result SHALL not create a duplicate feature/context. Read-only preview and refusal before creation SHALL not persist a feature.

#### Scenario: Spin establishes ownership
- **WHEN** spin successfully creates a worktree for `add-widget`
- **THEN** its output identifies the stable feature, selected contract, actual branch/worktree, and existing `/move` handoff, and all repository worktrees resolve that same association

#### Scenario: Association persistence fails
- **WHEN** the worktree and proposal transfer succeed but association persistence fails
- **THEN** spin reports the partial operation and exact recovery context without claiming successful registration, committing files, or deleting the transferred proposal

#### Scenario: Rename after spin
- **WHEN** the operator renames a spun-out branch and explicitly rebinds its verified context
- **THEN** the original feature, contract, and history remain associated without requiring restoration of the conventional branch name
