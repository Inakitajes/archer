## MODIFIED Requirements

### Requirement: Home presents a unified masthead
The Home launcher SHALL display a left-aligned three-line `CONVOY` wordmark in one uniform neutral tone. To its right, the masthead SHALL show the build line (version, short commit fragment, platform) right-aligned on the first row and the project path right-aligned on the second row. The build line SHALL read `<version> (<commit-fragment>, <platform>)`, where `<commit-fragment>` is the first 7 characters of the build's commit SHA (or `unknown` when no commit is known); it SHALL NOT include a `commit` label or a full-length hash. The launcher SHALL reserve one blank row above the wordmark and one blank row between the masthead and the body content. Compact widths SHALL fall back to a text wordmark with the build line right-aligned and a labeled project row below, without overflowing the terminal width. The launcher MUST NOT render a footer.

#### Scenario: Wide masthead
- **WHEN** Home opens with enough width for the full wordmark, build line, and project path
- **THEN** the wordmark is left-aligned, the build line is right-aligned on the first masthead row, and the project path is right-aligned on the second masthead row

#### Scenario: Commit fragment instead of the full hash
- **WHEN** the masthead renders with a known build commit
- **THEN** the first masthead row ends with `<version> (<first 7 characters of the commit SHA>, <platform>)`, and neither the word `commit` nor a commit hash longer than 7 characters appears anywhere in the masthead

#### Scenario: Compact masthead
- **WHEN** the terminal cannot fit the block wordmark beside the build line
- **THEN** Home shows a text `CONVOY` wordmark with the build line right-aligned and a labeled `project  <path>` row below it

#### Scenario: No footer
- **WHEN** Home renders in any width or graphics mode
- **THEN** no selection counter and no key hints appear anywhere on screen, one blank row pads the top of the screen, and two blank rows pad the bottom below the content
