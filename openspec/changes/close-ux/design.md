# Close UX — Design

## Context

`convoy close` is currently a headless driver: `runClose` performs preflight → sync → archive → squash → merge and `runCloseCommand` explains the outcome afterward, with cleanup printed as raw git commands. The squashed commit defaults to `` `${branchPrefix}: ${changeID}` `` even though `src/commit-message.ts` already contains the read-only conventional-commit writer used by `convoy finish`. The archive step moves the proposal and delta specs before the squash runs, so message context must be captured before that mutation. The TUI stack already provides progress rendering, finish's deliberate follow-up pattern, and `editMessageInEditor`.

## Goals / Non-Goals

**Goals:**

- Produce a hand-written-looking conventional commit with enforced capability scope, readable imperative subject, and the change id in the body.
- Keep the local close sequence observable and report its merge shape.
- Offer cleanup safely when interactive while preserving a scriptable, factual headless path.

**Non-Goals:**

- Changing `convoy finish` beyond inheriting the new default writer model.
- Adding `--no-ff` or changing merge policy; fast-forward remains preferred when possible.
- Waiting for GitHub Actions or other remote CI checks; this surface covers the local close sequence and its optional push.
- Redesigning the board, archive-on-main remediation, or the squash walk itself.

## Decisions

### D1 — Snapshot message context before archive, then compose and normalize

Before `openspec archive` moves the live change, close snapshots the proposal excerpt, change id, touched capability set, and collapsible commit subjects. After archive has committed its result — when the final diffstat exists — close sends that snapshot plus the diffstat to `proposeCommitMessage`.

The model output is a proposal, not authority. Close normalizes it after parsing: exactly one touched capability replaces the proposed scope; zero or several capabilities remove it; the change id is injected into the body. The deterministic fallback uses the normalized branch type, the same scope rule, and a type-appropriate imperative verb plus the normalized proposal title (`feat`/`perf` → `improve`, `fix` → `fix`, `refactor` → `refactor`, `docs` → `document`, `test` → `test`, all others → `update`). Its body begins with `change <change-id>` and then includes collapsed commit summaries.

An explicit `--message` is authoritative and bypasses composition, normalization, and model startup.

Alternatives: model-only (rejected — close must complete offline and during model outages), pure deterministic (rejected — slug-derived messages caused the current problem), reading context after archive (rejected — the live path has moved and archive layout naming is an implementation detail).

### D2 — Default writer model: `openrouter/z-ai/glm-5.3-flash`

`defaultCommitMessageModel` moves from `anthropic/claude-haiku-4-5` to `openrouter/z-ai/glm-5.3-flash`. The implementation verifies that the id passes the existing model parsing/resolution path; a runtime provider failure still degrades to D1's fallback. The id is pinned here rather than in the spec because model ids change faster than requirements. `finish` inherits the switch automatically; nothing else about its flow changes.

### D3 — Observation and user decisions use separate interfaces

`runClose` keeps the sequence logic and accepts two independent collaborators:

- `onEvent(event): void` receives one-way state (`step-started`, `step-completed`, `step-skipped(reason)`, `step-failed(step, remediation)`, merge shape and final result) for either renderer.
- `resolveMessage(proposal): Promise<message>` is the two-way gate before `applySquash`: TTY asks accept/edit; headless accepts the proposal unchanged; `--message` avoids the callback entirely.

This keeps rendering observable without making an event subscriber responsible for controlling the sequence. The TTY checklist and headless formatter consume the same event stream, so narration has one source of truth.

### D4 — Message editing reuses finish's editor flow

The TTY resolver shows the normalized message and offers accept / edit. Edit delegates verbatim to `editMessageInEditor`: same GIT_EDITOR/VISUAL/EDITOR resolution, git comment-line stripping, and subject/body split already used and tested by finish. No second editor implementation is introduced.

### D5 — Fast-forward stays, and merge shape is derived from git state

The merge keeps today's semantics. Close records the base checkout SHA before merge and inspects the resulting commit: target-head equality without a new merge commit means fast-forward; a resulting commit with multiple parents means merge commit; unchanged means already up to date. Both renderers report that shape. This is narration, not policy.

### D6 — Checklist shape

Preflight renders as one line (`clean tree · 24/24 tasks · no live runs`). Sync, archive, squash, and merge each render running / completed / skipped-with-reason / failed-with-remediation. Skips are first-class (`sync skipped — main already an ancestor`). A stopped sequence leaves the final frame visible; resume emits detected completed/skipped states so they render checked before work continues.

### D7 — Cleanup follows git's dependency graph

Push is independent. Close resolves the base branch's configured upstream into remote plus remote branch and runs/prints an explicit refspec (`git push <remote> <local-base>:<remote-branch>`). Without an upstream, push is unavailable with a remediation instead of producing the invalid `git push main` shape.

Worktree removal must succeed before branch deletion becomes available because git refuses to delete a checked-out branch. The completed TTY footer can show all actions, but branch delete is disabled until that dependency clears. An action is marked complete only after success; failure leaves it available with its error and retry. Headless output prints push (when configured), worktree removal, then branch deletion in safe execution order. None runs without an explicit choice.

## Risks / Trade-offs

- [Archive moves the message inputs] → D1 snapshots them before the first mutation and never discovers context from the archive layout.
- [Model id is unavailable or the provider fails] → verify local resolution during implementation; runtime falls back without blocking close.
- [Model ignores the capability rule] → scope and change-id body are normalized after parsing, outside the model.
- [TUI and headless narration drift] → both render the same close event stream.
- [A cleanup action fails halfway] → dependency state advances only after success; the action stays visible with retry/remediation.
- [TUI holds a long git operation] → cancellation is honored at step boundaries only; a stop leaves the same resumable git state as today's `close --resume`.

## Migration Plan

None. The surface is additive; message changes affect only future closes; `--message` remains an exact override for scripted flows. Rollback restores the print-only driver and previous default model without data migration.
