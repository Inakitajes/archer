## Context

`runSpin` obtains every non-ignored untracked file below the selected `openspec/changes/<id>/` path and moves those files into a newly created worktree. Its cleanup currently collects only each moved file's immediate former parent before attempting to remove empty directories. For a path such as `specs/feature-spin/spec.md`, that includes `specs/feature-spin/` but not the intermediate `specs/` directory, so the latter keeps the change root physically present even though Git reports a clean checkout.

The cleanup runs after all file moves and must work identically whether an individual move used a same-filesystem rename or the cross-device copy-and-unlink fallback.

## Goals / Non-Goals

**Goals:**

- Remove every emptied ancestor of a moved artifact through the selected change root.
- Make the cleanup boundary explicit and prevent it from reaching another change or a parent OpenSpec directory.
- Remove directories only when the filesystem confirms atomically that they are empty.

**Non-Goals:**

- Sweeping historical empty directories or directories outside the selected change.
- Changing which files spin moves, worktree creation, branch naming, or committed-on-base behavior.
- Adding rollback or transaction semantics to the existing multi-file move sequence.
- Changing cleanup performed by the external `openspec archive` command.

## Decisions

### Build a bounded ancestor set from the moved paths

The move helper will receive or derive the absolute selected change root. For every moved file, cleanup will walk from the file's former parent upward to and including that root, add each directory to a deduplicated candidate set, and then process candidates deepest first.

This extends the current strategy without scanning the complete OpenSpec tree. A recursive sweep was considered, but it could remove pre-existing empty sibling directories that the move did not empty and would broaden the operation beyond the paths implicated by spin.

### Use atomic empty-directory removal

Each candidate will be removed with an operation that succeeds only for an empty directory, rather than checking with `readdir` and then issuing a recursive removal. This closes the check/remove race and guarantees that a file, symlink, or other entry prevents deletion.

An already-absent or non-empty candidate is a valid cleanup outcome. Unexpected filesystem errors will be surfaced instead of allowing spin to claim complete cleanup when it could not satisfy the contract.

### Keep cleanup after all artifact moves

Cleanup remains a separate final phase after every artifact has moved. Processing the complete candidate set deepest first ensures sibling artifact directories are removed before their shared parents are tested and allows the selected change root to disappear only after its descendants are gone.

## Risks / Trade-offs

- **[Unexpected cleanup error occurs after files have moved]** → Surface the error with the affected path; do not add a partial rollback that could itself lose or duplicate artifacts.
- **[A future caller provides a path outside the selected change]** → Enforce the explicit change-root boundary before adding cleanup candidates.
- **[Non-moved or ignored content remains in the selected tree]** → Atomic empty-directory removal preserves the directory and its contents; spin removes only directories proven empty.

## Migration Plan

No data or configuration migration is required. The behavior applies to future spins; existing empty local directories are not swept automatically. Rollback consists of reverting the cleanup helper and its regression assertions.
