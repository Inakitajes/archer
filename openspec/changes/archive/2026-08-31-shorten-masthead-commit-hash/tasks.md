## 1. Version line

- [x] 1.1 In `src/version.ts`, add a pure helper that returns the first 7 characters of a commit SHA (passing `"unknown"` through unchanged) and rework `versionDetails()` to format `<version> (<fragment>, <platform>)` without the `commit` label or full hash; leave `formatVersion()` untouched. Verify with `bun test test/version.test.ts` — existing cases stay green.
- [x] 1.2 Extend `test/version.test.ts` with `versionDetails()` cases: a release info with a 40-char commit renders `0.1.1 (aaaaaaa, darwin-arm64)`, an unknown commit renders the `unknown` fragment, and no rendering contains the word `commit`. Verify with `bun test test/version.test.ts`.

## 2. Masthead and verification

- [x] 2.1 Confirm `src/home-tui.ts` needs no edits: both masthead layouts render `versionDetails()` and `wordmarkGlyphRows()` measures it, so the shortened line and the wider block-wordmark threshold apply automatically. Verify with `bun test test/home-tui.test.ts`.
- [x] 2.2 Run the full suite and typecheck (`bun test && bun run typecheck`) and confirm the only behavior change is the masthead build line; `--version` output still carries the full hash.
