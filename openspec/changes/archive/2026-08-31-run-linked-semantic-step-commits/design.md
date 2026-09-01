## Context

See `proposal.md` for motivation and `specs/step-commit-messages/spec.md` for the behavioral contract.

Writable agent phases currently persist only Markdown and derive the commit subject from its first non-empty line. `commitPhase` and interrupted recovery construct that one-line message independently, while human review uses a third fixed message path. All three eventually call `addAllAndCommit`, which stages and scans changes before committing as `convoy@local`. The active `Workspace` already carries a validated run ID, but normal finalization and human commit helpers do not pass it to message construction.

The report bridge already validates structured tool arguments and persists successful writes atomically. The finish and close flows identify intermediate commits by author email and read only their subjects when selecting and describing the squash range, so multiline bodies do not need to participate in range detection.

There are two important constraints:

- Commit-message composition is part of repository finalization and must not add a new model call or create a new failure mode after valid work is ready to commit.
- A report can be written successfully and Convoy can stop before the corresponding Git commit, so semantic metadata held only in memory would be lost during recovery.

## Goals / Non-Goals

**Goals:**

- Centralize normal, recovery, and human-iteration message construction behind one bounded and testable format.
- Reuse the phase agent's knowledge through optional structured report metadata without adding per-commit inference cost.
- Persist structured metadata defensively so recovery can trust it only when it belongs to the current report.
- Derive honest deterministic messages from report or staged-change evidence when structured metadata is unavailable.
- Keep existing secret scanning, Git hooks, machine authorship, and squash-range behavior intact.

**Non-Goals:**

- Preserve intermediate run trailers in the final user-authored squash commit.
- Generate conventional `feat`/`fix` types for intermediate commits or replace the `convoy(<step>)` prefix.
- Ask the operator to write a message after every human iteration.
- Use a second language model to summarize each phase or inspect semantic correctness of agent-supplied prose.
- Backfill or rewrite existing intermediate commits.

## Decisions

### D1. Represent step messages with one shared pure descriptor and renderer

Introduce a small module independent of `runner.ts` and the final squash composer. Its core value is a `StepCommitDescription` containing a subject and up to three details, plus pure functions that normalize, bound, and render:

```text
convoy(<step>): <semantic subject>

- <concrete detail>
- <concrete detail>

Convoy-Run: <complete run ID>
```

The renderer owns the complete 72-character subject budget, including `convoy(<step>): `. It strips ANSI/C0 control bytes, Markdown heading markers, line breaks, repeated whitespace, surrounding punctuation, and partial trailing words. Detail lines are rendered as bullets, normalized to one line, capped at 120 characters, and limited to three. The run trailer is always appended from the validated workspace ID after all untrusted text has been normalized.

Generic control-byte and subject-bounding helpers will be extracted from `commit-message.ts` into a dependency-neutral text module so both final and intermediate composers can reuse them without creating the existing `commit-message.ts` → `runner.ts` import cycle.

Alternatives considered:

- Put the run ID in the subject. Rejected because the full ID consumes too much of the 72-character semantic budget and makes every oneline log repetitive.
- Replace the prefix with a conventional commit type. Rejected because the intermediate nature and phase are useful, existing documentation and fallbacks recognize the prefix, and the final squash already provides the conventional user commit.
- Put provenance in Git notes. Rejected because notes are not transferred by normal push/fetch workflows and are easy to lose.

### D2. Extend `write_report` with optional structured commit metadata

Writable OpenCode phases can submit this additional shape alongside `markdown`:

```json
{
  "commit": {
    "subject": "preserve report sessions across human gates",
    "details": [
      "Keep report and advisor handles alive during manual iteration",
      "Cover reopened OpenCode sessions with regression tests"
    ]
  }
}
```

The generated tool schema, `WriteReportPayload`, validated payload, and report runtime carry the optional object. Boundary validation requires a non-empty single-line subject, zero to three non-empty single-line details, and conservative input-size limits. Oversized but structurally valid prose is bounded by the renderer; multiline or over-count input is rejected while the session remains open for correction. Read-only phases reject commit metadata because they cannot create a step commit.

The writable phase prompt explicitly asks for an imperative English subject that describes the repository outcome and concrete details, not the report, agent, or process. This is guidance rather than a semantic validator: Convoy can validate shape and safety, but it cannot prove prose accuracy without another model call.

Alternatives considered:

- Continue parsing the first Markdown heading. Rejected as the primary source because existing history demonstrates that role/report headings are common and structurally indistinguishable from intentional titles.
- Run the existing final commit writer after every step. Rejected because it adds latency, cost, server lifecycle complexity, and a new post-work failure path for information the phase agent already has.
- Embed machine-readable frontmatter in the Markdown report. Rejected because reports are user-facing artifacts and already have a structured tool boundary available.

### D3. Persist a report-bound sidecar for crash-safe recovery

Each successful report-tool write atomically updates a private sidecar adjacent to the report, for example `reports/implementer.md.commit.json`, with schema version, SHA-256 of the persisted Markdown, and the optional normalized description. The runtime writes the report first and then atomically replaces the sidecar. Every successful write records an envelope even when no commit description is supplied, preventing an older description from silently surviving a later report revision.

Normal finalization and recovery load a sidecar only when:

1. its schema and fields validate;
2. its report hash equals the current persisted report; and
3. its step/report location belongs to the current workspace.

A missing, stale, malformed, or partially updated sidecar is ignored and activates fallback composition. This makes a crash between the two atomic renames degrade message quality rather than pair the wrong description with a commit. The sidecar remains in the private run directory and is never staged in the target repository.

Alternatives considered:

- Keep the descriptor only on the in-memory report handle. Rejected because commit failure and process interruption are explicitly recoverable after restart.
- Persist only the descriptor without a report hash. Rejected because multiple corrected `write_report` calls could leave a valid but stale description attached to newer Markdown.

### D4. Use a deterministic source hierarchy and reject generic report labels

The shared composer selects data in this order:

1. valid hash-matched structured description;
2. first useful line from the accepted Markdown report;
3. staged-change evidence;
4. a context-specific honest fallback.

A report line is not useful when its normalized value is only the phase/agent name or a role/process label such as `<phase> report`, `test report`, `security audit`, `adversarial review`, or `design polish`. Labels followed by a concrete suffix remain useful. The classifier is deliberately narrow and exact after normalization so it does not reject legitimate sentences containing those words.

Staged-change evidence is generated after `git add -A` from NUL-delimited staged status. For one changed path the fallback can say `update <path>`; for several paths it uses a safe common area when one exists or `update <count> files`. Up to three status/path entries can become deterministic detail bullets. Recovery with no stronger source uses `recover interrupted phase changes`. Human iteration uses staged evidence and falls back to `apply manual changes` only when Git cannot provide usable paths.

No source failure blocks the commit. The final fallback always yields a valid bounded subject and the authoritative run trailer.

### D5. Compose from the exact staged change set

Extend the Git commit seam so `addAllAndCommit` can accept either its existing string or an asynchronous message factory. It will continue to:

1. run `git add -A`;
2. return without committing when status is empty;
3. reject suspicious staged files and reset staging;
4. derive a safe staged-change summary;
5. invoke the message factory; and
6. run the existing unsigned machine commit with normal hooks.

Normal, recovery, and human paths pass a factory that closes over run ID, step identity, report path, and recovery mode. Existing callers and tests that pass a fixed string remain compatible. Building after staging ensures the human/deterministic fallback describes the files that actually enter the commit and avoids creating a message when there are no changes.

Alternatives considered:

- Inspect working-tree status before calling `addAllAndCommit`. Rejected because the observed files could differ from the exact staged set and message work would run even when the commit seam later finds nothing.
- Duplicate staging in a higher-level step helper. Rejected because it would split secret scanning and no-change behavior across commit paths.

### D6. Thread workspace provenance through every commit path

Normal finalization receives the workspace or a minimal `{ runID, runDir }` context in addition to phase and target directory. Recovery already has the workspace. Human review changes `commitHumanChanges` to receive the workspace used by its caller. All paths then invoke the same renderer, which validates the run ID and appends exactly one trailer.

`addAllAndCommit` remains a generic Git primitive and does not invent run provenance for unrelated callers such as tests. The step-level factory is responsible for provenance, ensuring an agent cannot override it through report content.

### D7. Preserve finish and close compatibility without carrying trailers forward

No changes are required to squash-range selection: `CommitInfo` can remain SHA, author email, and subject, and `resolveSquashRange` continues to stop at the first non-`convoy@local` commit. The final message writer continues receiving semantic subjects, which improves its deterministic fallback, while bodies and `Convoy-Run` trailers disappear when the range is soft-reset and recommitted as the user.

Compatibility tests will create real multiline step commits and prove that finish and close select and replace the same range. Existing one-line commits and runs without sidecars continue through the fallback path.

## Risks / Trade-offs

- **[Agent-supplied semantics can still be inaccurate]** → Prompt for outcome-oriented text, retain staged evidence for fallbacks, and keep final squash confirmation as the user-controlled boundary; do not claim semantic validation that Convoy cannot perform deterministically.
- **[The generic-heading classifier can reject or accept borderline titles]** → Match only normalized exact labels and test concrete suffixes; structured data is the primary path for all new writable OpenCode phases.
- **[A crash can leave report and sidecar temporarily inconsistent]** → Use independent atomic writes plus a report hash; inconsistency causes a safe fallback, never stale semantic data.
- **[Long custom step names leave little subject room]** → Budget the complete prefix first and always retain a non-empty bounded fallback; current safe step-name constraints limit the worst case.
- **[Human fallbacks based on paths are less semantic than agent prose]** → Prefer common changed areas and status details while avoiding a new model call or an extra operator prompt.
- **[Commit-msg hooks may enforce repository-specific formats]** → Preserve the existing subject prefix and hook execution path; surface hook failures exactly as today rather than bypassing them.
- **[Run IDs can outlive deleted run directories]** → Treat the trailer as immutable provenance, not a guarantee that private run artifacts were retained.

## Migration Plan

1. Add the optional report payload and sidecar format without changing legacy report acceptance.
2. Route normal, recovery, and human commits through the shared renderer and staged message factory.
3. Update prompts, tests, and documentation together so new agents begin supplying structured descriptions immediately.
4. Validate that legacy reports without sidecars, existing one-line commits, recovery, finish, and close retain their current operational behavior.

Rollback requires only reverting the runtime changes. Existing multiline commits remain valid Git history, and ignored sidecars in private run directories require no migration or cleanup.
