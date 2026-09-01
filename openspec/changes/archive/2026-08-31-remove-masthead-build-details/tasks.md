## 1. Version formatting

- [x] 1.1 Rework the Home-specific `versionDetails()` formatter to return the complete version string without a parenthetical commit or platform suffix, remove any formatter-only commit-shortening code that becomes unused, and update `test/version.test.ts` with exact stable and local cases while preserving `formatVersion()` expectations; verify with `bun test test/version.test.ts`.

## 2. Home behavior and verification

- [x] 2.1 Confirm both Home masthead layouts and the glyph-row width calculation continue to consume the shared formatter without layout-specific changes, and add or adjust wide and compact rendering assertions so the version appears without separate build details while project-path behavior remains unchanged; verify with `bun test test/home-tui.test.ts`.
- [x] 2.2 Run `make test` and confirm typechecking and the full test suite pass, including the unchanged `convoy --version` contract.
