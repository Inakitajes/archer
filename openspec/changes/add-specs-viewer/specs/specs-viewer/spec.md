## Purpose

The `convoy specs` command lets an operator browse OpenSpec state — active changes and canonical specs — in a terminal UI, read each change's artifacts as rendered markdown, hand a selected change straight to the interactive run launcher with it already pinned as the contract, or open a standalone OpenCode session on the repo rooted at the change's planning files.

## ADDED Requirements

### Requirement: Specs command discovers OpenSpec state from the filesystem

Convoy SHALL expose a `convoy specs` subcommand that reads only the `openspec/` directory of the target repo: active changes are the entries of `openspec/changes/` excluding `archive`, dotfiles, and stray non-directory files; canonical specs are every markdown file under `openspec/specs/**`. The command MUST NOT invoke the `openspec` binary or write any file.

#### Scenario: Repo without openspec directory

- **WHEN** `convoy specs` runs in a repository with no `openspec/` directory
- **THEN** Convoy prints a message saying no specs were found and exits successfully without launching any UI

#### Scenario: Repo with openspec directory but no active changes

- **WHEN** `convoy specs` runs in a repository whose `openspec/changes/` contains only `archive`
- **THEN** the Active Changes section is reported or shown empty, and canonical specs (if any) remain browsable

### Requirement: Root view separates active changes from canonical specs

In the interactive browser, the root navigation list SHALL present two visually distinct sections: **Active Changes** first, then **Canonical Specs**, separated so each is independently reachable while scrolling. A change entry without a readable `proposal.md` SHALL still be listed by its id.

#### Scenario: Sections appear in order

- **WHEN** the browser opens with at least one active change and at least one canonical spec
- **THEN** the Active Changes section is listed above the Canonical Specs section with visually distinct headers

#### Scenario: Change missing its proposal

- **WHEN** an active change directory has no `proposal.md`
- **THEN** the change still appears in the list, titled by its directory id

### Requirement: Change detail groups artifacts by type

Selecting an active change SHALL show its markdown files grouped into labeled sections — Proposal, Design, Tasks, and Delta Specs — where Delta Specs files are grouped per capability path. Each section's content renders as markdown; delta spec sections MAY style their requirement-operation headers (`ADDED`, `MODIFIED`, `REMOVED`) distinctly. Files that cannot be read render as a placeholder instead of failing the browser.

#### Scenario: All artifact types present

- **WHEN** a change contains `proposal.md`, `design.md`, `tasks.md`, and `specs/cli/spec.md`
- **THEN** the detail view shows four labeled sections Proposal, Design, Tasks, and Delta Specs (cli), each rendering that file's content

#### Scenario: Unreadable artifact

- **WHEN** one of a change's markdown files cannot be read
- **THEN** its section shows a placeholder, and the remaining sections render normally

### Requirement: Apply this spec hands off to the launcher preselected

While browsing a change, the user can invoke an **Apply this spec** action. Convoy SHALL then open the standard interactive run launcher with that change id pinned as the selected contract — equivalent to starting `convoy` and picking that spec row — so the operator continues through the normal pipeline selection, run-option toggles, branch step, and plan review. A cancelled launcher returns control to exit without starting any run.

#### Scenario: Handoff preselects the change

- **WHEN** the user selects "Apply this spec" on change `add-specs-viewer` and confirms through the launcher
- **THEN** the resulting run attaches exactly the `add-specs-viewer` bundle without re-asking which change to use

#### Scenario: Launcher cancelled after handoff

- **WHEN** the user invokes "Apply this spec" and then aborts the launcher
- **THEN** no run starts and no side effects remain

### Requirement: Iterate on this plan opens an OpenCode session on the change

While browsing a change, the user can invoke an **Iterate on this plan** action. Convoy SHALL open a standalone OpenCode session rooted at the repository directory, with the change's planning files (proposal, design, tasks, and delta specs) referenced as initial context. The session is external to Convoy and outlives the browser; any edits to the change are made by the operator through OpenSpec authoring commands inside that session, not by Convoy.

#### Scenario: Iterate opens a repo-rooted session

- **WHEN** the user selects "Iterate on this plan" on change `add-specs-viewer`
- **THEN** Convoy opens a standalone OpenCode session in the repository directory whose initial prompt lists the change's planning files as context

#### Scenario: Iterate requires no launcher

- **WHEN** the user selects "Iterate on this plan" and then closes the session without running any pipeline
- **THEN** no run starts; only the standalone session was opened

### Requirement: Non-TTY invocations print a plain listing

When stdin or stdout is not a TTY, `convoy specs` SHALL print a plain text listing of active changes (id plus artifact inventory) and canonical specs instead of launching the TUI, and exit successfully.

#### Scenario: Piped output

- **WHEN** `convoy specs` runs with stdout redirected to a pipe in a repo with changes
- **THEN** a plain listing prints and the process exits 0 without any terminal control sequences

#### Scenario: Empty state when piped

- **WHEN** `convoy specs` runs piped in a repo with no openspec directory
- **THEN** a single message notes that no specs were found and the process exits 0
