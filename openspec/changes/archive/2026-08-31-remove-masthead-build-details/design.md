## Context

The Home masthead gets its version-row text from `versionDetails()` in `src/version.ts`; `src/home-tui.ts` uses that same value in both masthead layouts and when calculating whether the three-row wordmark fits. The baseline formatter appends a short commit and platform to `info.version`, while the separate `formatVersion()` function backs the detailed `convoy --version` output. Local builds already place their short commit in SemVer build metadata. See proposal.md — Why and the `home-launcher` delta spec.

## Goals / Non-Goals

**Goals:**

- Keep one Home-specific formatting boundary that returns the complete version unchanged.
- Preserve detailed commit and platform information on the diagnostic CLI surface.
- Let existing responsive layout calculations react naturally to the shorter string.

**Non-Goals:**

- Changing local-build version generation or SemVer metadata.
- Changing `formatVersion()` or the `convoy --version` output contract.
- Adjusting project-path alignment, wordmark constants, or compact-layout behavior.

## Decisions

**1. Make `versionDetails()` return `info.version` directly.**

The Home formatter will no longer read `info.commit` or `info.platform`; any local marker and short commit remain present because they are already part of `info.version`. This applies one consistent shape to stable and local builds. An alternative that removes the suffix only for local builds was rejected because it would leave the same nonessential parenthetical details on releases and require unnecessary branching.

**2. Keep `formatVersion()` independent and unchanged.**

The CLI formatter remains the source of `convoy <version> (commit <full-sha>, <platform>)`. Reusing the simplified Home formatter for CLI output was rejected because installers, the updater, and bug reports rely on the diagnostic line's existing shape and detail.

**3. Do not edit Home layout logic.**

Both wide and compact mastheads already render `versionDetails()`, and `wordmarkGlyphRows()` measures it. Shortening the formatted value therefore updates rendering and the width threshold together without layout-specific branches or constants.

**4. Test the formatting boundary and retain Home integration coverage.**

Formatter tests will assert exact stable and local output, including that local metadata appears once and no parenthesis or platform is appended. Existing Home rendering tests will continue to verify that the formatter's value appears in the masthead; CLI version tests remain unchanged.

## Risks / Trade-offs

- [The Home screen no longer exposes architecture at a glance] → Keep commit and platform available through `convoy --version`, the intended diagnostic surface.
- [A local version still contains a hash] → This is intentional build identity embedded once in the version, not duplicated masthead detail.
- [The shorter value changes the width at which the block wordmark appears] → This follows the existing measured-layout design and reduces unnecessary compact fallback.

## Migration Plan

No migration is required because this changes only rendered Home text. Rollback is a direct revert of the formatter and its tests.
