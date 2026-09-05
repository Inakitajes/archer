## Why

Manual `finish` and feature `close` currently reuse an authorship-bounded squash, so a finished run becomes an operator-authored barrier to later closing and intermediate feature commits still reach the base. Successful runs should compact themselves without an extra gesture, while closing should always land the complete feature as one commit without rewriting published feature history.

## What Changes

- Add automatic, non-configurable run finalization, visible as the last lifecycle row in the dashboard. After successful execution, goal settlement, and success hooks, eligible current-run commits become one conventional operator-authored commit without message confirmation or automatic publication.
- Define actual run boundaries and commit provenance instead of reusing an unbounded authorship suffix. Preserve previous runs and independent operator commits; refuse unsafe compaction rather than compacting a misleading partial range.
- Persist per-run intermediate commit evidence, durable backup refs, and finalization outcomes before rewriting. Surface compaction failures separately from pipeline success; never bypass signing, hooks, or published-history safety.
- **BREAKING**: Remove the `convoy finish` command and manual finish/push actions from run completion. The only publication action is **Create pull request**, which deliberately performs a normal push followed by PR creation. Existing browsing/navigation remains available.
- **BREAKING**: Replace close's branch rewrite plus ordinary merge with a true squash merge onto the local base. All feature-exclusive work is included regardless of author; there is no preserve-commits mode or configurable fork boundary.
- Keep close's sync and OpenSpec archive, reviewed final message, and optional cleanup. Permit published feature branches with factual remote/PR guidance; never force-push. Guard base movement, record landing receipts, and require verified evidence before deleting a locally squash-landed branch.

## Capabilities

### New Capabilities

- `run-finalization`: Mandatory automatic current-run compaction, recoverable history, durable presentation, and the deliberate Create pull request action replacing manual finish.

### Modified Capabilities

- `feature-close`: True squash landing, pinned-base safety, resumability without ancestry assumptions, reviewed messaging, and evidence-gated cleanup of published or local features.
- `step-commit-messages`: Replace the legacy shared authorship-walk compatibility promise with run-provenance-aware automatic compaction and author-independent feature closing.

## Impact

Touches the runner/coordinator completion lifecycle, metadata and retention, Git mutation helpers, goal-settlement integration, control/attach/history transport, run dashboard and command palette, CLI dispatch, PR integration, close orchestration/presentation, cleanup, and control-board landing evidence. Removes the public finish command while retaining only the internal primitives needed by automatic finalization. Updates documentation, help, and integration/regression tests; introduces no configurable pipeline step or new external service dependency. Main specs and project code remain unchanged during this planning change.
