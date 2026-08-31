## Why

Convoy's intermediate commits are difficult to trace back to the run that produced them, and their subjects are only as useful as the first heading in each phase report. Generic headings such as "Implementer report" or "Test report" leave an unreadable history precisely when an operator needs to inspect, recover, or debug a run before it is squashed.

## What Changes

- Add the complete Convoy run ID to every intermediate commit as a machine-readable `Convoy-Run` Git trailer.
- Give writable agent phases a structured way to report a concise semantic commit subject and concrete detail lines alongside their Markdown report.
- Compose bounded, sanitized, readable step commit messages from structured phase output, with honest fallbacks for legacy reports, interrupted recovery, and manual iterations.
- Apply the same run-linking and formatting rules to normal phase commits, recovered phase commits, and commits created after human OpenCode iterations.
- Preserve the existing `convoy(<step>):` subject prefix and `convoy@local` identity so intermediate commits remain recognizable and `convoy finish` continues to select them by authorship.
- Keep final squash behavior unchanged: intermediate run trailers are not required to survive in the user-authored commit produced by `convoy finish` or `convoy close`.

## Capabilities

### New Capabilities

- `step-commit-messages`: Defines traceable, semantic, and safely formatted commit messages for all Convoy-created intermediate commits.

### Modified Capabilities

None.

## Impact

- Phase report tooling and runtime payload validation gain optional commit-message metadata for writable phases.
- Runner, recovery, and human-review commit paths use a shared message composer with access to the run ID and step-local changes.
- Git commit messages become multiline and include a deterministic trailer, while commit identity and squash-range detection remain compatible.
- Tests and user documentation covering reports, recovery, human iteration, Git commits, and finish compatibility require updates.
- No new runtime dependency or configuration is required.
