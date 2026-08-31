## Why

The Home launcher currently splits its identity and project context across visually disconnected regions, while the active destination is too subtle and the non-graphics fallback presents unrelated ASCII art instead of prioritizing navigation. Refining the masthead, selector, and fallback will make the entry screen clearer and more intentional in both graphics-capable and plain terminals.

## What Changes

- Replace the centered, multi-tone wordmark with a left-aligned three-line `CONVOY` wordmark whose letters share one neutral tone.
- Build one masthead from the wordmark plus a right column: the full build line (version, commit, platform via `versionDetails()`) right-aligned on the first row and `project  <path>` right-aligned on the second row; compact widths fall back to a text wordmark with the version right-aligned and a labeled project row below.
- Remove the footer entirely (selection counter and key hints included), extending the body to the terminal bottom.
- Pad the screen globally: one blank row above the wordmark, one between the masthead and the image, two between the image and the dock, and two below the dock content.
- Render the selected destination as `◆ [key] label ◆`, reserving equivalent marker space for inactive destinations so navigation does not shift.
- Keep the current cropped image experience when Kitty Graphics is supported.
- When Kitty Graphics is unavailable or the selected image is invalid, render no image and no ASCII sculpture; vertically center the destination selector and its contextual one-line description in the available body.
- Preserve responsive row/stacked destination layouts and compact-terminal clipping.

## Capabilities

### New Capabilities

- `home-launcher`: Defines Home masthead composition, destination selection treatment, graphics behavior, and the vertically centered no-graphics fallback.

### Modified Capabilities

None.

## Impact

- Affects `src/home-tui.ts` and `src/home-art.ts`, plus the graphics plumbing they now use: `src/kitty-graphics.ts` (protocol probe and placement) and `src/png-tint.ts` are new, `src/version.ts` gains the `versionDetails()` build line, `src/cli.ts` probes Kitty support before starting the home session, and `assets/home/` gains per-destination images (with `scripts/kitty-test.ts` for manual verification).
- Updates `test/home-tui.test.ts` and `test/home-art.test.ts`; adds `test/kitty-graphics.test.ts` and `test/png-tint.test.ts`.
- No command-line API, configuration format, dependency, or persisted-data changes.
- Kitty Graphics remains optional; the change modifies only presentation and fallback behavior.
