## Context

See `proposal.md` for motivation and `specs/feature-close/spec.md` for the behavioral contract. Today `runClose` emits only a generic `step-started` event before it awaits message composition, while `CloseTui` samples its spinner frame only when some other event triggers a render. The same TUI renders three review choices vertically but maps movement to horizontal keys, and delegates Edit back to the command layer so OpenTUI can be suspended around `$EDITOR`.

Post-close cleanup has two different kinds of non-runnable state represented by the same `unavailable` status. A branch blocked by an extant worktree can become runnable in the current session after worktree removal; worktree removal blocked because the command was launched from inside that worktree cannot. A child process cannot move its parent shell out of the directory, so the latter is guidance for a later shell action rather than an interactive action.

## Goals / Non-Goals

**Goals:**

- Keep operation progress renderer-neutral and truthful while giving the TUI an independent animation cadence.
- Make message review and inline multiline editing one coherent TUI state machine with explicit acceptance.
- Represent retryable actions, same-session prerequisites, and deferred cleanup as different presentation concepts.
- Preserve safe Git ordering and existing headless output.

**Non-Goals:**

- Streaming model tokens or exposing provider-internal progress.
- Changing commit-message model selection, timeout, normalization before review, squash range selection, or merge behavior.
- Changing `convoy finish` or removing its external-editor workflow.
- Adding shell integration capable of changing the parent shell's working directory.
- Automatically running push or cleanup.

## Decisions

### D1 — Give squash typed phases in the Close event stream

Extend the Close event contract with a renderer-neutral squash phase whose values cover `composing-message`, `awaiting-message-review`, and `creating-commit`. `runClose` emits the phase before each corresponding await or mutation:

```text
step-started(squash)
        │
        ▼
composing-message ──▶ awaiting-message-review ──▶ creating-commit
        │                       │                         │
        └── model/fallback      └── accept/edit/cancel   └── applySquash
```

The presentation reducer maps these stable phase identifiers to human-readable row detail. The headless formatter may consume the same event without emitting noisy intermediate lines; its final facts remain unchanged.

This keeps semantic operation state in the orchestrator instead of inferring it from which TUI method happens to be waiting. A free-form progress string was considered, but typed phases prevent renderer copy from becoming part of the core control contract and make exhaustive tests possible.

### D2 — Animate independently from operation events

`CloseTui` owns a short render ticker while a checklist row is running. Each tick recomputes the existing time-based spinner frame and requests a render; the ticker stops when no row is running, while the renderer is suspended, or when the TUI is destroyed. Resume restarts it from current state.

The operation event stream is intentionally not used as an animation clock: model composition can be healthy while producing no intermediate event. The dashboard's existing periodic render pattern supplies the precedent. A model heartbeat event was rejected because it would fabricate operation progress and couple animation frequency to the core workflow.

### D3 — Keep the lightweight review selector and align keys with layout

The three review choices retain the existing integer selection model. Up/Down and `j`/`k` become the primary movement keys; Tab and the existing horizontal keys remain aliases for compatibility. Enter activates the highlighted choice, while direct accept/edit/cancel shortcuts continue to work. The footer advertises vertical movement.

Using a focusable select component for three static choices would add focus lifecycle work without improving behavior. The native focus model is reserved for the editor where it materially improves multiline input.

### D4 — Make the TUI own the reviewed message and inline draft

Change the interactive resolver boundary so `CloseTui` returns either the final accepted message string or cancellation. The command layer no longer interprets an `edit` decision or launches `$EDITOR` for Close.

The TUI keeps two values:

- `reviewedMessage`: the value shown on the review screen and returned only by Accept.
- `editDraft`: a temporary value owned by a centered multiline editor overlay.

```text
                ┌──────────── discard / Esc ────────────┐
                │                                        │
Review ── Edit ─┴─▶ Inline editor ── Save/Ctrl+S ──▶ Review
  │                                                        │
  ├── Accept ──▶ return reviewedMessage                    │
  └── Cancel ──▶ return undefined                          │
```

The overlay uses OpenTUI's existing `TextareaRenderable` so multiline paste, vertical cursor movement, selection, undo/redo, scrolling, and terminal-cell-aware cursor rendering are not reimplemented. Enter inserts a newline, Ctrl+S saves, and Escape discards the draft. Save normalizes line endings, strips unsafe control bytes, trims only outer blank lines, and refuses an empty subject. It updates `reviewedMessage` and returns to review; it does not accept the commit.

While edit mode is active, the global key handler intercepts only overlay commands and interrupt semantics. Ordinary editing keys are not prevented or stopped, allowing the focused textarea to process them. Focus is acquired when the overlay opens, released before it closes, and restored correctly after renderer suspension or destruction.

Adapting the launcher's hand-written prompt editor was considered. The native textarea is preferred because a commit message needs true multiline cursor motion and paste behavior, and duplicating the launcher's buffer/wrapping logic would retain known Unicode and editing limitations. Keeping `$EDITOR` as a second Close action was rejected to keep the review contract small; `convoy finish` remains the power-user external-editor surface.

### D5 — Separate current-session actions from deferred cleanup guidance

Resolve follow-ups into two presentation groups:

1. **Actions** — operations the current process can run now or after another same-session action. These carry available/running/completed/failed/blocked state and are selectable only when available or retryable.
2. **Deferred cleanup** — a reason plus ordered, copyable commands that require the operator to leave the target worktree. These are informational and have no selection marker or `unavailable` action status.

When Close runs outside the feature worktree, Remove worktree remains an action and Delete branch remains blocked until removal succeeds. When Close runs inside it, neither cleanup operation enters the action list; the TUI explains that the parent shell must leave the worktree and shows the existing `git -C <main-dir> worktree remove ...` followed by `git -C <main-dir> branch -d ...`. Configured push remains an independent action in either case. A missing upstream remains an explicit push remediation, not a fabricated action.

Silently hiding cleanup was rejected because it would lose valuable next steps. Keeping both as `unavailable` was rejected because it implies that waiting or navigating can unlock them. Deleting the current worktree anyway was rejected because the parent shell would be left in a removed directory.

### D6 — Verify state transitions, parser input, and delayed work

Tests use a deferred message writer to hold Close in `composing-message`, advance an injected/fake animation clock, and assert that successive frames differ while the semantic detail remains stable. Review tests drive keys through the OpenTUI input parser rather than calling the key handler with handcrafted events. Editor tests cover focus, multiline paste, cursor movement, save-to-review, discard, empty-subject validation, and acceptance of the edited value. Interactive orchestration tests assert that Close never invokes `$EDITOR` and that `applySquash` receives only an accepted value.

Cleanup tests cover both launch locations: outside the worktree, removal unlocks deletion; inside it, only safe actions are selectable and ordered deferred commands are rendered with the shell-location explanation.

## Risks / Trade-offs

- [A render ticker consumes resources or survives the scene] → Start it only for running rows and stop it on completion, suspension, route closure, and destruction; test timer disposal.
- [The global key handler swallows textarea input] → Route edit-mode commands before the normal prevent-default path and verify real parser input, paste, and cursor movement.
- [Inline edits produce an invalid Git message] → Reject an empty subject and apply the existing control-byte sanitation before returning to review; Git hooks and signing retain their existing terminal handoff.
- [Native textarea behavior differs across the pinned OpenTUI version] → Keep its integration behind the Close TUI's small draft interface and cover focus/save/discard with renderer tests.
- [Cleanup guidance becomes stale after external filesystem changes] → Re-resolve action state whenever the follow-up screen resumes; commands remain explicit and Git itself validates them when eventually run.

## Migration Plan

No persisted data or configuration changes are required. Ship the event, reducer, TUI, and orchestration changes together so no renderer receives an unknown phase. Rollback restores the old resolver and follow-up presentation; already-created commits and worktrees require no migration.
