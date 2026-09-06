## MODIFIED Requirements

### Requirement: Create pull request is the only run-publication action

Run completion SHALL expose `Create pull request` in the command palette independently of compaction success, with no manual finish or standalone push action. Existing inspection and navigation actions SHALL remain. For feature-linked runs, publication SHALL use the shared assessment of the selected feature's currently verified associated branch, not the branch now occupying the historical run path. For no-spec runs, publication SHALL retain explicit verified run-context selection without requiring a fabricated feature contract. Selecting the action SHALL explicitly authorize a normal push to the disclosed repository/remote followed by PR creation; it MUST NOT publish automatically, force-push, delete branches, or remove worktrees. The action SHALL revalidate current identity, branch state, and unresolved recovery blockers immediately before publication rather than treating an old run's HEAD or a prior assessment as authority. A resulting run commit SHALL seed the PR title/body when applicable; otherwise the run summary and current branch context SHALL seed them. Missing GitHub CLI/authentication or unsafe/unresolved state SHALL disable publishing with actionable guidance. Headless output SHALL provide guidance only unless a separate explicit publication request exists. Publication SHALL NOT mark local integration, archive, or hosted PR merge complete.

#### Scenario: Deliberate PR creation
- **WHEN** the operator selects Create pull request on a safe verified feature branch
- **THEN** Convoy performs a normal push and creates the PR, displaying its URL without a separate push choice

#### Scenario: Push is rejected or PR already exists
- **WHEN** the normal push is rejected, or a matching open PR already exists
- **THEN** Convoy respectively stops before PR creation with no force-push fallback, or opens/reports the existing PR rather than creating a duplicate

#### Scenario: GitHub CLI is unavailable
- **WHEN** a completed run is viewed without a usable GitHub CLI
- **THEN** Create pull request is unavailable with setup/manual guidance while inspection remains usable

#### Scenario: Historical path has been reused
- **WHEN** an old run's former worktree path now belongs to another feature
- **THEN** publication resolves the old run's feature through its current verified association or explains why it is unavailable, and never pushes the replacement branch

## ADDED Requirements

### Requirement: Run history preserves feature identity independently of rewrite authority

New feature-backed runs SHALL retain stable repository/feature identity and their reviewed contract set in durable metadata and cleanup-surviving run records, alongside immutable run-start branch/path/commit provenance. Board, attach, and historical views SHALL join by that identity rather than reinterpret the current checkout at a stored path. Legacy records SHALL disclose missing association evidence until explicitly adopted. Rebinding a feature SHALL NOT rewrite the originating run boundary or grant permission to compact across a changed branch, independent commits, or missing evidence. Existing compaction eligibility, protected recovery history, signing/hooks, and publication-safety rules SHALL remain authoritative. Feature cleanup SHALL NOT remove run recovery evidence.

#### Scenario: Two runs and a renamed feature
- **WHEN** two runs finish for a feature and its context is later explicitly rebound after a branch rename
- **THEN** both runs remain linked to the feature, their original branch observations remain inspectable, and no automatic rewrite occurs during inspection or rebinding

#### Scenario: Association does not repair missing provenance
- **WHEN** a legacy run is adopted into a feature but lacks a trustworthy run-start boundary
- **THEN** the history link becomes available while automatic compaction still refuses to rewrite without the required provenance
