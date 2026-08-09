import { describe, expect, test } from "bun:test"

import { renderRunPlan, sanitizeReviewInline, sanitizeReviewText } from "../src/run-review"
import type { RunPlan } from "../src/types"

function samplePlan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    prompt: { source: "inline", text: "Build a login page with email and password" },
    target: { directory: "/home/user/project", baseRef: "main", worktree: false, dirty: false },
    pipeline: {
      name: "implement",
      steps: [
        {
          type: "agent",
          name: "implementer",
          stepName: "implementer",
          groupId: "g1",
          agentName: "implementer",
          description: "Implement the feature",
          model: "openai/gpt-5",
          resolvedModel: {
            configured: "openai/gpt-5",
            logical: "openai/gpt-5",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "openai/gpt-5",
            target: "vercel/openai/gpt-5",
          },
          inputFiles: ["prd.md"],
          inputDiff: true,
          reportPath: "reports/implementer.md",
          advisor: "default",
          advisorMaxCalls: 3,
          resolvedAdvisor: {
            configured: "anthropic/claude-opus-4",
            logical: "anthropic/claude-opus-4",
            gateway: "vercel",
            providerID: "vercel",
            modelID: "anthropic/claude-opus-4",
            target: "vercel/anthropic/claude-opus-4",
          },
        },
      ],
    },
    modelRouting: { gateway: "vercel" },
    hooks: { pre: [], post: [] },
    attachments: [],
    permissions: "interactive",
    ...overrides,
  }
}

describe("renderRunPlan", () => {
  test("renders a basic compact plan", () => {
    const plan = samplePlan()
    const output = renderRunPlan(plan, true)
    expect(output).toContain("Convoy run plan")
    expect(output).toContain("Prompt: inline")
    expect(output).toContain("Target:")
    expect(output).toContain("Pipeline: implement · 1 steps")
    expect(output).toContain("Gateway: Vercel AI Gateway")
  })

  test("renders a full plan with step details", () => {
    const plan = samplePlan()
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Review Convoy run")
    expect(output).toContain("1. implementer · OpenCode · writable")
    expect(output).toContain("Logical: openai/gpt-5")
    expect(output).toContain("Target:  vercel/openai/gpt-5")
    expect(output).toContain("Advisor: anthropic/claude-opus-4 → vercel/anthropic/claude-opus-4 · max 3 calls/attempt")
  })

  test("renders a human gate step", () => {
    const plan = samplePlan()
    plan.pipeline.steps = [
      {
        type: "human",
        name: "review-gate",
        stepName: "review-gate",
        description: "Manual review",
        inputFiles: [],
        inputDiff: true,
        reportPath: "reports/review-gate.md",
      },
    ]
    const output = renderRunPlan(plan, false)
    expect(output).toContain("1. review-gate · human gate")
  })

  test("renders hooks when present", () => {
    const plan = samplePlan()
    plan.hooks = {
      pre: [{ command: "echo hello", continueOnError: false }],
      post: [{ command: "echo done", when: "always", continueOnError: false }],
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Hooks:")
    expect(output).toContain("pre: echo hello")
    expect(output).toContain("post: echo done")
    expect(output).toContain("(always)")
  })

  test("renders attachments and permissions count", () => {
    const plan = samplePlan()
    plan.attachments = [{ name: "screenshot.png", mime: "image/png", path: "/tmp/screenshot.png" }]
    plan.permissions = "interactive"
    const output = renderRunPlan(plan, false)
    expect(output).toContain("interactive permissions")
    expect(output).toContain("1 attachments")
  })

  test("renders a smart judge when present", () => {
    const plan = samplePlan()
    plan.smartJudge = {
      model: {
        configured: "anthropic/claude-haiku-4",
        logical: "anthropic/claude-haiku-4",
        gateway: "vercel",
        providerID: "vercel",
        modelID: "anthropic/claude-haiku-4",
        target: "vercel/anthropic/claude-haiku-4",
      },
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Judge:")
  })

  test("renders a read-only step", () => {
    const plan = samplePlan()
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") {
      step.readOnly = true
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("read-only")
  })

  test("renders resume gateway override when present", () => {
    const plan = samplePlan()
    plan.resume = {
      gatewayOverride: {
        original: { gateway: "vercel" },
        pending: { gateway: "configured" },
      },
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Resume gateway override:")
    expect(output).toContain("original: As configured")
    expect(output).toContain("pending phases: As configured")
  })

  test("renders full prompt when option is set", () => {
    const plan = samplePlan()
    plan.prompt = { source: "file", text: "Line 1\nLine 2\nLine 3" }
    const output = renderRunPlan(plan, false, { fullPrompt: true })
    expect(output).toContain("  Line 1")
    expect(output).toContain("  Line 2")
    expect(output).toContain("  Line 3")
  })

  test("renders worktree info when worktree mode is on", () => {
    const plan = samplePlan()
    plan.target.worktree = true
    plan.target.branch = "feat/login"
    const output = renderRunPlan(plan, true)
    expect(output).toContain("Worktree: yes · branch feat/login")
  })

  test("renders worktree directory when present", () => {
    const plan = samplePlan()
    plan.target.worktreeDir = "/tmp/convoy-worktree/feat-login"
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Worktree directory: /tmp/convoy-worktree/feat-login")
  })

  test("renders dirty working tree info", () => {
    const plan = samplePlan()
    plan.target.dirty = true
    const output = renderRunPlan(plan, true)
    expect(output).toContain("include dirty")
  })

  test("handles plan without resolvedModel for an agent step", () => {
    const plan = samplePlan()
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") {
      step.resolvedModel = undefined
    }
    const output = renderRunPlan(plan, false)
    expect(output).toContain("Model:")
  })

  test("handles plan without advisor", () => {
    const plan = samplePlan()
    const step = plan.pipeline.steps[0]
    if (step?.type === "agent") {
      step.advisor = undefined
      step.resolvedAdvisor = undefined
    }
    const output = renderRunPlan(plan, false)
    expect(output).not.toContain("Advisor:")
  })
})

describe("sanitizeReviewText", () => {
  test("strips ANSI escape sequences", () => {
    expect(sanitizeReviewText("hello\u001b[31m world")).toBe("hello world")
  })

  test("strips control characters", () => {
    expect(sanitizeReviewText("hello\u0000world")).toBe("helloworld")
  })

  test("replaces tabs with spaces", () => {
    expect(sanitizeReviewText("hello\tworld")).toBe("hello world")
  })
})

describe("sanitizeReviewInline", () => {
  test("strips ANSI and control chars and collapses whitespace", () => {
    expect(sanitizeReviewInline("  hello\u001b[31m   world  ")).toBe("hello world")
  })

  test("trims the result", () => {
    expect(sanitizeReviewInline("  spaced  out  ")).toBe("spaced out")
  })
})