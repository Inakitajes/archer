## Context

See proposal.md - Why. The handoff happens inside `runHomeNavigationLoop` (`src/cli.ts`): `openDestination` runs a destination like `openSpecsBrowser`, which awaits `browseSpecs` → `loadSpecsView`/`assembleControlBoard` **before** the destination scene mounts. The previous scene's tree is already destroyed on close (`TuiScene.close()` destroys but leaves the frame painted, per `src/tui-session.ts`), so the last home frame sits on screen, frozen, while the load runs. Every destination in the home session shares this shape (`src/specs.ts`, `src/runs.ts`, `src/config-tui.ts`, `src/launch-tui.ts`), and all mount their scene via `sceneForRoute(route, ...)`.

Relevant constraints from the existing architecture:
- `TuiSession.openScene(id)` closes the current active scene and mounts a new one; the new scene paints over the previous frame with no blank frame and no alternate-screen toggle. This is the atomic-handoff primitive we already have.
- `TuiScene` exposes `close()` and `requestInterrupt()`; the route's `onInterrupt` sets an `interrupted` flag the navigation loop checks.
- Theme palette lives in `src/tui-theme.ts` (`theme.text`, `theme.dim`, `theme.faint`, etc.); `setTheme` swaps it.
- Rendering is OpenTUI `BoxRenderable`/`TextRenderable`; backgrounds are transparent, so the field is drawn with fg-colored glyphs.

## Goals / Non-Goals

**Goals:**
- A reusable transition that mounts on the shared `TuiSession` while a destination loads, animates a character ripple field, and hands off atomically to the destination scene.
- Only show it for genuinely slow loads (threshold), never extend the load, and never flash on fast loads.
- Keep the transition cheap enough to run on large terminals and over SSH; honor reduced motion; support `Ctrl+C` interrupt.

**Non-Goals:**
- Not a splash/onboarding screen, not a permanent background.
- Not changing the destination screens' own requirements (header, list, reader, etc. are untouched).
- Not a generic async spinner API for arbitrary async work outside the home-session destination handoff.

## Decisions

### 1. Wrap the destination load in a transition-scene helper
Introduce a helper (new module `src/loading-transition.ts`) shaped like:

```
withLoadingTransition(route, label, load): Promise<T>
```

- If `route` is undefined (non-interactive/piped) it just runs `load` unchanged — preserving the plain-output path.
- It races `load` against a threshold delay (≈150 ms). If `load` wins, no transition is shown (spec: no flash). If the delay wins, it mounts a transition scene on `route.session` and animates until `load` settles.

This is the single choke point that every destination's `browseSpecs`/`browseRuns`/`editConfigTui`/`launchRunTui` can pass through, so the transition is uniform rather than hand-rolled per screen.

**Alternatives considered:** (a) a global loading overlay inside each destination — rejected, it would be duplicated per screen and must be mounted before each load anyway; (b) forcing every load through a shared loader component — heavier than needed; the helper wrapping the existing `await` is the smallest change.

### 2. The transition is a real `TuiScene`, so handoff stays atomic
The helper opens `sceneForRoute(route, "convoy-loading-scene")` when it decides to show. When `load` settles, the helper closes the transition scene; the destination's own `sceneForRoute(route, "<dest>")` mount then closes whatever scene is active. Because both are scenes on the same session, the frame is replaced in place — no blank frame, no alternate-screen exit/re-entry (the existing contract in `src/tui-session.ts`).

### 3. Ripple field drawn with glyphs and per-cell fg color
A grid of cells covers the body area. Each cell's glyph and brightness is a function of a set of expanding ripples (origin point, radius growing over time, decaying strength), evaluated per frame. Brightness is quantized to a small ramp of the theme's text → dim → faint colors, so cells render as `StyledText` runs rather than true alpha. Ripples are seeded at random ambient points and expand outward; the effect reads as overlapping circular waves, not noise (mirrors Apollo's `FieldCanvas`, but cell-based).

**Alternatives considered:** true alpha/SGR-blend per cell — not supported well in terminal cells and much more expensive; a single rolling glyph column — visually reads as "Matrix" noise, not waves. The ramp + expanding-ripple model is the right tradeoff.

### 4. Bounded work for large terminals and SSH
- Cap the animation at ≈30 fps (same cadence Apollo uses).
- Use a coarse cell grid (e.g. one cell per ~2 columns/rows) and skip cells entirely on very large terminals by clamping the evaluated grid to a maximum size; the field covers the screen but is not sampled at every terminal cell.
- Recompute the field in a throttled ticker; render only when a frame is due.
- This keeps CPU and ANSI output bounded so it stays smooth over SSH or a slow link.

### 5. Reduced motion → static frame
Detect a reduced-motion preference and, when set, render one static frame of the ripple field instead of animating (the spec requires a static frame, not absence). Detection is the open question below; the default path uses a config/flag with a terminal-capability probe when available.

### 6. Interrupt through the existing route interrupt
The transition registers the route's interrupt handler on its scene. When `Ctrl+C` fires, the helper rejects/aborts the pending `load` (an abort signal the destination load can observe) and closes the transition, so `runHomeNavigationLoop` sees `interrupted` and exits without a destination starting.

## Risks / Trade-offs

- **[A static-looking field on very large terminals]** → Clamp the evaluated grid and keep the coarse sampling; the wave still reads as a field, just at lower resolution.
- **[Animation cost on slow links]** → The 30 fps cap and coarse grid bound ANSI output; if needed, drop to a lower fps under a detected slow link.
- **[Aborting a load is hard when the destination does I/O without a signal]** → The abort signal is best-effort: `Ctrl+C` at minimum stops the animation and returns control; the destination's `await` resolves or rejects naturally and the helper closes the transition either way. The spec's observable behavior (interrupt returns control, no destination started) holds.
- **[Reduced-motion detection in a terminal]** → May not be directly observable. Mitigation: a config/flag default, and treat an unknown value as "no preference" so the animation is still available; documented in the open question.

## Migration Plan

This is additive. No persistent state, no data migration, no schema change. Rollback is reverting the change — the helper is a thin wrapper, so destination behavior without it is unchanged. Default off for non-interactive paths; only the interactive home-session handoff gains the transition.

## Open Questions

- How to reliably detect a reduced-motion preference in a terminal app? Options: a `ui.reducedMotion` config flag (default `false`/`auto`), an environment variable, or an ANSI/OS-level probe. This can be settled during implementation without changing the specs (the requirement is "honor it when set") or the task breakdown, but a concrete detection mechanism should be chosen before coding the reduced-motion path.
