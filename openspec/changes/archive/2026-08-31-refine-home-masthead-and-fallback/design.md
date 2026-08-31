## Context

See `proposal.md` for motivation and `specs/home-launcher/spec.md` for observable behavior. Home currently renders project chrome, a separate centered wordmark, an image-or-ASCII art region, a responsive destination dock, and a footer. Kitty placements use absolute terminal-cell geometry, so every vertical layout change must update both OpenTUI sizing and the placement origin.

## Goals / Non-Goals

**Goals:**
- Treat product identity, short version, and project path as one responsive masthead.
- Make selection unmistakable without introducing layout movement.
- Keep Kitty image geometry synchronized with the revised masthead.
- Make the no-graphics path a deliberate navigation-only composition.

**Non-Goals:**
- No changes to destination routing, keyboard shortcuts, image tinting, or crop mathematics.
- No new terminal protocol, dependency, configuration option, or reusable masthead component.
- No visual changes to destination screens outside Home.

## Decisions

**Decision: Build one masthead from the wordmark, short version, and project row.**
- The three-line wordmark stays in its own fixed-height renderable and is aligned left rather than centered.
- The major-minor version is right-aligned on the masthead's first line and removed from the footer to avoid duplication.
- The `project  <path>` line moves immediately below the wordmark/version region and uses the existing path-shortening behavior.
- All wordmark letters use the same neutral text tone; destination accent remains reserved for interaction.
- Alternative rejected: placing project context to the right of the logo. The user selected version-right/project-below, and long paths would make a side-by-side project block unstable.

**Decision: Give every destination fixed marker slots.**
- Each destination reserves one leading and one trailing marker slot plus spacing.
- The selected item fills those slots with accent-colored `◆`; inactive items fill them with equal-width spaces.
- Both row and stacked composers use the same item representation, so changing selection changes color/content but not measured width.
- Alternative rejected: adding diamonds only to the selected item, which would recenter the row or shift neighboring items on every keypress.

**Decision: Branch Home layout on actual image availability, not only terminal capability.**
- Graphics mode is active only when the protocol is supported and the selected destination resolves to a valid image.
- In graphics mode, the art box remains the flexible region above the bottom dock and Kitty placement starts after the complete masthead.
- In navigation-only mode, the art renderable is hidden/blank and the selector-plus-description dock is centered as one unit in the body.
- Home no longer calls the ASCII sculpture renderer for fallback content and no animation ticker is needed for this screen.
- Alternative rejected: retaining ASCII artwork, because the requested fallback explicitly prioritizes centered navigation with no substitute image.

**Decision: Keep responsive height accounting explicit.**
- Masthead, project row, footer, selector rows, selector-description spacer, and optional image region each contribute named row counts.
- The Kitty placement row uses the same masthead row total that the OpenTUI layout subtracts from the body.
- Compact widths preserve the stacked selector and clipping behavior; very narrow mastheads may use the existing compact text fallback while preserving the same information.

## Risks / Trade-offs

- **Short terminals may not fit masthead, minimum image area, selector, description, and footer simultaneously** → Collapse optional masthead breathing room before reducing required navigation rows; keep tests at the 20-row boundary.
- **Absolute Kitty placement can drift after masthead changes** → Derive the placement origin from the same row helper used by layout and test emitted placement commands after resize.
- **Diamond markers can make the wide selector exceed compact thresholds** → Include marker slots in item measurement and let the existing row/stack breakpoint choose the compact layout.
- **Removing ASCII fallback changes the identity of plain-terminal Home** → Keep the full masthead visible and center the complete navigation block so the fallback remains intentional rather than empty.

## Refinement Decisions (review feedback)

**Decision: Stack the full build line and project path as a right column beside the wordmark.**
- The masthead shows `versionDetails()` — the full version, commit hash, and platform with the brand prefix dropped — right-aligned on the wordmark's first row, and the project path right-aligned on the second row.
- Compact widths swap the block mark for a text `CONVOY` with the version right-aligned, plus a labeled `project  <path>` row below; the wide/compact breakpoint accounts for the version line's measured width.
- Alternative rejected: keeping the labeled project row under the masthead, which read as a fourth, disconnected chrome row.

**Decision: Remove the footer entirely.**
- The selection counter and key hints were redundant with direct shortcuts and visual selection, so Home no longer renders a footer region; the body extends to the terminal bottom and the navigation-only fallback centers against it.
- The Kitty placement origin derives from `mastheadRows()` only, and the image height subtracts the dock plus the new gap row.

**Decision: Reserve one blank row between the image and the destination dock.**
- The art box carries a one-row bottom margin in graphics mode only, so the photo never touches the selector; in navigation-only mode the centered block is unchanged apart from the extra body height the removed footer grants.

**Decision: Give the screen global breathing room.**
- One blank row pads the very top of the screen (wordmark box top padding), one blank row separates the masthead from the image (art box top margin), two blank rows separate the image from the dock (art box bottom margin), and two blank rows pad the very bottom below the description (dock bottom padding, applied in both graphics and centered fallback modes).
- `mastheadRows()` includes the top padding so the OpenTUI layout and the Kitty placement origin stay in lockstep; the image height subtracts the dock, the bottom padding, and both gap rows.
- Centering is computed, not flexed: the fallback dock gets an explicit integer top padding (`floor` of the free space) and the description carries its own blank spacer row in-content, because flex `justifyContent: center` sub-row rounding swallowed spacer rows at odd terminal heights.

## Migration Plan

Implement as a presentation-only update with no data migration. Rollback is a code revert restoring the previous centered wordmark, footer version, selector styling, and ASCII fallback.
