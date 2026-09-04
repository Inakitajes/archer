## MODIFIED Requirements

### Requirement: Home presents a unified masthead
In non-graphics mode the Home launcher SHALL display a left-aligned three-line `CONVOY` wordmark in one uniform neutral tone. To its right, the masthead SHALL show the complete version string right-aligned on the first row and the project path right-aligned on the second row. The version string SHALL include any prerelease and build metadata already present in the build's version, including local-build metadata, and SHALL NOT append a parenthetical suffix or separately display the commit or platform. Compact widths SHALL fall back to a text wordmark with the version string right-aligned and a labeled project row below, without overflowing the terminal width. In graphics mode the masthead SHALL instead be a single slim chrome row below one blank top-padding row: the labeled project path on the left and the complete version string right-aligned, both in a faint tone; the block wordmark is rendered as part of the centered destination poster instead. The launcher MUST NOT render a footer and SHALL keep one blank row between the masthead region and the body content.

#### Scenario: Wide masthead
- **WHEN** Home opens without graphics support, with enough width for the full wordmark, version string, and project path
- **THEN** the wordmark is left-aligned, the version string is right-aligned on the first masthead row, and the project path is right-aligned on the second masthead row

#### Scenario: Commit fragment instead of the full hash
- **WHEN** the masthead or chrome renders a stable or local build version
- **THEN** it shows the build's complete version string, including any embedded local-build metadata, and contains no parenthetical commit or platform details

#### Scenario: Compact masthead
- **WHEN** the terminal cannot fit the block wordmark beside the version string
- **THEN** Home shows a text `CONVOY` wordmark with the version string right-aligned and a labeled `project  <path>` row below it

#### Scenario: Slim chrome in graphics mode
- **WHEN** Home opens in a graphics-capable terminal with a valid destination image
- **THEN** the top shows one faint chrome row with the labeled project path on the left and the version string right-aligned, and no wordmark appears in the masthead region

#### Scenario: No footer
- **WHEN** Home renders in any width or graphics mode
- **THEN** no selection counter and no key hints appear anywhere on screen, one blank row pads the top of the screen, and two blank rows pad the bottom below the content

### Requirement: Graphics-capable Home preserves the image experience
When a valid Home image is available and Kitty Graphics is supported, the Home launcher SHALL display the selected destination image as a centered poster: the block `CONVOY` wordmark above the image separated from it by two blank rows, the pair centered horizontally in the terminal and vertically centered between the chrome row and the destination controls. In this mode the destination controls SHALL render as a centered column of the four destinations below the poster. The image SHALL be scaled with aspect-preserving contain fit — the whole image is visible and never cropped — and SHALL NOT exceed 60 columns wide or 50 rows tall. When the available space is smaller than the capped card, the image SHALL shrink to fit while keeping its aspect ratio. The poster MUST NOT overlap the chrome row or the destination controls and SHALL keep at least one blank row below the chrome and at least one blank row above the controls.

#### Scenario: Kitty Graphics available
- **WHEN** Home opens in a terminal that supports Kitty Graphics and the selected destination has a valid image
- **THEN** the uncropped image is displayed centered with the block wordmark two rows above it and the destinations listed as a centered column below, at least one blank row under the chrome and one blank row above the controls

#### Scenario: Large terminal respects the cap
- **WHEN** the space between the chrome and the controls is larger than the caps
- **THEN** the image card is at most 60 columns wide and 50 rows tall and the remaining space stays plain background around the centered poster

#### Scenario: Small terminal shrinks the card
- **WHEN** the space between the chrome and the controls is smaller than the capped card
- **THEN** the card scales down with its aspect ratio intact and still does not overlap the chrome or the controls

#### Scenario: Selection swaps the poster image in place
- **WHEN** the selection moves to another destination with a valid image
- **THEN** the wordmark stays put and only the image changes, without moving the poster

### Requirement: Destination description wraps to at most two contextual lines
The Home launcher SHALL show the selected destination description beneath the selector, separated from it by one blank row, centered, wrapped to at most two rows; when the description does not fit in two rows it SHALL clip the last row with an ellipsis without overflowing the terminal width.

#### Scenario: Description fits on one line
- **WHEN** the selected description fits the available width
- **THEN** it shows as a single centered row beneath the selector

#### Scenario: Description on a narrow terminal
- **WHEN** the selected description exceeds the available width but fits in two rows
- **THEN** it wraps onto a second centered row with no ellipsis

#### Scenario: Description overflows two rows
- **WHEN** the selected description does not fit in two rows at the available width
- **THEN** the second row ends with an ellipsis without overflowing

## RENAMED Requirements

- FROM: `### Requirement: Destination description remains a single contextual line`
- TO: `### Requirement: Destination description wraps to at most two contextual lines`
