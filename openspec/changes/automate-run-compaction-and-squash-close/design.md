## Context

See `proposal.md` for motivation and the three delta specs for behavior contracts.

Current implementation facts that materially change the earlier conversational outline:

- `finish.ts` selects a suffix by `convoy@local` identity, ignoring run ownership, then soft-resets and commits as the operator. It is not an exact per-run operation. `step-commit.ts` already writes authoritative `Convoy-Run` trailers, but metadata does not persist an immutable run-start HEAD or full writable-phase commit ledger.
- `feature-close.ts` syncs the local base into the feature, archives with OpenSpec, folds a special authorship range, and performs an ordinary merge. Preserving operator commits is explicitly required by the existing feature-close spec; this change replaces that contract.
- The coordinator owns production execution with no interactive stdin. Today's manual finish is client-side and can suspend a TUI for signing; moving it into the runner is not a terminal handoff.
- Runner success hooks can fail fatally or mutate/publish the repository. Goal settlement can restore an earlier measured tree. Both affect the safe final interval.
- Existing saved input diffs are cumulative and conditional, successful workspaces can be deleted, and `refs/convoy/finish/<branch>` is overwritten by later finishes. These are insufficient evidence for the promised per-run recovery.
- Squash merges do not establish feature ancestry in the base. Equal trees neither prove a past close nor safely authorize later `branch -D`. A local squash landing also does not guarantee that GitHub marks an existing PR merged.

## Goals / Non-Goals

**Goals:**
- Separate current-run rewrite policy from whole-feature landing policy; share safe Git primitives, never the range selector.
- Make automatic compaction mandatory as a lifecycle attempt, not unconditional permission to rewrite unknown history.
- Preserve exact inspectable intermediate work before changing refs and keep recovery independent of disposable run workspaces.
- Keep completion, attach, resume, publication, and cleanup consistent through durable state and optimistic Git identity checks.

**Non-Goals:**
- No configurable finish step, squash strategy, preserve-commits option, fork-point override, new manual finish command, automatic PR/push, or force-push.
- No replacement for interactive Git conflict resolution, no full interactive terminal broker for detached coordinators, and no automatic bypass of hooks/signatures.
- No rewrite of independent human/foreign-run commits during automatic run compaction; feature close still includes their content.
- No automatic remote feature-branch deletion, hosted PR merge, or claim that a local landing proves hosted PR completion.
- No retroactive rewrite of historical runs or guarantees for recovery objects that were already deleted before this change.

## Decisions

### D1. Finalization is a lifecycle epilogue, not pipeline YAML

Use a dedicated `Compact run` row with a stable lifecycle identity separate from agent-step names. It is visible in live/attached/historical dashboards but cannot be targeted by `--only`/`--skip`, configured, or run as a goal fragment. The YAML goal step remains terminal among configured steps; no goal-subflows contract needs to change.

Order: all phases and any existing run report → final goal settlement → existing summary/score preparation → existing success post-hooks → automatic finalization → final completion/status/notification → coordinator finish hold → disposable cleanup. Do not synthesize a missing report agent. Append finalization results to durable summaries after the operation.

This deliberately corrects the earlier outline's promise that all success hooks would see a compacted branch: a fatal post-hook failure must still count as failed execution and must prevent automatic compaction. Hooks that publish intermediate commits can therefore block compaction. Document migration to the deliberate Create PR action for that workflow; do not silently reorder hooks or rerun them to recover finalization.

Normal goal termination (including plateau/cap/no-score where execution currently succeeds) is execution success; target attainment remains a separate existing outcome. Finalize only surviving history after restoration, once per logical run. Same-run resume preserves its original boundary. A new run receives a new boundary even on the same branch.

Alternative rejected: reuse `prepareFinish` when the dashboard opens or inject a YAML agent step. Either makes history mutation depend on having a client, permits duplicate/filtered execution, or conflicts with terminal goal semantics.

### D2. Persist run ownership before any run-owned mutation

Add versioned durable metadata for repository common-dir identity, worktree/branch identity, initial HEAD, accepted include-dirty policy, and an ordered phase/attempt ledger (before SHA, after SHA, tree IDs, run/step identity, no-change/read-only marker). Initialize before pre-hooks and phases; if this prerequisite cannot be persisted, refuse to start writable execution. Record Convoy-mediated human/recovery commits under the same run. Preserve the record across resume; never infer a missing legacy boundary solely from author email.

Eligibility requires a clean, verified branch and a fully accounted-for linear interval from the run-start HEAD to the surviving final HEAD. Each replacement commit must match current-run recorded ownership and its authoritative trailer. Independent user commits, foreign-run commits, unexpected merge parents, hook-created commits, or unaccounted mutations block the whole operation. Do not compact just a suffix and report success. A pre-hook that deliberately changes history is allowed by existing hook policy, but it can make automatic compaction unsafe; close remains available.

Zero current-run commits: skip without writer or ref mutation, even above older Convoy commits. One non-empty current-run commit: still normalize to an operator-authored conventional commit. For any non-empty verified interval with zero net tree difference, regardless of commit count, save evidence and remove the interval back to the start HEAD without manufacturing an empty user commit; persist `state: completed`, `disposition: no-net-change`, and no produced commit. Accepted `--include-dirty` content belongs to its first Convoy-owned commit, with that initial consent recorded.

Alternative rejected: reuse the authorship walk with only an added merge-base floor. Merge-base is a feature boundary, not a run boundary, and would absorb prior failed runs or mutate historical work after a read-only run.

### D3. Recovery evidence survives both compaction and normal retention

Store a compact recovery manifest/journal in the repository's Git common-dir (not tracked project files), with a cleanup-surviving run index at `<convoy-home>/run-records/<run-id>.json` containing repository identity, manifest location, run summary, and finalization status. `<convoy-home>` follows the existing `CONVOY_HOME`/default resolver. Extend run discovery to merge these records with legacy workspace metadata so deleting a disposable workspace cannot lose the manifest's discoverability. Give every run a private protected namespace such as `refs/convoy/runs/<run-id>/...`, with create-only refs for original phase/attempt tips and a separate pre-compaction tip. Convoy must use expected-absent ref creation and never overwrite these evidence refs; external deletion of repository metadata is outside this guarantee. Retain before/after commit endpoints and parent information; refs keep their trees/blobs reachable through ordinary GC. Goal-discarded attempt tips must be protected before best-state restoration. No-change and read-only attempts have explicit records rather than invented diffs.

Run history must survive ordinary successful-workspace cleanup at least as a metadata/finalization/commit-ledger record. Existing full transcript/report retention settings can remain, but must not delete the recovery manifest or protective refs. Historical views offer exact endpoint diffs or quoted `git diff <before> <after>`/`git show` commands, plus a safe recovery-branch instruction. Do not advertise an unconditional hard reset of a branch that may have advanced. Legacy branch-level finish backups are left untouched; new runs never overwrite each other's recovery refs.

This change adds no automatic recovery GC. Explicit user deletion/retention operations must name the lost recovery scope; deleting the whole repository is outside the guarantee. Failure to durably retain required evidence blocks a rewrite.

Alternative rejected: trust `*.pre.diff`, reflog expiry, or one backup ref per branch. None preserves independently inspectable history across multiple runs, cleanup, and GC.

### D4. Guarded, unattended run rewrite with its own outcome

Use a repository-scoped mutation lease shared by finalization, close, and Convoy cleanup/publication mutations, in addition to existing per-run leases. External Git does not honor that lease, so all operations still revalidate expected refs, worktree/index state, and commit ancestry immediately before mutation. Known running Convoy work in the same execution worktree blocks rewriting; the lease is not a claim that arbitrary external edits are impossible.

Before compacting, query advertised branch heads for every configured remote using bounded, non-interactive read-only remote Git. Test replacement commit reachability against those heads. If remote objects are missing locally or remote state cannot be verified, block with fetch/authentication guidance rather than assume unpublished; do not implicitly fetch, push, or modify remote-tracking refs. Local upstream configuration alone is neither proof of publication nor a reason to block. With no remotes, local provenance/cleanliness guards suffice. This guards known/current publication; remote changes after the check cannot be globally locked, so no absolute guarantee about concurrent external publication is claimed.

Journal expected original head/index/tree, target parent, backup refs, proposed message, and transaction phase before starting a rewrite. Reuse soft-reset/commit semantics only inside this guarded transaction, with immediate checks and awaited writes. On a failure, restore original HEAD/index only when the checkout still matches the operation-owned intermediate state; otherwise preserve evidence and mark recovery required, never hard-reset concurrent edits. Crash reconciliation examines expected original, staged, and committed states before a same-run resume can proceed. Persist a resulting commit immediately; recognize an already-created result by parent/tree/message/transaction evidence rather than squash it again.

Run signing/hooks retain normal user identity and configuration. Add a bounded non-interactive commit executor; do not reuse `commitAsUser`'s current unbounded inherited-terminal spawn for automatic finalization. All subprocesses used in this unattended finalization path (including writer and publication probes) have bounded deadlines; start with a fixed 120-second Git operation deadline, closed stdin, disabled terminal credential prompts, captured diagnostics, and process-group termination/reaping on timeout. Do not add a configuration toggle or fall back to unsigned/no-verify commits. Signing already available non-interactively remains usable; interactive-only signing can fail visibly. A terminal broker is explicitly out of scope. This closed-stdin policy does not apply to interactive close: its candidate commit retains the existing `withTerminal` suspension path for operator signing/hooks.

Persist finalization separately as pending/running/completed/skipped/blocked/failed with reason, replacement count, produced commit/message, backup/manifest reference, and recovery-required flag. Execution success and exit status remain successful for safely blocked/rolled-back compaction; summaries and dashboards must say `execution succeeded; compaction blocked/failed`, not an unqualified clean finish. Unreconciled transaction state disables PR publication. Failed execution never triggers a new compaction attempt, although recovery must reconcile any already-started transaction before further work.

Alternatives rejected: silently disable signing, block on a client confirmation, or run a best-effort reset without a journal. All violate either full automation or preservation guarantees.

### D5. A deliberate, current-branch PR action replaces all manual finish surfaces

Remove `finish-command.ts`'s public execution path, CLI flags/help, `[f]` shortcut, finish modal, standalone run push choice, and the finish-dependent PR gate. A small retired-command diagnostic must recognize `convoy finish` only to fail before it can be treated as a prompt; it is not a compatibility command.

Expose `Create pull request` as the sole publication action in the run palette, not the sole palette item overall. Keep browsing, sessions, reports, Git inspection, and navigation. Persist the compaction result/message so PR setup does not call the old range resolver and fail with 'nothing to squash'. Historic views are read-only until a deliberate publication action; that action resolves the current branch/worktree again and does not assume it still equals the old run's output.

Disclose repository, current feature branch, remote destination, and base in the action context. Resolve an existing upstream/PR remote when unambiguous, otherwise the unique repository remote; ambiguous remotes require an explicit destination choice before publication, not a guessed push. Disable for the base branch, unresolved recovery, dirty/detached/missing worktree, missing `gh`, or unavailable authentication. A missing `gh` must yield installation/manual `gh pr create` guidance, not the claim that a nonexistent binary is an executable alternative.

On deliberate selection: revalidate → normal push to the disclosed destination with an explicit refspec → locate/create PR and return URL. Never force on non-fast-forward rejection. Query/reuse an existing matching PR. If push succeeds but PR creation fails, preserve that outcome and allow retry without duplicate PR creation. A published uncompacted branch is legitimate. Compose PR text from the persisted run result when still applicable, otherwise current branch plus run-summary context. Creating a PR never marks an unmet quality goal as reached.

Alternative rejected: keep the CLI as a repair escape or hide push behind an automatic post-run action. The user explicitly removed manual finish and reserved publication for deliberate PR creation.

### D6. Close stages a true squash result and lands one regular commit

`close` resolves a safe local base branch and computes the Git merge-base relationship; no user-specified fork-point or preserve mode exists. Refuse unrelated/ambiguous relationships rather than fall back to HEAD. A historical branch creation timestamp is not a Git fork-point contract. After sync the merge-base with the captured base is its tip; this is expected. Use base-exclusive reachability for subjects/counts and an aggregate tree diff for content, not a first-parent author walk or a promise about original commit counts already erased by run compaction.

Sequence: preflight both worktrees and unresolved transactions → persist close identity/context → sync the captured local base into feature → snapshot proposal/capabilities/full feature context → OpenSpec archive and additive archive commit → compose/review → stage a squash-merge candidate → land → persist receipt → optional cleanup. No implicit fetch/pull is added to sync; report that it uses the local base. Existing `--message` and headless acceptance behavior stay. Preserve message context before archive in the durable close journal for resume.

Do not reset or squash the feature branch. The prepared final tree must include the synchronized base, complete feature content, conflict resolutions, and archive output. Create a regular commit whose parent is the captured base and whose tree is that prepared tree. To avoid leaving the operator's main index half-staged on hook/signing failure, use a private detached integration worktree at the captured base for `git merge --squash <captured-post-archive-feature-tip>`, staged-secret scan, and the operator-signed/hooked candidate commit. The captured tip here is explicitly the post-archive tip, never the original pre-sync/pre-archive tip. Do not suppress hooks/signing in this worktree; path/environment-sensitive hooks may fail honestly. Verify candidate parent/tree and clean state after hooks before landing.

With the main checkout still clean and on the exact captured base, advance it to the single verified candidate with a guarded fast-forward-only update. This is NOT fast-forwarding to the feature tip: the candidate is a new one-parent squash commit on base, so base history receives exactly one commit. The final update must fail on stale expected base state; never fall back to an ordinary merge or force update. Retain a protected candidate/journal until the landing receipt is durable.

If the base moves during sync, archive, message review, candidate creation, or landing, stop rather than merge against a moving name. Resume must re-sync against the new base and revalidate canonical archive output using OpenSpec's supported validation path, preserving prior snapshot inputs without rerunning an already-completed archive blindly. Invalid or conflicting canonical output requires explicit repair. Once the candidate is created it may be rebuilt against a newly validated base only as a new journal attempt, never reused silently with a stale parent.

An identical prepared/base tree produces `no-content-to-land`, not an empty commit or proof that a close previously occurred. No automatic destructive cleanup is enabled from that alone.

Alternative rejected: squash the feature to its fork then ordinary-merge. That can introduce a merge commit and rewrites published history unnecessarily. Also rejected: assume sync guarantees conflict-free landing forever; it only integrates a particular base SHA.

### D7. Landing receipts replace ancestry guesses for resume and cleanup

Persist a versioned close journal/receipt in the Git common-dir keyed by repository, feature branch, and change identity. Include attempt ID, captured base, original and post-archive feature tips, prepared tree, message context, candidate SHA, landing SHA, and transaction phase. Save candidate identity before advancing base. On restart, a candidate already reachable from the recorded base branch can complete a receipt without creating another commit. Uncertain states stop with concrete recovery evidence rather than discard a staged/candidate tree.

At the start of `close --resume`, before any sync or task/archive mutation, check for a completed receipt for the unchanged feature tip with landing still reachable from base. If found, skip completed work and proceed to safe cleanup, even when base has advanced or trees no longer match. Resolve this receipt by branch/change identity before requiring a feature worktree: a removed worktree must not prevent resuming remaining branch cleanup. An already-deleted branch is recorded as cleaned, not recreated. A changed feature tip or non-reachable/reverted-by-history-rewrite landing invalidates that cleanup authorization and requires explicit inspection/new close planning. Content reverts committed later do not erase the fact of a historical landing, but are not proof a fresh feature should be landed again.

Without a receipt, keep existing external patch-equivalence signals probabilistic and retain archive-on-main. Direct close must consult this signal before sync/landing: probable external landing stops for inspection or deliberate archive-on-main instead of treating uncertain evidence as permission to land again. Absence of patch-equivalence evidence is not proof that no external squash occurred; document the detector's limits. Integrate receipts into the board where definite local close state is required; do not upgrade a hosted PR to merged from local Git evidence. Disclose known remote branch/upstream context factually; close does not need to contact a remote or block merely because a feature is published.

Cleanup remains explicit: normal base push, clean worktree removal, then local branch deletion. A squash-landed branch often fails `branch -d`; permit `branch -D` ONLY after checking receipt authenticity, exact current feature tip, landing reachability, and worktree cleanliness/removal under the mutation lease. Recheck at action time. Protect intermediate history with retained run refs and a close-specific feature-tip ref before deletion.

Headless and inside-worktree deferred commands must embed expected tip/landing guards and safe shell quoting before removal/deletion; never print an unconditional `git branch -D`. If guards cannot be expressed/verified safely, give inspection guidance and withhold deletion. Expected refs must be rechecked immediately before deletion, not just before earlier worktree removal. No remote branch deletion is included.

Alternative rejected: tree equality plus unconditional force-delete. Equality cannot identify the attempt, survive later base changes, or protect new work on the feature branch.

### D8. Presentation and compatibility are part of the change

Persist/transport the lifecycle row and its message/result through runner → coordinator/control → live attach → historical reconstruction. Do not reuse an interactive-only `FinishSeam` that performs Git work in the client. Show pending/running and precise skip/blocked/failure reasons, plus recovery/inspection links. Preserve agent/goal phase totals and identities; a lifecycle row must not masquerade as a model invocation or acquire configurable prompt/report routing.

Close checklist becomes sync, archive, squash-merge with compose/review/create substates. Remove the old merge-shape type/events and collapse dual success narration into one landing result. Preserve inline message editing, cancellation, terminal suspension for interactive close signing, cleanup dependencies, and failure readability. Update CLI help, `--dry-run` narration, launcher copy, README, configuration comments, and historical compatibility readers together.

New capability `run-finalization` owns the lifecycle/palette contract. Existing `run-launcher` only specifies dirty-tree gates, which do not change; no artificial delta is added. `step-commit-messages` replaces its legacy shared author-walk requirement. Existing goal configuration remains untouched.

## Risks / Trade-offs

- **More than a UI change** → Run-start boundaries, durable evidence, transaction safety, and coordinator integration are prerequisites, not optional polish. Do not ship automatic rewriting first and add recovery later.
- **Unattended signing or hooks may fail** → Fixed bounded execution, no bypass, separately reported finalization outcome, and safe PR/close workflows remain available. Private integration worktrees can expose hook assumptions about ignored build artifacts; surface these failures rather than disable hooks.
- **Conservative publication verification may block offline runs' compaction** → Execution still succeeds; remote inspection never forces a push, and feature close remains author-independent. Document the offline trade-off.
- **Preserving independent user commits can prevent one-commit-per-run** → Block clearly instead of silently changing scope. Feature close is where all authors' feature work is intentionally consolidated.
- **Retained refs consume storage** → Compact manifests plus Git object reachability rather than duplicate full worktrees. No automatic expiry until explicit deletion semantics exist.
- **External processes can bypass Convoy locks** → Expected-ref, branch, index/tree, and dirty-state guards on each mutation boundary; preserve evidence on ambiguity. Do not claim atomicity across arbitrary user Git processes.
- **Hooks may publish before finalization** → Preserve current fatal-hook semantics by finalizing afterward; public documentation recommends the deliberate PR action instead of publication hooks for automatically compacted branches.
- **Local squash merge and hosted PR state can differ** → Return factual local SHA/remote push results and an existing PR URL, never a synthetic hosted merged state.

## Migration Plan

1. Add versioned boundary/ledger/finalization/receipt readers with backward-compatible missing-field handling; preserve legacy finish backups and old run readability. Do not auto-compact legacy history without reliable evidence.
2. Implement durable recovery/transactions and safety tests before wiring the automatic lifecycle mutation. Add the finalization row and independent PR path through live and historical clients.
3. Replace close's landing strategy and cleanup evidence, then remove its special author-range walkers and merge-shape presentation.
4. Remove the public finish command/modal/push flow and update all help, errors, docs, and migration notes in the same release. No compatibility execution shim or configuration toggle is introduced.
5. Verify the acceptance matrix across local and bare-remote fixture repos, coordinator/headless and attached clients, crash injection, goal restoration, and published/unpublished histories. Ordinary full test/typecheck runs are required during implementation, not during this planning workflow.
6. Rollback strategy: a code rollback must preserve new metadata/refs and any committed landings. Do not rewrite branches automatically to restore old UX. An operator can inspect protected pre-compaction/feature refs on a recovery branch. Reverting a published landing is an ordinary explicit Git revert, never a force-push. Downgraded tooling must not be trusted to resume new-format in-flight transactions.
