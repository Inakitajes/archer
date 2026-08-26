# Design: add-specs-viewer

## Context

`convoy runs` established Convoy's interactive-browser shape: a thin CLI case in `parseCommand`, a pure-ish data layer (`runs.ts`), and an opentui master-detail browser (`runs-browser.ts`) that falls back to a plain listing when stdin/stdout isn't a TTY. `src/openspec.ts` already reads the OpenSpec layout with hardened primitives (`isOpenSpecChangeId`, `listOpenSpecChanges`, `collectDirRelativeMarkdown`, `titleFromProposal`, `stripYamlFrontmatter`) but only to build runner bundles. The launcher (`launch-tui.ts`) already pins a chosen change into the run options (`selectedChangeId → selection.change`) and preloads its prompt via `openSpecPromptFor`; what it lacks is an entry point that arrives with a change already selected.

See proposal.md for motivation and specs/specs-viewer/spec.md for behavior.

## Goals / Non-Goals

**Goals**

- Mirror the runs-browser architecture so the new code feels native to the repo.
- Convoy's browser is read-only (purely reads files, never writes or invokes the `openspec` binary); the Iterate action hands off to an external OpenCode session rather than editing in-process.
- Handoff into the existing launcher flow with zero duplication of pipeline/config UX.

**Non-Goals**

- Progress parsing of task checkboxes (deferred).
- Browsing `openspec/archive/`.
- In-browser editing of specs or `$EDITOR` actions: Iterate hands off to an external OpenCode session where edits happen via OpenSpec commands; Convoy never mutates a change itself.
- Support for OpenSpec standalone stores (Convoy's runner can't see them either today).
- Delta-vs-canonical diff views.

## Decisions

### D1. Filesystem reads, not the openspec CLI

Reuse and extend `openspec.ts` helpers rather than shelling out to `openspec list/show`. Rationale: consistency with the bundle loader's stated philosophy ("Convoy never writes OpenSpec state" and adds no tool dependency), plus testability without the external binary.
*Alternative considered*: wrapping the CLI would give validation/schemas for free, at the cost of version coupling and an ambient dependency.

### D2. New data layer `src/specs.ts`

Pure functions over directory entries:

```ts
type SpecsEntry =
  | { kind: "change"; id: string; title: string
      artifacts: { section: "proposal"|"design"|"tasks"|"delta"; capability?: string; file: string }[] }
  | { kind: "spec"; path: string }   // relative to openspec/

loadSpecsView(targetDir): Promise<{ changes: ChangeEntry[]; specs: string[] }>
```

Artifact→section mapping is name-based: `proposal.md` → Proposal, `design.md` → Design, `tasks.md` → Tasks, everything else under `<change>/specs/**` → Delta grouped by first path segment. Unmatched markdown files land in the nearest fitting group (delta if under `specs/`, otherwise proposal-less "Other") so nothing disappears. Pure and testable like `resolveChange`; I/O lives in one loader function.

### D3. TUI as a sibling of RunsBrowser

`src/specs-browser.ts` follows `runs-browser.ts`: same `tui-theme` palette/hints/theme-change handling, `markdown-render` for the right pane, compact-width stacked layout below ~84 columns, keybindings consistent with runs (arrows/vim keys, Enter, Esc/q). Root level = two-section entity list; change level = artifact sections. Non-TTY callers get `printSpecsList()` mirroring `printRunList`.

### D4. Resolution object, action-shaped for growth

Like `RunsResolution`, `browseSpecs()` returns `{ type: "exit" } | { type: "apply-change"; changeID: string } | { type: "iterate-change"; changeID: string }`. Each action resolves with the selected change id; future actions (editor, etc.) fit the union without reshaping call sites.

### D5. Launcher handoff via a preset option

Add an optional parameter to `launchRunTui(...)`, e.g. `presetChange?: string`. When set: the prompt step starts with that spec row pinned (`selectedChangeId` initialized to the preset instead of auto-detected) and the current pick-fallback heuristics are skipped for the pin. Everything downstream is untouched because the handoff reuses `launchInteractiveRun`'s normal path from `cli.ts`. Cancellation safety: launcher returns `undefined` exactly as today.

Rationale: avoids re-implementing config steps inside the browser and avoids spawning a subprocess of ourselves. A dirty-tree/unreadable-repo error surfaces through the existing launcher steps.
*Alternative considered*: `convoy --change <id>` relaunch as subprocess — rejected (process/env duplication, awkward exit-code plumbing).

### D6. CLI wiring

New case in `parseCommand`: `convoy specs` (no positional args beyond the keyword; future flags later) dispatching after plan/validation hooks, similar placement to `runs`. Help text gains one line. Parser tests extended in the `cli-parser.test.ts` style.

### D7. Iterate reuses the pipeline iterate window mechanism

The Iterate action reuses `openIterateOpencodeWindow` (`src/opencode.ts`) — the same standalone-session backend the pipeline's iterate key ("I") uses — but seeds it with the change's planning files instead of run reports. A new prompt builder (sibling of `tui.ts`'s `iteratePrompt`) lists `proposal.md`, `design.md`, `tasks.md`, and each delta spec as context. Always rooted at the repository directory, where the change's `openspec/changes/<id>/` lives. Because the session is standalone and outlives Convoy, edits to the change are made by the operator via OpenSpec authoring commands inside OpenCode — keeping Convoy's read-only stance intact.

## Risks / Trade-offs

- [Launch-tui internal state is intricate; seeding `selectedChangeId` could interact with auto-detection notices] → preset applied only at initialization before the first render; tests cover launcher-with-preset in isolation plus a regression test that zero-argument launch behavior is unchanged.
- [A change dir can contain many files across nested delta capabilities] → sections cap listing noise by grouping per capability; rendering stays lazy (read on select, not upfront) so big repos stay snappy.
- [Frontmatter/YAML or malformed markdown may render oddly] → reuse `stripYamlFrontmatter`/`titleFromProposal`; renderer failures degrade to plain text via placeholder path.
- [Iterate hands off to an external OpenCode session; edits happen outside Convoy] → Convoy never writes; the session is standalone and documented as the operator's authoring surface, keeping Convoy's read-only stance intact.
- [Users expect archive access once active changes are browsable] → explicitly out of scope; resolution-object design leaves room for a later filter toggle.

## Migration Plan

Purely additive command and one optional parameter — no migration needed. Rollback is removing the subcommand case; no persisted state exists anywhere.

## Open Questions

None blocking. (In-browser editing remains out of scope; Iterate covers revision via an external OpenCode session.)
