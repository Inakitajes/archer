# home-launcher Specification

## Purpose

Defines a clear, responsive Home launcher that communicates product identity, project context, active navigation, and graphics fallback behavior consistently across terminals.

## Requirements

### Requirement: Home presents a unified masthead
The Home launcher SHALL display a left-aligned three-line `CONVOY` wordmark in one uniform neutral tone. To its right, the masthead SHALL show the complete version string right-aligned on the first row and the project path right-aligned on the second row. The version string SHALL include any prerelease and build metadata already present in the build's version, including local-build metadata, and SHALL NOT append a parenthetical suffix or separately display the commit or platform. The launcher SHALL reserve one blank row above the wordmark and one blank row between the masthead and the body content. Compact widths SHALL fall back to a text wordmark with the version string right-aligned and a labeled project row below, without overflowing the terminal width. The launcher MUST NOT render a footer.

#### Scenario: Wide masthead
- **WHEN** Home opens with enough width for the full wordmark, version string, and project path
- **THEN** the wordmark is left-aligned, the version string is right-aligned on the first masthead row, and the project path is right-aligned on the second masthead row

#### Scenario: Commit fragment instead of the full hash
- **WHEN** the masthead renders a stable or local build version
- **THEN** the first masthead row ends with the build's complete version string, including any embedded local-build metadata, and contains no parenthetical commit or platform details

#### Scenario: Compact masthead
- **WHEN** the terminal cannot fit the block wordmark beside the version string
- **THEN** Home shows a text `CONVOY` wordmark with the version string right-aligned and a labeled `project  <path>` row below it

#### Scenario: No footer
- **WHEN** Home renders in any width or graphics mode
- **THEN** no selection counter and no key hints appear anywhere on screen, one blank row pads the top of the screen, and two blank rows pad the bottom below the content

### Requirement: Active destination is visibly bracketed by diamonds
The Home launcher SHALL render the selected destination with one filled diamond before and one filled diamond after its shortcut and label. Inactive destinations SHALL reserve equivalent marker width so changing selection does not shift the destination layout.

#### Scenario: Selected destination in stacked layout
- **WHEN** destinations are stacked and Pipelines is selected
- **THEN** the selected row reads visually as `◆ [P]  PIPELINES ◆` while inactive rows remain aligned with it

#### Scenario: Selected destination in row layout
- **WHEN** destinations share one row and selection moves between them
- **THEN** the selected item gains both diamonds without changing the positions of the other items

### Requirement: Graphics-capable Home preserves the image experience
When a valid Home image is available and Kitty Graphics is supported, the Home launcher SHALL display the selected destination image using the existing aspect-fill crop behavior between the masthead and the destination controls, separated from the masthead by one blank row and from the controls by two blank rows, without overlapping either region.

#### Scenario: Kitty Graphics available
- **WHEN** Home opens in a terminal that supports Kitty Graphics and the selected destination has a valid image
- **THEN** the cropped image is displayed below the masthead with one blank row above and two blank rows before the destination controls

### Requirement: Non-graphics Home prioritizes navigation
When Kitty Graphics is unavailable or no valid image can be displayed, the Home launcher SHALL display neither an image nor an ASCII sculpture. It SHALL vertically center the destination selector together with its selected destination description in the available body.

#### Scenario: Kitty Graphics unavailable
- **WHEN** Home opens in a terminal without Kitty Graphics support
- **THEN** no image or ASCII artwork is shown and the destination-and-description block is vertically centered

#### Scenario: Selected image unavailable
- **WHEN** Kitty Graphics is supported but the selected destination has no valid displayable image
- **THEN** Home uses the same vertically centered navigation-only fallback without showing ASCII artwork

### Requirement: Destination description remains a single contextual line
The Home launcher SHALL show the selected destination description as one line beneath the selector, separated from it by one blank row, and SHALL clip the line with an ellipsis when needed.

#### Scenario: Description on a narrow terminal
- **WHEN** the selected description exceeds the available width
- **THEN** the description remains on one line and ends with an ellipsis without overflowing
