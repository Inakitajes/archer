# Compact home poster

## Why

The Home photo currently runs full-bleed: it covers 100% of the terminal width and height between the masthead and the dock with an aspect-fill crop. On large terminals this drowns the navigation and chops the illustrations unpredictably. A smaller, centered "poster" reads better and keeps the artwork whole.

## What Changes

- In Kitty-graphics mode the selected destination photo becomes a centered card instead of a full-bleed canvas: aspect-preserving contain fit (no crop), capped at 50 columns wide and 50 rows tall, centered horizontally and vertically in the space between the chrome and the dock.
- The block `CONVOY` wordmark moves out of the masthead and sits directly above the photo card, centered, so wordmark + card read as one poster. The poster is vertically centered as a unit.
- The masthead in graphics mode shrinks to a single slim chrome row: labeled project path on the left, version string right-aligned, both faint. One blank row of top padding is kept.
- Non-graphics fallback is unchanged: the existing masthead (block or text wordmark with version/project) plus the vertically centered navigation-only layout.
- The bottom dock (diamond-bracketed destination tabs + contextual description) keeps its current placement and spacing.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `home-launcher`: "Graphics-capable Home preserves the image experience" changes from full-bleed aspect-fill crop to a capped, centered contain card integrated with the moved wordmark; "Home presents a unified masthead" gains a graphics-mode exception where the masthead is the slim project/version chrome and the wordmark lives in the poster.

## Impact

- `src/home-tui.ts`: layout math (`render`, `mastheadRows`, `wordmarkContent`), poster composition, and `syncImage` placement (contain fit + centering instead of cover crop).
- `src/kitty-graphics.ts`: new contain-fit placement helper alongside `coverSourceRect`.
- `test/home-tui.test.ts`, `test/kitty-graphics.test.ts`: updated/added cases for the card caps, centering, chrome row, and untouched fallback.
- No asset changes; tinting pipeline (`src/png-tint.ts`) is unaffected.
