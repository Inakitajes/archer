## Purpose

Track a unit of implementation through explicit repository-scoped identity and independently verified lifecycle evidence, so branch names, artifact copies, archive operations, and checkout cleanup do not redefine or erase the operator's work.

## ADDED Requirements

### Requirement: Features have stable repository-scoped identities

Convoy SHALL assign a stable identity to each registered feature and persist its explicit change-contract set, intended local base, current implementation-context association, historical run links, and close-attempt references independently of branch names and worktree paths. Worktrees sharing a Git common directory SHALL share the records. A feature SHALL have one current implementation context; multiple changes in that context SHALL be an explicitly reviewed contract set, not separate independently closable slices of the same branch. A context SHALL NOT be silently claimed by two features. New incarnations of a completed feature SHALL receive new identities even when a branch name or change slug is reused. No-spec runs SHALL remain supported without creating a fictitious OpenSpec change.

#### Scenario: Two checkouts inspect the same work
- **WHEN** Convoy opens in two worktrees of one repository
- **THEN** both resolve a registered feature to the same identity and contract set while observing current Git state independently

#### Scenario: A branch name is reused
- **WHEN** a new feature uses the former branch name of a completed feature
- **THEN** the new feature has a different identity and does not inherit the old feature's runs or landing authority

#### Scenario: Several contracts share a branch
- **WHEN** an operator accepts one implementation context with two selected changes
- **THEN** one feature records both contracts and close assesses the entire feature rather than offering two partial branch landings

### Requirement: Associations express explicit intent rather than naming heuristics

Successful spin and accepted feature-backed launch SHALL persist the operator-approved association before any run executes. Convoy SHALL offer explicit adoption of existing work and explicit rebinding of an existing feature to a verified context, without requiring branch renaming. Association SHALL validate repository membership, actual checked-out branch, worktree registration, intended base, and the selected active or archived artifacts. Any Git-valid existing branch name SHALL be supported. Adoption SHALL NOT mark tasks, archives, or integration complete. Branch spelling, a sole active directory, matching commit tips, and worktree enumeration order SHALL be suggestions only and MUST NOT independently authorize lifecycle mutation. Browsing, preparing a launch, or cancelling selection SHALL NOT create an association.

#### Scenario: An arbitrary branch is adopted
- **WHEN** the operator explicitly associates change `add-widget` with registered worktree branch `team/alice/release-42` and base `main`
- **THEN** Convoy records the association without renaming the branch and resolves subsequent lifecycle actions through the feature identity

#### Scenario: A copied change is discovered
- **WHEN** an unrelated worktree inherits a completed change directory by merging its base
- **THEN** the copy supplies discovery evidence but does not change the feature's association or enable closing that unrelated branch

#### Scenario: Conflicting context selection
- **WHEN** adoption or rebinding names a branch different from the checkout's actual branch, another repository, or a context already assigned to another feature
- **THEN** the operation refuses without running or closing work and explains the conflicting identities

### Requirement: One resolver supplies all lifecycle action targets

Board, launcher, continue, publication, and close SHALL resolve a selected feature using the same association rules. Explicit selectors SHALL be cross-checked rather than silently overriding contradictory selectors. Resolution SHALL distinguish verified, unassociated, ambiguous, missing, and unreadable contexts and expose the evidence and remediation. Existing branch/change selectors SHALL remain accepted for lookup; unresolved headless requests SHALL exit non-zero with an explicit adoption or rebinding command rather than guessing. A rename or moved worktree SHALL retain the historical feature record; verified rebinding SHALL update current attributes without rewriting historical run boundaries. Rebinding SHALL NOT run while a live run or unreconciled mutation makes the transition unsafe.

#### Scenario: Branch rename is not a new feature
- **WHEN** a feature's branch is renamed outside Convoy
- **THEN** its record and history remain visible, and an unverified association offers rebinding instead of becoming another feature or silently authorizing mutation

#### Scenario: A run and close select the same work
- **WHEN** a feature is selected for a run and later for close from another checkout
- **THEN** both resolve the same feature, contracts, base, and verified implementation context regardless of branch naming convention

#### Scenario: An explicit selector is mistyped
- **WHEN** a close request includes a change selector that conflicts with the selected feature's contracts
- **THEN** Convoy refuses with a selector diagnostic before checking or modifying another change

### Requirement: Lifecycle facts remain orthogonal and evidence-based

Assessment SHALL distinguish association validity; artifact state per contract as active, verified-archived, missing, ambiguous, or unreadable; task completion; execution/liveness; local integration as pending, probable, verified, stale, or unknown; remote publication observations; and cleanup progress. Task completion SHALL NOT imply successful validation or close eligibility. Archive SHALL NOT imply integration. Local landing or push SHALL NOT imply hosted PR merge. Missing files, inaccessible Git/run records, and malformed lifecycle evidence SHALL NOT be converted into completed facts. A human-readable summary SHALL be derived from those facts rather than persisted as authoritative status.

#### Scenario: Archived implementation is not integrated
- **WHEN** a feature's contracts have verified archive evidence but no verified integration
- **THEN** its summary retains pending integration and permits reviewing close prerequisites instead of describing the feature as finished

#### Scenario: State cannot be read
- **WHEN** required run-state or Git evidence is unreadable
- **THEN** relevant capabilities report unknown evidence and a concrete blocker rather than assuming no live runs or a clean tree

### Requirement: Shared action capabilities explain eligibility and revalidate execution

Every lifecycle assessment SHALL supply applicable actions with availability, concrete blocker reasons, remediation, target identity/context, and evidence freshness. UI labels, menus, keyboard handlers, and CLI decisions SHALL consume the same eligibility rules. “Ready to close” SHALL only describe a verified association whose current close-start prerequisites pass; complete tasks alone SHALL be described as implementation complete. Reviewing close prerequisites SHALL remain discoverable when integration is pending, even when executing close is blocked. Each mutation SHALL freshly revalidate association revision, repository, branch/HEAD, worktree, base, and required evidence, refusing changed targets instead of switching automatically.

#### Scenario: Complete tasks with a live run
- **WHEN** all tasks are checked but a run is still live
- **THEN** Convoy does not label the feature ready to close and its close review explains the live-run blocker

#### Scenario: The target changes after review
- **WHEN** a branch or association changes after the operator reviewed an action
- **THEN** executing the action refuses the stale target and requests refreshed review without mutating the replacement context

### Requirement: Discovery survives archive and cleanup without inventing ownership

Read-only discovery SHALL combine registered features, active contract candidates, associated archive/evidence references, legacy run/close evidence, and actual Git worktrees. Registered unfinished features SHALL remain discoverable after archive or worktree removal. Completed features SHALL remain accessible in history without requiring obsolete worktrees. Artifact copies SHALL be represented as sources rather than competing owners. A missing associated source SHALL NOT silently fall back to a same-slug foreign copy. Discovery and history inspection SHALL NOT create, migrate, or repair records as a side effect.

#### Scenario: Worktree disappears before integration
- **WHEN** an unfinished feature's worktree is deleted outside Convoy
- **THEN** the feature remains visible with its history and missing-context remediation, without claiming that the old path still exists

#### Scenario: Reopening completed history
- **WHEN** a feature has been integrated and cleaned up
- **THEN** its contracts, runs, and landing evidence remain inspectable in history without replaying close

### Requirement: Legacy evidence is adopted conservatively

Existing names, runs, and close journals SHALL remain readable as legacy evidence with provenance and uncertainty disclosed. Import SHALL require explicit adoption, validate stored identity fields and repository membership, preserve original evidence, and reject ambiguous or mismatched records. A branch-derived journal filename SHALL NOT establish identity. Imported run associations SHALL NOT manufacture run-start rewrite authority; imported landing evidence SHALL retain exact-tip and reachable-landing checks. Corrupt, unsupported-version, or colliding records SHALL produce repair guidance rather than silent reassignment. Loss of local registry state SHALL yield adoption/recovery, not invented success.

#### Scenario: Two legacy names collide
- **WHEN** legacy journal naming maps two branch spellings to one filename
- **THEN** adoption checks embedded identity and evidence, rejects a conflicting association, and does not reuse a foreign landing receipt

#### Scenario: Legacy run has no durable feature ID
- **WHEN** a legacy run is displayed after its checkout path was reused
- **THEN** it retains historical evidence and remains unassociated unless explicitly verified, rather than being attributed to the feature now at that path

#### Scenario: Completed legacy work is recovered without a worktree
- **WHEN** an operator explicitly recovers a completed feature from legacy landing evidence whose worktree no longer exists
- **THEN** Convoy creates a stable feature record from that evidence, grants only receipt-verified cleanup/follow-up eligibility, and does not grant new execution authority or require the historical path to exist

### Requirement: Contract sets and new incarnations have explicit reviewed transitions

Adding, removing, or reordering a live feature's contract set SHALL be an explicit reviewed association revision. The review SHALL show the complete proposed set, selected sources, and intended base; a revision SHALL be refused during a live run or unresolved close attempt. Completing a feature SHALL release its context claim so a new feature may reuse the same branch or worktree, but reuse SHALL require an explicit new-work decision that creates a new identity and does not reopen the old receipt. A retained completed context SHALL NOT silently accept another implementation run or lifecycle mutation without that decision.

#### Scenario: A second contract is added
- **WHEN** an operator explicitly revises a live feature to include a second change and accepts it while no run is live
- **THEN** the feature records the complete reviewed contract set and close assesses the whole branch

#### Scenario: New work begins on a completed context
- **WHEN** the operator explicitly starts new work on a retained branch/worktree after a completed feature
- **THEN** a new feature identity is created without inheriting the completed feature's runs or landing authority

#### Scenario: Contract revision is blocked while running
- **WHEN** an operator attempts to revise a live feature's contract set while a run is live or a close attempt is unresolved
- **THEN** the revision is refused until the run completes or the attempt is reconciled

### Requirement: Recovery reconciles interrupted work after a context moves

A pending close attempt whose context moves, is renamed, or loses its worktree SHALL remain a distinct unresolved attempt. Verified rebinding of the feature SHALL be permitted as explicit recovery even while that attempt is pending, provided no other live or unreconciled mutation conflicts; it SHALL update current attributes and invalidate stale attempt targets rather than silently replaying them. New work or a resumed attempt SHALL be a new attempt with fresh revalidation and an explicit decision; old evidence SHALL be preserved, never treated as authority over the moved context.

#### Scenario: Context moves after archive preparation
- **WHEN** an interrupted close attempt prepared an archive but the feature's worktree then moved to a new path
- **THEN** the operator can explicitly rebind the feature, the stale attempt target is marked invalid, and recovery offers a fresh revalidated attempt while preserving the archive evidence

#### Scenario: Rename does not require restoring the old name
- **WHEN** a feature's branch is renamed between an interrupted close and resume
- **THEN** explicit rebinding allows resume without recreating the old branch or path, and no stale target is reused for mutation

### Requirement: Lifecycle records preserve safety across concurrent updates

Feature associations and close evidence SHALL be versioned, validated, and written atomically with conflict detection. An inability to persist required intent or recovery evidence SHALL block the corresponding mutation. Close attempts SHALL have distinct identities; completed landing receipts SHALL not be overwritten by a later attempt or no-change result. Concurrent Convoy operations SHALL serialize conflicting repository mutations; external changes SHALL be detected through current Git evidence and guarded ref updates. Ordinary cleanup SHALL NOT delete feature/run recovery evidence.

#### Scenario: Concurrent association edits
- **WHEN** two sessions attempt to change the same association from the same prior version
- **THEN** only one update succeeds and the other requests refreshed inspection instead of overwriting it

#### Scenario: Storage fails before landing
- **WHEN** required candidate or recovery evidence cannot be persisted
- **THEN** no landing occurs and the operator receives a recoverable error
