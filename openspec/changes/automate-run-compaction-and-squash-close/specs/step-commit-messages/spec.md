## ADDED Requirements

### Requirement: Compaction and closing preserve run-linked commit compatibility
Run-linked semantic messages SHALL remain valid inputs to automatic run compaction and feature closing despite multiline bodies and trailers. Automatic compaction MUST use the originating run's durable boundary and commit provenance rather than selecting all consecutive commits by authorship alone. Feature close SHALL include the complete feature-exclusive change regardless of authorship or intermediate trailers. The resulting operator-authored commits SHALL NOT be required to retain intermediate `Convoy-Run` trailers; their replacement relationship MUST remain recoverable through durable run/close evidence. The retired `convoy finish` command SHALL NOT remain an execution path.

#### Scenario: Automatic compaction sees run-linked commits
- **WHEN** the verified current-run interval contains `convoy@local` commits with semantic subjects, multiline detail bodies, and authoritative `Convoy-Run` trailers
- **THEN** automatic finalization selects that interval without admitting older runs solely because their author is also Convoy

#### Scenario: Close replaces intermediate history
- **WHEN** `convoy close` lands a feature containing operator commits and run-linked intermediate commits
- **THEN** the base gains one operator-authored squash-merge commit without needing to copy the intermediate trailers or rewrite the feature commits

## REMOVED Requirements

### Requirement: Existing squash behavior remains compatible
**Reason**: The old contract requires a shared authorship walk and an executable manual finish command. Both are deliberately replaced, while semantic messages and intermediate run trailers remain valid.
**Migration**: Use `Compaction and closing preserve run-linked commit compatibility`: automatic run compaction selects durable current-run ownership, close lands all feature-exclusive content regardless of author, and the retired finish command no longer executes.
