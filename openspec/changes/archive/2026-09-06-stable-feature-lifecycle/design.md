## Context

See `proposal.md` for motivation and `specs/feature-lifecycle/spec.md` for the new domain contract. The planning baseline is the current main checkout, which already includes automatic run compaction, protected recovery refs, a repository mutation lease, squash-close candidates/receipts, and goal dashboard improvements. This is not a replacement for those safety mechanisms.

Current responsibilities are fragmented:

- `control-board.ts` discovers active directories across worktrees, chooses a copy through branch/Markdown/list-order precedence, and derives stage separately from browser action gates.
- `openspec.ts` selects run contracts using explicit ID, sole change, branch match, or diff overlap; that selection is not a durable ownership relationship.
- `specs.ts` and browser handoffs can lose the authoritative checkout, and archived work drops out of active-only discovery.
- `run-plan.ts`, metadata, and run indexes contain useful frozen boundaries, but no universally durable feature/contract link. The board can reinterpret old target paths using today's checked-out branch.
- Close supports explicit change selectors but otherwise derives a slug from branch spelling. Its missing-active-directory shortcut is not positive archive proof. Journals use lossy branch/change filenames, and some crash windows precede durable outcome recording.

The existing control-board requirement prohibits a registry, and its purpose text repeats that assumption. This change deliberately replaces that contract. Canonical purpose summaries for control-board/feature-spin must be reconciled during implementation/spec synchronization; the present planning operation does not edit canonical specs.

## Goals / Non-Goals

**Goals:**

- Introduce a small shared lifecycle domain, not a new hosted tracker or daemon.
- Make identity selection stable and action authorization conservative; separate historical intention from current verifiable state.
- Support work created outside Convoy, archived before close, renamed, relocated, or interrupted, without asking the operator to restore a magic branch name.
- Preserve whole-feature squash landing and exact-tip cleanup evidence while eliminating repeat-close and resume ambiguity.
- Make the ordinary UI explain the next useful action, with identical targets and reasons in CLI, root, detail, and follow-ups.

**Non-Goals:**

- No automatic hosted PR merge, remote status polling, cross-machine registry synchronization, or automatic publication/deletion.
- No path-filtered close, stacked-branch orchestration, or aggregation of several implementation branches into one feature. One feature has one current context and an explicitly reviewed set of change contracts.
- No change to OpenSpec artifact formats, no agent-authored archive repair by Convoy, and no automatic reactivation of archived changes.
- No weakening of run compaction boundaries: a feature rename can preserve lifecycle identity while an old run still refuses a rewrite because its originating boundary no longer validates.
- No unconditional guarantee against arbitrary concurrent filesystem writes by external programs. Serialize Convoy operations, use Git's own safety/ref guards, detect divergence, and stop with recovery evidence rather than overwrite unverified work.

## Decisions

### D1. Persist associations and evidence, never an authoritative display status

Add a versioned repository-local store under the canonical Git common directory:

```text
<git-common-dir>/convoy/
  repository.json                     # repository UUID and schema version
  features/<feature-id>/
    feature.json                      # current association, revision, history pointers
    attempts/<attempt-id>/journal.json
    receipts/<attempt-id>.json         # immutable verified landing record
```

Use opaque UUIDs for repository, feature, and attempt identities; do not encode branch/change spellings into filenames. Protected refs use `refs/convoy/features/<feature-id>/<attempt-id>/...` and verify existing ref values rather than accepting any pre-existing object. Validate schema, embedded IDs, repository membership, relative paths, and ref syntax on every load. Read failures are typed as missing, corrupt, unsupported, or unreadable, never all collapsed to absence.

A feature record stores:

- Display name and stable ID; repository ID and monotonically increasing association revision.
- Ordered contract set: change ID, resolved planning source, active-relative path or explicit archive candidate, and association provenance. Preserve each revision's selected set.
- Intended local base ref, not a permanently frozen base SHA; each close attempt captures its own base SHA.
- Current full branch ref, canonical checkout path, and worktree administrative identity where Git exposes one. Path and branch are current attributes, not identity keys.
- Historical observations/rebindings, durable run IDs, and close attempt/receipt references. A feature record does not store `ready`, `integrated`, or `clean` as authoritative facts.

Creation occurs only on explicit adoption, successful spin registration, or acceptance of a new feature-backed launch. Reads do not create the repository UUID, lock sidecars, migration files, or indexes. No-spec runs remain valid without a feature; explicit adoption of an archived change requires its source selection and does not imply verification success.

**Alternative rejected:** a cached status enum or full event-sourced workflow engine. The former becomes stale after external Git/OpenSpec actions; the latter adds machinery beyond the association and recovery evidence needed here. Atomic versioned records plus immutable attempts/receipts fit existing patterns.

### D2. One feature owns one current context; contract selection is separate

Allow a feature to carry multiple explicitly selected changes because existing run bundle composition already supports that. Close validates every associated contract, archives remaining active contracts in deterministic ID order, and lands the entire branch once. Do not expose independent closes for each contract on that branch. The UI names the complete set and whole-branch scope.

At most one active association can claim a branch/worktree context. The same change slug in multiple worktrees is a collection of artifact copies, not multiple owners. Reusing a closed branch name or starting further implementation after a completed feature creates a new feature ID through an explicit new-work decision; never silently reopen the old receipt. Changes to a live feature's contract set require a reviewed association revision and are blocked during a live run or unresolved close attempt. Historical runs keep their original contract set.

**Alternative rejected:** one feature per directory or per run. Directories are copied/archived and runs are repeated; neither corresponds to the operator's unit of implementation.

### D3. Explicit adoption and rebinding replace naming authority

Introduce these user-facing operations (planned commands, not executed by this change):

```text
convoy feature show [<feature-id>] [--json]
convoy feature adopt --branch <name> --change <id> [--change <id> ...] --base <local-ref> [--archive-path <path>]
convoy feature bind <feature-id> --branch <name> --worktree <path>
convoy feature revise <feature-id> --change <id> [--change <id> ...] --base <local-ref>
convoy feature recover <feature-id> [--legacy]
convoy feature new-work --branch <name> --worktree <path> [--change <id> ...] --base <local-ref>
convoy close --feature <feature-id> [--resume]
convoy close --feature <feature-id> --cleanup worktree
convoy close --feature <feature-id> --cleanup branch
```

`show` is read-only and can show unresolved discovery evidence for the current context. `adopt` names existing work; all required values are explicit in headless mode. A single `--archive-path` disambiguates one archived contract; multi-contract ambiguous archives are selected one at a time in the TUI/adoption review rather than inferred from date ordering. The implementation must expose an equivalent unambiguous repeated mapping form for headless multi-contract adoption (`--archive-source <change-id>=<path>`); it is mutually exclusive with the single-contract shorthand. Paths must resolve within the selected planning root, with symlink escape checks.

`bind` is explicit consent to update a feature's context, but not to change its base/contracts, migrate a foreign receipt, rewrite a run boundary, or claim landing. Verify Git common-directory membership, registered worktree root, actual branch, context uniqueness, and absence of live/unreconciled mutation before updating its revision. A tip match can support inspection, never by itself prove a rename: several branches may share a tip. Wrong refs, detached contexts, and a directory that is merely a subdirectory of main are rejected as implementation contexts. New integration requires a source context distinct from the landing checkout and source branch distinct from the base.

`revise` is explicit reviewed consent to add/remove/reorder a live feature's contract set and change its intended base. It is refused during a live run or unresolved close attempt. `recover` is evidence-only import of a completed feature whose worktree is gone; it validates embedded identity, repository membership, protected refs, candidate/feature trees, and landing reachability, then grants only receipt-verified follow-up/cleanup eligibility, never new execution authority. It does not require the historical worktree or branch to exist. `new-work` is explicit consent to start a new feature on a retained completed context; it creates a new identity and does not reopen the completed feature's receipt or inherit its runs. All three persist a new association revision and are refused on ambiguity without a reviewed selection.

Existing `--branch`, `--change`, and `--resume` remain selectors. When several selectors are supplied they must agree with the registered feature. For multi-contract features, `--change` can locate a containing feature only if unique; it never narrows landing scope. An unassociated interactive close opens adoption review without running sync/archive. An unassociated headless close exits non-zero with the exact explicit adoption command. Naming/sole-change/diff heuristics may propose a contract selection in the launcher, but only accepted review establishes the relationship.

Resolver order: explicit feature ID; verified current context association; unique association selected by explicit branch/change filters; otherwise unresolved candidates. It returns a tagged result with evidence and blockers, not an optional branch string. Invalid explicit selectors never fall through to a different heuristic. Deletion/move/rename leaves the feature visible; rebinding is a guarded recovery action.

**Alternative rejected:** remove the branch-name condition and keep other discovery heuristics. That hides the ownership problem rather than fixing it and can close the wrong branch.

### D4. Durable run links complement immutable execution boundaries

Add optional repository/feature ID, association revision, and reviewed contract IDs/source references to reviewed plans, persisted run metadata, and cleanup-surviving run indexes. Write the link before execution, including for failed/aborted runs, not only after successful compaction. Reader adapters preserve frozen branch/path/start-SHA fields and never reconstruct history by mapping an old path to today's branch.

Spin records the actual created branch/path, with an intent/recovery marker before transfer and a committed association before success output. A partial failure exposes the created worktree and moved files; retry can explicitly adopt that context without allocating a duplicate. Accepted launcher creation follows the same staged pattern; cancellation before acceptance writes no feature record. Reusing an association does not change it merely because a different checkout launched the command.

Feature-linked Apply and Continue carry a complete action target; Iterate uses the associated planning checkout. Continue disables *new worktree creation* rather than relying on an ambiguous isolation label. Archived contracts support reading and close, not another apply run until the operator creates/selects new active work. Multi-change selection is explicit in review.

No-spec publication retains verified run-context selection. Feature-backed publication uses the current associated context and current safety checks, not a historical HEAD as authority. The lease and final checks apply at actual push time; missing tools/auth remain publication-specific blockers, not close blockers. Run compaction still validates its original run boundary even after a feature was rebound.

**Alternative rejected:** use existing run branch fields as the feature registry. Some work has no run, old plans may be temporary, and a mutable branch is not a stable join key.

### D5. Shared pure assessment over typed observations

Introduce a lifecycle module boundary with separate read adapters, identity resolver, pure fact/capability evaluation, and action executors. Initial integration points are `control-board.ts`, `specs.ts`, launcher/CLI, `publish.ts`, and feature-close. Remove the dependency whereby close imports board-specific task helpers; artifact/task observation belongs below both consumers.

An assessment contains:

```text
feature / association revision / observed-at
context: verified | unassociated | ambiguous | missing | unreadable
contracts[]: active | verified-archived | missing | ambiguous | unreadable
tasks[]: done/total | unknown
execution: live run IDs | no-live-runs | unknown
integration: pending | probable | verified(receipt) | stale | unknown
publication: observed remote/upstream/PR facts, each with provenance
cleanup: worktree and branch observations, independently verified
actions[]: { id, applicable, enabled, blockers[], remediation[], target }
```

Action targets include repository/feature IDs, association revision, contract sources, source/base refs, and relevant observed SHAs. Executors acquire mutation coordination and reload fresh evidence before acting; an assessment is an explanation, not a transferable permission token. Adapters return structured read errors. In particular run-discovery failures cannot masquerade as an empty live-run set.

Summary precedence favors recovery/unknown blockers over claimed readiness. Typical presentation:

| Observed facts | Summary | Useful next action |
| --- | --- | --- |
| Candidate without association | Association needed | Adopt or spin |
| Associated, tasks incomplete or run live | In implementation | Continue / inspect run |
| Tasks complete but close blockers | Implementation complete · blocked | Review close |
| All close-start prerequisites pass | Ready to close | Close |
| Verified archive, no verified integration | Implementation complete · archive verified | Review close |
| Patch-equivalent, no receipt | Probably merged | Inspect / archive on main |
| Verified landing, cleanup remains | Integrated locally | Push / guarded cleanup |
| Verified landing and absent cleaned context | Completed | History |

Task checkboxes do not prove tests passed. Archived alone does not prove integration; receipt reachability does not prove remote publication or PR merge. No new hosted polling is added.

**Alternative rejected:** reuse only the existing preflight for rendering. That preflight assumes a resolved active worktree and cannot describe unassociated, archived, removed, or cleanup-only subjects; the shared evaluator must cover discovery through history, with phase-specific prerequisites.

### D6. Read-only discovery and UI actions stay coherent

Discover registered features first, then unassociated active candidates and legacy evidence; enumerate worktrees and sources without granting ownership. Include archived sources referenced by records/attempts and offer explicit archive selection during adoption. Do not flood the default board with every historical archive directory. Registered pending features remain in **Features** even when active directories vanish; registered completed work is accessible through **History**. Run-bearing no-spec contexts stay in **Worktrees without spec** even when they contain copied changes.

Associated artifact inventory always comes from its validated source using absolute paths. Broken association yields missing/unreadable information, not a silent same-slug fallback. Unassociated duplicate sources are readable through source selection without creating records. Board rows and artifact inventories share feature identity keys and source provenance to avoid mixed titles/tasks/targets.

Add a discoverable `Actions` menu in root and ordinary detail, available even when footer hints truncate. Close review remains applicable while integration is pending and shows blocked execution reasons. Fullscreen reader keys remain unchanged; leaving fullscreen restores the selected feature and menu. Provide explicit refresh and refresh after external action return; invalidate artifact/assessment caches together and preserve selection by identity. This change does not add a background daemon or require continuous polling.

Headless listing uses the same assessment. JSON inspection exposes machine-readable blockers, provenance, observed revision, and action targets without performing repair writes. Menu dispatch, shortcut dispatch, and CLI checks consume the same capabilities; no duplicated branch/path gate remains in the renderer.

**Alternative rejected:** always show `x close` and let the command fail. That leaves wrong/missing targets and invisible context transitions unresolved and still provides no path from detail to identity repair.

### D7. Archive is positively verified, including external archive

Introduce one artifact-state reader used by adoption, assessment, and close. Capture original active-contract identity, task counts, delta capability/requirement inventory, and proposal context before invoking OpenSpec. Task completion is required for every contract. For a previously archived contract, find a unique archive candidate tied to the selected ID and explicit source; do not take the latest date prefix as ownership proof. Parse selected paths as paths within the planning root, never interpolate unchecked branch spelling into them.

Archive evidence includes source/archive relative paths, associated feature/contract revision, checked task counts, archive artifact blob identities, canonical-spec requirement effects, and committed feature SHA/tree. Verification requires:

1. The archive source is unambiguous and readable, with the expected change metadata/artifacts and completed tasks.
2. Active/archive coexistence is explained by an in-progress recorded operation; unexplained competing active/archived sources are blocked.
3. Delta effects are represented in canonical specs: ADDED/MODIFIED requirement blocks and scenarios, REMOVED absence, and RENAMED source/destination rules, preserving full capability paths. Normalize only structural Markdown differences; do not substitute an LLM's semantic guess for proof. A verified no-delta change with valid metadata needs no canonical effect comparison.
4. The prepared result is committed and related to the current feature preparation. Recheck after base sync and before candidate creation.

Use a focused deterministic delta/effect verifier shared across these paths, reusing existing OpenSpec parsing facilities where available. It is verification only: OpenSpec CLI remains the artifact writer. If later legitimate canonical changes make exact evidence insufficient, report the conflicting requirement and ask for explicit OpenSpec reconciliation rather than silently weakening verification. Unsupported structures and unprovable external archives stay blocked with source-specific guidance. Completed task evidence remains required even if OpenSpec previously archived with warnings.

For recorded interrupted archive work, expected affected paths/effects are captured before CLI invocation. Resume accepts only the verified intended archive result; unrelated dirty paths stop it before committing. Multi-contract archive proceeds deterministically, preserving a completion record per contract. Archived proposal/capability context feeds message composition after the live directory disappears. When several contracts touch the same requirement, verification is applied over the ordered composed effect with retained per-contract evidence; an unprovable composition stops before the first archive mutation rather than validating each contract against a final tree that another contract already changed.

**Alternative rejected:** `!exists(activeDir)` or merely `exists(archiveDir)`. Neither establishes identity, task completion, or canonical spec synchronization. No automatic “skip verification” flag is introduced.

### D8. Close becomes an identity-keyed recoverable transaction

Keep existing one-parent squash construction and conventional-message review, but persist an attempt before the first mutation and reconcile by observed effects rather than phase name alone:

```text
resolved/reviewed
  → sync intent → sync verified (or conflict recovery)
  → archive intent/result per contract
  → prepared feature tip/tree + preserved message context
  → candidate intent → protected candidate verified
  → landing intent → ref landed → base checkout reconciled
  → immutable receipt
  → independent cleanup intents/results
```

Journals capture expected association revision, source/base refs and SHAs, source/worktree observations, per-contract archive evidence, protected feature/candidate refs, and operation IDs. Save intent before each mutation and result afterward. Required persistence failures stop before the corresponding mutation. Existing record/ref mismatches are errors, not success.

Every close, not just `--resume`, first checks pending attempts and completed receipts. For unchanged verified landed work it returns the original landing plus still-applicable follow-ups; it does not merge the base again, clear the receipt on tree equality, or create another commit. `--resume` selects recovery of the current feature/attempt; a valid current association permits bare resume, and `--feature` permits resume after worktree deletion. Multiple unfinished legacy candidates require explicit selection.

Crash reconciliation rules:

- **During sync:** recorded pre-sync tip/base plus actual merge state identify a conflict or a completed merge. Leave conflicts for the operator; do not rerun a merge blindly.
- **After archive but before commit:** verify intended archive effects and scoped dirt before committing; unrelated changes stop recovery.
- **After candidate creation:** reload protected refs and verify one captured-base parent and exact prepared tree before reuse.
- **After base landing but before receipt:** if the recorded candidate remains reachable from the intended base and the prepared feature context is unchanged, reconcile checkout/evidence and record that landing, including when base advanced afterward.
- **Base moved without candidate:** do not reuse the stale candidate. Offer renewed sync/review with a new preparation/attempt retaining the old evidence, and revalidate archive effects.
- **Feature moved after receipt:** show stale current eligibility. Never silently reland or clean it up; retain the old receipt and require explicit new-work/recovery planning.

Patch equivalence without a receipt remains probable. Direct close must consult that assessment before sync/landing, as the canonical spec already requires. This change does not introduce an “external squash equals verified receipt” shortcut; archive-on-main stays available after deliberate review and verifies the actual base checkout branch. Archive-on-main also verifies the base-checkout copy corresponds to the selected contract before archiving and records the resulting archive source/evidence, leaving integration as probably merged or pending rather than confirmed. When the feature worktree retains its active copy afterward, discovery must prefer the recorded archive source for that contract instead of continuing to report the unarchived copy as current work.

**Alternative rejected:** one mutable journal per branch/change, plus a `landed` boolean. It collides on names, loses generations after rename/reuse, and cannot distinguish a completed Git effect from a missing acknowledgement.

### D9. Guard landing and cleanup at the operation boundary

Reuse the repository mutation lease for association writes, run finalization, close mutation segments, publication, and cleanup. Do not hold it while waiting for message review; persist preparation, release it, and reacquire/revalidate afterward. The lease serializes Convoy only. Git reference updates additionally use expected-old values; landing should atomically verify the prepared feature ref and update the captured base ref through a Git ref transaction rather than rely solely on a prior `baseNow` check plus `merge --ff-only`.

Ref landing and checkout materialization are distinct recorded stages because Git does not atomically update a branch ref, the entire worktree, and Convoy's journal. Record the clean base index/tree/HEAD before landing. Once the guarded ref transaction succeeds, the landing has happened: subsequent failure is checkout/evidence recovery, not a claim that the base is unadvanced. Materialize the candidate into the base checkout only when its recorded branch/index/worktree preconditions still hold, using Git's guarded two-tree checkout/update behavior rather than an unconditional hard reset. If unexpected edits, checkout switches, or external ref movements appear, leave them intact and require reconciliation; block cleanup/publication while this recovery is unresolved. Tests must cover each boundary and no overwrite of unrelated edits.

Both worktree removal and branch deletion reload receipt and association, check landing reachability and exact source tip, verify no live run/recovery, and require consent. Worktree removal uses Git's non-forced removal protections after clean-context checks. Local branch deletion uses an expected-tip ref deletion after confirming no registered worktree checks out the branch; remove branch configuration only after successful guarded deletion, not before. Do not use a separate tip test followed by unconditional `branch -D` as the safety mechanism.

Deferred/headless cleanup prints the feature-keyed guarded `convoy close --feature ... --cleanup ...` commands, with worktree removal before branch deletion and an explicit instruction to leave the source checkout first. These execute the same checks as the TUI, eliminating evidence loss through display-only command objects. A later branch at the same spelling must not be deleted using the old receipt. If both branch/worktree are already absent, record observable cleanup state without recreating them; feature/run evidence remains retained.

**Alternative rejected:** let the TUI carry an old “safe” boolean or an unprotected shell recipe. Eligibility can change after rendering, and shell check-then-delete is not an atomic expected-tip mutation.

### D10. Conservative compatibility and migration

New readers accept current legacy records and distinguish them from stable-ID records. On explicit adoption, inspect embedded journal branch/change fields, repository evidence, protected refs, candidate/feature trees and landing reachability. Never trust a lossy filename alone. Write a new identity-keyed import record with provenance and preserve the original bytes and refs. A collision, unsupported version, or contradictory context stays unresolved. Legacy run links are imported only when their durable evidence and selected association agree; missing boundaries do not become rewrite permissions.

No read-time migration or automatic relabelling of old paths. A new clone or lost common-directory store displays unassociated work and offers adoption; filenames and commit prose cannot recreate proven lifecycle facts. Existing valid local receipts can be recovered explicitly. The registry is local operational metadata, not part of the committed proposal and not shared by pushing a branch.

Canonical purpose summaries that say “no registry” or describe only active-directory navigation must be updated when applying/synchronizing this change, without removing unrelated requirements. The old `finish` lookup example is replaced by Close/Continue context lookup in the worktree delta. Conventional branch creation, location templates, dirty-tree consent, no-spec runs, and automatic run-compaction protections remain compatible.

**Alternative rejected:** transparently write migrated associations during board load. That promotes heuristics to authority without consent and makes inspection mutate the repository's operational state.

## Risks / Trade-offs

- **Local association metadata can be lost or copied between clones** → Validate repository identity/common directory and current Git membership; expose recovery/adoption instead of silently granting authority. No cross-machine identity guarantee in this scope.
- **Explicit adoption adds a one-time step for old work** → Pre-fill evidence-backed suggestions and show all fields together; new spin/accepted launch registers automatically. Refuse only uncertain mutation, not reading.
- **Strict archive verification can block legitimate evolved specs** → Name the exact unproven delta effect and retain all artifacts; require OpenSpec reconciliation rather than guessing or editing specs inside Convoy.
- **Multi-contract close can partially archive before a later failure** → Persist per-contract intent/result, stop before landing, and resume with verified effects. The confirmation always states whole-branch scope.
- **A shared assessment could become an expensive monolith** → Separate pure policy from adapters; batch worktree/run discovery and memoize only within one observation snapshot. Explicit refresh replaces caches, and execution always rereads required evidence.
- **External Git/filesystem actions do not honor Convoy's lease** → Expected-ref transactions, registered-context checks, Git's non-forced checkout/removal protections, durable intent, and recovery on divergence. Never advertise complete cross-process filesystem atomicity.
- **Ref landing succeeds while checkout/receipt update fails** → Model landing and checkout recovery separately, preserve candidate refs, block follow-up mutation until reconciliation, and fault-inject both sides of every acknowledgement boundary.
- **Stable identity is mistaken for history-rewrite permission** → Keep run boundaries immutable and compaction guards independent; rebinding never rewrites old run metadata or loosens publication safety.
- **Large cross-cutting rollout leaves a mixed model** → Land implementation in dependency order but switch user-facing resolution only when all action consumers share the resolver; enforce end-to-end invariant tests before release.

## Migration Plan

1. Add versioned readers/store and shared observation/resolution APIs with legacy records still readable. Introduce explicit feature inspection/adoption/rebinding and test typed corruption/ambiguity paths.
2. Wire registration into spin and accepted launch; persist feature/run links before execution. Preserve no-spec flows and cancelled-preview behavior.
3. Replace board ownership, artifact resolution, handoffs, action menus, refresh, and publication selection together. Legacy candidates remain visible with one-time adoption guidance.
4. Migrate close execution to stable attempt identity, positive archive verification, immutable receipts, guarded landing/recovery, and shared cleanup executors. Import legacy evidence only through explicit validated adoption.
5. Run lifecycle scenario, crash-boundary, concurrency, compatibility, typecheck, and full-suite coverage; document the local-record contract, archive/integration distinctions, and guarded commands. Synchronize delta specs and their outdated purpose summaries through the normal reviewed OpenSpec workflow.

**Rollback:** retain legacy evidence and all new protected refs; never delete operational history as part of a downgrade. A pre-change binary cannot safely interpret new feature associations/attempts, so downgrade requires stopping writers and resolving pending transactions with the newer binary first. Read-only Git/OpenSpec inspection remains available. Do not describe rollback as transparent compatibility or automatically convert new receipts to lossy old keys.
