## Why

When an operator enters a destination from the home launcher — most noticeably the specs browser — the screen that was just shown stays painted but stops responding while the destination loads. `loadSpecsView` reads the OpenSpec tree, and `assembleControlBoard` shells out to Git and the `openspec` CLI to derive worktree, task, and run state. On a repo with many changes this reads as a frozen menu for a beat or two. The wait is real but currently invisible.

## What Changes

- Introduce a reusable loading-transition screen that animates a breathing sea of characters (traveling swells under a slow global pulse) in the current theme while a destination loads, with the status line centered over the field.
- Show the transition only for genuine load time, with a short threshold (≈150 ms) so fast loads do not flash it.
- Replace the transition with the destination as soon as it is ready; never extend the load to finish an animation.
- Paint the transition with OpenTUI renderables (no images, no canvas), sized to the terminal and bounded so large terminals and SSH sessions stay responsive.
- Keep the existing scene handoff semantics: no blank frame, no alternate-screen exit/re-entry between screens.
- Support `Ctrl+C` to interrupt the load and return control, and degrade gracefully to a plain status message when the destination cannot be loaded or the terminal is not interactive.
- Honor reduced-motion preferences by rendering a static frame instead of animating.

## Capabilities

### New Capabilities
- `loading-transition`: A shared transition screen shown while a destination within the home session loads, animating a breathing sea of characters in the current theme and handing off to the destination atomically.

### Modified Capabilities
- (none — the destination screens themselves do not change their requirements; only the handoff between them gains a transition.)

## Impact

- Affected source: `src/tui-session.ts` (scene handoff), the destination launchers (`src/home-tui.ts`, `src/specs.ts`), and a new module for the transition renderable (e.g. `src/loading-transition.ts`).
- No new runtime dependencies; the wave field is computed in-process and drawn through the existing OpenTUI renderer.
- Behavior is additive and non-breaking: non-interactive and piped invocations keep their current plain-text paths.
