# Feature Flow

## Why

Convoy drives spec-driven implementation but leaves the surrounding lifecycle — going from an explored idea to a working worktree, and from a finished change to an archived, merged branch — as a set of manual rituals: propose on main (dirtying it), hand-run `git worktree add`, hand-run sync/archive/merge in the right order, and no single place to see which features exist and what stage each is in. The old OpenCode plugin papered over part of this with an LLM guessing a pipeline; removing it (b045693) fixed the guessing but left the gap. The information to close the gap is already on disk — worktrees, branches, `openspec/changes/`, run plans — so the lifecycle can be orchestrated deterministically and *displayed* without convoy writing any OpenSpec state or keeping any registry of its own.

## What Changes

- **`convoy spin` — birth of a feature, deterministic.** Given an uncommitted OpenSpec change on the base checkout (the happy path: explore → propose in-session → spin), spin creates an isolated worktree whose branch name is derived deterministically from the change: a conventional-commit prefix inferred from the change's own delta-spec operations (`ADDED` requirements → `feat`, only-`MODIFIED` → `change`, only-`REMOVED` → `fix`), then the change id (`feat/specs-viewer-tabbed-reading`). It moves the uncommitted `openspec/changes/<id>/` files into the worktree, commits nothing on main, reverts nothing, and prints the `/move` handoff so the operator's OpenCode session — the exploration conversation itself — relocates to the worktree with its history intact (OpenCode's native `/move` dialog lists the fresh worktree after its project-directory refresh).
- **Global `/spin` OpenCode command, installed by convoy.** A thin prompt wrapper that tells the agent in the current session to run `convoy spin` and relay the next steps; no inference, no pipeline guessing. Convoy installs/updates it into the user's global `~/.config/opencode/commands/` — a minimal renacer of the removed `opencode-install`, one markdown file, nothing per-repo.
- **`convoy control` — the single board, fully inferred.** `convoy specs` evolves into `convoy control` (`specs` stays as an alias): one panel for every feature and spec. Each Active Changes row derives its state live — tasks done/total, linked runs, uncommitted proposal, synced-with-main, merged — from git, `openspec list`, and run plans, with no persisted registry: if it appears it is correct; if it is stale, closing the gap is the flow's job. A **Worktrees without spec** section lists isolated-run worktrees that carry no OpenSpec change.
- **Row actions.** *Spin out* materializes a worktree for a change stranded on main (uncommitted files travel; committed ones are left alone and resolve at merge). *Continue* hands the feature to the launcher **reusing its existing worktree and branch** instead of minting a new one, and the launcher warns when isolation is enabled while already inside a worktree ("you are on branch X of worktree Y — fork only if you truly mean it"). *Close* runs the full closing sequence. *Archive on main* remediates merged-but-unarchived changes (the `worktree-location` situation) without a redundant merge.
- **`convoy close` — death of a feature, one sequence.** Preflight (clean tree, tasks complete, no live runs) → sync (merge the base branch into the feature branch; conflicts stop for the human) → archive (shell out to `openspec archive`, the tool that owns that state) → squash (existing `finish` logic collapses convoy's commits into one signed conventional commit) → merge into the base branch in the main checkout → optional push, branch cleanup, worktree removal. Merged-ness is detected honestly: patch-equivalence (`git cherry`) reports *probably merged*, never *merged* — the close sequence is the only path that makes it certain.
- **Tabbed reading absorbed.** The `specs-viewer-tabbed-reading` redesign (branch `feat/specs-viewer-tabbed-reading`, superseded by this change) lands here: the control board's reading level becomes a full-width tabbed pane (one tab per artifact group, merged Delta Specs tab, hidden strip for single groups), with a fullscreen reader (`v`) and copy-the-active-tab (`c`) matching the run dashboard's conventions, and leaner header/footer chrome.

## Capabilities

### New Capabilities

- `feature-spin`: deterministic worktree creation from an uncommitted change — conventional-prefix inference, branch/worktree naming, moving the change files, the `/move` handoff, and the globally installed `/spin` wrapper.
- `feature-close`: the closing sequence — preflight, sync, archive, squash, merge, optional cleanup — and honest merged-detection for remediation rows.
- `control-board`: the inferred feature board — `convoy control` surface, derived per-change state, sections (active changes, worktrees without spec, canonical specs), and the row actions (spin out, continue with worktree reuse, close, archive on main), plus the launcher's nested-isolation warning.

### Modified Capabilities

- `specs-viewer`: the reading experience becomes the tabbed detail level (tabs per artifact group, single merged Delta Specs tab, hidden strip for single groups, repurposed keys), gains the fullscreen reader and copy-the-active-tab, and drops the static header line and obvious-navigation footer hints — superseding and absorbing the `specs-viewer-tabbed-reading` change.

## Impact

- Modified code: `src/cli.ts` (new `spin`/`close` commands, `specs` → `control` alias), `src/specs-browser.ts` + `src/specs.ts` (board sections, state columns, actions, tabbed reading), `src/launch-tui.ts` (feature-row handoff with worktree/branch reuse, nested-isolation warning), `src/finish.ts` (close sequence reuses the squash core), `src/openspec.ts` (resolver stays the single branch↔change matcher), `src/worktree.ts` (prefix inference input, spin entry).
- New code: `src/spin.ts`, `src/feature-close.ts`, `src/control-board.ts` (view assembly), a minimal `src/opencode-install.ts` rebirth (one global command file).
- OpenSpec stays write-only to its owner: convoy shells out to `openspec archive` and never edits `openspec/` by hand; the board only reads.
- No new dependencies; no persisted convoy-side feature registry anywhere.
- Supersedes branch `feat/specs-viewer-tabbed-reading` (its artifacts are absorbed into this change's delta).
