## Why

The home launcher's masthead right-aligns the build line next to the wordmark, e.g. `0.6.0 (commit 4f2a9b8c1d3e5f7a9b0c1d2e3f4a5b6c7d8e9f0a, darwin-arm64)`. The word "commit" plus the full 40-character SHA is noise in a header that has room for a tag, not a build line: it consumes ~50 columns that the wordmark layout must work around, and no identification beyond a short hash fragment is ever needed at a glance.

## What Changes

- The masthead build line drops the `commit` label and the full 40-character hash, and instead shows a short commit fragment: `0.6.0 (a475995, darwin-arm64)`.
- The short fragment is the first 7 characters of the commit SHA — git's `--short` convention, and the same shortening `scripts/build.ts` already applies for local build metadata (`0.6.0-local+a475995`). The user asked for "the last digits"; a short fragment is the intent, and the 7-character prefix is what git tooling accepts, so that convention is used.
- The `convoy --version` CLI diagnostic output is unchanged: it keeps the full hash because it is a copy-paste surface for bug reports, not chrome.
- Both masthead layouts (wide block wordmark and compact text wordmark) pick up the new line automatically, as will the glyph-row width calculation that reserves space for it.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `home-launcher`: the "Home presents a unified masthead" requirement changes the build line shown right-aligned on the first masthead row from the full build line (version, full commit with `commit` label, platform) to version, short commit fragment (no label), platform.

## Impact

- `src/version.ts`: `versionDetails()` (the masthead's build line) stops deriving from `formatVersion()` and formats the shortened line; `formatVersion()` (CLI `--version`) keeps the full hash.
- `src/home-tui.ts`: no behavior edits expected — it renders `versionDetails()` and measures its width by calling the same function.
- Tests: `test/version.test.ts` gains coverage for the shortened masthead line; `test/home-tui.test.ts` asserts against `versionDetails()` itself and adapts automatically.
- No config, CLI flags, or persisted formats change; the full SHA remains available via `convoy --version`.
