## Context

See `proposal.md` for motivation and `specs/goal-subflows/spec.md` for the behavioral contract.

The current pipeline DSL resolves one flat sequence of agent/human steps, with one-level `parallel` blocks compiled into contiguous `groupId`s. Goal behavior sits outside that sequence: pipeline-level scalar settings and CLI flags activate `goal-loop.ts`, CLI resolution separately looks up a regular pipeline named `goal-fix`, and each improvement iteration builds and runs a new plan. The reviewed plan, launch file, run options, and goal loop therefore carry overlapping representations that can diverge.

Every repeated run currently gets a workspace, metadata record, run ID, pipeline identity, PRD-history entry, hosted release, and reset event. This makes a single bounded operation appear as unrelated runs and prevents historical reconstruction from recovering the full score trajectory. The existing score parser, best-state snapshot/restore policy, goal-brief sanitization, phase runner, report contracts, model routing, and parallel execution are valuable and should be reused rather than rewritten.

## Goals / Non-Goals

**Goals:**

- Model goal behavior as an owned terminal control step in the selected pipeline.
- Make the immutable reviewed `RunPlan` the sole execution authority for prefix, improve, measure, models, advisors, and policy.
- Preserve fresh independent scoring and bounded stop/restore behavior while removing magic pipeline and agent-name coupling.
- Execute and persist the complete cycle as one logical run with one lifecycle and reconstructable state.
- Fail closed with migration help for every retired flag and legacy configuration shape.
- Introduce the architecture incrementally, keeping behavior-preserving seams testable between stages.

**Non-Goals:**

- A general-purpose loop/conditional workflow language.
- More than one goal step, non-terminal goals, nested goals, or human gates inside goal fragments.
- Selecting reports from unrelated historical runs or continuing a new goal cycle from a historical score.
- Changing the quality rubric, score schema, default scorer roster, plateau mathematics, or safe best-state restore guards.
- Allowing run-time flags to synthesize, enable, disable, or alter a pipeline's goal policy.

## Decisions

### 1. Add a terminal domain-specific `goal` step

The external shape is:

```yaml
pipelines:
  ship:
    steps:
      - agent: sync-with-base
        name: sync
        reports: none

      - goal:
          target: 85
          maxIterations: 3
          plateau: 3

          improve:
            briefStep: fix
            steps:
              - agent: goal-fixer
                name: fix
                reports: none
                diff: true
                prdHistory: true

          measure:
            steps:
              - parallel:
                  - agent: quality-scorer
                    name: score
                    models: [openrouter/x-ai/grok-4.6#high, openrouter/z-ai/glm-5.3#high]
                    reports: none
                    prdHistory: true
              - agent: quality-score-report
                name: score-report
                model: openrouter/z-ai/glm-5.3#high
                reports: [score]
                verify: true
                prdHistory: true
```

`GoalStepSpec` joins `StepSpec` as a control node alongside `parallel`. Validation requires it to be the final and only goal node. `target` is required; `maxIterations` and `plateau` retain defaults of three.

The resolver splits a pipeline into ordinary prefix steps and one optional resolved goal plan. It does not flatten repeated instances in advance because the number of iterations is dynamic.

Alternatives considered:

- A pipeline-level `goal.repeat.steps` object would fit the current two-pipeline runtime with fewer edits, but it would keep initial scoring outside the owned control structure and duplicate scorer definitions.
- `initial`/`repeat`/`each` annotations on flat steps reduce nesting but make execution order and scorer isolation something authors must mentally compile.
- A generic `loop/until` node adds flexibility that Convoy does not need and weakens quality-score-specific validation.

### 2. Resolve improve and measure as pipeline fragments, not pipelines

Introduce a reusable fragment resolver that accepts `StepSpec[]`, the agent registry, model defaults, and an empty local report namespace. It returns ordered resolved steps with the existing model fan-out, parallel grouping, read-only enforcement, report paths, advisor resolution, and deliverable contracts.

Conceptually:

```ts
type ResolvedPipelineFragment = {
  steps: Step[]
  maxConcurrentAgents?: number
}

type ResolvedGoalPlan = {
  target: number
  maxIterations: number
  plateau: number
  briefRecipient: string
  improve: ResolvedPipelineFragment
  measure: ResolvedPipelineFragment
  scoreProducer: string
}
```

Fragments deliberately omit pipeline name, default prompt, suggestions, hooks, nested goal policy, and public registry identity. `briefRecipient` is resolved from `improve.briefStep`; `scoreProducer` is inferred from the unique final quality-score deliverable contract, not from agent or step names.

The measure fragment is resolved with no outer reports. Each invocation gets a fresh namespace, so `previous`, `all`, and explicit report names can reference only reports created earlier in that same measurement. The improve fragment follows the same rule. A pipeline that needs more measurement evidence must add a collector step inside `measure` rather than importing narrative from prefix or previous rounds.

### 3. Make `RunPlan` the only goal authority

The routed and reviewed plan owns the effective `ResolvedGoalPlan`. Model routing recursively freezes prefix, improve, and measure exactly once. Plan review expands both fragment templates and states their maximum invocation count; preflight walks the same resolved tree, including advisors.

Remove goal state from run options and launch transport: no `goalFixPipeline`, scalar goal options, or separate `LaunchFile.goal`. The coordinator dispatches one reviewed plan to the normal runner. The runtime never looks up a pipeline by the string `goal-fix` and never rebuilds/reroutes an internal plan between iterations.

This closes the present consent gap where plan review can display one routed fix pipeline while execution reads another unresolved copy from `RunOptions`.

### 4. Execute fragments within one hosted run context

Refactor the phase-group execution portion of `run()` into an internal `executeFragment(context, fragment, invocation)` operation. The outer runner creates the workspace, metadata store, OpenCode host, controller bindings, status tracker, hooks, and shutdown handling once, then schedules:

```text
prefix
measure(0)
while below target and policy permits:
  improve(n)
  measure(n)
summary + post-hooks + one finish hold
```

Repository commits and per-phase read-only baselines continue using the current phase runner. Existing pure policy code for target/plateau/cap, quality-score parsing, sanitized briefs, snapshots, and guarded restoration is retained behind the new scheduler.

Concrete phase IDs are stable and safe for metadata keys, for example:

- `goal-measure-0-score__openrouter-x-ai-grok-4-6-high`
- `goal-improve-1-fix`
- `goal-measure-1-score-report`

Display metadata keeps the logical fragment step name separately so the TUI does not expose physical IDs as the primary label.

A transitional implementation may first execute the resolved fragments through an adapter around the existing hosted-run machinery, but it MUST preserve one parent run identity and MUST NOT expose child runs in history. The end state removes `KeptWorkspaces`, repeated hosted releases, `goalContinues`, `deferPostHooks`, and trajectory transport through run options.

### 5. Isolate briefs, reports, and authoritative score promotion

After each successful measurement, persist the complete canonical `QualityScore` and build the next sanitized improve brief from that object. Only the concrete phase matching `briefRecipient` receives it.

Invocation reports use namespaced paths:

```text
reports/goal/iteration-0/measure/<step>.md
reports/goal/iteration-1/improve/<step>.md
reports/goal/iteration-1/measure/<step>.md
```

The latest authoritative consensus report is also atomically promoted to `reports/score-report.md`, preserving existing tooling and operator expectations. Promotion happens only after contract validation and metadata persistence, so an invalid or interrupted attempt cannot replace the last measured score.

Step filters are resolved only against ordinary prefix steps. Goal control and fragment steps are outside their namespace; attempts to name them fail instead of partially compiling a loop.

### 6. Persist goal state in a new metadata schema

Advance run metadata with a goal record containing:

```ts
type GoalRunState = {
  target: number
  maxIterations: number
  plateau: number
  iteration: number
  stage: "measure" | "improve" | "complete"
  scores: QualityScore[]
  bestScore?: number
  outcome?: "goal" | "plateau" | "max-iterations" | "no-score" | "failed"
  restored?: boolean
  restoreRefusedReason?: string
}
```

The frozen resolved goal definition remains part of the parent plan. Metadata is flushed after phase completion, score validation/promotion, stage transitions, best-state capture, and final outcome. Resume derives its next action from this durable state and existing report/phase status rather than reconstructing a child pipeline. Schema-v3 metadata remains readable as historical non-grouped runs, but old `goal-fix` child runs are not retroactively merged.

Run history exposes final/current score and trajectory from metadata. Historical attach passes the same reconstructed goal view and quality score to the dashboard as live control. This also fixes the current control-path omission by making finish outcome score fields part of the serializable protocol rather than relying only on ephemeral `RunResult` data.

### 7. Keep one parent lifecycle and update presentation incrementally

Global and parent pipeline pre-hooks run once before prefix execution. Parent post-hooks run once after the final outcome and receive the existing goal environment variables plus the final/best authoritative score. Fragments cannot declare or inherit pipeline-specific hook names.

The launch and plan-review TUI display goal policy plus improve/measure templates, but no toggle. During execution, the dashboard appends or activates iteration-qualified groups under the parent pipeline and keeps the existing trajectory/verdict header behavior. Control protocol updates describe an active goal stage/iteration rather than replacing the dashboard with another pipeline/run ID.

Config TUI treats `goal` as a collapsible terminal control node. Materializing a built-in produces the full embedded definition. `goal-fix` is removed from all built-in lists and cannot be customized independently.

### 8. Remove flags and fail legacy configuration closed

The CLI parser recognizes retired goal flags only long enough to emit a targeted migration error before plan review or worktree creation; help and launcher options omit them. No compatibility execution path remains.

Config validation detects:

- Pipeline-level scalar `goal`
- `goalMaxIterations`
- `goalPlateau`
- A top-level pipeline named `goal-fix`

It aggregates all detected paths into one error and renders an equivalent terminal goal skeleton. Where both a scalar owner and legacy `goal-fix` definition exist, the diagnostic preserves the scalar policy and shows the legacy steps as source material for `improve`/`measure`; it does not guess their semantic split or write the file. The `goal-fix` name remains reserved to prevent old configuration from becoming an unrelated public pipeline silently.

The built-in `ship` definition, shipped config templates, and repository test fixtures migrate atomically with parser support so released project content never depends on the rejected legacy shape. Operator-owned global or project configuration, including custom `full-cycle` pipelines, is never rewritten; it receives the actionable migration error.

## Risks / Trade-offs

- **[Risk] The control-step DSL significantly broadens parser, resolver, and config-TUI address shapes.** → Keep goal terminal and non-nestable, centralize fragment parsing/resolution, and add path-specific schema tests before runtime work.
- **[Risk] Moving from multiple hosted runs to one context can regress shutdown, permissions, baselines, commits, or server attachment.** → Extract fragment execution without changing phase execution first; port abort, release, failure-gate, and read-only-boundary tests before deleting old lifecycle code.
- **[Risk] Dynamic iterations complicate phase identity and TUI reconstruction.** → Use deterministic invocation-qualified physical IDs plus separate logical labels, and make metadata—not transient reset messages—the reconstruction source of truth.
- **[Risk] Report promotion can expose a score inconsistent with repository state.** → Persist score, associated repository snapshot, and namespaced report before atomically updating the conventional final-report path.
- **[Risk] Strict migration breaks existing global/project config immediately.** → Fail before side effects, aggregate every legacy path, and print a copyable skeleton; document the release as breaking. No silent fallback is permitted by decision.
- **[Risk] Preventing measure from reading prefix reports changes current `ship` wiring.** → Preserve PRD/spec and diff attachments, move any load-bearing evidence collection into `measure`, and retain scorer-blindness regression tests.
- **[Risk] A single retained workspace can grow with iteration logs and reports.** → Namespace artifacts, cap iterations, and honor run-directory cleanup only once at settlement.
- **[Trade-off] Custom goal authors repeat some model configuration across pipelines.** → Ownership and reviewability are preferred over a hidden global template; TypeScript built-ins can share private construction helpers without creating public configuration inheritance.

## Migration Plan

1. Add failing contract tests for terminal goal parsing, fragment validation, flag removal, legacy errors, public pipeline visibility, and scorer isolation.
2. Introduce goal/fragment spec and resolved types plus shared fragment resolution; migrate built-in `ship` and project `full-cycle` while retaining the old runtime behind a private adapter.
3. Route and freeze embedded fragments in `RunPlan`; update plan review and preflight, then remove `goalFixPipeline` and duplicate launch/config decision state.
4. Move scheduling into one run context, preserving current policy/brief/restore code and adding invocation-qualified report/phase identities.
5. Add durable goal metadata, score promotion, resume checkpoints, run-history fields, and live/historical control transport.
6. Replace pipeline-reset presentation with parent-run goal-stage presentation; consolidate hooks and workspace settlement.
7. Remove the public `goal-fix` built-in, goal flags, legacy scalar execution paths, child-run orchestration, and obsolete lifecycle fields.
8. Update README/config templates and run the full typecheck, unit/integration suite, strict OpenSpec validation, and build verification.

Rollback during development is by stage: keep each stage behaviorally complete and do not delete the old executor until the embedded plan passes parity tests. Once the breaking schema ships, rollback requires restoring the prior binary and prior configuration together; the migration diagnostic does not mutate user files, so operators retain their original config for that rollback.
