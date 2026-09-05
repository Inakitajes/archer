## Why

`convoy spin` moves an uncommitted OpenSpec change into its new worktree, but its current cleanup only considers directories that directly contained moved files. Intermediate directories such as `openspec/changes/<id>/specs/` can remain empty in the base checkout, creating invisible local residue because Git does not track empty directories.

## What Changes

- Make spin remove the complete empty directory ancestry left by moved change artifacts, including the selected change root.
- Bound cleanup to `openspec/changes/<id>/` and preserve any directory that still contains files, symlinks, or other content.
- Add regression coverage for nested artifact directories and isolation from other active changes.

## Capabilities

### New Capabilities

- None.

### Modified Capabilities

- `feature-spin`: Clarify and enforce that moving an uncommitted change leaves no empty source directory tree in the base checkout while preserving unrelated content.

## Impact

- Affected implementation: `src/spin.ts` source-directory cleanup after moving artifacts.
- Affected tests: `test/spin.test.ts` spin integration coverage.
- No CLI syntax, branch naming, worktree layout, dependency, or compatibility changes.
