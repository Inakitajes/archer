## 1. Durable run boundaries and recovery evidence

- [x] 1.1 Add versioned run-boundary, phase/attempt-ledger, finalization-state, and recovery-manifest types with backward-compatible readers; verify round-trip and missing-field tests preserve legacy run readability and distinguish pipeline result from compaction result.
- [x] 1.2 Persist execution repository/worktree/branch identity, run-start HEAD, and include-dirty consent before pre-hooks or writable execution; verify failure injection prevents writable startup when that boundary cannot be saved and same-run resume never replaces it.
- [x] 1.3 Record before/after commit endpoints and current-run provenance for writable phases, accepted human iterations, and interrupted-phase recovery; verify semantic multiline/trailer fixtures and no-change/read-only ledger entries.
- [ ] 1.4 Protect run and goal-discarded attempt tips with create-only per-run refs before rewrite/restoration; verify a two-run fixture retains independently inspectable before/after diffs after best-state restoration and ordinary Git garbage collection.
- [ ] 1.5 Add the cleanup-surviving run index and Git-common-dir manifests, extending run discovery beyond disposable workspace metadata; verify ordinary successful cleanup preserves history discovery, finalization evidence, and exact Git inspection commands without requiring retained transcripts.

## 2. Safe automatic compaction engine

- [ ] 2.1 Introduce repository-scoped mutation coordination and expected-ref/index/tree guard primitives for finalization and close; verify competing Convoy operations serialize and simulated external HEAD/branch/dirt changes cause refusal without overwrite.
- [x] 2.2 Replace automatic range selection with verified current-run boundary plus ledger/trailer ownership; verify previous successful/failed runs, independent operator commits, foreign commits, unknown merges, and missing legacy evidence are never included by authorship alone.
- [x] 2.3 Handle zero, one, multiple, and net-zero current-run intervals; verify a report-only run above older machine commits changes no refs or writer state, one non-empty commit becomes operator-authored, and a net-zero interval records completed/no-net-change without an empty commit.
- [x] 2.4 Add bounded read-only remote-head publication verification covering all configured remotes without implicit fetch; verify bare-remote fixtures allow unpublished new commits above a published ancestor, block replacement of published commits, and fail closed on unavailable or missing remote evidence.
- [ ] 2.5 Implement a bounded unattended operator-commit executor preserving identity, signing, hooks, and staged-secret checks; verify no stdin interaction, no unsigned/no-verify fallback, timeout process cleanup, secret refusal, and captured diagnostics with executable test doubles.
- [x] 2.6 Journal backup/message/expected-state checkpoints around the guarded rewrite and reconcile interruption; verify injected stops before reset, after reset, after commit, and before final metadata cannot duplicate compaction or discard concurrent work.
- [ ] 2.7 Persist complete/skipped/blocked/failed outcomes and recovery-required state independently from execution success; verify safely blocked/rolled-back compaction leaves execution successful while unresolved transactions disable publication and expose precise recovery guidance.

## 3. Runner and coordinator lifecycle integration

- [ ] 3.1 Invoke finalization once after phases, goal settlement, and successful existing post-hooks but before final completion/notification/cleanup; verify ordinary and hosted-run event-order tests and fatal-hook/abort cases do not compact.
- [ ] 3.2 Integrate goal-restored histories and same-run resume without altering configured terminal-goal rules; verify initial goal success, plateau/cap/no-score normal stops, restored earlier trees, and resumed attempts each yield at most one logical finalization result.
- [ ] 3.3 Add the non-configurable `Compact run` lifecycle identity and reject filter/config attempts to target it without reserving ordinary agent names accidentally; verify custom pipelines remain unchanged and lifecycle rows cannot be skipped or repeated as goal fragments.
- [ ] 3.4 Carry finalization state/result/message and recovery references through progress/control snapshots, run summaries, and durable history; verify late attach, coordinator exit, and stopped-run reconstruction show identical results without launching another rewrite.
- [ ] 3.5 Render the terminal lifecycle row with explicit skipped/blocked/failed reasons and recovery/inspection links in TUI and headless output; verify dashboard/key-driver snapshots retain ordinary inspection actions and do not miscount lifecycle work as agent/goal phases.

## 4. Independent Create pull request action and finish removal

- [ ] 4.1 Implement current-branch PR preparation independent of the removed manual squash seam, using persisted result text only when still applicable; verify historical/newly changed branches are revalidated and base/dirty/detached/missing/recovery-required states disable publication.
- [ ] 4.2 Resolve and disclose repository, remote/refspec, branch, and base without guessing ambiguous destinations; verify existing upstream, unique remote, multi-remote selection, missing `gh`, and authentication-remediation cases with non-publishing doubles.
- [ ] 4.3 Implement deliberate normal-push then locate/create-PR sequencing; verify push rejection never force-pushes or creates a PR, existing PRs return their URL, and push-success/PR-failure retries do not duplicate publication.
- [ ] 4.4 Replace run finish/push follow-ups with only the Create pull request publication entry while retaining navigation/inspection; verify successful compaction and safely blocked compaction both offer the action when its own preconditions hold and headless completion publishes nothing.
- [ ] 4.5 Remove the public finish command, legacy flags/help, shortcut/modal, and execution seam from CLI, runner, attach, and TUI surfaces; verify `convoy finish` and old options produce an actionable non-zero retirement diagnostic before any prompt/run/repository side effect, with no compatibility squash path.

## 5. Close transaction and true squash landing

- [ ] 5.1 Add versioned close journals/receipts and target resolution that checks completed receipts before requiring a worktree; verify a fresh close, resume after archive, resume after worktree removal, and already-deleted local branch are distinguished without recreation.
- [ ] 5.2 Move main-checkout cleanliness/local-base checks into preflight, derive the fork relationship solely through Git merge-base, and disclose remote context factually; verify published features are permitted, unrelated/ambiguous bases are refused, and preflight failures leave both worktrees unchanged.
- [ ] 5.3 Keep additive local-base sync and CLI-owned archive while pinning base/post-archive feature revisions and preserving full message inputs; verify no fetch/pull occurs and resume after archive/cancel retains proposal/capability/all-feature subjects.
- [ ] 5.4 Build the squash candidate in a private integration worktree from the captured post-archive feature tip, retaining secret scanning, operator hooks/signing, and interactive close terminal suspension; verify the candidate has exactly the pinned base parent and prepared tree, including archive output and every author's feature content.
- [ ] 5.5 Land only the verified one-parent candidate on an unchanged clean base, with candidate protection and awaited receipt persistence; verify a fixed-base and advanced-base fixture each gain exactly one regular commit and preserve all original feature commit identities.
- [ ] 5.6 Add stale-base/feature guards and resume integration/archive-result revalidation; verify movement during review, candidate creation, or final update stops safely without a fallback ordinary merge or a stale candidate landing.
- [ ] 5.7 Reconcile crash points before/after candidate creation, base advancement, and receipt persistence; verify successful landing is recognized after later base advancement, hook/signing failures leave base unadvanced, and identical trees without a receipt report no-content rather than authorize deletion.
- [ ] 5.8 Remove close's authorship/sync-specific range walkers, pending-sync-merge discovery, and ordinary merge-shape result types; verify no code path can preserve intermediate feature commits in new base history or rewrite published feature commits.

## 6. Close presentation, merged detection, and safe cleanup

- [ ] 6.1 Replace separate squash/merge checklist rows with squash-merge compose/review/create substates and landing SHA/base narration; verify TUI animation, inline edit/save/cancel, explicit `--message`, headless formatting, and dry-run output retain their intended behavior without merge-shape text.
- [ ] 6.2 Feed verified receipts into board/direct-close merged detection while retaining probabilistic external evidence; verify direct close stops on probable external landing, archive-on-main remains deliberate, and no local landing/push claims a hosted PR was merged.
- [ ] 6.3 Gate worktree removal and local `branch -D` on receipt, exact current tip, landing reachability, cleanliness, and worktree-removal ordering; verify changed tips, new dirt, missing evidence, or changed base history block deletion and retained feature refs survive successful cleanup.
- [ ] 6.4 Generate guarded, quoted deferred/headless cleanup commands with expected-tip checks immediately before deletion; verify paths/branches with shell-sensitive characters, invocation from inside the feature worktree, and mutation between removal and deletion never produce an unconditional destructive continuation.
- [ ] 6.5 Preserve optional normal base push and missing-upstream guidance without remote feature deletion; verify rejected pushes never force and cleanup resume after worktree removal offers only remaining evidence-backed actions.

## 7. Documentation and migration

- [ ] 7.1 Rewrite README/help/launcher/config-model descriptions for automatic Compact run, independent Create PR, and always-squash close; verify current user guidance no longer instructs pressing finish or promises preservation of operator feature commits on the base.
- [ ] 7.2 Document hook ordering, safe compaction refusal, non-isolated runs, bounded unattended signing, remote-verification/offline behavior, retained history, and receipt-gated cleanup; verify each documented failure/recovery path refers to a supported action rather than the retired command or unconditional hard reset.
- [ ] 7.3 Document migration/rollback for existing runs, legacy backup refs, published PR branches, and new-format in-flight transactions; verify legacy reading fixtures remain valid and migration never rewrites history or marks hosted PRs merged automatically.

## 8. Cross-flow acceptance and verification

- [ ] 8.1 Add an end-to-end two-successful-runs → Create PR → close fixture against a local bare remote; verify one commit per eligible run, one regular feature landing on base, normal pushes only, unchanged published feature ancestry, and exact retained intermediate diffs.
- [ ] 8.2 Add cross-flow blocked-auto-compaction → successful close and operator-only-feature scenarios; verify close never depends on author-based eligibility or a manual finish command and the base result is one commit whenever the aggregate change is non-empty.
- [ ] 8.3 Exercise standalone/headless/coordinator/attach/history and crash-resume paths in hermetic integration tests using Git/OpenSpec/model/signing/PR doubles; verify no real remote publication, unavailable interactive input cannot hang, and removed commands never start implementation runs.
- [ ] 8.4 Run `bun run typecheck` and `bun test` after implementation, resolve regressions in existing finish/close/runner/goal/control/TUI tests, and record exact commands/results; verify the delta scenarios are covered and no force-push invocation or old executable finish path remains.
- [ ] 8.5 Run `openspec validate automate-run-compaction-and-squash-close --strict` and review the final implementation diff against the three capability deltas; verify all implementation tasks have evidence before requesting archive, without archiving automatically.
