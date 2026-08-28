## MODIFIED Requirements

### Requirement: Change detail groups artifacts by type

Selecting an active change or a canonical spec SHALL show one full-width reading pane under a horizontal tab strip, with one tab per artifact group — Proposal, Design, Tasks, Delta Specs, and Other when present. All delta spec files SHALL share a single Delta Specs tab regardless of how many capabilities they span, concatenated with a small heading naming each capability before that capability's files. The tab strip SHALL be omitted when the subject has a single group (a canonical spec, or a change with one artifact group), leaving only a title row identifying the subject. Tabs SHALL switch with left/right keys (or `h`/`l`) and digit keys `1`–`9`; up/down keys SHALL scroll the active tab's content line by line. Each tab's content renders as markdown with YAML frontmatter stripped; delta spec content MAY style its requirement-operation headers (`ADDED`, `MODIFIED`, `REMOVED`) distinctly. Files that cannot be read render as a placeholder instead of failing the browser.

#### Scenario: All artifact types present

- **WHEN** a change contains `proposal.md`, `design.md`, `tasks.md`, and `specs/cli/spec.md`
- **THEN** the detail view shows tabs Proposal, Design, Tasks, and Delta Specs in a horizontal strip above one full-width reading pane, each tab rendering that file's content

#### Scenario: Multiple delta capabilities merge into one tab

- **WHEN** a change contains `specs/cli/spec.md` and `specs/ui/spec.md`
- **THEN** a single Delta Specs tab shows both files' content, with a heading naming `cli` before its file and a heading naming `ui` before its file

#### Scenario: Single-group subject hides the tab strip

- **WHEN** the user enters a canonical spec (or a change with only one artifact group)
- **THEN** no tab strip renders; only the title row identifying the subject and the full-width reading pane, whose content is scrollable and readable without tab navigation

#### Scenario: Arrow keys scroll the reading pane

- **WHEN** the active tab's rendered content is taller than the pane and the user presses up/down (or `k`/`j`)
- **THEN** the content scrolls line by line within the same tab instead of moving between sections

#### Scenario: Unreadable artifact

- **WHEN** one of a change's markdown files cannot be read
- **THEN** its tab shows a placeholder, and the remaining tabs render normally

## ADDED Requirements

### Requirement: Fullscreen reader

At the detail level, pressing `v` SHALL toggle an immersive reader that replaces the entire board — no header, footer, or tab chrome — leaving a single title bar that identifies the subject, the active tab, the copy hint (`c copy`), the close hint (`v/esc close`), and the scroll position. Within the reader, line keys SHALL scroll by line, paging keys by page, and home/end (with `g`/`G`) SHALL jump to the start or end; the tab-switching keys SHALL change the active tab inside the reader, resetting its scroll, and the title bar SHALL reflect the new tab. `v`, `q`, or escape SHALL close the reader and return to the detail level with the same active tab. The fullscreen reader MUST NOT be reachable from the root level, and scroll hints MUST NOT appear in the title bar.

#### Scenario: Toggle in and out

- **WHEN** the user presses `v` while reading a change's detail view
- **THEN** the reader replaces the header, footer, and tab chrome with one full-width pane plus its title bar, and pressing `v` (or escape, or `q`) returns to the detail view showing the same tab

#### Scenario: Tabs switch inside the reader

- **WHEN** the user presses right (or `l`) inside the reader
- **THEN** the next tab's content renders full width with its scroll reset, and the title bar names the new tab

#### Scenario: Not offered at the root level

- **WHEN** the board sits at the root list with a change selected
- **THEN** pressing `v` does nothing — the fullscreen reader exists only at the detail level

### Requirement: Copy the active tab

Inside the fullscreen reader, pressing `c` SHALL copy the active tab's markdown source to the system clipboard through the same clipboard pipeline the run dashboard uses. The copied payload SHALL be the frontmatter-stripped file bodies of that tab, joined, including the injected per-capability headings when the active tab is Delta Specs. The title bar SHALL report the outcome of the copy attempt, including when no clipboard mechanism is available or the transport rejects the payload, without interrupting reading.

#### Scenario: Copy succeeds

- **WHEN** the user presses `c` in the reader while the Proposal tab is active and a clipboard mechanism is available
- **THEN** the clipboard receives the proposal's markdown source (frontmatter stripped) and the title bar reports the copy

#### Scenario: Copy with multiple delta capabilities

- **WHEN** the user presses `c` while the merged Delta Specs tab is active
- **THEN** the clipboard receives every delta file's markdown source in order, each preceded by its capability heading

#### Scenario: Copy fails gracefully

- **WHEN** the user presses `c` and no clipboard mechanism is available
- **THEN** the title bar reports the failure and the reader continues functioning

### Requirement: Minimal chrome

The board's chrome SHALL stay lean. The header SHALL show exactly one content line — the live change and spec counts — with no static location line. The footer SHALL advertise only actions that are not universal navigation conventions: hints for arrow-key selection, paging, or scrolling MUST NOT appear in the footer at any level, nor in the fullscreen reader's title bar. The footer's hint-overflow behavior (truncation with a more-actions marker) is retained.

#### Scenario: Header carries no static location line

- **WHEN** the board renders at any level
- **THEN** the header's only content line shows the live counts, and no line naming the `openspec/changes` / `openspec/specs` directories appears

#### Scenario: Footer drops obvious navigation hints

- **WHEN** the detail level renders with actions available
- **THEN** the footer hints list actions like read, apply, iterate, full, and quit — and contains no arrow-key or paging hints
