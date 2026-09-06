## MODIFIED Requirements

### Requirement: Consistent path across decision points

New-worktree creation, collision handling, and launcher preview SHALL use the same documented/configured/default location allocation. A path already considered taken SHALL never be handed to `git worktree add` again. Existing feature contexts SHALL instead be located through verified associations and the current repository's Git worktree inventory, never by reconstructing ownership from branch-derived directory names. A moved context SHALL require verified rebinding when its association is stale. Rebinding SHALL not rename or recreate the directory merely to match current branch spelling. Branch slug templates SHALL remain allocation/display conventions.

#### Scenario: Suffix avoids collision at a declared location
- **WHEN** the launcher's worktree allocation finds the resolved branch location occupied
- **THEN** its existing suffix policy selects a non-colliding branch/location consistently in preview and creation, and any resulting feature association records the actual result
#### Scenario: Finish locates a non-default worktree

- **WHEN** a lifecycle action such as close or continue targets a feature associated with a worktree outside the built-in default location
- **THEN** Convoy validates that context against Git's worktree inventory instead of assuming a branch-derived path

#### Scenario: Close and continue locate a non-default worktree

- **WHEN** close or continue resolves a feature whose verified association points at a worktree outside the built-in default location
- **THEN** Convoy locates the worktree from the repository's worktree list (or the feature's verified association) rather than reconstructing a fixed path

#### Scenario: Worktree moves outside Convoy
- **WHEN** Git reports a feature's worktree at a new path
- **THEN** the feature remains visible, verified rebinding updates its current location, and old run paths remain historical observations rather than current mutation targets
