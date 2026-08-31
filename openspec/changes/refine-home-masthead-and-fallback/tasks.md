## 1. Masthead and Footer

- [x] 1.1 Recompose Home with a left-aligned, single-tone three-line `CONVOY` wordmark, right-aligned major-minor version, and project row beneath; verify wide and compact frame tests assert placement and no overflow
- [x] 1.2 Remove the duplicate version from the footer while preserving selection count and key hints; verify Home footer tests cover both wide and narrow widths

## 2. Destination Selector

- [x] 2.1 Add fixed leading/trailing marker slots to every destination and render accent `◆` markers for the selected item; verify stacked and row-layout tests show `◆ [P]  PIPELINES ◆` without positional movement after selection changes
- [x] 2.2 Keep the contextual description one line below a blank spacer and preserve ellipsis clipping; verify narrow-frame tests remain within terminal width

## 3. Graphics and Fallback Layout

- [x] 3.1 Remove ASCII sculpture rendering from Home and vertically center the selector-plus-description block when no valid Kitty image is available; verify no-graphics and missing-image frame tests contain no art glyphs and assert balanced vertical position
- [x] 3.2 Update graphics-mode body sizing and Kitty placement origin for the complete masthead while retaining cover crop and artifact cleanup; verify image selection/resize command tests keep placements outside masthead and dock rows
- [x] 3.3 Remove Home's now-unused ASCII animation ticker/imports and verify direct navigation, cleanup, and shared-session tests still pass

## 4. Verification

- [x] 4.1 Run `bun run typecheck` and the focused Home/Kitty/PNG test files; verify all commands exit successfully
- [x] 4.2 Run `bun test`, `bun run build`, and `git diff --check`; verify the full suite passes, the binary builds, and no whitespace errors are reported

## 5. Masthead Refinement (review feedback)

- [x] 5.1 Move the project path into the masthead's right column beneath the full build line (version + commit + platform via `versionDetails`); compact widths keep a text wordmark with version right-aligned and a labeled project row; verify wide frames assert both right-aligned rows and narrow frames keep the labeled row
- [x] 5.2 Remove the footer entirely — selection counter and key hints are gone; verify no frame contains `1/4` or the hint text and the navigation block centers to the terminal bottom
- [x] 5.3 Reserve one blank row between the image placement and the destination dock (art box bottom margin); verify placement geometry tests assert the gap and navigation/shared-session tests still pass
- [x] 5.4 Re-run `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check`; verify all pass

## 6. Breathing Room (review feedback)

- [x] 6.1 Reserve one blank row above the `CONVOY` wordmark (global top padding) and one blank row between the masthead and the image; verify frame tests assert the blank top row and the Kitty placement origin includes the masthead gap
- [x] 6.2 Reserve one blank row below the destination description (global bottom padding) in both graphics and centered fallback modes; verify centering balance assertions still hold within one row
- [x] 6.3 Re-run `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check`; verify all pass

## 7. Dock Breathing Room (review feedback)

- [x] 7.1 Widen the image-to-selector gap to two blank rows (`DOCK_GAP_ROWS`) and the bottom padding to two blank rows; verify placement geometry tests assert the enlarged gaps
- [x] 7.2 Make the dock's spacer rows rounding-proof: the description carries its own blank row in-content and centering uses explicit computed top padding instead of flex centering; verify stacked frames keep the spacer at every tested height
- [x] 7.3 Re-run `bun run typecheck`, `bun test`, `bun run build`, and `git diff --check`; verify all pass
