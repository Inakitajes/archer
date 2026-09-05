## ADDED Requirements

### Requirement: Attached dashboards reconstruct the goal pipeline tree
Live attach and stopped-run reconstruction SHALL rebuild every goal-fragment phase shown in the dashboard's pipeline panel from durable run state — the frozen pipeline's improve and measure fragments plus the deterministic invocation-qualified phase identities — rather than from bare phase names. A reconstructed goal phase SHALL carry the logical step identity of its fragment step (including model and variant labels for fan-out members and read-only status), and each goal invocation SHALL form its own tree group so nesting and iteration boundaries are visible. Execution-side grouping, batching, resume, and report identities MUST remain unchanged by this reconstruction.

#### Scenario: Attach mid-cycle shows structured measurement
- **WHEN** an operator attaches to a live goal run whose measurement fragment has fanned one scoring step across two models and whose consensus step has not started
- **THEN** the pipeline panel shows one group for the measurement invocation containing the two scoring members labelled by model nested under their shared step, plus the consensus step as its own pending row, instead of flat rows of qualified physical ids

#### Scenario: Iteration boundaries remain visible
- **WHEN** a goal run has completed measurement zero, one improvement round, and is measuring again
- **THEN** the pipeline panel shows each invocation as a separate group labelled by its stage and round (measurement zero, improvement one, measurement one), and phases of different invocations never merge into one group

#### Scenario: Labels use logical step names
- **WHEN** the pipeline panel renders a goal phase row or group
- **THEN** labels read from the fragment step's logical name and model (for example `score ×2`, `grok-4-6#high`, `score-report`, `fix`), not from the invocation-qualified physical id

#### Scenario: Stopped run keeps the same structure
- **WHEN** a completed goal run with multiple invocations is reopened from history
- **THEN** the reconstructed pipeline panel shows the same per-invocation grouping, nesting, and labels the live dashboard showed

### Requirement: Live attach seeds the in-flight goal invocation
While a goal run is live, reconstruction SHALL include the invocation the durable goal record reports as current even when none of its phases has been recorded yet, so dashboards opened between stage boundaries receive those phases' events and the progress counter reflects the real phase total. Invocations that never execute MUST NOT be listed on a settled run.

#### Scenario: Attach between improvement and measurement
- **WHEN** an operator attaches to a live goal run during the pause between an improvement stage and its following measurement, before any measurement phase has started
- **THEN** the dashboard already lists the pending measurement invocation's phases and subsequent phase events (start, session, usage, completion) land on those rows

#### Scenario: Settled run lists only executed invocations
- **WHEN** a goal run settled at measurement zero without running any improvement round
- **THEN** reconstruction lists only the prefix phases and the measurement-zero invocation, and no pending rows exist for improvement rounds that never ran
