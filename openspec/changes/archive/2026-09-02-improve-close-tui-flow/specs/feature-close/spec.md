## MODIFIED Requirements

### Requirement: Close squashes and merges into the base branch

After archiving, close SHALL collapse the run's commits into one conventional commit under the operator's identity using the same authorship-anchored walk `convoy finish` uses, then merge the feature branch into the base branch from the main checkout. The merge SHALL be performed only when the squash left a single clean commit; the operator's own commits on the branch (for example the proposal commit) SHALL survive the squash. The merge SHALL be allowed to land as a fast-forward when the base branch has not moved, and which merge shape ran SHALL be reported to the operator. Once the merge completes, pushing the base ref to its configured remote, removing the worktree, and deleting the feature branch SHALL remain deliberate and SHALL never happen automatically. Cleanup that is safe from the process's current location SHALL be offered as an action. When close was launched from inside the feature worktree, worktree removal and branch deletion SHALL instead be identified as deferred cleanup, with the current shell location named as the blocker and exact continuation commands shown in safe execution order; they SHALL NOT appear as actions that could become runnable in that session. When close runs outside the feature worktree, worktree removal SHALL be runnable and SHALL succeed before branch deletion becomes available. Headless mode SHALL print commands with the configured remote and base ref named explicitly and in a safe execution order. When the base branch has no configured upstream, push SHALL be unavailable with a concrete remediation and headless mode SHALL print no invalid push command.

#### Scenario: One conventional commit lands

- **WHEN** close completes through the merge
- **THEN** the base branch gains the squashed conventional commit plus any operator-authored commits, the canonical specs reflect the archived change, and the feature worktree still exists until the operator deliberately cleans it up

#### Scenario: Fast-forward is narrated, not hidden

- **WHEN** the squash completes and the base branch has not moved since the branch forked
- **THEN** the merge lands as a fast-forward and the close surface reports that shape explicitly

#### Scenario: Cleanup respects git dependencies

- **WHEN** close completes while its process is outside the target feature worktree and that worktree still exists
- **THEN** configured push and worktree removal are runnable, branch deletion stays unavailable until worktree removal succeeds, and no cleanup runs without confirmation

#### Scenario: Cleanup is deferred inside the feature worktree

- **WHEN** close completes after being launched from inside the target feature worktree
- **THEN** configured push remains runnable, worktree and branch cleanup are presented as steps to perform after leaving that worktree rather than as unavailable actions, and their exact commands appear in dependency order with the shell location named as the reason

#### Scenario: Missing upstream disables push

- **WHEN** close completes and the base branch has no configured upstream
- **THEN** push is unavailable with setup remediation and the headless summary prints no invalid push command

### Requirement: Close shows its progress as a checklist

When running interactively, close SHALL render the whole sequence in a real full-screen TUI — not line-oriented terminal output redrawn with cursor-control bytes. The TUI SHALL show preflight as one line, then sync, archive, squash, and merge, with each step's completion, skip (with reason), or failure visible as it happens. A running indicator SHALL continue changing while asynchronous work is in progress, including periods with no new operation event. The squash row SHALL distinguish composing the commit message, waiting for message review, and creating the squashed commit rather than presenting those phases as an undifferentiated or frozen squash. The composed message SHALL be presented inside the TUI with a vertically navigable Accept, Edit, and Cancel selector plus direct shortcuts. Edit SHALL open an inline multiline field initialized with the complete proposed message; saving an edit SHALL return to review without accepting it, cancelling an edit SHALL preserve the previously reviewed message, and the commit SHALL land only after explicit acceptance. After a successful merge, current-session cleanup actions SHALL remain in the TUI, external cleanup prerequisites SHALL be presented as guidance rather than runnable choices, and failed actions SHALL be retryable. A mid-sequence stop SHALL keep the TUI open with the failed step and its remediation until the operator dismisses it; resuming SHALL show previously completed steps already checked. When not running interactively, close SHALL print the same operational facts as a stdout summary without attempting any interactive offers.

#### Scenario: Checklist completes in a terminal

- **WHEN** close runs to completion in a TTY
- **THEN** each step is visible as completed or skipped-with-reason, the merge shape is narrated, and current-session follow-up actions appear in that same interface

#### Scenario: Message composition remains visibly live

- **WHEN** the commit-message writer takes time to answer without emitting intermediate events
- **THEN** the squash row names message composition as the current work and its running indicator continues to animate until the flow advances

#### Scenario: Review choices follow their visual direction

- **WHEN** the Accept, Edit, and Cancel choices are shown as a vertical list
- **THEN** Up and Down move the selected choice, Enter activates it, and the direct accept, edit, and cancel shortcuts remain available

#### Scenario: The message is confirmed before landing

- **WHEN** the squash step reaches the composed message in a TTY
- **THEN** the TUI lets the operator accept it as-is, edit it inline, or cancel, and the commit lands only after acceptance

#### Scenario: The message is edited and confirmed inside the TUI

- **WHEN** the operator chooses Edit, modifies the subject or multiline body, and saves
- **THEN** the TUI returns to message review with the edited message, no external editor opens, and the edited message lands only after the operator chooses Accept

#### Scenario: Cancelling an inline edit preserves the reviewed message

- **WHEN** the operator changes the inline draft and cancels the edit
- **THEN** the TUI returns to review with the message that existed before the edit and nothing lands

#### Scenario: A stop keeps the state readable

- **WHEN** a step fails mid-sequence in a TTY
- **THEN** the checklist stays visible with the failed step marked and its remediation shown, and a later resume shows the completed steps already checked

#### Scenario: Headless cleanup commands are executable

- **WHEN** close runs without a TTY
- **THEN** the outcome is printed as a stdout summary, the push command names the configured remote and base ref explicitly, worktree removal is printed before branch deletion, and nothing interactive is attempted
