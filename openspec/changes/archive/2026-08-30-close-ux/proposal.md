# Close UX

## Why

Closing a feature is the highest-stakes moment of the flow — it rewrites a branch, archives a change, and lands on main — yet today it remains opaque while those operations run and only explains the outcome afterward. A generic squashed message, an unreported merge shape, and cleanup commands that are printed rather than actionable leave the operator unsure what landed and what remains to clean up.

## What Changes

- Close composes a readable conventional commit through a model-backed writer with a deterministic fallback: capability-derived scope, meaningful subject, and the change id in the body.
- The default commit-writer model moves to `openrouter/z-ai/glm-5.3-flash`; `convoy finish` inherits the same default.
- In a TTY, close renders preflight, sync, archive, squash, and merge as a live checklist with skips, failures, resume state, and merge shape visible; headless runs remain non-interactive and print an equivalent factual summary.
- The squash message is confirmed or edited before it lands; `--message` remains the non-interactive override.
- Push, worktree removal, and branch deletion become deliberate interactive offers. Branch deletion is enabled only after the worktree has been removed; headless mode prints safe remote-aware commands. Nothing runs automatically.
- Merge policy stays unchanged: fast-forward is used when possible and reported explicitly.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `feature-close`: the squash requirement gains a composed conventional message; cleanup becomes a safe sequence of deliberate offers; a new progress requirement covers the TTY checklist, headless summary, message confirmation, merge narration, and resume state.

## Impact

- `src/feature-close.ts` — snapshots the change context before archive, composes the message before squash, and reports progress and merge shape.
- `src/feature-close-command.ts` — dual-mode surface: TUI progress in a TTY, stdout summary otherwise; follow-up offers.
- `src/commit-message.ts` — default model switch; the writer prompt accepts scope candidates and a proposal excerpt as inputs.
- `src/cli.ts` — the board's `close-change` handoff opens the interactive surface instead of the print-only driver.
- `convoy finish` — inherits the new default writer model; no behavior change otherwise.
