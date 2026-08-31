# specs-viewer Specification

## Purpose

The `convoy specs` command lets an operator browse OpenSpec state — active changes and canonical specs — in a terminal UI, read each change's artifacts as rendered markdown, hand a selected change straight to the interactive run launcher with it already pinned as the contract, or open a standalone OpenCode session on the repo rooted at the change's planning files.

## Requirements

### Requirement: Specs command discovers OpenSpec state from the filesystem

Convoy SHALL expose a `convoy specs` subcommand that reads only the `openspec/` directory of the target repo: active changes are the entries of `openspec/changes/` excluding `archive`, dotfiles, and stray non-directory files; canonical specs are every markdown file under `openspec/specs/**`. The command MUST NOT invoke the `openspec` binary or write any file.

#### Scenario: Repo without openspec directory

- **WHEN** `convoy specs` runs in a repository with no `openspec/` directory
- **THEN** Convoy prints a message saying no specs were found and exits successfully without launching any UI

#### Scenario: Repo with openspec directory but no active changes

- **WHEN** `convoy specs` runs in a repository whose `openspec/changes/` contains only `archive`
- **THEN** the interactive root omits the Active Changes section and its title entirely, and canonical specs (if any) remain browsable

### Requirement: Root view shows only non-empty sections

In the interactive browser, the root navigation list SHALL present each non-empty board section in this order: **Active Changes**, **Worktrees without spec**, then **Canonical Specs**. The sections SHALL have visually distinct headers and remain independently reachable while scrolling. A section with no entries SHALL be omitted entirely, including its header. A change entry without a readable `proposal.md` SHALL still be listed by its id.

#### Scenario: Sections appear in order

- **WHEN** the browser opens with entries in all three sections
- **THEN** Active Changes is listed above Worktrees without spec, which is listed above Canonical Specs, with visually distinct headers

#### Scenario: Empty root sections disappear

- **WHEN** any root section has no entries
- **THEN** neither that section's rows nor its title are rendered

#### Scenario: Change missing its proposal

- **WHEN** an active change directory has no `proposal.md`
- **THEN** the change still appears in the list, titled by its directory id

### Requirement: Canonical selection keeps the root list full-size

While a canonical spec is selected at the root, the redundant details panel SHALL be hidden and the browse list SHALL use the full body in both wide and compact layouts. Pressing Enter SHALL still open that spec in the full-width reading level. Returning to the root SHALL restore the list-only full-body layout for the still-selected canonical spec. Active-change and worktree selections SHALL retain their useful root details panel.

#### Scenario: Canonical spec selected at root

- **WHEN** the root selection lands on a canonical spec in either a wide or compact terminal
- **THEN** the details panel is absent and the browse list fills the body

#### Scenario: Return from a canonical reader

- **WHEN** the user presses Enter on a canonical spec and then returns from its reader
- **THEN** that spec remains selected at the root and the redundant details panel is hidden again

#### Scenario: Change and worktree previews remain

- **WHEN** the root selection lands on an active change or a worktree without spec
- **THEN** the details panel remains visible with the selected row's useful lifecycle or worktree information

### Requirement: Change detail groups artifacts by type

Entering an active change or a canonical spec SHALL show one full-width reading pane under a horizontal tab strip, with one tab per artifact group — Proposal, Design, Tasks, Delta Specs, and Other when present. All delta spec files SHALL share a single Delta Specs tab regardless of how many capabilities they span, concatenated with a small heading naming each capability before that capability's files. The tab strip SHALL be omitted when the subject has a single group (a canonical spec, or a change with one artifact group), leaving only a title row identifying the subject. Tabs SHALL switch with left/right keys (or `h`/`l`) and digit keys `1`–`9`; up/down keys SHALL scroll the active tab's content line by line. Each tab's content renders as markdown with YAML frontmatter stripped; delta spec content MAY style its requirement-operation headers (`ADDED`, `MODIFIED`, `REMOVED`) distinctly. Files that cannot be read render as a placeholder instead of failing the browser.

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

### Requirement: Apply this spec hands off to the launcher preselected

While browsing a change, the user can invoke an **Apply this spec** action. Convoy SHALL then open the standard interactive run launcher with that change id pinned as the selected contract — equivalent to starting `convoy` and picking that spec row — so the operator continues through the normal pipeline selection, run-option toggles, branch step, and plan review. A cancelled launcher returns control to exit without starting any run.

#### Scenario: Handoff preselects the change

- **WHEN** the user selects "Apply this spec" on change `add-specs-viewer` and confirms through the launcher
- **THEN** the resulting run attaches exactly the `add-specs-viewer` bundle without re-asking which change to use

#### Scenario: Launcher cancelled after handoff

- **WHEN** the user invokes "Apply this spec" and then aborts the launcher
- **THEN** no run starts and no side effects remain

### Requirement: Iterate on this plan opens an OpenCode session on the change

While browsing a change, the user can invoke an **Iterate on this plan** action. Convoy SHALL open a standalone OpenCode session rooted at the repository directory, with the change's planning files (proposal, design, tasks, and delta specs) referenced as initial context. The session SHALL be pre-authorized to read the entire repository without per-file read confirmations — revising a change requires consulting the surrounding code and specs, so the repo-wide read grant is intentional; only reads are pre-granted, and writes follow the session's normal defaults. The session is external to Convoy and outlives the browser; any edits to the change are made by the operator through OpenSpec authoring commands inside that session, not by Convoy.

#### Scenario: Iterate opens a repo-rooted session

- **WHEN** the user selects "Iterate on this plan" on change `add-specs-viewer`
- **THEN** Convoy opens a standalone OpenCode session in the repository directory whose initial prompt lists the change's planning files as context

#### Scenario: Iterate requires no launcher

- **WHEN** the user selects "Iterate on this plan" and then closes the session without running any pipeline
- **THEN** no run starts; only the standalone session was opened

#### Scenario: Iterate session is pre-authorized to read the repository

- **WHEN** the user selects "Iterate on this plan"
- **THEN** the OpenCode session starts with read access to the whole repository pre-granted (no per-file read confirmations), so the agent can consult surrounding code and specs while revising the change

### Requirement: Non-TTY invocations print a plain listing

When stdin or stdout is not a TTY, `convoy specs` SHALL print a plain text listing of active changes (id plus artifact inventory) and canonical specs instead of launching the TUI, and exit successfully.

#### Scenario: Piped output

- **WHEN** `convoy specs` runs with stdout redirected to a pipe in a repo with changes
- **THEN** a plain listing prints and the process exits 0 without any terminal control sequences

#### Scenario: Empty state when piped

- **WHEN** `convoy specs` runs piped in a repo with no openspec directory
- **THEN** a single message notes that no specs were found and the process exits 0

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

The board's chrome SHALL stay lean. The header SHALL show exactly one content line in the unified home-session header style: a faint `project ` label followed by the normalized target project directory supplied by the loaded specs view; the browser SHALL NOT substitute its process working directory. Live change and spec counts SHALL NOT appear there. The footer SHALL advertise only actions that are not universal navigation conventions: hints for arrow-key selection, paging, or scrolling MUST NOT appear in the footer at any level, nor in the fullscreen reader's title bar. The footer's hint-overflow behavior (truncation with a more-actions marker) is retained.

#### Scenario: Header identifies the loaded project

- **WHEN** the board renders at any non-fullscreen level for a normalized target directory
- **THEN** the header's only content line shows `project  ` followed by that directory and does not show live change/spec counts or the browser process's working directory

#### Scenario: Footer drops obvious navigation hints

- **WHEN** the detail level renders with actions available
- **THEN** the footer hints list actions like read, apply, iterate, full, and quit — and contains no arrow-key or paging hints
