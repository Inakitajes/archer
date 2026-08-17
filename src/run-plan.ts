import { resolveModel, type ModelGateway, type ModelRoutingOverrides } from "./model-routing"
import type { PrdHistoryPreview } from "./prd-history"
import { defaultGoalMaxIterations, defaultGoalPlateau } from "./quality-score"
import { stepRunnerFor } from "./step-runners"
import type { AgentStep, Pipeline, RunOptions, RunPlan, Step } from "./types"

export type BuildRunPlanInput = RunOptions & {
  promptSource?: RunPlan["prompt"]["source"]
  worktree?: boolean
  /** Worktree runs: the branch name confirmed in the launcher, frozen into the plan the user reviews. */
  branch?: string
  /** Worktree runs: the directory that branch will be checked out in. */
  worktreeDir?: string
  /** The run's frozen gateway when resuming; recorded in the plan when an explicit --gateway replaces it. */
  resumeGateway?: ModelGateway
  /** Precomputed checkout preview; `buildRunPlan` does not touch the filesystem. */
  prdHistoryPreview?: PrdHistoryPreview
}

/** Purely resolves the complete execution shape; it performs no filesystem or process effects. */
export function buildRunPlan(input: BuildRunPlanInput): RunPlan {
  const gateway = input.gateway ?? "configured"
  const overrides = input.modelRoutingOverrides ?? {}
  // The immutable plan must never recursively freeze caller-owned config.
  const pipeline = routePipeline(filterPipeline(structuredClone(input.pipeline), input.onlySteps, input.skipSteps), gateway, overrides, input.modelOverride, {
    advisorOverride: input.advisorOverride,
    advisorDisabled: input.advisorDisabled,
  })
  const judge = input.smart
    ? resolveModel(input.smartJudgeModel, gateway, overrides)
    : undefined
  const hooks = hooksForPlan(input, pipeline.name)
  // Goal mode: when on, route the goal-fix pipeline through the same gateway
  // and freeze its config into the plan the operator reviews and preflights —
  // so the full bounded loop (target, cap, plateau, fix pipeline, mutation) is
  // visible and validated before a single model session starts.
  const goal =
    input.goal !== undefined && input.goalFixPipeline
      ? {
          target: input.goal,
          maxIterations: input.goalMaxIterations ?? defaultGoalMaxIterations,
          plateau: input.goalPlateau ?? defaultGoalPlateau,
          fixPipeline: routePipeline(structuredClone(input.goalFixPipeline), gateway, overrides, input.modelOverride, {
            advisorOverride: input.advisorOverride,
            advisorDisabled: input.advisorDisabled,
          }),
        }
      : undefined
  return deepFreeze({
    prompt: { source: input.promptSource ?? (input.resumeRunID ? "resume" : "inline"), text: input.prompt },
    target: {
      directory: input.targetDir,
      baseRef: input.baseRef,
      worktree: input.worktree ?? false,
      dirty: input.includeDirty,
      ...(input.branch ? { branch: input.branch } : {}),
      ...(input.worktreeDir ? { worktreeDir: input.worktreeDir } : {}),
    },
    pipeline,
    modelRouting: { gateway },
    ...(judge ? { smartJudge: { model: judge } } : {}),
    hooks,
    attachments: [...input.files],
    ...(input.prdHistoryPreview ? { prdHistory: input.prdHistoryPreview } : {}),
    permissions: input.yolo ? "yolo" : input.smart ? "smart" : "interactive",
    ...(goal ? { goal } : {}),
    ...(input.resumeRunID
      ? {
          resume: {
            runID: input.resumeRunID,
            ...(input.resumeGateway && input.resumeGateway !== gateway
              ? { gatewayOverride: { original: input.resumeGateway, pending: gateway } }
              : {}),
          },
        }
      : {}),
  })
}

export type AdvisorPlanOverrides = {
  /** Forces this advising model on every advisor-capable step. Empty leaves each step's own resolution alone. */
  advisorOverride?: string
  /** Strips the advisor from every step; wins over advisorOverride. */
  advisorDisabled?: boolean
}

export function routePipeline(
  pipeline: Pipeline,
  gateway: ModelGateway,
  overrides: ModelRoutingOverrides,
  modelOverride = "",
  advisor: AdvisorPlanOverrides = {},
): Pipeline {
  return {
    ...pipeline,
    steps: pipeline.steps.map((step): Step => {
      if (step.type !== "agent" || stepRunnerFor(step.runner).id !== "opencode") return structuredClone(step)
      const configured = modelOverride || `${step.model}${step.variant ? `#${step.variant}` : ""}`
      const resolvedModel = resolveModel(configured, gateway, overrides)
      return {
        ...step,
        model: `${resolvedModel.providerID}/${resolvedModel.modelID}`,
        ...(resolvedModel.variant ? { variant: resolvedModel.variant } : { variant: undefined }),
        resolvedModel,
        ...routeAdvisor(step, gateway, overrides, advisor),
      }
    }),
  }
}

/**
 * The advisor is routed through the run's gateway exactly like the executor's
 * model, so a `--gateway openrouter` run doesn't consult the advisor direct.
 * Returns the full set of advisor fields (explicitly undefined when off) so the
 * spread always overwrites whatever the step carried in.
 */
function routeAdvisor(
  step: AgentStep,
  gateway: ModelGateway,
  overrides: ModelRoutingOverrides,
  { advisorOverride = "", advisorDisabled = false }: AdvisorPlanOverrides,
): Pick<AgentStep, "advisor" | "advisorVariant" | "resolvedAdvisor"> {
  const off = { advisor: undefined, advisorVariant: undefined, resolvedAdvisor: undefined }
  if (advisorDisabled) return off
  const configured = advisorOverride || (step.advisor ? `${step.advisor}${step.advisorVariant ? `#${step.advisorVariant}` : ""}` : "")
  if (!configured) return off

  const resolvedAdvisor = resolveModel(configured, gateway, overrides)
  return {
    advisor: `${resolvedAdvisor.providerID}/${resolvedAdvisor.modelID}`,
    advisorVariant: resolvedAdvisor.variant,
    resolvedAdvisor,
  }
}

function filterPipeline(pipeline: Pipeline, only: string[], skip: string[]): Pipeline {
  const selected = (step: Step) => {
    const logicalName = step.type === "agent" ? step.stepName : step.name
    if (only.length > 0 && !only.includes(step.name) && !only.includes(logicalName)) return false
    return !skip.includes(step.name) && !skip.includes(logicalName)
  }
  return { ...pipeline, steps: pipeline.steps.filter(selected) }
}

function hooksForPlan(input: RunOptions, pipelineName: string) {
  const pipeline = input.hooks.pipelines[pipelineName]
  return structuredClone({
    pre: [...input.hooks.pre, ...(pipeline?.pre ?? [])],
    post: [...input.hooks.post, ...(pipeline?.post ?? [])],
  })
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

export function plannedStepModel(step: AgentStep): string {
  if (step.runner === "claude-code") return `claude-code/${step.model || "default"}`
  return step.resolvedModel?.target ?? `${step.model}${step.variant ? `#${step.variant}` : ""}`
}

/** The step's advising model as the reviewed plan shows it, or undefined when the step runs without one. */
export function plannedStepAdvisor(step: AgentStep): string | undefined {
  if (!step.advisor) return undefined
  return step.resolvedAdvisor?.target ?? `${step.advisor}${step.advisorVariant ? `#${step.advisorVariant}` : ""}`
}
