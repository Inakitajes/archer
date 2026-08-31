## 1. Commit Message Foundation

- [x] 1.1 Extract dependency-neutral commit-text sanitization and whole-subject word-boundary capping from the final commit composer, preserve its existing behavior, and verify with `bun test test/commit-message.test.ts` plus `bun run typecheck`.
- [x] 1.2 Add the pure step commit descriptor, generic-report-label classifier, deterministic changed-path fallbacks, and multiline renderer with one authoritative `Convoy-Run` trailer; verify unit coverage for 72-character subjects, 120-character details, three-detail limits, control bytes, word boundaries, generic headings, trailer injection, and valid run IDs.

## 2. Structured Report Metadata

- [x] 2.1 Extend the generated `write_report` schema and report payload validation with optional writable-phase `commit.subject` and `commit.details`, reject malformed or read-only usage without replacing a prior valid candidate, and verify with focused report and bridge tests.
- [x] 2.2 Update writable phase instructions to request an imperative semantic subject and concrete details while leaving read-only/scoring instructions coherent; verify prompt assertions in `bun test test/runner.test.ts test/report-bridge.test.ts`.
- [x] 2.3 Persist an atomic versioned commit-description sidecar containing the report hash on every successful tool write, add safe hash-matched loading with stale/malformed fallback, and verify corrected writes, absent descriptions, interruption, path containment, and file mode behavior in `bun test test/report-runtime.test.ts test/runner.test.ts`.

## 3. Exact Staged-Change Composition

- [x] 3.1 Extend `addAllAndCommit` to support an asynchronous message factory invoked after staging and secret scanning with NUL-safe staged-change evidence, while retaining fixed-string callers and no-change behavior; verify staging, renames, unusual paths, secret rejection, hooks, and unsigned machine identity in `bun test test/git.test.ts test/git-extended.test.ts`.
- [x] 3.2 Route normal writable phase finalization through the shared composer with workspace provenance and the structured → useful report → staged evidence → honest fallback hierarchy; verify semantic subject/body/trailer output and no-empty-commit behavior in `bun test test/runner.test.ts`.
- [x] 3.3 Route interrupted writable-phase recovery through the same composer, reusing only hash-matched persisted descriptions and otherwise naming recovery honestly; verify original run linkage, stale-sidecar rejection, existing-report fallback, and read-only refusal in `bun test test/runner.test.ts test/reproduction.test.ts`.
- [x] 3.4 Pass workspace provenance into every human iteration commit and derive its subject/details from the exact staged paths instead of `apply manual iteration`; verify run trailers, multiple iterations, unusual paths, and no-change iterations in `bun test test/human.test.ts test/human-extended.test.ts test/human-hold.test.ts`.

## 4. Squash Compatibility and Documentation

- [x] 4.1 Add real multiline run-linked intermediate commits to finish and close coverage and verify authorship-bounded selection, semantic-subject input, successful replacement, rollback paths, and intentional trailer disappearance with `bun test test/finish.test.ts test/finish-command.test.ts test/finish-command-integration.test.ts test/feature-close.test.ts`.
- [x] 4.2 Update README commit lifecycle, recovery, human iteration, and finish documentation with the semantic message shape and `Convoy-Run` lookup example, and verify documented commands and terminology against the implemented CLI behavior.

## 5. Full Verification

- [x] 5.1 Run `bun run typecheck` and `bun test`, and resolve every regression without weakening the step-commit-message scenarios.
- [x] 5.2 Run `openspec validate run-linked-semantic-step-commits --type change --strict` and confirm the proposal, capability delta, design, and completed task state remain coherent before archive.
