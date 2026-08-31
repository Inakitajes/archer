## MODIFIED Requirements

### Requirement: Minimal chrome

The board's chrome SHALL stay lean. The header SHALL show exactly one content line in the unified home-session header style: a faint `project ` label followed by the normalized target project directory supplied by the loaded specs view; the browser SHALL NOT substitute its process working directory. Live change and spec counts SHALL NOT appear there. The footer SHALL advertise only actions that are not universal navigation conventions: hints for arrow-key selection, paging, or scrolling MUST NOT appear in the footer at any level, nor in the fullscreen reader's title bar. The footer's hint-overflow behavior (truncation with a more-actions marker) is retained.

#### Scenario: Header identifies the loaded project

- **WHEN** the board renders at any non-fullscreen level for a normalized target directory
- **THEN** the header's only content line shows `project  ` followed by that directory and does not show live change/spec counts or the browser process's working directory

#### Scenario: Footer drops obvious navigation hints

- **WHEN** the detail level renders with actions available
- **THEN** the footer hints list actions like read, apply, iterate, full, and quit — and contains no arrow-key or paging hints