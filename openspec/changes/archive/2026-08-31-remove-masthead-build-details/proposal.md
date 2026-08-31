## Why

The Home masthead currently repeats build identity beside the version as `(<commit-fragment>, <platform>)`. This is redundant for local builds, whose version already embeds the short commit as build metadata, and adds visual noise and width pressure for every build.

## What Changes

- The Home masthead shows only the complete version string on its version row, with no parenthetical commit or platform details.
- Stable builds continue to render their normal version; local builds retain the `-local+<short-commit>` metadata already embedded in that version.
- Both wide and compact Home masthead layouts use the simplified version string, including when calculating whether the block wordmark fits.
- The `convoy --version` diagnostic output remains unchanged and continues to report the full commit and platform.
- Project-path alignment and other responsive masthead behavior remain unchanged.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `home-launcher`: revise the unified masthead requirement so its first row contains only the complete version string, without separate commit or platform details.

## Impact

- `src/version.ts`: the Home-specific version formatter returns the version string without appending build details; the CLI formatter is unchanged.
- `src/home-tui.ts`: no behavior-specific edits are expected because both layouts already render and measure the Home-specific formatter.
- `test/version.test.ts` and `test/home-tui.test.ts`: expectations cover release and local versions without a parenthetical suffix.
- No configuration, CLI flags, persisted formats, build metadata, or dependencies change.
