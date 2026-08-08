import { describe, expect, test, mock } from "bun:test"

import { preflightTargets, validatePreflightTargets } from "../src/preflight-validation"
import { preflightRunPlan } from "../src/preflight"
import type { RunPlan } from "../src/types"

function plan(): RunPlan {
  return {
    prompt: { source: "inline", text: "ship it" },
    target: { directory: "/repo", baseRef: "main", worktree: false, dirty: false },
    pipeline: {
      name: "implement",
      steps: [
        {
          type: "agent",
          name: "implementer",
          stepName: "implementer",
          groupId: "g1",
          agentName: "implementer",
          description: "Implements",
          model: "vercel/openai/gpt-5.6-sol",
          resolvedModel: {
            configured: "openai/gpt-5.6-sol",
            logical: "openai/gpt-5.6-sol",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "openai/gpt-5.6-sol",
            target: "vercel/openai/gpt-5.6-sol",
          },
          inputFiles: ["prd.md"],
          inputDiff: false,
          reportPath: "reports/implementer.md",
        },
      ],
    },
    modelRouting: { gateway: "vercel" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
  }
}

function directOpenAIPlan(): RunPlan {
  const result = plan()
  const step = result.pipeline.steps[0]!
  if (step.type !== "agent") throw new Error("expected agent step")
  step.model = "openai/gpt-5.6-terra"
  step.variant = "xhigh"
  step.resolvedModel = {
    configured: "openai/gpt-5.6-terra#xhigh",
    logical: "openai/gpt-5.6-terra#xhigh",
    gateway: "configured",
    providerID: "openai",
    modelID: "gpt-5.6-terra",
    variant: "xhigh",
    target: "openai/gpt-5.6-terra#xhigh",
  }
  result.modelRouting.gateway = "configured"
  return result
}

function catalog(input: { providerID?: string; connected?: boolean; modelID?: string; variants?: string[] } = {}) {
  const providerID = input.providerID ?? "vercel"
  const modelID = input.modelID ?? "openai/gpt-5.6-sol"
  return {
    all: [
      {
        id: providerID,
        models: {
          [modelID]: { variants: Object.fromEntries((input.variants ?? []).map((variant) => [variant, {}])) },
        },
      },
    ],
    connected: input.connected === false ? [] : [providerID],
  }
}

function noopDiscover() {
  return Promise.resolve(catalog())
}

describe("OpenCode run-plan preflight", () => {
  test("collects OpenCode steps, smart judge, and branch namer targets — never Claude Code", () => {
    const reviewed = plan()
    reviewed.pipeline.steps.push({
      type: "agent",
      name: "external-audit",
      stepName: "external-audit",
      groupId: "g2",
      agentName: "external-audit",
      description: "External audit",
      runner: "claude-code",
      model: "opus",
      inputFiles: ["prd.md"],
      inputDiff: false,
      reportPath: "reports/external-audit.md",
      readOnly: true,
    })
    reviewed.smartJudge = {
      model: {
        configured: "anthropic/claude-haiku-4.5",
        logical: "anthropic/claude-haiku-4.5",
        gateway: "vercel",
        providerID: "vercel",
        modelID: "anthropic/claude-haiku-4.5",
        target: "vercel/anthropic/claude-haiku-4.5",
      },
    }
    reviewed.target = { ...reviewed.target, worktree: true, branch: "feat/add-onboarding" }

    expect(preflightTargets(reviewed).map((target) => target.target)).toEqual([
      "vercel/openai/gpt-5.6-sol",
      "vercel/anthropic/claude-haiku-4.5",
    ])
  })

  test("accepts connected providers and exact physical model IDs", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog())).not.toThrow()
  })

  test("accepts the classic connected OpenAI catalog used by session.prompt", () => {
    expect(() =>
      validatePreflightTargets(
        preflightTargets(directOpenAIPlan()),
        catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["xhigh"] }),
      ),
    ).not.toThrow()
  })

  test("preflights the resolved run against classic discovery in its target directory", async () => {
    const reviewed = directOpenAIPlan()
    let discoveredDirectory: string | undefined

    await preflightRunPlan(reviewed, async (directory) => {
      discoveredDirectory = directory
      return catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["xhigh"] })
    })

    expect(discoveredDirectory).toBe("/repo")
  })

  test("returns early when the plan has no preflight targets", async () => {
    const reviewed = plan()
    reviewed.pipeline.steps = []
    let discoverCalled = false

    await preflightRunPlan(reviewed, async () => {
      discoverCalled = true
      return catalog()
    })

    expect(discoverCalled).toBe(false)
  })

  test("returns early when the plan only has claude-code steps", async () => {
    const reviewed = plan()
    reviewed.pipeline.steps[0] = {
      ...reviewed.pipeline.steps[0],
      runner: "claude-code",
      model: "opus",
      resolvedModel: undefined,
    } as typeof reviewed.pipeline.steps[0]
    let discoverCalled = false

    await preflightRunPlan(reviewed, async () => {
      discoverCalled = true
      return catalog()
    })

    expect(discoverCalled).toBe(false)
  })

  test("throws when a provider is not connected", async () => {
    const reviewed = plan()

    await expect(preflightRunPlan(reviewed, async () => catalog({ connected: false }))).rejects.toThrow(
      "Missing provider credentials",
    )
  })

  test("throws when a model is not found in the catalog", async () => {
    const reviewed = plan()

    await expect(
      preflightRunPlan(reviewed, async () => catalog({ modelID: "some-other-model" })),
    ).rejects.toThrow("Model unavailable")
  })

  test("throws when a variant is not found in the catalog", async () => {
    const reviewed = directOpenAIPlan()

    await expect(
      preflightRunPlan(
        reviewed,
        async () => catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["high"] }),
      ),
    ).rejects.toThrow("Model unavailable")
  })

  test("throws when the discover function rejects", async () => {
    const reviewed = plan()

    await expect(
      preflightRunPlan(reviewed, async () => {
        throw new Error("network error")
      }),
    ).rejects.toThrow("network error")
  })

  test("throws when the catalog is missing the provider entry entirely", async () => {
    const reviewed = directOpenAIPlan()

    await expect(
      preflightRunPlan(reviewed, async () => ({
        all: [],
        connected: [],
      })),
    ).rejects.toThrow("Model unavailable")
  })

  test("reports Vercel authentication guidance when it is not connected", () => {
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog({ connected: false }))).toThrow(
      "Missing provider credentials: vercel",
    )
    expect(() => validatePreflightTargets(preflightTargets(plan()), catalog({ connected: false }))).toThrow(
      "AI_GATEWAY_API_KEY",
    )
  })

  test("reports unavailable variants from the exact classic model catalog", () => {
    expect(() =>
      validatePreflightTargets(preflightTargets(directOpenAIPlan()), catalog({ providerID: "openai", modelID: "gpt-5.6-terra", variants: ["high"] })),
    ).toThrow("Model unavailable")
  })

  test("reports the logical and exact physical target when a model is unavailable", () => {
    const targets = preflightTargets(plan())
    const withoutTarget = catalog({ modelID: "some-other-model" })

    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("Model unavailable through Vercel AI Gateway")
    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("logical: openai/gpt-5.6-sol")
    expect(() => validatePreflightTargets(targets, withoutTarget)).toThrow("target:  vercel/openai/gpt-5.6-sol")
  })
})

describe("withinPreflightTimeout edge cases (through preflightRunPlan)", () => {
  test("rejects immediately when AbortSignal.timeout fires (race condition)", async () => {
    const reviewed = plan()
    const originalTimeout = AbortSignal.timeout
    const abortedSignal = AbortSignal.abort()
    AbortSignal.timeout = mock(() => abortedSignal) as unknown as typeof AbortSignal.timeout
    try {
      await expect(
        preflightRunPlan(reviewed, async () => {
          await new Promise(() => {})
          return catalog()
        }),
      ).rejects.toThrow("OpenCode preflight timed out")
    } finally {
      AbortSignal.timeout = originalTimeout
    }
  })

  test("resolves with valid discover", async () => {
    const reviewed = plan()
    const discover = mock(() => Promise.resolve(catalog()))
    await expect(preflightRunPlan(reviewed, discover)).resolves.toBeUndefined()
    expect(discover).toHaveBeenCalled()
  })

  test("rejects when discover promise rejects", async () => {
    const reviewed = plan()
    await expect(
      preflightRunPlan(reviewed, async () => {
        throw new Error("discovery failure")
      }),
    ).rejects.toThrow("discovery failure")
  })
})