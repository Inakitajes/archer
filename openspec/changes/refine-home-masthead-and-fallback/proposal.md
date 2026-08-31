## Why

The Home launcher currently splits its identity and project context across visually disconnected regions, while the active destination is too subtle and the non-graphics fallback presents unrelated ASCII art instead of prioritizing navigation. Refining the masthead, selector, and fallback will make the entry screen clearer and more intentional in both graphics-capable and plain terminals.

## What Changes

- Replace the centered, multi-tone wordmark with a left-aligned three-line `CONVOY` wordmark whose letters share one neutral tone.
- Put the short `v0.8` version at the right edge of the wordmark and move `project  <path>` below the masthead; remove the duplicate version from the footer.
- Render the selected destination as `◆ [key] label ◆`, reserving equivalent marker space for inactive destinations so navigation does not shift.
- Keep the current cropped image experience when Kitty Graphics is supported.
- When Kitty Graphics is unavailable, render no image and no ASCII sculpture; vertically center the destination selector and its contextual one-line description in the available body.
- Preserve responsive row/stacked destination layouts and compact-terminal clipping.

## Capabilities

### New Capabilities

- `home-launcher`: Defines Home masthead composition, destination selection treatment, graphics behavior, and the vertically centered no-graphics fallback.

### Modified Capabilities

None.

## Impact

- Affects `src/home-tui.ts`, the embedded-wordmark option in `src/home-art.ts`, and their tests.
- No command-line API, configuration format, dependency, or persisted-data changes.
- Kitty Graphics remains optional; the change modifies only presentation and fallback behavior.
