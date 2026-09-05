## 1. Transition module and scene helper

- [ ] 1.1 Create `src/loading-transition.ts` exporting `withLoadingTransition<T>(route: TuiRoute | undefined, label: string | undefined, load: () => Promise<T>): Promise<T>`, and verify the file typechecks (`bun run typecheck`).
- [ ] 1.2 Make the helper run `load` directly when `route` is undefined, and verify the non-interactive/piped path still prints the existing plain output with no TUI scene mounted.
- [ ] 1.3 Race `load` against a configurable threshold (~150 ms) so a fast load shows no transition, and verify with a unit test that a load resolving under the threshold mounts no transition scene.

## 2. Ripple field renderer

- [ ] 2.1 Implement the ripple model (ambient seeds expanding as circular waves, decaying strength) and verify a pure geometry function returns per-cell glyph + brightness for a given time and grid.
- [ ] 2.2 Map each cell's brightness onto a ramp of the current theme colors (text → dim → faint) and verify the rendered `StyledText` runs use only those palette colors and stay legible on light and dark themes.
- [ ] 2.3 Draw the field as a coarse, clamped grid at ~30 fps and verify on a large terminal size that the frame rate and per-frame cell count stay bounded (no per-terminal-cell sampling).

## 3. Wire the transition into the destination handoff

- [ ] 3.1 Mount the transition as a `TuiScene` via `sceneForRoute(route, "convoy-loading-scene")` when the load outlasts the threshold, and verify it replaces the prior frame with no blank frame or alternate-screen toggle.
- [ ] 3.2 Close the transition scene when `load` settles and verify the destination's own `sceneForRoute` mount paints over it atomically.
- [ ] 3.3 Route the specs browser through `withLoadingTransition` around `loadSpecsView`/`browseSpecs`, and verify `convoy specs` on a repo with many changes shows the transition only when the load is slow.

## 4. Interrupt, reduced motion, and graceful failure

- [ ] 4.1 Register the route's interrupt handler on the transition scene so `Ctrl+C` stops the animation and returns control without a destination starting, and verify interrupt exits cleanly.
- [ ] 4.2 Render a static frame instead of animating when a reduced-motion preference is set (config flag `ui.reducedMotion` defaulting to auto/probe), and verify the static frame renders and is replaced by the destination when ready.
- [ ] 4.3 Make a failed destination load give way to a readable status message and return control, and verify no stale/broken screen remains.

## 5. Verification

- [ ] 5.1 Run `bun run typecheck` and the test suite (`bun test`) and verify all existing and new tests pass.
- [ ] 5.2 Manually run `convoy` on a repo with active OpenSpec changes, open Specs, and verify the transition appears only during a real load, animates as waves, and hands off without a flash or frozen frame.
