## Context

`src/home-tui.ts` paints a flex column (wordmark masthead → art canvas → dock). In graphics mode the art canvas is a full-width blank backdrop and `syncImage()` places the tinted photo over the whole body with `coverSourceRect` (aspect-fill crop, 1-col side insets). Kitty placements render above the text layer (z=0), so any text under the placement rect must be blank. The spec scenarios (see specs delta) keep the fallback path untouched. Constraints: deterministic row math only — flex centering has proven unreliable at odd terminal heights (existing comment in `render()`), and placements are re-issued every frame after a paint.

## Goals / Non-Goals

**Goals:**
- Contain-fit photo card capped at 50 cols × 50 rows, centered horizontally and vertically between chrome and dock.
- Block `CONVOY` wordmark centered directly above the card as one poster unit; masthead collapses to a slim project/version chrome row in graphics mode.
- Reuse the existing transmit-once/re-place-per-frame lifecycle unchanged.

**Non-Goals:**
- No changes to assets, `png-tint.ts`, the navigation-only fallback layout, or key handling.
- No new configuration surface for the caps (constants, not settings).

## Decisions

- **Contain math in a pure helper** (`containCard` in `src/kitty-graphics.ts`, next to `coverSourceRect`): given image pixel size, available cols/rows, cell aspect ratio (cellW/cellH), and the caps, return `{ cols, rows }` where `colsPerRow = (imgW / imgH) / cellAspect`, `rows = min(capRows, availRows, floor(capCols / colsPerRow))`, `cols = min(capCols, availCols, round(rows * colsPerRow))`, clamped to ≥1×1. The placement then uses the full source rect (no crop) instead of `coverSourceRect`. Alternative considered: keep cover and letterbox via source rect — rejected, cover always fills the target, so letterboxing must happen in the target rect itself.
- **Poster lives in one text canvas, not new flex boxes**: the art canvas content becomes `topPad` blank rows + centered wordmark rows + `WORDMARK_IMAGE_GAP_ROWS` blank rows + blank rows; `syncImage()` places the card at `row = mastheadRows + topPad + wordmarkRows + gap`, `col = floor((width - cols) / 2)`, with `topPad = floor((artHeight - posterRows) / 2)` clamped at 0. One deterministic function computes the geometry and both `render()` and `syncImage()` call it, so text and image can never disagree. Alternative: separate `TextRenderable` above the image with flex centering — rejected for the known rounding pitfalls and because it splits the geometry across two code paths.
- **Caps as exported constants** `homePosterMaxCols = 60`, `homePosterMaxRows = 50` in `home-tui.ts` so tests import them instead of hardcoding. (First cut shipped 50; user feedback asked for a slightly bigger card — 60 cols yields ~59×16 for the 800×436 assets on 2:1 cells.)
- **Column controls + roomier poster rhythm**: in graphics mode with a valid photo the destinations render as a centered column (the existing stacked dock) instead of the wide one-row tabs, and the wordmark sits two blank rows above the card (`WORDMARK_IMAGE_GAP_ROWS = 2`). The tabs decision keys on photo validity (`imageFor(kind)`), never on the fitted geometry, because `posterLayout()` consumes `dockRows()` and keying on fit would recurse.
- **Tightened dock**: the selector sits one row under the poster (`DOCK_GAP_ROWS = 1`, was 2) and the contextual description wraps to at most `DESCRIPTION_LINES = 2` centered rows (`wrapStyled` + `clipChunks` ellipsis on overflow) instead of one truncated row. The dock block grows by one row while the gap shrinks by one, so `artHeight` — and the poster geometry — stay exactly as specced; only the controls move closer to the art. This deliberately supersedes the older "single contextual line" and "two blank rows above the controls" spec text, updated in the delta.
- **Graphics-mode chrome**: `wordmarkBox` renders one faint row — `project  <shortPath>` left, `versionDetails()` right, via the existing `padBetween` — and `mastheadRows()` returns `TOP_PAD_ROWS + 1` when the selected kind has an image, else the current wordmark height. The masthead therefore tracks `hasImage` per render; switching between valid-image kinds keeps chrome height stable, so the poster does not jump.
- **Poster wordmark glyphs**: always the 3-row block when the terminal fits `CONVOY_WORDMARK_WIDTH`, else a 1-row bold text `CONVOY`. The old 2-row compact variant existed to seat the version beside the block; the chrome row frees that coupling.
- **No room → fallback**: if `artHeight` cannot fit wordmark + gap + a *useful* card while honoring the 1/2-row clearances, the kind is treated as not displayable (centered navigation-only fallback, same as a damaged asset). "Useful" is `HOME_POSTER_MIN_CARD_ROWS = 4`: the budget is checked before `containCard` and the fitted `card.rows` again after it, because a narrow terminal can cap rows below the budget through the width axis. A 2-3 row dither renders as noise, so the poster yields instead of shrinking to mush. Keeps the hard "never overlap" guarantee simple.

## Risks / Trade-offs

- [Cell aspect unmeasured (no CSI 16 reply, e.g. exotic emulators)] → `terminalCellAspectRatio()` already falls back to a sane default; worst case the card is slightly distorted by ≤1 cell of rounding, never cropped.
- [`round(rows * colsPerRow)` can drift ≤1 cell from exact aspect] → accepted; sub-cell precision is impossible in a cell grid and kitty scales the bitmap to the rect anyway.
- [Chrome height changes when selection lands on a kind without a valid image] → by design (fallback layout); all four shipped assets are valid, so it is an edge path only.
- [Wordmark text under a mis-computed placement rect would be painted over] → geometry comes from the single shared function and the placement row starts strictly after `wordmarkRows + gap`; covered by a unit test asserting rect/wordmark disjointness.
