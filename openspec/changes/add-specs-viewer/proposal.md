# Add Specs Viewer

## Why

Convoy already reads the OpenSpec layout (`openspec/specs/`, `openspec/changes/<id>/`) to attach spec bundles to pipeline runs, but no human-facing surface shows it. Operators who want to review what active changes exist — and read their proposals, designs, tasks, and delta specs — must fall back to raw file browsing or to the `openspec` CLI, coupling them to external tooling Convoy deliberately avoids depending on. A browser parallel to `convoy runs` closes the loop: see the contract, then run it.

## What Changes

- Add a `convoy specs` subcommand that interactively browses OpenSpec state:
  - Two visually separated sections at the root level: **Active Changes** (`openspec/changes/`, archive and dotfiles excluded) and **Canonical Specs** (`openspec/specs/**`).
  - Entering a change shows its artifact sections — Proposal, Design, Tasks, Delta Specs (grouped per capability) — in a master-detail layout with rendered markdown.
  - The browser itself is read-only: it purely reads files, never invokes the `openspec` binary, and never writes to the repo.
- Non-TTY invocations print a plain listing instead of launching the TUI (same rule as `convoy runs`).
- Selecting a change offers an **"Apply this spec"** action that hands off to the standard interactive launcher with that change preselected as the contract (`--change <id>` semantics): pipeline picker, worktree/branch toggles, plan review — all unchanged.
- Selecting a change also offers an **"Iterate on this plan"** action that opens a standalone OpenCode session rooted at the repo directory with the change's planning files (proposal, design, tasks, delta specs) seeded as context, so the operator can revise the change using the OpenSpec authoring commands inside OpenCode — the correct way to update a change.
- Extend `launchRunTui` to accept a preseeded change selection so the handoff lands on a launcher that already pins the spec row.

## Capabilities

### New Capabilities

- `specs-viewer`: The `convoy specs` command — discovery of active changes and canonical specs, sectioned navigation, artifact rendering, non-TTY fallback, the "Apply this spec" launcher handoff, and the "Iterate on this plan" OpenCode session.

### Modified Capabilities

<!-- No canonical specs exist yet in openspec/specs/, so nothing is modified;
     launcher preselection is captured inside the specs-viewer capability because
     it defines externally observable behavior of the handoff. -->

## Impact

- New code: `src/specs.ts` (data layer), `src/specs-browser.ts` (TUI).
- Modified code: `src/cli.ts` (new subcommand in `parseCommand`, help text), `src/launch-tui.ts` (accept preset change id), and an iterate-prompt builder alongside `tui.ts`'s `iteratePrompt`.
- Reused modules: `src/openspec.ts` (change discovery helpers), `src/markdown-render.ts`, `src/tui-theme.ts`, `src/opencode.ts` (`openIterateOpencodeWindow`).
- Tests: new `test/specs*.test.ts`; parser additions covered by `cli-parser` tests.
- No runner, coordinator, or attach-path changes; strictly additive command, one optional launcher parameter, and one new session-opener path.
