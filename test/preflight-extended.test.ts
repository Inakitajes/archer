import { describe, expect, test } from "bun:test"
import { preflightRunPlan } from "../src/preflight"
import { preflightTargets, validatePreflightTargets } from "../src/preflight-validation"
import type { RunPlan, ResolvedModel } from "../src/types"

function basePlan(): RunPlan {
  return {
    prompt: { source: "inline", text: "test" },
    target: { directory: "/repo", baseRef: "main", worktree: false, dirty: false },
    pipeline: {
      name: "default",
      steps: [
        {
          type: "agent",
          name: "coder",
          stepName: "coder",
          groupId: "g1",
          agentName: "coder",
          description: "Coder",
          model: "openai/gpt-5",
          resolvedModel: {
            configured: "openai/gpt-5",
            logical: "openai/gpt-5",
            gateway: "configured",
            providerID: "openai",
            modelID: "gpt-5",
            target: "openai/gpt-5",
          },
          inputFiles: [],
          inputDiff: false,
          reportPath: "report.md",
        },
      ],
    },
    modelRouting: { gateway: "configured" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
  }
}

function catalog(overrides?: Partial<{
  providerID: string
  modelID: string
  variants: string[]
  connected: string[]
}>) {
  const providerID = overrides?.providerID ?? "openai"
  const modelID = overrides?.modelID ?? "gpt-5"
  const variants = overrides?.variants ?? []
  const connected = overrides?.connected ?? [providerID]
  return {
    all: [
      {
        id: providerID,
        models: {
          [modelID]: { variants: Object.fromEntries(variants.map((v) => [v, {}])) },
        },
      },
    ],
    connected,
  }
}

describe("preflightRunPlan", () => {
  test("skips discovery when there are no agent targets", async () => {
    const plan: RunPlan = { ...basePlan(), pipeline: { ...basePlan().pipeline, steps: [] } }
    let called = false
    await preflightRunPlan(plan, async () => { called = true; return catalog() })
    expect(called).toBe(false)
  })

  test("skips discovery when targets only contain claude-code steps", async () => {
    const plan = basePlan()
    plan.pipeline.steps = [{
      ...plan.pipeline.steps[0]!,
      type: "agent",
      runner: "claude-code",
      resolvedModel: null as unknown as undefined,
    } as typeof plan.pipeline.steps[0]]
    let called = false
    await preflightRunPlan(plan, async () => { called = true; return catalog() })
    expect(called).toBe(false)
  })

  test("runs discovery in the plan target directory", async () => {
    let discoveredDir = ""
    await preflightRunPlan(basePlan(), async (directory) => {
      discoveredDir = directory
      return catalog()
    })
    expect(discoveredDir).toBe("/repo")
  })

  test("passes validation when the provider and model exist", async () => {
    await expect(preflightRunPlan(basePlan(), () => catalog())).resolves.toBeUndefined()
  })

  test("throws when the provider is not in the catalog", async () => {
    const plan = basePlan()
    const step = plan.pipeline.steps[0]!
    if (step.type === "agent") {
      step.resolvedModel!.providerID = "nonexistent"
    }
    await expect(preflightRunPlan(plan, () => catalog())).rejects.toThrow("Model unavailable")
  })

  test("throws when the provider exists but is not connected", async () => {
    await expect(
      preflightRunPlan(basePlan(), () => catalog({ connected: [] })),
    ).rejects.toThrow("Missing provider credentials")
  })

  test("throws when the model ID is not in the provider's model list", async () => {
    await expect(
      preflightRunPlan(basePlan(), () => catalog({ modelID: "other-model" })),
    ).rejects.toThrow("Model unavailable")
  })

  test("throws when a required variant is missing", async () => {
    const plan = basePlan()
    const step = plan.pipeline.steps[0]!
    if (step.type === "agent" && step.resolvedModel) {
      step.resolvedModel.variant = "xhigh"
      step.resolvedModel.target = "openai/gpt-5#xhigh"
    }
    await expect(
      preflightRunPlan(plan, () => catalog({ variants: ["high", "low"] })),
    ).rejects.toThrow("Model unavailable")
  })

  test("passes when a required variant exists", async () => {
    const plan = basePlan()
    const step = plan.pipeline.steps[0]!
    if (step.type === "agent" && step.resolvedModel) {
      step.resolvedModel.variant = "xhigh"
      step.resolvedModel.target = "openai/gpt-5#xhigh"
    }
    await expect(
      preflightRunPlan(plan, () => catalog({ variants: ["xhigh"] })),
    ).resolves.toBeUndefined()
  })

  test("re-throws when discovery rejects with an error", async () => {
    await expect(
      preflightRunPlan(basePlan(), () => Promise.reject(new Error("discovery failed"))),
    ).rejects.toThrow("discovery failed")
  })

  test("validates smartJudge targets if present", async () => {
    const plan = basePlan()
plan.smartJudge = {
      model: {
        configured: "anthropic/claude-haiku",
        logical: "anthropic/claude-haiku",
        gateway: "configured",
        providerID: "anthropic",
        modelID: "claude-haiku",
        target: "anthropic/claude-haiku",
      } as ResolvedModel,
    }
    await expect(
      preflightRunPlan(plan, () => ({
        all: [
          { id: "openai", models: { "gpt-5": { variants: {} } } },
          { id: "anthropic", models: { "claude-haiku": { variants: {} } } },
        ],
        connected: ["openai", "anthropic"],
      })),
    ).resolves.toBeUndefined()
  })

  test("rejects when smartJudge provider is missing from catalog", async () => {
    const plan = basePlan()
    plan.smartJudge = {
      model: {
        configured: "anthropic/claude-haiku",
        logical: "anthropic/claude-haiku",
        gateway: "configured",
        providerID: "anthropic",
        modelID: "claude-haiku",
        target: "anthropic/claude-haiku",
      } as ResolvedModel,
    }
    await expect(
      preflightRunPlan(plan, () => ({
        all: [
          { id: "openai", models: { "gpt-5": { variants: {} } } },
        ],
        connected: ["openai"],
      })),
    ).rejects.toThrow("Model unavailable")
  })

  test("includes resolvedAdvisor targets in preflight", () => {
    const plan = basePlan()
    const advisor: ResolvedModel = {
      configured: "openai/gpt-4",
      logical: "openai/gpt-4",
      gateway: "configured",
      providerID: "openai",
      modelID: "gpt-4",
      target: "openai/gpt-4",
    }
    const step = plan.pipeline.steps[0]!
    if (step.type === "agent") {
      step.resolvedAdvisor = advisor
    }
    const targets = preflightTargets(plan)
    expect(targets).toContainEqual(advisor)
  })
})