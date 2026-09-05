# feature-close Specification

## Purpose
Close a feature in one orchestrated sequence — sync, archive, squash, merge, optional cleanup — so canonical specs are produced against a fresh base branch and no drift window or stale-change state can survive.

## Requirements

### Requirement: Close preflights before touching anything

`convoy close` SHALL refuse to start unless the feature worktree's tree is clean, the change's tasks are all complete, no live Convoy run is attached to the worktree's branch, and the main checkout is clean and on the intended local base branch. Repository identities and required Git state MUST be verifiable. Each blocker SHALL include concrete remediation. A published feature branch SHALL NOT block close merely because it is published; close SHALL disclose known remote tracking/publication context without asserting that a PR exists or has been merged. An upstream by itself SHALL NOT be described as proof of publication. Close MUST NOT force-push or automatically publish.

#### Scenario: Incomplete tasks stop the sequence

- **WHEN** close runs on a change with 8 of 11 tasks complete
- **THEN** nothing changes on any branch and the message names the missing task count

#### Scenario: Main checkout is unavailable for landing

- **WHEN** the main checkout is dirty or not on the intended local base branch
- **THEN** close stops before sync or archive with the concrete prerequisite rather than mutating the feature first

#### Scenario: Published feature closes normally

- **WHEN** a complete, clean feature branch has published commits and all other preconditions hold
- **THEN** close discloses the known remote context and proceeds without rewriting the published commits or requiring a force-push

### Requirement: Close syncs the base branch before archiving

Close SHALL merge the local base branch into the feature branch inside the feature worktree as its first repository mutation when synchronization is necessary. Sync SHALL NOT mean fetch or pull and MUST NOT move the base checkout. The fork relationship SHALL be derived from Git merge-base, without a configurable boundary or preserve-commits mode; unrelated or ambiguous bases SHALL be refused rather than guessed. Close SHALL capture the base revision used for sync and revalidate it before landing. A conflicting merge SHALL stop with the conflict state left for the operator to resolve and SHALL support `close --resume` without blindly repeating completed steps. If the base advances after sync or during review, close SHALL stop for renewed integration and validation rather than claiming the landing is necessarily conflict-free.

#### Scenario: Clean sync

- **WHEN** the local base has advanced and integration applies cleanly
- **THEN** the feature contains the captured local base tip before archive, while the base checkout and remote refs are not advanced by sync

#### Scenario: Conflicting sync pauses the sequence

- **WHEN** the sync merge conflicts
- **THEN** close stops with the conflict listed and resume after resolution continues from the first unmet prerequisite

#### Scenario: Base advances during message review

- **WHEN** the operator confirms a message after the base moved beyond the synchronized revision
- **THEN** close refuses that stale landing and requests resume with fresh integration and archive-result validation

### Requirement: Close archives through the OpenSpec CLI

Close SHALL archive the change by running the OpenSpec CLI's archive command inside the feature worktree — convoy never edits `openspec/` itself — and SHALL commit the archive result on the feature branch under the operator's identity. Archive failures SHALL abort the sequence before any squash or merge happens.

#### Scenario: Archive then commit

- **WHEN** the sync step completed cleanly
- **THEN** the OpenSpec CLI archives the change inside the worktree, the change directory moves to the archive layout, canonical specs gain the merged deltas, and the result is committed on the feature branch

### Requirement: Close always squash-lands the complete feature

After archiving, close SHALL land the entire feature-exclusive result as exactly one regular conventional commit under the operator's identity on the captured local base revision. The commit SHALL have one parent, that base revision, and SHALL include operator commits, previous run-compaction results, remaining intermediate run work, sync resolutions, and archive output as content rather than additional base-history commits. Commits already reachable from the base SHALL NOT be duplicated. Close MUST NOT squash-rewrite the feature branch, fast-forward the base to its tip, or create an additional merge commit. The existing feature history SHALL remain intact apart from additive sync/archive work. Empty aggregate changes SHALL produce an explicit no-change result, not an empty landing commit or an unsupported claim of prior landing.

The landing SHALL preserve operator signing, hooks, and secret-file protections and SHALL guard against stale branch/base/index/worktree state. A failure before landing MUST leave the base unadvanced; interrupted operations SHALL expose recovery evidence and MUST NOT discard unrelated work. Completed landing SHALL be recorded durably for resume and cleanup.

After a verified landing, pushing the base to its configured remote, removing the worktree, and deleting the local feature branch SHALL remain separate deliberate choices. Push MUST be normal, never forced. Cleanup SHALL require verified landing evidence tied to the exact current feature tip and a landing still contained in the base, rather than assuming squash-merged ancestry or relying only on tree equality. Worktree removal SHALL precede branch deletion and refuse dirty or changed worktrees. When launched inside the feature worktree, removal/deletion SHALL be deferred guidance with guarded commands in safe execution order, not runnable in-session actions. Headless guidance SHALL name the configured remote/base and preserve these guards. Missing base upstream SHALL disable push with concrete setup guidance. Remote feature branch deletion SHALL NOT be automatic.

#### Scenario: One conventional commit lands

- **WHEN** close completes for a branch containing an operator proposal, two automatically compacted runs, and archive output
- **THEN** the base gains exactly one regular commit with all resulting feature content, no individual proposal/run/archive commits are added to base history, and the feature worktree still exists

#### Scenario: Advanced base still receives one commit

- **WHEN** the base advanced since the fork and sync resolved integration before archive
- **THEN** close lands one commit on the synchronized base without an additional merge commit or duplicated base changes

#### Scenario: Uncompacted or operator-only feature

- **WHEN** a feature contains unsquashed machine commits or only operator-authored work
- **THEN** close includes the complete feature result without depending on a successful automatic run compaction

#### Scenario: Empty aggregate change

- **WHEN** the validated archived feature tree is identical to the captured base tree and no landing receipt exists
- **THEN** close reports no content to land, creates no empty commit, and does not offer destructive branch cleanup on that fact alone

#### Scenario: Cleanup respects git dependencies

- **WHEN** close has verified landing evidence, runs outside the unchanged feature worktree, and that worktree still exists
- **THEN** configured push and clean worktree removal are runnable, branch deletion remains unavailable until removal succeeds, and no cleanup runs without confirmation

#### Scenario: Cleanup is deferred inside the feature worktree

- **WHEN** close completes from inside the feature worktree
- **THEN** configured base push remains runnable and worktree/branch cleanup is presented as guarded continuation commands after leaving that directory

#### Scenario: Feature changes before cleanup

- **WHEN** the feature tip changes or the worktree becomes dirty after landing
- **THEN** cleanup refuses removal/deletion instead of applying an unconditional force-delete based on an old landing

#### Scenario: Missing upstream disables push

- **WHEN** close completes and the base has no configured upstream
- **THEN** push is unavailable with setup remediation and headless mode prints no invalid push command

### Requirement: Merged detection reports probability, not certainty

For a change whose branch content appears in the base only through inferred patch equivalence, the board and close SHALL report *probably merged*, never *merged*. A verified durable Convoy landing receipt naming the feature tip and a landing commit still reachable from the base SHALL establish a completed close even after the base subsequently advances. Resume MUST consult this evidence before performing new sync/archive work and MUST NOT create a second landing for the same closed tip. Equality of trees alone SHALL NOT establish a previous close or authorize forced branch deletion. When a change appears probably merged but remains unarchived, the board SHALL retain the deliberate archive-on-main remediation without performing sync or another feature landing. Close SHALL NOT claim that a hosted PR was merged merely because a local squash landing or base push succeeded.

#### Scenario: Squash-merged change shows honestly

- **WHEN** a feature was squash-merged externally without a Convoy receipt and remains unarchived
- **THEN** the board reports probably merged and offers archive on main rather than inventing a certain Convoy landing

#### Scenario: Direct close encounters probable external landing

- **WHEN** direct close detects patch-equivalence evidence suggesting an external landing but has no verified receipt
- **THEN** it stops before syncing or landing again and provides inspection or deliberate archive-on-main guidance instead of treating probability as permission for a duplicate landing

#### Scenario: Archive on main

- **WHEN** the operator accepts archive on main for that change
- **THEN** OpenSpec archives in the main checkout and the result is committed there without sync, squash, or feature merge

#### Scenario: Resume after base advances beyond a completed landing

- **WHEN** close is resumed for an unchanged feature tip whose recorded landing remains reachable from the now-advanced base
- **THEN** close reports the existing landing and offers only still-safe cleanup without resyncing or creating another commit

#### Scenario: Resume after worktree removal

- **WHEN** a verified close removed the feature worktree but branch cleanup was interrupted
- **THEN** resume resolves the recorded branch from the landing receipt without requiring a worktree, rechecks its tip and landing, and offers only remaining safe cleanup

### Requirement: The squashed commit carries a composed conventional message

The squash-merge commit's message SHALL be composed from the change's proposal, capability names, all feature-exclusive commit subjects, and the aggregate feature change against the captured base, with deterministic fallback when the writer cannot provide a usable proposal. Close SHALL preserve this context across archive and resume so a retry does not degrade into an archive-only description. Regardless of writer output, composed messages SHALL use the single touched capability as scope and omit scope when zero or several capabilities are touched. The subject SHALL be a readable imperative line derived from the change, not the change ID slug; the fallback SHALL use a type-appropriate verb and normalized proposal title. Composed messages SHALL name the change ID in the body. An explicit `--message` SHALL win verbatim and bypass composition and message review.

#### Scenario: Writer proposal lands

- **WHEN** the writer answers for a change touching one capability
- **THEN** the composed subject is readable and imperative, the scope is that capability, and the body names the change ID

#### Scenario: Broad writer proposal loses its scope

- **WHEN** the writer proposes a scope for a change touching several capabilities
- **THEN** close removes the scope while preserving the readable subject and change ID body

#### Scenario: Deterministic fallback without a model

- **WHEN** no writer is available
- **THEN** close derives the branch type, appropriate capability scope, readable imperative subject, and change ID body without preventing message review

#### Scenario: Explicit override wins

- **WHEN** close runs with an explicit message override
- **THEN** that exact message is used without composition or message confirmation

#### Scenario: Resume after archiving

- **WHEN** the operator resumes after archive and a cancelled message review
- **THEN** the writer still receives the preserved proposal and complete feature context rather than only the archive commit

### Requirement: Close shows its progress as a checklist

Interactive close SHALL retain its full-screen TUI with preflight as a one-line summary followed by sync, archive, and squash-merge rows. Every row SHALL report completion, skip with reason, or failure. Squash-merge SHALL distinguish composing the message, awaiting review, and creating the landing commit, with a changing running indicator during asynchronous work. The result SHALL name the base and landing SHA and report one feature landing, not a fast-forward or merge-commit shape. The message review SHALL retain a vertical Accept/Edit/Cancel selector, Up/Down navigation, direct shortcuts, and inline multiline editing: saving returns to review without acceptance, cancelling preserves the reviewed value, and no landing happens until acceptance except with explicit `--message` or the existing headless acceptance policy. Failed operations SHALL remain readable until dismissed. Resume SHALL show verified completed steps without replaying them. Optional cleanup SHALL remain in the same interface with retries and deferred prerequisites as guidance. Headless mode SHALL print the same operational facts and guarded continuation commands without interactive offers.

#### Scenario: Checklist completes in a terminal

- **WHEN** close succeeds in a TTY
- **THEN** sync, archive, and squash-merge states stay visible, the base and landing commit are reported, and safe optional cleanup appears in the same interface

#### Scenario: Message composition remains visibly live

- **WHEN** the writer takes time without emitting intermediate events
- **THEN** the squash-merge row names composition and continues animating until the operation advances

#### Scenario: Review choices follow their visual direction

- **WHEN** Accept, Edit, and Cancel appear vertically
- **THEN** Up/Down moves selection, Enter activates it, and the direct shortcuts remain available

#### Scenario: The message is confirmed before landing

- **WHEN** interactive close reaches message review without an explicit override
- **THEN** the operator can accept, edit, or cancel before anything lands on the base

#### Scenario: The message is edited and confirmed inside the TUI

- **WHEN** the operator saves a multiline edit
- **THEN** close returns to review without opening an external editor or landing until the edited message is accepted

#### Scenario: Cancelling an inline edit preserves the reviewed message

- **WHEN** the operator cancels an inline draft
- **THEN** the prior reviewed message is restored and no landing happens

#### Scenario: A stop keeps the state readable

- **WHEN** a step fails
- **THEN** the TUI retains the failed row and remediation until dismissed, and resume reconstructs verified completed work

#### Scenario: Headless cleanup commands are executable

- **WHEN** close completes without a TTY
- **THEN** output names the remote and base explicitly, orders worktree removal before branch deletion, and includes landing/tip guards rather than an unconditional branch force-delete
