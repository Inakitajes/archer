## ADDED Requirements

### Requirement: Attached dashboards follow new goal invocations live
While a dashboard is attached to a live goal run, the pipeline panel SHALL gain each goal invocation's phase rows when the scheduler starts that invocation — without detaching and re-attaching — and subsequent phase events (start, session, usage, activity, completion) SHALL land on those rows. The progress counter SHALL reflect the added rows. Growing the panel MUST be additive: rows and state belonging to earlier invocations (status, durations, costs, reports, transcripts, feed entries) MUST be preserved, and the panel MUST NOT present the run as complete while any invocation is executing.

#### Scenario: Next invocation appears without re-attaching
- **WHEN** a dashboard attached since measurement zero watches the run complete measurement zero and begin improvement one
- **THEN** the improvement-one rows appear in the pipeline panel as that invocation starts, the counter counts them, and the panel no longer shows only completed rows while the run continues

#### Scenario: Events land on the followed rows
- **WHEN** an invocation that appeared live starts one of its steps
- **THEN** that step's row shows running status, its session, usage, and completion arrive on the same row, and no detach/re-attach was needed

#### Scenario: Earlier invocations are preserved
- **WHEN** the panel grows to include improvement one after measurement zero completed
- **THEN** measurement zero's rows keep their completed status, durations, costs, and browsable reports, and no feed or transcript content belonging to them is cleared

#### Scenario: Observer dashboards follow too
- **WHEN** a read-only observer (not the controller) is attached while the cycle moves to the next invocation
- **THEN** the observer's panel also gains the new invocation's rows, since following is a property of the dashboard's view, not of its control role

### Requirement: The attached header goal view follows the cycle live
While a dashboard is attached to a live goal run whose pipeline has a goal step, the header SHALL show the goal's target, the current iteration against the run cap, and the trajectory of authoritative scores measured so far, updating as the durable goal record advances — without detaching and re-attaching. A dashboard attached at any point SHALL show the same goal view a fresh attach would derive, and a run without a goal step SHALL keep today's header without goal segments.

#### Scenario: Score appears after measurement zero
- **WHEN** measurement zero completes and its score is checkpointed while a dashboard has been attached since the run started
- **THEN** the header shows the goal target and a trajectory containing that score without the operator re-attaching

#### Scenario: Mid-cycle attach shows the accumulated trajectory
- **WHEN** an operator attaches after two measurements have completed and improvement two is running
- **THEN** the header immediately shows the target, the current iteration, and the two measured scores, matching a fresh attach

#### Scenario: Non-goal runs keep the plain header
- **WHEN** a dashboard is attached to a live run whose pipeline has no goal step
- **THEN** the header shows no goal segments, as today

### Requirement: Goal invocation reports resolve in the dashboard
Each goal invocation phase row SHALL carry its invocation-qualified report identity so the dashboard's report panel — inline and fullscreen — reads that invocation's report (`reports/goal/iteration-N/<stage>/<step>.md`) rather than a path derived from the phase's physical name. A completed measurement or improvement step SHALL display its report instead of a no-report placeholder, and prefix phases SHALL continue resolving their conventional `reports/<step>.md` reports unchanged.

#### Scenario: A completed scoring step shows its consensus report
- **WHEN** an operator opens the reports panel for a measurement-consensus step that completed inside the goal cycle
- **THEN** the panel shows that round's consensus report from its iteration-qualified path, and no "wrote no report" placeholder appears

#### Scenario: Rounds remain separately browsable in the panel
- **WHEN** two measurement rounds have completed and the operator browses each round's scorer report in the dashboard
- **THEN** each round's row shows its own round's report, never another round's

#### Scenario: Prefix reports are unaffected
- **WHEN** an operator opens the report of a prefix step that wrote `reports/<step>.md`
- **THEN** the panel resolves it exactly as before the change
