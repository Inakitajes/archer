# Tasks

## 1. Contain-fit geometry

- [x] 1.1 Add `containCard({ sourceWidth, sourceHeight, availableCols, availableRows, cellAspect, maxCols, maxRows })` to `src/kitty-graphics.ts` implementing the design's math (cols-per-row from image aspect ÷ cell aspect, caps, ≥1×1 clamps) and cover it in `test/kitty-graphics.test.ts` with wide-terminal (caps bind: 50×14-ish for the 800×436 assets at 2:1 cells), narrow-terminal (width binds), and squat-terminal (height binds) cases
- [x] 1.2 Export `homePosterMaxCols = 50` and `homePosterMaxRows = 50` constants from `src/home-tui.ts` and add a shared poster-geometry method (chrome rows, wordmark rows, gap, `topPad`, card `cols/rows`, `col/row`) used by both `render()` and `syncImage()`, with a unit test asserting the placement rect starts below the wordmark rows and respects the 1-row chrome / 2-row dock clearances

## 2. Poster rendering

- [x] 2.1 In graphics mode, render the art canvas as the poster: `topPad` blank rows + centered block wordmark (3 rows when `CONVOY_WORDMARK_WIDTH` fits, else 1-row bold text `CONVOY`) + one gap row + blank rows, and verify via the existing `test/home-tui.test.ts` content-assertion style that wordmark glyphs are centered and the canvas stays blank under the card rect
- [x] 2.2 Replace `coverSourceRect` usage in `syncImage()` with `containCard` + full-source placement centered at the shared geometry, and verify by unit test that the emitted placement cols/rows never exceed the caps and that selection changes keep the wordmark row fixed (poster does not jump)
- [x] 2.3 Treat a kind as not displayable when the art area cannot fit wordmark + gap + ≥1-row card with clearances, so it falls back to the centered navigation-only layout, and verify with a small-canvas unit test

## 3. Slim chrome masthead

- [x] 3.1 Make `wordmarkContent`/`mastheadRows` mode-aware: with a valid image, one faint row `project  <path>` left + `versionDetails()` right via `padBetween`; without, the current masthead unchanged, and verify both variants in `test/home-tui.test.ts` (graphics chrome keeps the full version string, no commit/platform parentheticals)
- [x] 3.2 Confirm the non-graphics fallback (no Kitty / invalid asset) renders exactly as before by running the existing fallback tests unmodified

## 4. Integration verification

- [x] 4.1 Run `bun test test/home-tui.test.ts test/kitty-graphics.test.ts test/png-tint.test.ts` plus the full `bun test` suite and fix any fallout
- [x] 4.2 Manual check in Ghostty/Kitty at three sizes (≥160×50, ~90×40, ~60×20): poster centered and uncropped, caps respected, chrome row slim and faint, dock untouched, selection swaps images without moving the wordmark; record results in the change notes (verified by the user across four feedback rounds: column controls, tighter then 2-row dock, whole-block centering with equal margins, and the 48-col two-line description)

## 5. Poster polish (user feedback after first cut)

- [x] 5.1 Widen the card ceiling `homePosterMaxCols` 50 -> 60 (assets now render ~59x16 on 2:1 cells vs 48x13) and widen the wordmark-to-image gap `WORDMARK_IMAGE_GAP_ROWS` 1 -> 2; verify caps constants + gap reflected in geometry tests
- [x] 5.2 Render the destination controls as a centered column in poster mode at any width (was one row on wide terminals); key `usesRowTabs` on photo validity so `posterLayout` can consume `dockRows` without recursing; verify column layout + centering in a unit test
- [x] 5.3 Add `HOME_POSTER_MIN_CARD_ROWS = 4`: yield to the navigation-only fallback when the fitted card would be a 2-3 row noise dither (checked on the row budget and again on `card.rows` after `containCard` for the width-bound case); verify with the 60x20 squat-terminal test

## 6. Tighter dock (user feedback, second round)

- [x] 6.1 Raise the destination column one row: `DOCK_GAP_ROWS` 2 -> 1 (artHeight unchanged: gap -1, dock +1)
- [x] 6.2 Wrap the contextual description to at most `DESCRIPTION_LINES = 2` centered rows via `wrapStyled`, ellipsis via `clipChunks` on overflow; update the delta spec (REMOVED single-line header -> RENAMED + MODIFIED) and the narrow-home test
- [x] 6.3 Verify: `bun test` full suite green, `tsc --noEmit` clean, poster geometry numbers unchanged (59x16 @ 160x50 / 90x40, 60x20 fallback)

## 7. Centered poster block (user feedback, third round)

- [x] 7.1 Treat wordmark + card + controls + description as one vertically centered block: `posterLayout()` splits the leftover into equal `topPad`/`bottomPad` margins (the selector hugs the image at the fixed 1-row gap instead of the dock pinning to the bottom edge); dock box grows by `bottomPad` with a dynamic `paddingBottom`
- [x] 7.2 Update the delta spec (block centering + equal margins) and the pinned placements (90x28/80x24 card rows shift +1 to 9); add assertions for margin equality (|topPad-bottomPad| <= 1) and selector adjacency (card bottom + 1)

## 8. Breathing room + capped description (user feedback, fourth round)

- [x] 8.1 Two blank rows between the photo and the selector: `DOCK_GAP_ROWS` 1 -> 2 (card budgets shrink one row: 33x9 @ 90x28, 18x5 @ 80x24); update placements + selector adjacency (+2) in tests
- [x] 8.2 Cap the description at `DESCRIPTION_MAX_COLS = 48` cells at any terminal width and always wrap long text to two balanced centered rows (`descriptionLines()` splits at the word boundary nearest the middle; greedy fill + `truncate` ellipsis past two rows); update the delta spec and wide-home test

## Verification notes (tasks 4.2 + 5.x + 6.x + 7.x + 8.x)

Automated evidence from the real `HomeLauncher.posterLayout()` + `tintPngToAccent`
(cell aspect 0.5, accent #7AA2F7), column dock + 2-row capped description (7 rows),
2-row poster gap, 2-row wordmark gap, 60-col cap, whole-block vertical centering
(equal margins):

- 160x50: card 59x16 @ col 50, row 16; wordmark (3 rows) @ row 11; chrome 2 rows; margins 8 top / 9 bottom; selector two blank rows under the card; description wraps to 48 cols (two balanced rows) even here.
- 90x40: card 59x16 @ col 15, row 11; wordmark @ row 6; margins 3 / 4.
- 70x30: card 40x11 @ col 15, row 9; selector two blank rows under the card; desc wraps to 2 rows; margins 1 / 1.
- 60x20: FALLBACK (nav-only) — column dock + wordmark + 2-row gap leave < 4 card rows, so the poster yields instead of shrinking to a noise dither.
- Geometry unit tests pin the placements (`\x1b[10;29H` c=33,r=9 at 90x28; `\x1b[10;32H` c=18,r=5 at 80x24), margin equality (|topPad-bottomPad| <= 1), selector adjacency (card bottom + 2), the capped two-line description (wide + narrow), the wordmark-above-card disjointness, the caps, the centered column controls, the slim faint chrome row, and both too-short-canvas fallbacks (120x12 and 60x20).
- Composited runtime simulations (9x18 px cells) reviewed at 160x50 / 90x40 / 70x30: poster centered as one block with the controls, image whole, margins even, description a narrow centered subtitle.
- Full `bun test`: 2711 pass / 0 fail; `tsc --noEmit` clean.

Pending: human eyeball check in a real Ghostty/Kitty session (`convoy` with no args) at the
three sizes above.
