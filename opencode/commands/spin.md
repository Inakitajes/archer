---
description: Create a branch and worktree for this change and move this session there
model: openrouter/deepseek/deepseek-v4-flash-0731#high
tools: bash
---

Create an isolated branch + worktree for the OpenSpec change the operator is
about to work on, and move this session into it.

1. Derive the branch name from the OpenSpec change the operator names
   (`/spin add-login` → `feat/add-login`), or from the current intent when no
   change exists yet (fall back to `feat/<what-the-operator-is-doing>`).
2. With git, create the branch and worktree, e.g.:

   ```
   git worktree add -b feat/add-login ../add-login main
   ```

   Confirm the new branch is checked out with `git branch --show-current`.
3. Move this session to the new worktree: point an attached/`opencode` session
   at the new directory. If the TUI cannot follow the new working directory,
   degrade to opening a new OpenCode session (a fork) rooted at the worktree
   and tell the operator where the original session went.

Keep the move local — creating the branch and worktree is the whole job. Do not
push, merge, or run any pipeline afterwards unless the operator asks.
