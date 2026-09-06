## Why

Convoy currently reconstructs feature identity from mutable branch names and copies of active OpenSpec directories, so routine merges, renames, and early archiving can hide unfinished work or show “ready to close” without a close action. A reliable workflow must remember which work the operator associated with a context, independently verify its current progress, and retain enough evidence to finish or resume safely.

## What Changes

- Introduce repository-local stable feature identities with explicit change-contract, implementation-context, base, run, and close-attempt associations. Persist intent and evidence, not a cached authoritative lifecycle status.
- Register associations during successful spin and accepted run launch; provide explicit inspection, adoption, and rebinding for pre-existing or externally changed contexts. Conventional names remain defaults, never ownership proof.
- **BREAKING**: replace branch-name/Markdown/list-order ownership and silent close-target guesses with one shared resolver. Unassociated legacy work stays visible; mutation requires a verified association or explicit adoption. Existing `--branch`, `--change`, and `--resume` spellings remain supported as selectors, not safety bypasses.
- Derive orthogonal artifact, task, execution, integration, publication, and cleanup facts through one assessment shared by the board, launcher, run publication, and close. Explain blocked actions instead of hiding them and revalidate targets before mutation.
- Keep archived-but-unintegrated features and integrated-but-not-cleaned features discoverable. Read artifacts from their associated source, including verified archives, without substituting unrelated copies.
- Make close identity-based, positively verify archive completion, preserve whole-branch squash semantics, reconcile interrupted landings, retain immutable receipts, and make repeated close and cleanup safe across rename, worktree removal, and retries.
- Migrate legacy run/journal evidence conservatively and preserve run-boundary, recovery, signing, hooks, secret-file, and exact-tip cleanup protections. Missing or ambiguous evidence is not success.

## Capabilities

### New Capabilities

- `feature-lifecycle`: Stable repository-scoped identity, explicit associations and reconciliation, lifecycle evidence, shared assessment and action capabilities, and conservative legacy adoption.

### Modified Capabilities

- `control-board`: Replace inferred ownership with associated feature rows and shared assessment; retain pending lifecycle work after archive or worktree deletion.
- `specs-viewer`: Read-only lifecycle discovery, authoritative active/archive artifact sources, feature-aware handoffs, and discoverable actions in root and detail views.
- `feature-spin`: Persist the feature/context association on successful spin without changing conventional default names or proposal-transfer behavior.
- `run-launcher`: Review and persist explicit feature/contract/context selection and revalidate it before execution.
- `run-finalization`: Preserve feature linkage in durable run history and resolve publication against the verified current feature context without weakening run-specific rewrite boundaries.
- `feature-close`: Shared target/preflight assessment, verified archive state, stable transaction identity, idempotent landing recovery, and evidence-gated cleanup.
- `worktree-location`: Separate new-worktree path allocation from lookup/rebinding of existing feature contexts.

## Impact

- Affects `src/control-board.ts`, `src/openspec.ts`, `src/specs.ts`, `src/specs-browser.ts`, spin/launcher/CLI handoffs, reviewed plans and run metadata/indexes, publication, close journals/commands, and Git mutation coordination. Introduces a shared lifecycle domain and repository-common-directory storage.
- Changes local CLI/TUI selection and compatibility behavior; no hosted service, new runtime dependency, remote registry, automatic publication, automatic branch deletion, or changes to OpenSpec's on-disk artifact format are required.
- Preserves ordinary no-spec runs and multi-change run contracts; an implementation context has one current feature association with an explicit contract set. Adoption does not imply task completion, archive success, integration, or permission to rewrite old run history.
- Requires end-to-end and fault-injection tests across copies, renames, archive-before-close, stale/corrupt evidence, concurrent changes, and partial cleanup, plus updated workflow documentation. This change creates planning artifacts only; implementation is a separate apply operation.
