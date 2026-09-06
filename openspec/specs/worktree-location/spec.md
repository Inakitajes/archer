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

All Convoy operations that reason about a worktree by its name SHALL resolve to the same path: creation, the collision check that appends `-2`, `-3`, … to avoid clobbering, the launcher preview shown before confirmation, and lookups that locate an existing worktree (via `git worktree list` when it is not at the built-in default). A path already considered taken for a branch SHALL never be handed to `git worktree add` again.

#### Scenario: Suffix avoids collision at a declared location

- **WHEN** a worktree already exists at the resolved location for a branch
- **THEN** Convoy uses a suffixed branch and location (`-2`, `-3`, …) so no collision occurs

#### Scenario: Close and continue locate a non-default worktree

- **WHEN** a lifecycle action such as close or continue targets a worktree that is not at the built-in default location
- **THEN** Convoy locates the worktree from the repository's worktree list (or the feature's verified association) rather than assuming a fixed path

### Requirement: Conventional branch naming preserved

Branch names proposed for worktrees SHALL remain conventional and semantic, prefixed with one of `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `build`, `ci`. This change SHALL NOT alter branch-naming behavior.

#### Scenario: Branch naming unchanged

- **WHEN** Convoy proposes a branch for a new work
- **THEN** the branch is a conventional, prefixed, semantic name (unchanged by this change)
