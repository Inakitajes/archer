# Tasks

## 1. Lifecycle storage and identity foundation

- [ ] 1.1 Add a repository-common-directory versioned store with opaque repository/feature/attempt UUIDs and schema/ref validation; verify readers return typed missing/corrupt/unsupported/unreadable results via unit tests for each.
- [ ] 1.2 Implement atomic versioned feature records (contract set, base, current context, revision, history pointers) with conflict detection; verify a lost-update write is refused and inspected before retry.
- [ ] 1.3 Implement immutable close attempt journals and receipts keyed by feature/attempt, with embedded identity and repository validation; verify a read ignores foreign or unsupported-version records.
- [ ] 1.4 Add protected feature/attempt refs and verify existing ref values; verify create-only refs are never overwritten and a pre-existing mismatched ref is refused.
- [ ] 1.5 Add read-only discovery combining registered features, active candidates, referenced archives, legacy run/close evidence, and Git worktrees; verify browsing never creates or migrates records (assert no writes).

## 2. Shared observation and resolver

- [ ] 2.1 Add a pure lifecycle assessment module (context, per-contract artifact state, tasks, execution, integration, publication, cleanup, actions) over typed observations; verify unit tests cover each orthogonal fact and unknown/unreadable evidence.
- [ ] 2.2 Add structured run/Git/artifact read adapters that surface unreadable evidence; verify a run-discovery failure is reported as unknown, not as an empty live-run set.
- [ ] 2.3 Implement the shared resolver (explicit feature ID → verified context → unique explicit branch/change filter → unresolved candidates); verify it returns a tagged result with evidence and blockers and never falls through an invalid selector to a heuristic.
- [ ] 2.4 Add deterministic archive-effect verification (ADDED/MODIFIED/REMOVED/RENAMED, full capability paths) and overlapping-contract composed-effect handling; verify with multi-contract fixtures and an unprovable composition stop.
- [ ] 2.5 Wire the assessment into control-board, specs-viewer, launcher, publication, and close so they consume identical action eligibility; verify the same blocked action renders the same reason in headless and TUI.

## 3. Feature identity operations

- [ ] 3.1 Implement `convoy feature show` (read-only, with `--json`) for a feature or current context, including unresolved discovery evidence; verify it mutates nothing and reports provenance.
- [ ] 3.2 Implement `convoy feature adopt` (branch/change/base, optional archive-path and headless `--archive-source <change>=<path>` mapping) validating repository membership, checked-out branch, worktree registration, and source; verify an arbitrary branch name is accepted and never renamed.
- [ ] 3.3 Implement `convoy feature bind` (context rebind) with uniqueness, common-directory, live-run, and unresolved-mutation checks; verify a renamed/moved context is rebound without rewriting run boundaries.
- [ ] 3.4 Implement `convoy feature revise` (contract set/base change) with live-run and unresolved-attempt refusal; verify adding a second contract records the complete reviewed set and that a running feature refuses.
- [ ] 3.5 Implement `convoy feature recover` for evidence-only completed features without a worktree; verify it grants only receipt-verified follow-ups and never new execution authority.
- [ ] 3.6 Implement `convoy feature new-work` to start a new identity on a retained completed context; verify it does not inherit the completed feature's runs or receipt.

## 4. Registration into spin and launch

- [ ] 4.1 Persist a stable association on successful spin (intent before transfer, committed association before success output); verify a persistence failure exposes the created context and transferred files without committing or deleting them.
- [ ] 4.2 Persist an association on accepted feature-backed launch and persist the feature link in durable run metadata before execution; verify cancellation before acceptance writes no feature record.
- [ ] 4.3 Carry stable feature identity, contract set, base, and verified context through feature Apply/Continue handoffs from any launch checkout; verify cross-checkout Apply/Continue reuse the associated context instead of a same-id launch copy.
- [ ] 4.4 Revalidate reviewed identity/revision/branch/worktree/base before execution and stop on a changed target; verify a branch switch after review refuses and attaches nothing to the new branch.

## 5. Run history and publication

- [ ] 5.1 Add repository/feature identity, association revision, and reviewed contract references to durable run metadata and cleanup-surviving records; verify board/attach/history join by identity and never reinterpret a stored path as today's branch.
- [ ] 5.2 Resolve feature-backed `Create pull request` through the shared current-context assessment and revalidate before push; verify publication never pushes the replacement branch at a reused historical path and never marks local integration/archive/PR merge complete.
- [ ] 5.3 Keep legacy run evidence readable until explicitly adopted and preserve immutable run-start boundaries; verify a legacy run without a durable boundary cannot authorize a compaction rewrite.

## 6. Board and specs viewer

- [ ] 6.1 Replace ownership resolution and stage/action gates with feature identity and shared capabilities; verify an inherited copy never claims a foreign feature and unassociated candidates show association/spin remediation.
- [ ] 6.2 Load associated artifact inventory from the verified source using absolute paths, and show missing/ambiguous/unreadable conditions without same-slug fallback; verify a missing associated worktree exposes another copy only as a candidate.
- [ ] 6.3 Add **Features** / **Worktrees without spec** / **Canonical Specs** sections with a discoverable **History** view; verify archived-but-unintegrated and integrated-but-not-cleaned work remain visible and completed work is reachable in history.
- [ ] 6.4 Add a discoverable `Actions` menu in root and ordinary detail using shared capabilities, available when footer hints truncate; verify a blocked close action stays inspectable with its reason and remediation.
- [ ] 6.5 Add explicit refresh (and refresh after external action return) preserving selection by identity and invalidating artifact/assessment caches together; verify a failed refresh discloses stale evidence instead of presenting readiness as current.
- [ ] 6.6 Keep fullscreen reader copy/close/tab keys unchanged and restore feature identity and lifecycle actions on return; verify `c` copies and performs no lifecycle mutation.

## 7. Close transaction rework

- [ ] 7.1 Resolve close through stable feature identity and validate selectors, verifying a mistyped change or contradictory worktree/branch refuses before mutation.
- [ ] 7.2 Capture original contract/task/delta/proposal context and require positive archive evidence (unique source, completed tasks, canonical-spec effects, committed result); verify an absent active directory alone is never treated as already archived.
- [ ] 7.3 Persist a close attempt before the first mutation and reconcile every boundary from observed effects; verify crash-after-landing, crash-after-archive, stale-candidate, and repeat-close scenarios behave as specified.
- [ ] 7.4 Preserve whole-branch squash landing (one parent, captured base, entire feature-exclusive result) and immutable receipts; verify no path-filtered landing, no duplicate base commits, and receipt survival across later attempts.
- [ ] 7.5 Make landing an expected-old guarded ref transaction distinct from checkout materialization; verify an interrupted landing after ref success is reconciled and a moved base rejects the stale candidate.
- [ ] 7.6 Gate both worktree removal and branch deletion on verified landing, exact unchanged feature tip, no live run, and consent; verify a reused branch name or changed tip is never deleted and removal precedes deletion.
- [ ] 7.7 Expose the same guarded cleanup through command output, TUI follow-up, and headless guidance; verify deferred/headless commands execute the same checks rather than an unprotected check-then-force-delete recipe.
- [ ] 7.8 Extend the interactive close checklist with verified feature/context identification and explicit archive/integration/cleanup distinctions; verify a blocked close review remains reachable and performs no Git or archive mutation.
- [ ] 7.9 For archive-on-main, verify the base-checkout copy corresponds to the selected contract, record the archive source/evidence, and keep integration as probably merged or pending; verify the feature worktree's active copy no longer displaces the recorded archive source.

## 8. Migration and compatibility

- [ ] 8.1 Keep legacy readers and distinguish legacy evidence from stable-ID records; verify legacy records remain readable and are never migrated as a read-time side effect.
- [ ] 8.2 Add explicit legacy adoption with embedded identity/repository validation, preserving original bytes/refs; verify a filename collision or mismatched embedded identity is refused and not reassigned.
- [ ] 8.3 Update canonical purpose summaries (control-board, feature-spin, specs-viewer) that describe active-only navigation or "no registry", and the worktree delta's stale `finish` lookup behavior; verify no unrelated requirement is removed and validation stays green.
- [ ] 8.4 Preserve no-spec runs, multi-change contracts, conventional branch creation, location templates, dirty-tree consent, and run-compaction boundaries; verify existing run-launcher, feature-spin, worktree-location, and run-finalization behavior remains compatible.

## 9. End-to-end verification

- [ ] 9.1 Add lifecycle scenario tests covering copies, renames, moves, archive-before-close, external archive, ambiguous/missing sources, and repeated cleanup; verify the full suite passes.
- [ ] 9.2 Add crash-boundary and concurrency fault-injection tests for association writes, archive, candidate, landing, and cleanup; verify no unrelated work is overwritten and every boundary reconciles.
- [ ] 9.3 Add end-to-end test that a completed feature stays discoverable and a renamed/unassociated feature is not silently closed or claimed; verify no ownership regression.
- [ ] 9.4 Run typecheck and the full test suite and record results; verify a clean build and zero regressions.
- [ ] 9.5 Document the local record contract, archive/integration distinctions, guarded cleanup commands, and the explicit identity operations; verify documentation matches the implemented commands.
