# tui-header Specification

## Purpose

Defines the single-line header chrome shared by every destination screen of the home session — one bare content row that anchors the operator to the current context without any version or border chrome. The home launcher's own masthead is governed by the `home-launcher` capability.

## Requirements

### Requirement: Home-session destination screens draw one bare header row

Every destination screen reachable from the home launcher — the "pipelines" run launcher, the specs browser, the runs browser, and the config editor — SHALL draw its top chrome as exactly one content row with no border box and no panel title. The body panels below SHALL reflow into the reclaimed vertical space without other layout changes. The home launcher itself is out of scope: its masthead is defined by the `home-launcher` capability.

#### Scenario: Each destination renders the same bare anatomy

- **WHEN** the run launcher, specs browser, runs browser, or config editor opens in a terminal
- **THEN** its top edge shows one header content row and no rounded border box, panel border title, or extra padding row above the body panels

### Requirement: Header left-anchors a context label and value

The header content SHALL be left-anchored with a faint label, two spaces, and a text value, all truncated to fit the terminal width on one line. Project-anchored screens — the pipelines run launcher and the specs browser — SHALL use the label `project`: specs SHALL show the target project directory, and the run launcher SHALL show the target project name. The runs browser SHALL use the label `runs` followed by a run-history stats summary (`N runs · ✓ X · ✗ Y · $cost`, with live runs excluded from the completed/failed counts as today). The runs browser SHALL NOT show its runs-root data directory or any "run history" caption in the header. The config editor SHALL use the label `config` followed by the path of the active tab's config file (global or project), shortened relative to the home directory when applicable.

#### Scenario: Project screens label the project

- **WHEN** the specs browser renders for a target project directory
- **THEN** the header reads `project  <directory>` and no other header content appears

#### Scenario: Run launcher labels the target project

- **WHEN** the pipelines run launcher renders
- **THEN** the header reads `project  <project name>` followed by its step breadcrumb

#### Scenario: Runs browser shows stats, not a data root

- **WHEN** the runs browser renders
- **THEN** the header reads `runs  <stats>` where `<stats>` summarizes the visible history (`N runs · ✓ X · ✗ Y · $cost`), and neither a path under the runs root nor a "Runs History" or "run history" caption appears anywhere in the header

#### Scenario: Config editor labels the active file

- **WHEN** the config editor renders
- **THEN** the header reads `config  <active tab path>` with the Global/Project tab strip as its right-aligned segment

### Requirement: Right-aligned header segments carry only screen-local context

When a screen's header has a right-aligned segment, it SHALL carry only that screen's own working context — the config editor's tab strip, or the run launcher's step breadcrumb — and never global chrome like the convoy version. The specs browser SHALL draw no right-aligned segment at all.

#### Scenario: Config tabs ride the header

- **WHEN** the config editor renders
- **THEN** the right end of the header line shows the Global/Project tab strip with the active tab emphasized, and the left end remains `config  <active tab path>`

#### Scenario: Run launcher breadcrumb rides the header

- **WHEN** the pipelines run launcher renders outside its review step
- **THEN** the right end of the header line shows the pipeline → prompt → options → (branch) → review breadcrumb, and the left end remains `project  <project name>`

### Requirement: Headers carry no convoy version tag

No destination screen reachable from the home launcher — run launcher, specs browser, runs browser, or config editor — SHALL render a convoy-and-version tag (`convoy vX`, `convoy specs vX`, `◆ convoy vX · config`, or similar) in its header chrome. The header row and its border area SHALL contain only the context elements defined above; the version SHALL NOT appear in any of these headers. The home launcher's masthead build line is governed by the `home-launcher` capability.

#### Scenario: No version rides any header

- **WHEN** any of the four home-session destination screens renders
- **THEN** none of its header content, border titles, or header rows contain a convoy-plus-version string such as `convoy v`, `convoy specs v`, or `◆ convoy`

#### Scenario: Fullscreen readers keep hiding the header

- **WHEN** the specs browser's fullscreen reader replaces the board chrome
- **THEN** the header row, including its `project` label line, is absent from the frame alongside the footer and tab chrome
