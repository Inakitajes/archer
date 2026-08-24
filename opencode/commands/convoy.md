---
description: Run a Convoy pipeline against the OpenSpec change active in this directory
model: openrouter/deepseek/deepseek-v4-flash-0731#high
tools: bash
---

Run Convoy on the OpenSpec change active in the current directory.

1. Determine the active OpenSpec change under `openspec/changes/` (a single
   non-archived change, the branch-named change, or `--change <id>` when the
   operator said so). If there is no active change, tell the user to run
   `/opsx:propose` first and stop.
2. If the `convoy` binary is on PATH, run:

   ```
   convoy -p <pipeline-or-review> --no-tui --no-confirm
   ```

   without inventing a prompt: the spec bundle is the contract and an OpenSpec
   change must already be attached. Prefer `-p review` for a report-only run
   and `-p implement` for a writable run; the operator may name a custom
   pipeline with `/convoy <pipeline-name>`.
3. Report the pipeline's outcome and the run id back to the operator. Never
   push, merge, or open pull requests — that stays a human decision.
