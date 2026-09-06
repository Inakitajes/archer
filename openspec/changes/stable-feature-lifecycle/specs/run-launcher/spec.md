## ADDED Requirements

### Requirement: Launch review distinguishes contracts from feature association

The launcher SHALL show the selected contract set separately from the stable feature and verified execution context. A feature-aware apply or continue handoff SHALL preserve that identity and associated context from any launch checkout. Automatic contract suggestions, including a sole active change or branch-name match, SHALL not silently establish ownership. An accepted new feature-backed run SHALL explicitly register or reuse the reviewed association before execution. A selected context already owned by another feature SHALL require an explicit compatible selection or rebinding decision, not overwrite that association. No-spec runs SHALL keep their existing flow without inventing a change. Cancelling before acceptance SHALL leave no new feature record or worktree.

#### Scenario: One active spec on an arbitrary branch
- **WHEN** an unassociated branch contains one active change and the launcher suggests it
- **THEN** review shows the proposed feature/context/contract association, and only acceptance records that intent

#### Scenario: Apply from another checkout
- **WHEN** Apply is invoked on a registered feature while the browser was launched in a different worktree
- **THEN** the launcher pins the selected contracts and associated execution context instead of resolving a same-id change in the launch directory

#### Scenario: Multiple changes are selected
- **WHEN** review accepts two contracts for one implementation context
- **THEN** the feature and reviewed plan record the complete selected set and explain that close integrates the whole branch

### Requirement: Execution revalidates reviewed identity and persists run linkage

Before a feature-backed run starts, Convoy SHALL revalidate the reviewed repository, feature identity, association revision, actual branch/worktree, base, and active contract sources. Persistence of the feature link in durable run metadata SHALL precede execution. A changed or unverifiable target SHALL stop with remediation rather than silently selecting another contract or branch. This check SHALL be additional to, not a replacement for, the existing dirty-tree consent and execution-time gate. Association confirmation SHALL NOT imply consent to include dirty files. Reopening a historical run SHALL not change its frozen context.

#### Scenario: Branch switches after review
- **WHEN** the worktree changes branches after an operator accepts review
- **THEN** the run refuses before execution and does not attach the new branch's changes to the reviewed feature

#### Scenario: Dirty consent remains separate
- **WHEN** a feature association is confirmed while the execution tree is dirty and include-dirty is off
- **THEN** the existing explicit dirty-tree choice and final execution gate remain effective

#### Scenario: Run survives temporary workspace cleanup
- **WHEN** an accepted feature-backed run finishes and its temporary run workspace is removed
- **THEN** its durable record still identifies the feature, selected contracts, and frozen execution context
