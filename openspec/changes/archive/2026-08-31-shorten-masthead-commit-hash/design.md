## Context

The masthead line comes from `versionDetails()` in `src/version.ts`, which today derives from `formatVersion()` by stripping the `convoy ` prefix: both read `<version> (commit <full 40-char SHA>, <platform>)`. `formatVersion()` also backs the `convoy --version` CLI output. `src/home-tui.ts` renders `versionDetails()` in both masthead layouts and uses `displayWidth(versionDetails())` to decide whether the three-row block wordmark fits, so every masthead consumer goes through the one function. See proposal.md — Why.

## Goals / Non-Goals

**Goals:**

- Masthead build line reads `<version> (<7-char commit fragment>, <platform>)` with no `commit` label, in both wide and compact layouts.
- Keep the full SHA on the `convoy --version` diagnostic surface.

**Non-Goals:**

- Changing `formatVersion()` / `--version` output or its tests' expectations.
- Changing the build-time version metadata scheme in `scripts/build.ts` (`0.6.0-local+a475995`).
- Any masthead layout work beyond what falls out of the shorter string automatically.

## Decisions

**1. Shorten in `versionDetails()`, not in `formatVersion()`.**
`versionDetails()` stops deriving from `formatVersion()` and formats its own line: `${info.version} (${shortCommit}, ${info.platform})`. Alternative: shortening `formatVersion()` itself would also change `--version` — rejected, the full hash there is the copy-paste identity for bug reports. This split also makes the two functions' difference intentional instead of a regex away from identical.

**2. The fragment is the first 7 characters of the SHA, via a small pure helper in `version.ts`.**
`scripts/build.ts` already shortens the same way (`commit.slice(0, 7)` for local build metadata), and 7-char prefixes are what git accepts for `git show`/`git log`, so the fragment is usable, not just short. The user's wording was "últimos dígitos" (last digits) — recorded as a deliberate deviation: a suffix fragment can't be fed to git tooling, defeating the point of showing a hash at all. The helper handles the `"unknown"` sentinel for free (`"unknown".slice(0, 7)` is `"unknown"`). `scripts/build.ts` keeps its own slice rather than importing runtime code into the build script.

**3. No layout edits.**
`wordmarkGlyphRows()` measures `displayWidth(versionDetails())`, so the ~33-column saving automatically lets the block wordmark appear at narrower widths. That is the desired effect; touching layout constants would fight it.

## Risks / Trade-offs

- [Two local builds sharing 7 leading chars would render identically] → Acceptable: the fragment is glanceable chrome, not identity; `--version` keeps the full SHA.
- [Local builds show the fragment twice (`0.6.0-local+a475995 (a475995, …)`)] → Pre-existing shape (full hash already repeated the metadata's fragment); special-casing local builds adds branching for no diagnostic value.
- [Hidden consumers of the long line] → Verified by search: `versionDetails()` is used only by `home-tui.ts` and the tests; `formatVersion()` only by `cli.ts` and tests.

## Migration Plan

None — a pure display change with no persisted formats, flags, or protocol. Rollback is a plain revert.
