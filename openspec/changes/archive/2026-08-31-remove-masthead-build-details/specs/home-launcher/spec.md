## MODIFIED Requirements

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
