# step-commit-messages Specification

## Purpose
Make every Convoy-created intermediate commit traceable to its originating run and readable as a concise account of the repository changes made by that step.

## Requirements

### Requirement: Every intermediate commit identifies its run
Convoy SHALL append exactly one machine-readable `Convoy-Run: <run-id>` Git trailer containing the complete originating run ID to every intermediate commit it creates. This SHALL cover normal writable agent phases, accepted interrupted-phase recovery, and each committed human OpenCode iteration. Convoy, rather than agent-supplied content, MUST determine the trailer value.

#### Scenario: Normal writable phase is linked
- **WHEN** a writable agent phase leaves repository changes and Convoy commits them
- **THEN** the commit contains exactly one `Convoy-Run` trailer whose value equals the active workspace run ID

#### Scenario: Recovered phase is linked
- **WHEN** an operator accepts recovery of uncommitted changes from an interrupted writable phase
- **THEN** the recovery commit contains the run ID of the resumed workspace as its `Convoy-Run` trailer

#### Scenario: Human iteration is linked
- **WHEN** a human OpenCode iteration leaves changes that Convoy commits
- **THEN** that iteration commit contains the active workspace run ID as its `Convoy-Run` trailer

#### Scenario: A step leaves no changes
- **WHEN** a writable phase or human iteration leaves no staged repository changes
- **THEN** Convoy creates no empty commit merely to record the run trailer

### Requirement: Step subjects describe repository outcomes
Every Convoy-created intermediate commit SHALL retain the recognizable `convoy(<step>): <summary>` subject shape and `convoy@local` identity. The summary SHALL describe the repository outcome rather than only naming the role, phase, report, or process. The complete subject line, including the prefix, MUST be no longer than 72 characters and MUST be a sanitized single line; shortening SHALL avoid leaving a partial final word when a word boundary is available.

#### Scenario: Structured semantic subject is available
- **WHEN** a writable phase supplies the semantic subject `preserve report sessions across human gates`
- **THEN** its commit subject is `convoy(<step>): preserve report sessions across human gates`, subject to the complete-line length limit

#### Scenario: Report heading is only a generic label
- **WHEN** the only report heading is a role-only or report-only label such as `Implementer report` or `Test report`
- **THEN** Convoy does not use that label unchanged as the commit summary and instead applies its fallback composition rules

#### Scenario: Proposed subject exceeds the limit
- **WHEN** the prefix and proposed summary would exceed 72 characters
- **THEN** Convoy safely shortens the summary so the complete subject is at most 72 characters without cutting through a word when a usable earlier boundary exists

#### Scenario: Proposed subject contains unsafe formatting
- **WHEN** proposed commit text contains line breaks, terminal control bytes, Markdown heading markers, or repeated whitespace
- **THEN** Convoy removes control bytes and heading markers and collapses the subject to one normalized line before committing or displaying it

### Requirement: Writable phases can supply structured commit descriptions
The phase-report interface SHALL allow a writable agent to submit an optional commit description separately from its complete Markdown report. A commit description SHALL contain one subject and zero to three concrete detail lines. Convoy MUST validate this data at the report boundary, MUST preserve accepted data long enough to survive interruption before the commit, and SHALL use it in preference to inference from free-form Markdown.

#### Scenario: Structured description is accepted
- **WHEN** a writable phase submits a valid subject and two concrete detail lines with a valid Markdown report
- **THEN** Convoy accepts the report, uses the subject for the commit summary, and renders the two details in the commit body

#### Scenario: Structured description is absent
- **WHEN** a writable phase submits a valid Markdown report without structured commit data
- **THEN** Convoy accepts the report and composes the commit message through the defined fallback path

#### Scenario: Structured description is malformed
- **WHEN** a phase submits empty, multiline, over-count, or otherwise invalid structured commit data
- **THEN** the report call returns a validation error without replacing the last valid report candidate, allowing the phase to correct and resubmit it

#### Scenario: Convoy stops after accepting the report
- **WHEN** Convoy persists a valid report and structured commit description but is interrupted before committing the repository changes
- **THEN** an accepted recovery can reuse that persisted description rather than degrading to a generic recovery subject

### Requirement: Commit bodies contain bounded concrete details
When a valid structured or composed description includes details, Convoy SHALL render at most three sanitized bullet lines between the subject and the trailer. Each detail SHALL be a single concrete statement no longer than 120 characters. Agent-supplied content MUST NOT be able to inject or replace commit trailers.

#### Scenario: Concrete details are available
- **WHEN** a commit description contains valid details
- **THEN** the commit message contains those details as Markdown-style bullets followed by a blank line and the `Convoy-Run` trailer

#### Scenario: No concrete details are available
- **WHEN** no trustworthy detail lines can be produced
- **THEN** Convoy emits the semantic subject and run trailer without inventing a body

#### Scenario: Detail attempts to inject a trailer
- **WHEN** a detail contains embedded newlines or text shaped as an additional Git trailer
- **THEN** Convoy normalizes or rejects the detail so the resulting message still has exactly one authoritative `Convoy-Run` trailer

### Requirement: Missing semantic data has an honest non-blocking fallback
Commit-message composition MUST NOT prevent otherwise valid repository changes from being committed solely because structured metadata is absent or invalid. Convoy SHALL prefer accepted structured data, then useful report content, then step-local change evidence. Recovery without persisted semantic data SHALL state that interrupted changes were recovered. Human iterations without report metadata SHALL describe changed paths or the changed-file count when available instead of using the fixed summary `apply manual iteration`.

#### Scenario: Legacy report has a useful heading
- **WHEN** no structured description exists but the report begins with a specific repository outcome
- **THEN** Convoy uses a sanitized and bounded form of that outcome as the commit summary

#### Scenario: No trustworthy semantic source exists during recovery
- **WHEN** interrupted changes are accepted for recovery and no persisted semantic description or useful report summary exists
- **THEN** Convoy uses an honest recovery summary and still appends the resumed run's trailer

#### Scenario: Human iteration has only change evidence
- **WHEN** a human iteration has no report description but changed-file evidence is available
- **THEN** Convoy derives a bounded summary or detail from that evidence rather than using the fixed `apply manual iteration` message
### Requirement: Compaction and closing preserve run-linked commit compatibility
Run-linked semantic messages SHALL remain valid inputs to automatic run compaction and feature closing despite multiline bodies and trailers. Automatic compaction MUST use the originating run's durable boundary and commit provenance rather than selecting all consecutive commits by authorship alone. Feature close SHALL include the complete feature-exclusive change regardless of authorship or intermediate trailers. The resulting operator-authored commits SHALL NOT be required to retain intermediate `Convoy-Run` trailers; their replacement relationship MUST remain recoverable through durable run/close evidence. The retired `convoy finish` command SHALL NOT remain an execution path.

#### Scenario: Automatic compaction sees run-linked commits

- **WHEN** the verified current-run interval contains `convoy@local` commits with semantic subjects, multiline detail bodies, and authoritative `Convoy-Run` trailers
- **THEN** automatic finalization selects that interval without admitting older runs solely because their author is also Convoy

#### Scenario: Close replaces intermediate history

- **WHEN** `convoy close` lands a feature containing operator commits and run-linked intermediate commits
- **THEN** the base gains one operator-authored squash-merge commit without needing to copy the intermediate trailers or rewrite the feature commits