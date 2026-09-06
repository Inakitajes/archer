# worktree-location Specification

## Purpose

Defines how Convoy resolves and creates the directory for an isolated git worktree, so a project can declare where its worktrees live and every decision point falls back to a deterministic default.

## Requirements

### Requirement: Worktree location resolution order

Convoy SHALL resolve the directory for an isolated worktree from, in order: the repository's documented worktree convention, the configured `defaults.worktreeLocation`, and the built-in default. The first usable location SHALL be used; a declared or configured location that is not usable SHALL be skipped in favor of the next option.

#### Scenario: Repo convention wins over config

- **WHEN** the repository's documentation declares a worktree convention and `defaults.worktreeLocation` is also set
- **THEN** Convoy creates the worktree using the repository's documented convention

#### Scenario: Config wins over built-in default

- **WHEN** no repository convention is declared but `defaults.worktreeLocation` is set
- **THEN** Convoy creates the worktree using the configured template

#### Scenario: Unusable declared location falls back

- **WHEN** the documented or configured location cannot be created (missing, non-writable, or unsafe)
- **THEN** Convoy falls back to the next available option, ultimately the built-in default

### Requirement: Built-in default location

When no convention or configuration applies, Convoy SHALL create isolated worktrees under `~/.convoy/worktrees/<branch-slug>`, where `<branch-slug>` is a filesystem-safe form of the branch name.

#### Scenario: No convention or config

- **WHEN** the repository declares no worktree convention and `defaults.worktreeLocation` is unset
- **THEN** Convoy creates the worktree under `~/.convoy/worktrees/<branch-slug>`

### Requirement: Location templates with placeholders

A configured or documented worktree location SHALL support `{repo}` and `{branch}` placeholders. `{repo}` SHALL expand to the repository directory name, and `{branch}` SHALL expand to the filesystem-safe branch slug. A leading `~` in a location SHALL expand to the user's home directory.

#### Scenario: Location template expands placeholders

- **WHEN** the location is `~/dev/worktrees/{repo}/{branch}`, the repository directory is `calisteniapp`, and the branch slug is `feat-new-feature`
- **THEN** the resolved worktree directory is `~/dev/worktrees/calisteniapp/feat-new-feature`

#### Scenario: Location without `{branch}` still separates branches

- **WHEN** the configured or documented location has no `{branch}` placeholder (for example the fixed path `~/wt`)
- **THEN** Convoy appends the branch slug so each branch resolves to its own directory (`~/wt/<branch-slug>`)

### Requirement: Repository-documented convention

Convoy SHALL honor an explicit worktree-location convention declared in the repository's documentation (for example `AGENTS.md` or `README.md`) when that declaration is a recognized, machine-readable marker. Loose prose SHALL NOT be interpreted as a convention.

#### Scenario: Recognized marker in documentation

- **WHEN** `AGENTS.md` contains an explicit worktree-location marker with a valid template
- **THEN** Convoy uses that template to create the worktree

#### Scenario: No recognizable marker

- **WHEN** the documentation contains no explicit, recognized worktree-location marker
- **THEN** Convoy ignores the documentation and uses the configured or built-in default

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

### Requirement: Conventional branch naming preserved

Branch names proposed for worktrees SHALL remain conventional and semantic, prefixed with one of `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`. This change SHALL NOT alter branch-naming behavior.

#### Scenario: Branch naming unchanged

- **WHEN** Convoy proposes a branch for a new work
- **THEN** the branch is a conventional, prefixed, semantic name (unchanged by this change)
