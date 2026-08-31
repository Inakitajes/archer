## ADDED Requirements

### Requirement: Worktree-backed changes read their artifacts from the worktree

When the control board resolves an active change to a feature worktree, the specs view SHALL load that change's artifact inventory and title from that worktree's `openspec/changes/<id>/` tree, and every artifact file it lists SHALL be addressed by an absolute path so the reading pane loads it regardless of the working directory `convoy specs` was launched from. This resolution SHALL take precedence over any directory for the same change id in the launch checkout's `openspec/changes/` — including a stale, partial, or empty skeleton left behind there — mirroring the precedence the control board already applies to feature rows over same-id rows stranded on the base checkout. Changes the board does not resolve to a worktree SHALL keep loading from the launch checkout unchanged, and the operator SHALL NOT be required to relaunch the browser from another checkout, switch checkouts, or take any extra action to read such a change's artifacts.

#### Scenario: Stale skeleton on the launch checkout

- **WHEN** `convoy specs` opens in a checkout whose `openspec/changes/` holds a change directory with no markdown files, while the board resolves that change to a feature worktree carrying its full artifact set
- **THEN** the change lists with the worktree's artifacts and title, and entering it renders those artifacts in the reading pane instead of reporting that no markdown artifacts were found

#### Scenario: Reading works from any launch directory

- **WHEN** a worktree-backed change is listed and the browser's process working directory is not the worktree that carries the change's files
- **THEN** the artifact paths resolve into the worktree and every tab renders its file's content without read placeholders

#### Scenario: Diverging copies resolve to the worktree

- **WHEN** both the launch checkout and the feature worktree carry files for the same change id and the board resolves the change to the worktree
- **THEN** the worktree's copy supplies the artifact inventory and the row title

#### Scenario: Changes without a worktree are unchanged

- **WHEN** an active change is not resolved to any feature worktree
- **THEN** its artifacts and title load from the launch checkout's `openspec/changes/` exactly as before this resolution existed
