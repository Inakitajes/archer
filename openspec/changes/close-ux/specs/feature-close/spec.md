# feature-close Delta

## MODIFIED Requirements

### Requirement: Close squashes and merges into the base branch

After archiving, close SHALL collapse the run's commits into one conventional commit under the operator's identity using the same authorship-anchored walk `convoy finish` uses, then merge the feature branch into the base branch from the main checkout. The merge SHALL be performed only when the squash left a single clean commit; the operator's own commits on the branch (for example the proposal commit) SHALL survive the squash. The merge SHALL be allowed to land as a fast-forward when the base branch has not moved, and which merge shape ran SHALL be reported to the operator. Once the merge completes, pushing the base ref to its configured remote, removing the worktree, and deleting the feature branch SHALL each be offered as separate, deliberate actions and SHALL never happen automatically. Branch deletion SHALL remain unavailable while the branch is checked out in its worktree; worktree removal SHALL succeed before branch deletion becomes available. Headless mode SHALL print commands with the configured remote and base ref named explicitly and in a safe execution order. When the base branch has no configured upstream, push SHALL be unavailable with a concrete remediation and headless mode SHALL print no invalid push command.

#### Scenario: One conventional commit lands

- **WHEN** close completes through the merge
- **THEN** the base branch gains the squashed conventional commit plus any operator-authored commits, the canonical specs reflect the archived change, and the feature worktree still exists until the operator accepts its removal

#### Scenario: Fast-forward is narrated, not hidden

- **WHEN** the squash completes and the base branch has not moved since the branch forked
- **THEN** the merge lands as a fast-forward and the close surface reports that shape explicitly

#### Scenario: Cleanup respects git dependencies

- **WHEN** close completes while the feature branch is still checked out in its worktree
- **THEN** push and worktree removal are available, branch deletion stays unavailable until worktree removal succeeds, and no cleanup runs without confirmation

#### Scenario: Missing upstream disables push

- **WHEN** close completes and the base branch has no configured upstream
- **THEN** push is unavailable with setup remediation and the headless summary prints no push command

## ADDED Requirements

### Requirement: The squashed commit carries a composed conventional message

The squashed commit's message SHALL be composed, not templated from the branch name: a model-backed proposal seeded with the change's proposal document and the capability names from its delta specs, falling back deterministically when no model answers. Regardless of the writer's output, close SHALL normalize the scope to the single touched capability and SHALL omit it when the change touches zero or several capabilities. The subject SHALL be a readable imperative line derived from the change, not the change id slug; the deterministic fallback SHALL build it from a type-appropriate imperative verb plus the normalized proposal title. For composed messages, the change id SHALL be named in the body. An explicit `--message` override SHALL win verbatim and bypass composition.

#### Scenario: Writer proposal lands

- **WHEN** the commit writer answers for a change whose deltas touch one capability
- **THEN** the squashed subject is a readable imperative line, the scope is that capability, and the body names the change id

#### Scenario: Broad writer proposal loses its scope

- **WHEN** the writer proposes a scope for a change whose deltas touch several capabilities
- **THEN** close removes the scope before presenting the message and preserves the readable subject and change id body

#### Scenario: Deterministic fallback without a model

- **WHEN** no model is reachable when close composes the message
- **THEN** the fallback message still carries the branch prefix as type, the single touched capability as scope (omitted for zero- or multi-capability changes), an imperative subject built from a type-appropriate verb and the normalized proposal title, and the change id in the body

#### Scenario: Explicit override wins

- **WHEN** close runs with an explicit message override
- **THEN** the squashed commit uses it verbatim and no composition runs

### Requirement: Close shows its progress as a checklist

When running interactively, close SHALL render a live checklist of the sequence — preflight rendered as one line, then sync, archive, squash, and merge — with each step's completion, skip (with reason), or failure visible as it happens. The squash step SHALL present the composed message for confirmation or editing before the commit lands. A mid-sequence stop SHALL leave the checklist visible with the failed step and its remediation; resuming SHALL show previously completed steps already checked. When not running interactively, close SHALL print the same operational facts as a stdout summary without attempting any interactive offers.

#### Scenario: Checklist completes in a terminal

- **WHEN** close runs to completion in a TTY
- **THEN** each step is visible as completed or skipped-with-reason, the merge shape is narrated, and the follow-up offers appear on the completed checklist

#### Scenario: The message is confirmed before landing

- **WHEN** the squash step reaches the composed message in a TTY
- **THEN** the operator can accept it as-is or edit it, and the commit lands only after that choice

#### Scenario: A stop keeps the state readable

- **WHEN** a step fails mid-sequence in a TTY
- **THEN** the checklist stays visible with the failed step marked and its remediation shown, and a later resume shows the completed steps already checked

#### Scenario: Headless cleanup commands are executable

- **WHEN** close runs without a TTY
- **THEN** the outcome is printed as a stdout summary, the push command names the configured remote and base ref explicitly, worktree removal is printed before branch deletion, and nothing interactive is attempted
