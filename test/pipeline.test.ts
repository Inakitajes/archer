import { describe, expect, test } from "bun:test"

import {
  builtInAgents,
  builtInPipelines,
  defaultAdversarialModel,
  defaultImplementAuditModel,
  defaultImplementerModel,
  defaultImplementReviewModel,
  defaultOpusModel,
  defaultPipeline,
  resolvePipeline,
  slugifyModel,
  splitModelVariant,
  stepNames,
  synthesizeReadOnlyAgents,
  synthesizeVerifyingAgents,
  agentsForPipeline,
  validateStepFilters,
  verifyAgentSuffix,
  type PipelineSpec,
} from "../src/pipeline"
import type { AgentStep } from "../src/types"

const resolve = (spec: PipelineSpec, defaultModel?: string) =>
  resolvePipeline({ name: "test", spec, agents: builtInAgents, defaultModel })

const agentSteps = (spec: PipelineSpec) => resolve(spec).steps.filter((step): step is AgentStep => step.type === "agent")

describe("model shorthand", () => {
  test("splits provider/model#variant", () => {
    expect(splitModelVariant("openai/gpt-5.5#xhigh")).toEqual({ model: "openai/gpt-5.5", variant: "xhigh" })
    expect(splitModelVariant("anthropic/claude-opus-4-7")).toEqual({ model: "anthropic/claude-opus-4-7" })
    expect(() => splitModelVariant("openai/gpt-5.5#")).toThrow("invalid model")
    expect(() => splitModelVariant("#xhigh")).toThrow("invalid model")
  })
})

describe("default pipeline", () => {
  test("matches the historical six phases", () => {
    const pipeline = defaultPipeline()

    expect(stepNames(pipeline)).toEqual(["implementer", "patterns", "security", "design", "tests", "adversarial"])
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("wires inputs by convention exactly like the static pipeline did", () => {
    const steps = Object.fromEntries(
      defaultPipeline()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(steps.implementer?.inputFiles).toEqual(["prd.md"])
    expect(steps.implementer?.inputDiff).toBe(false)
    expect(steps.patterns?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
    expect(steps.patterns?.inputDiff).toBe(true)
    expect(steps.security?.inputFiles).toEqual(["prd.md", "reports/patterns.md"])
    expect(steps.design?.inputFiles).toEqual(["prd.md", "reports/security.md"])
    expect(steps.tests?.inputFiles).toEqual(["prd.md"])
    expect(steps.tests?.inputDiff).toBe(true)
    expect(steps.adversarial?.inputFiles).toEqual([
      "prd.md",
      "reports/implementer.md",
      "reports/patterns.md",
      "reports/security.md",
      "reports/design.md",
      "reports/tests.md",
    ])
  })

  test("pins Terra xhigh for implementation, GLM 5.2 xhigh for the audits, and Kimi K3 high for design and adversarial", () => {
    const byName = Object.fromEntries(
      defaultPipeline()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.patterns).toMatchObject({ model: "openrouter/z-ai/glm-5.2", variant: "xhigh" })
    expect(byName.security).toMatchObject({ model: "openrouter/z-ai/glm-5.2", variant: "xhigh" })
    expect(byName.design).toMatchObject({ model: "openrouter/moonshotai/kimi-k3", variant: "high" })
    expect(byName.tests).toMatchObject({ model: "openrouter/z-ai/glm-5.2", variant: "xhigh" })
    expect(byName.adversarial).toMatchObject({ model: "openrouter/moonshotai/kimi-k3", variant: "high" })
  })

  test("advises the implementation phase only: Sol xhigh at Terra's decision points", () => {
    const byName = Object.fromEntries(
      defaultPipeline()
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ advisor: "openai/gpt-5.6-sol", advisorVariant: "xhigh" })
    for (const name of ["patterns", "security", "design", "tests", "adversarial"]) {
      expect(byName[name]?.advisor).toBeUndefined()
    }
    // Exactly one step carries the advisor cost.
    expect(defaultPipeline().steps.filter((step) => step.type === "agent" && step.advisor).length).toBe(1)
  })

  test("the audits opt out of the advisor explicitly, so defaults.advisor cannot re-advise them", () => {
    // `advisor: false` and an omitted key resolve identically until a project
    // sets defaults.advisor — which is exactly the case this pins down.
    const byName = Object.fromEntries(
      resolvePipeline({
        name: "implement",
        spec: builtInPipelines.implement!,
        agents: builtInAgents,
        defaultAdvisor: "openrouter/anthropic/claude-opus-5",
      })
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ advisor: "openai/gpt-5.6-sol", advisorVariant: "xhigh" })
    for (const name of ["patterns", "security", "design", "tests", "adversarial"]) {
      expect(byName[name]?.advisor).toBeUndefined()
    }
  })

  test("does not score: measurement belongs to ship, not to the first draft", () => {
    expect(stepNames(defaultPipeline())).not.toContain("score-report")
  })

  test("keeps every implement step on its own model even when defaults.model is GPT", () => {
    const byName = Object.fromEntries(
      resolvePipeline({
        name: "implement",
        spec: builtInPipelines.implement!,
        agents: builtInAgents,
        defaultModel: "openai/gpt-5.5#xhigh",
      })
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    // Every step is pinned now, so defaults.model moves nothing here at all.
    const pinned = (value: string) => {
      const [model, variant] = value.split("#")
      return variant ? { model, variant } : { model }
    }
    expect(byName.implementer).toMatchObject(pinned(defaultImplementerModel))
    expect(byName.patterns).toMatchObject(pinned(defaultImplementAuditModel))
    expect(byName.design).toMatchObject(pinned(defaultImplementReviewModel))
    expect(byName.adversarial).toMatchObject(pinned(defaultAdversarialModel))
  })
})

describe("built-in implement-lite pipeline", () => {
  const implementLite = (defaultModel?: string) =>
    resolvePipeline({ name: "implement-lite", spec: builtInPipelines["implement-lite"]!, agents: builtInAgents, defaultModel })

  test("keeps the implement workflow and agents while swapping GPT phases to GLM 5.2", () => {
    const lite = implementLite().steps.filter((step): step is AgentStep => step.type === "agent")
    const standard = defaultPipeline().steps.filter((step): step is AgentStep => step.type === "agent")

    const workflowShape = (step: AgentStep) => ({
      name: step.name,
      stepName: step.stepName,
      agentName: step.agentName,
      inputFiles: step.inputFiles,
      inputDiff: step.inputDiff,
      reportPath: step.reportPath,
    })
    expect(lite.map(workflowShape)).toEqual(standard.map(workflowShape))

    const byName = Object.fromEntries(lite.map((step) => [step.name, step]))
    expect(byName.implementer?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.patterns?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.security?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.tests?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.design?.model).toBe("openrouter/moonshotai/kimi-k3")
    expect(byName.adversarial?.model).toBe("anthropic/claude-opus-5")
  })

  test("does not reintroduce GPT through defaults.model", () => {
    const byName = Object.fromEntries(
      implementLite("openai/gpt-5.5#xhigh")
        .steps.filter((step): step is AgentStep => step.type === "agent")
        .map((step) => [step.name, step]),
    )

    expect(byName.implementer).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.patterns).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.security).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.tests).toMatchObject({ model: "openrouter/z-ai/glm-5.2" })
    expect(byName.design).toMatchObject({ model: "openrouter/moonshotai/kimi-k3" })
    expect(byName.adversarial).toMatchObject({ model: "anthropic/claude-opus-5" })
  })

  test("distinguishes itself from implement by the phases that write and judge, not the audits", () => {
    const lite = Object.fromEntries(implementLite().steps.filter((s): s is AgentStep => s.type === "agent").map((step) => [step.name, step]))
    const standard = Object.fromEntries(defaultPipeline().steps.filter((s): s is AgentStep => s.type === "agent").map((step) => [step.name, step]))

    // Both run the audits on GLM 5.2; `implement` just turns its reasoning up.
    // What the lite variant actually gives up is Sol writing the code and Kimi
    // judging it at the end.
    for (const step of ["patterns", "security", "tests"]) {
      expect(lite[step]?.model).toBe(standard[step]!.model)
      expect(lite[step]?.variant).toBeUndefined()
      expect(standard[step]?.variant).toBe("xhigh")
    }
    expect(lite.implementer?.model).not.toBe(standard.implementer?.model)
    expect(lite.adversarial?.model).not.toBe(standard.adversarial?.model)
  })
})


describe("built-in ship pipeline", () => {
  const ship = () => resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })
  const shipSteps = () => ship().steps.filter((step): step is AgentStep => step.type === "agent")

  test("is sync then the measurement layer: no open-ended audits in between", () => {
    expect(shipSteps().map((step) => step.name)).toEqual([
      "sync",
      "score__openai-gpt-5-6-sol-xhigh",
      "score__anthropic-claude-opus-5",
      "score-report",
    ])
  })

  test("syncs the base in before anything reads the diff, so the score describes the merged result", () => {
    const [sync] = shipSteps()

    expect(sync).toMatchObject({ agentName: "sync-with-base", model: "openai/gpt-5.6-terra", variant: "xhigh" })
    // The merge writes to the repository: goal mode refuses a report-only
    // pipeline, so this step is also what makes ship goal-eligible.
    expect(sync?.readOnly).toBeFalsy()
  })

  test("declares its own goal, so the fix/re-score loop runs without --goal", () => {
    expect(ship().goal).toBe(85)
  })

  test("fans the scorers across Sol xhigh + opus as forced read-only", () => {
    const scorers = shipSteps().filter((step) => step.stepName === "score")

    expect(scorers).toHaveLength(2)
    expect(scorers.map((step) => ({ model: step.model, variant: step.variant }))).toEqual([
      { model: "openai/gpt-5.6-sol", variant: "xhigh" },
      { model: "anthropic/claude-opus-5", variant: undefined },
    ])
    // Fanned out across models: already read-only, so no __ro and no bash.
    for (const step of scorers) {
      expect(step.agentName).toBe("quality-scorer")
      expect(step.readOnly).toBe(true)
      expect(step.verify).toBeUndefined()
      // No review-scope step feeds these, so the diff has to arrive by the
      // "every step after the first gets it" default.
      expect(step.inputDiff).toBe(true)
      expect(step.inputFiles).toEqual(["prd.md", "reports/sync.md"])
    }
  })

  test("consensus step keeps bash to verify the scorers' claims and reads every report", () => {
    const report = shipSteps().find((step) => step.name === "score-report")

    expect(report).toMatchObject({
      agentName: "quality-score-report",
      model: "openai/gpt-5.6-sol",
      variant: "xhigh",
      readOnly: true,
      verify: true,
    })
    expect(report?.inputFiles).toEqual([
      "prd.md",
      "reports/sync.md",
      "reports/score__openai-gpt-5-6-sol-xhigh.md",
      "reports/score__anthropic-claude-opus-5.md",
    ])
  })
})

describe("built-in review pipeline", () => {
  const scored = () => resolvePipeline({ name: "review", spec: builtInPipelines.review!, agents: builtInAgents })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = scored()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("scope verifies: review-scope is a standalone read-only step with bash, so it runs the checks once", () => {
    const pipeline = scored()
    const scope = pipeline.steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")

    expect(scope).toMatchObject({
      agentName: "review-scope",
      readOnly: true,
      verify: true,
    })
    // Not fanned out, so it keeps its own name (no __ro suffix).
    expect(scope?.agentName.endsWith("__ro")).toBe(false)
  })

  test("scopes, runs the three audits fanned across two models, synthesizes a findings report, then scores", () => {
    expect(stepNames(scored())).toEqual([
      "scope",
      "clean-code__openai-gpt-5-6-terra-xhigh",
      "clean-code__anthropic-claude-opus-5",
      "security__openai-gpt-5-6-terra-xhigh",
      "security__anthropic-claude-opus-5",
      "bugs__openai-gpt-5-6-terra-xhigh",
      "bugs__anthropic-claude-opus-5",
      "report",
      "score__openai-gpt-5-6-sol-xhigh",
      "score__anthropic-claude-opus-5",
      "score-report",
    ])
  })

  test("the findings report synthesizes every audit and the consensus step reads it alongside the scores", () => {
    const findings = scored().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "report")
    expect(findings).toMatchObject({ agentName: "review-report", readOnly: true })
    expect(findings?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openai-gpt-5-6-terra-xhigh.md",
      "reports/clean-code__anthropic-claude-opus-5.md",
      "reports/security__openai-gpt-5-6-terra-xhigh.md",
      "reports/security__anthropic-claude-opus-5.md",
      "reports/bugs__openai-gpt-5-6-terra-xhigh.md",
      "reports/bugs__anthropic-claude-opus-5.md",
    ])

    const report = scored().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "score-report")

    expect(report).toMatchObject({ agentName: "quality-score-report", readOnly: true, verify: true })
    expect(report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openai-gpt-5-6-terra-xhigh.md",
      "reports/clean-code__anthropic-claude-opus-5.md",
      "reports/security__openai-gpt-5-6-terra-xhigh.md",
      "reports/security__anthropic-claude-opus-5.md",
      "reports/bugs__openai-gpt-5-6-terra-xhigh.md",
      "reports/bugs__anthropic-claude-opus-5.md",
      "reports/report.md",
      "reports/score__openai-gpt-5-6-sol-xhigh.md",
      "reports/score__anthropic-claude-opus-5.md",
    ])
  })
})

describe("built-in review-lite pipeline", () => {
  const reviewLite = () => resolvePipeline({ name: "review-lite", spec: builtInPipelines["review-lite"]!, agents: builtInAgents })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = reviewLite()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("scope verifies on the cheap model too, so the checks run once per review", () => {
    const scope = reviewLite().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")
    expect(scope).toMatchObject({ agentName: "review-scope", readOnly: true, verify: true })
  })

  test("runs entirely on low-cost models: GLM 5.2 scopes and reports, and the fan-out pairs GLM 5.2 with Kimi K3", () => {
    const pipeline = reviewLite()
    expect(stepNames(pipeline)).toEqual([
      "scope",
      "clean-code__openrouter-z-ai-glm-5-2",
      "clean-code__openrouter-moonshotai-kimi-k3",
      "security__openrouter-z-ai-glm-5-2",
      "security__openrouter-moonshotai-kimi-k3",
      "bugs__openrouter-z-ai-glm-5-2",
      "bugs__openrouter-moonshotai-kimi-k3",
      "report",
      "score__openrouter-z-ai-glm-5-2-xhigh",
      "score__openrouter-moonshotai-kimi-k3-high",
      "score-report",
    ])

    const byName = Object.fromEntries(
      pipeline.steps.filter((step): step is AgentStep => step.type === "agent").map((step) => [step.name, step]),
    )
    expect(byName.scope?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.report?.model).toBe("openrouter/z-ai/glm-5.2")
    expect(byName.report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code__openrouter-z-ai-glm-5-2.md",
      "reports/clean-code__openrouter-moonshotai-kimi-k3.md",
      "reports/security__openrouter-z-ai-glm-5-2.md",
      "reports/security__openrouter-moonshotai-kimi-k3.md",
      "reports/bugs__openrouter-z-ai-glm-5-2.md",
      "reports/bugs__openrouter-moonshotai-kimi-k3.md",
    ])
  })

  test("never reaches for Opus, which is what separates it from review", () => {
    // The scorer agents default to Opus, so the scorer steps have to pin their
    // models explicitly; an omitted `models:` would reintroduce exactly the cost
    // this pipeline exists to avoid.
    expect(JSON.stringify(builtInPipelines["review-lite"])).not.toContain("opus")
    const scorers = reviewLite().steps.filter((step): step is AgentStep => step.type === "agent" && step.stepName === "score")
    expect(scorers).toHaveLength(2)
    for (const step of scorers) {
      expect(step.model).not.toContain("opus")
    }
  })

  test("measures like review does, on its own models", () => {
    const report = reviewLite().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "score-report")
    expect(report).toMatchObject({ agentName: "quality-score-report", model: "openrouter/z-ai/glm-5.2", variant: "xhigh", readOnly: true, verify: true })
  })
})

describe("built-in fixer pipeline", () => {
  const fixer = () =>
    resolvePipeline({ name: "fixer", spec: builtInPipelines.fixer!, agents: builtInAgents }).steps.filter(
      (step): step is AgentStep => step.type === "agent",
    )

  test("runs reproduction, fixes, and validation in that order", () => {
    expect(fixer().map((step) => step.name)).toEqual(["reproduction", "fixes", "validation"])
  })

  test("carries every phase on Terra xhigh", () => {
    const byName = Object.fromEntries(fixer().map((step) => [step.name, step]))

    expect(byName.reproduction).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.fixes).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
    expect(byName.validation).toMatchObject({ model: "openai/gpt-5.6-terra", variant: "xhigh" })
  })

  test("lets reproduction and fixes write, and lets validation run checks without editing", () => {
    const byName = Object.fromEntries(fixer().map((step) => [step.name, step]))

    expect(byName.reproduction?.readOnly).toBeUndefined()
    expect(byName.fixes?.readOnly).toBeUndefined()
    // The point of the phase: it cannot edit, but it can rerun the proofs its
    // prompt tells it to rerun.
    expect(byName.validation?.readOnly).toBe(true)
    expect(byName.validation?.verify).toBe(true)
  })

  test("gives every phase the exact evidence trail its prompt reads by path", () => {
    const byName = Object.fromEntries(fixer().map((step) => [step.name, step]))

    // reproduction opens on the findings alone; the diff is what it proves them against.
    expect(byName.reproduction?.inputFiles).toEqual(["prd.md"])
    expect(byName.reproduction?.inputDiff).toBe(true)
    expect(byName.fixes?.inputFiles).toEqual(["prd.md", "reports/reproduction.md"])
    expect(byName.validation?.inputFiles).toEqual(["prd.md", "reports/reproduction.md", "reports/fixes.md"])
  })
})

describe("built-in review-cc pipeline", () => {
  const reviewCc = () => resolvePipeline({ name: "review-cc", spec: builtInPipelines["review-cc"]!, agents: builtInAgents })

  test("is report-only: every step is read-only and there is no human gate", () => {
    const pipeline = reviewCc()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    expect(agents.length).toBeGreaterThan(0)
    expect(agents.every((step) => step.readOnly)).toBe(true)
    expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
  })

  test("scope verifies on the Terra leg too, and the claude-code audits stay bash-less", () => {
    const scope = reviewCc().steps.find((step): step is AgentStep => step.type === "agent" && step.name === "scope")
    expect(scope).toMatchObject({ agentName: "review-scope", readOnly: true, verify: true })
  })

  test("pairs each Terra audit with a Claude Code audit and feeds every report to one Sol report step", () => {
    const pipeline = reviewCc()
    expect(stepNames(pipeline)).toEqual(["scope", "clean-code", "clean-code-cc", "security", "security-cc", "bugs", "bugs-cc", "report"])

    const byName = Object.fromEntries(
      pipeline.steps.filter((step): step is AgentStep => step.type === "agent").map((step) => [step.name, step]),
    )
    // The `-cc` slots run the local Claude Code CLI, so they carry its bare alias rather than provider/model.
    for (const name of ["clean-code-cc", "security-cc", "bugs-cc"]) {
      expect(byName[name]).toMatchObject({ runner: "claude-code", model: "opus" })
    }
    expect(byName.report).toMatchObject({ model: "openai/gpt-5.6-sol", variant: "xhigh" })
    expect(byName.report?.inputFiles).toEqual([
      "prd.md",
      "reports/scope.md",
      "reports/clean-code.md",
      "reports/clean-code-cc.md",
      "reports/security.md",
      "reports/security-cc.md",
      "reports/bugs.md",
      "reports/bugs-cc.md",
    ])
  })
})

describe("built-in hunter pipelines", () => {
  const hunter = () => resolvePipeline({ name: "hunter", spec: builtInPipelines.hunter!, agents: builtInAgents })
  const hunterMax = () => resolvePipeline({ name: "hunter-max", spec: builtInPipelines["hunter-max"]!, agents: builtInAgents })

  test("both are report-only with no human gate", () => {
    for (const pipeline of [hunter(), hunterMax()]) {
      const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
      expect(agents.length).toBeGreaterThan(0)
      expect(agents.every((step) => step.readOnly)).toBe(true)
      expect(pipeline.steps.some((step) => step.type === "human")).toBe(false)
    }
  })

  test("hunter pairs Terra with one specialty model per track and reconciles them on Sol", () => {
    const pipeline = hunter()
    expect(stepNames(pipeline)).toEqual([
      "hunter-correctness__openai-gpt-5-6-terra-xhigh",
      "hunter-correctness__openrouter-anthropic-claude-opus-5",
      "hunter-memory__openai-gpt-5-6-terra-xhigh",
      "hunter-memory__openrouter-x-ai-grok-4-5",
      "hunter-performance__openai-gpt-5-6-terra-xhigh",
      "hunter-performance__openrouter-x-ai-grok-4-5",
      "hunter-security__openai-gpt-5-6-terra-xhigh",
      "hunter-security__openrouter-moonshotai-kimi-k3",
      "hunter-reliability__openai-gpt-5-6-terra-xhigh",
      "hunter-reliability__openrouter-z-ai-glm-5-2",
      "hunter-supply-chain__openai-gpt-5-6-terra-xhigh",
      "hunter-supply-chain__openrouter-z-ai-glm-5-2",
      "hunter-report",
    ])

    const report = pipeline.steps.find((step): step is AgentStep => step.type === "agent" && step.stepName === "hunter-report")
    expect(report).toMatchObject({ model: "openai/gpt-5.6-sol", variant: "xhigh" })
    // `reports: previous` pulls in the whole parallel group: 6 tracks x 2 models.
    expect(report?.inputFiles.filter((file) => file.startsWith("reports/"))).toHaveLength(12)
  })

  test("hunter-max fans all six tracks across the same five models", () => {
    const pipeline = hunterMax()
    const agents = pipeline.steps.filter((step): step is AgentStep => step.type === "agent")
    const tracks = agents.filter((step) => step.stepName !== "hunter-max-report")

    expect(tracks).toHaveLength(30)
    expect(new Set(tracks.map((step) => step.stepName)).size).toBe(6)
    for (const track of new Set(tracks.map((step) => step.stepName))) {
      const models = tracks.filter((step) => step.stepName === track).map((step) => `${step.model}${step.variant ? `#${step.variant}` : ""}`)
      expect(models).toEqual([
        "openai/gpt-5.6-terra#xhigh",
        "openrouter/anthropic/claude-opus-5",
        "openrouter/z-ai/glm-5.2",
        "openrouter/moonshotai/kimi-k3",
        "openrouter/x-ai/grok-4.5",
      ])
    }

    const report = agents.find((step) => step.stepName === "hunter-max-report")
    expect(report).toMatchObject({ model: "openai/gpt-5.6-sol", variant: "xhigh" })
    expect(report?.inputFiles.filter((file) => file.startsWith("reports/"))).toHaveLength(30)
  })

  test("every track step attaches the diff and reads no earlier report", () => {
    for (const pipeline of [hunter(), hunterMax()]) {
      const tracks = pipeline.steps.filter(
        (step): step is AgentStep => step.type === "agent" && !step.stepName.endsWith("-report"),
      )
      expect(tracks.every((step) => step.inputDiff)).toBe(true)
      expect(tracks.every((step) => !step.inputFiles.some((file) => file.startsWith("reports/")))).toBe(true)
    }
  })
})

describe("pipeline resolution", () => {
  test("accepts agent names, aliases, and the human-review keyword as string steps", () => {
    const pipeline = resolve({ steps: ["implementer", "human-review", "pattern-auditor", "tests"] })

    expect(stepNames(pipeline)).toEqual(["implementer", "human-review", "pattern-auditor", "tests"])
    const auditor = pipeline.steps[2]
    expect(auditor?.type).toBe("agent")
    if (auditor?.type === "agent") expect(auditor.agentName).toBe("pattern-auditor")
    const tests = pipeline.steps[3]
    if (tests?.type === "agent") expect(tests.agentName).toBe("test-engineer")
  })

  test("accepts generic named human steps", () => {
    const pipeline = resolve({
      steps: ["implementer", { type: "human", name: "planning", description: "Plan interactively" }, "tests", { type: "human" }],
    })

    expect(stepNames(pipeline)).toEqual(["implementer", "planning", "tests", "human"])
    expect(pipeline.steps[1]).toMatchObject({ type: "human", name: "planning", description: "Plan interactively" })
    expect(pipeline.steps[3]).toMatchObject({ type: "human", name: "human" })
  })

  test("derives report paths and commit step names from the step name", () => {
    const [implementer, review] = agentSteps({
      steps: ["implementer", { agent: "adversarial", name: "final-check" }],
    })

    expect(implementer?.reportPath).toBe("reports/implementer.md")
    expect(review?.name).toBe("final-check")
    expect(review?.reportPath).toBe("reports/final-check.md")
  })

  test("reports modes: previous is the default, all/none/list override it", () => {
    const [first, second, third, fourth] = agentSteps({
      steps: [
        "implementer",
        "tests",
        { agent: "security", reports: "all" },
        { agent: "adversarial", reports: ["implementer"] },
      ],
    })

    expect(first?.inputFiles).toEqual(["prd.md"])
    expect(second?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
    expect(third?.inputFiles).toEqual(["prd.md", "reports/implementer.md", "reports/tests.md"])
    expect(fourth?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
  })

  test("human gates never leak into report wiring", () => {
    const [, after] = agentSteps({ steps: ["implementer", { type: "human", name: "planning" }, "tests"] })
    expect(after?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
  })

  test("diff defaults to everything but the first agent step", () => {
    const [first, second] = agentSteps({ steps: ["human-review", "implementer", { agent: "tests", diff: false }] })
    expect(first?.inputDiff).toBe(false)
    expect(second?.inputDiff).toBe(false)
  })

  test("model precedence: step > defaults.model > built-in preference", () => {
    const spec: PipelineSpec = {
      steps: ["implementer", "design", { agent: "tests", model: "openrouter/z-ai/glm-4.7#max" }],
    }

    const withoutDefault = agentSteps(spec)
    expect(withoutDefault[1]).toMatchObject({ model: "openrouter/moonshotai/kimi-k3" })

    const [implementer, design, tests] = resolvePipeline({
      name: "test",
      spec,
      agents: builtInAgents,
      defaultModel: "anthropic/claude-sonnet-4-6",
    }).steps.filter((step): step is AgentStep => step.type === "agent")

    expect(implementer?.model).toBe("anthropic/claude-sonnet-4-6")
    expect(design?.model).toBe("anthropic/claude-sonnet-4-6")
    expect(tests).toMatchObject({ model: "openrouter/z-ai/glm-4.7", variant: "max" })
  })

  test("project agents override built-in preferences via their model field", () => {
    const agents = builtInAgents.map((agent) =>
      agent.name === "design-polisher" ? { ...agent, model: "openai/gpt-5.5#xhigh" } : agent,
    )
    const [design] = resolvePipeline({ name: "test", spec: { steps: ["design"] }, agents }).steps as AgentStep[]
    expect(design).toMatchObject({ model: "openai/gpt-5.5", variant: "xhigh" })
  })

  test("resolved steps keep read-only agent enforcement metadata", () => {
    const agents = builtInAgents.map((agent) => (agent.name === "security-auditor" ? { ...agent, readOnly: true } : agent))
    const [security] = resolvePipeline({ name: "test", spec: { steps: ["security"] }, agents }).steps as AgentStep[]

    expect(security).toMatchObject({ agentName: "security-auditor", readOnly: true })
  })

  test("numbers repeated human gates and threads per-step settings", () => {
    const pipeline = resolve({
      steps: ["implementer", "human-review", { agent: "tests" }, "human-review"],
    })

    expect(stepNames(pipeline)).toEqual(["implementer", "human-review", "tests", "human-review-2"])
    const tests = pipeline.steps[2]
    expect(tests).toMatchObject({ type: "agent", agentName: "test-engineer" })
  })

  test("rejects broken specs with errors that name the offender", () => {
    expect(() => resolve({ steps: ["implementer", "implementer"] })).toThrow('duplicate step name "implementer"')
    expect(() => resolve({ steps: [{ agent: "implementer", name: "human-review" }] })).toThrow("reserved name")
    expect(() => resolve({ steps: ["imaginary-agent"] })).toThrow('unknown agent "imaginary-agent"')
    expect(() => resolve({ steps: ["human-review"] })).toThrow("no agent steps")
    expect(() => resolve({ steps: [{ agent: "tests", reports: ["later"] }, { agent: "security", name: "later" }] })).toThrow(
      "not an earlier agent step",
    )
  })

  test("rejects unsafe step names when resolving programmatic pipeline specs", () => {
    expect(() => resolve({ steps: [{ agent: "security", name: "../../../../tmp/owned" }] })).toThrow(
      "filesystem-safe identifier",
    )
  })
})

describe("step filters", () => {
  test("validates --only/--skip names against the pipeline, tolerating human gates", () => {
    const pipeline = defaultPipeline()

    expect(() => validateStepFilters(pipeline, { onlySteps: ["implementer"], skipSteps: ["tests"] })).not.toThrow()
    expect(() => validateStepFilters(pipeline, { onlySteps: ["secuirty"], skipSteps: [] })).toThrow('unknown step "secuirty"')

    const headless = { ...pipeline, steps: pipeline.steps.filter((step) => step.type !== "human") }
    expect(() => validateStepFilters(headless, { onlySteps: [], skipSteps: ["human-review"] })).not.toThrow()
  })

  test("accepts a fanned-out step's shared stepName alongside its full disambiguated name", () => {
    const pipeline = resolve({
      steps: ["implementer", { agent: "adversarial", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
    })
    expect(() => validateStepFilters(pipeline, { onlySteps: ["clean-code"], skipSteps: [] })).not.toThrow()
    expect(() => validateStepFilters(pipeline, { onlySteps: ["clean-code__anthropic-claude-opus-4-7"], skipSteps: [] })).not.toThrow()
  })
})

describe("parallel groups", () => {
  test("resolves a parallel block into steps sharing one groupId, forced read-only with a synthesized agent name", () => {
    const [, patterns, security] = agentSteps({ steps: ["implementer", { parallel: ["patterns", "security"] }] })

    expect(patterns?.groupId).toBeDefined()
    expect(patterns?.groupId).toBe(security?.groupId)
    expect(patterns?.readOnly).toBe(true)
    expect(security?.readOnly).toBe(true)
    // pattern-auditor/security-auditor aren't read-only by default, so parallel execution synthesizes a "__ro" variant
    expect(patterns?.agentName).toBe("pattern-auditor__ro")
    expect(security?.agentName).toBe("security-auditor__ro")
  })

  test("doesn't double-suffix an agent that's already configured read-only", () => {
    const agents = builtInAgents.map((agent) => (agent.name === "security-auditor" ? { ...agent, readOnly: true } : agent))
    const [security] = resolvePipeline({ name: "test", spec: { steps: [{ parallel: ["security"] }] }, agents }).steps as AgentStep[]
    expect(security?.agentName).toBe("security-auditor")
    expect(security?.readOnly).toBe(true)
  })

  test("a verifying step loses bash in a parallel block", () => {
    const pipeline = resolvePipeline({
      name: "test",
      spec: { steps: [{ parallel: [{ agent: "review-scope", name: "scope", verify: true }, "patterns"] }] },
      agents: builtInAgents,
    })
    const [scope] = pipeline.steps as AgentStep[]

    expect(scope?.readOnly).toBe(true)
    expect(scope?.verify).toBeUndefined()
    // Already read-only, and verify was dropped, so no __ro / __verify for scope.
    expect(scope?.agentName).toBe("review-scope")
  })

  test("a step inside a parallel block never sees its own siblings' reports, only earlier groups'", () => {
    const [, patterns, security] = agentSteps({ steps: ["implementer", { parallel: ["patterns", "security"] }] })
    expect(patterns?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
    expect(security?.inputFiles).toEqual(["prd.md", "reports/implementer.md"])
  })

  test("reports: previous after a group expands to every member of that group", () => {
    const steps = agentSteps({
      steps: ["implementer", { parallel: ["patterns", "security"] }, { agent: "adversarial", name: "triage" }],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/patterns.md", "reports/security.md"])
  })

  test("reports: all includes every member of every earlier group", () => {
    const steps = agentSteps({
      steps: ["implementer", { parallel: ["patterns", "security"] }, { agent: "adversarial", name: "triage", reports: "all" }],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/implementer.md", "reports/patterns.md", "reports/security.md"])
  })

  test("empty parallel block is rejected", () => {
    expect(() => resolve({ steps: ["implementer", { parallel: [] }] })).toThrow("empty parallel block")
  })

  test("nested parallel blocks are rejected", () => {
    // Nesting isn't representable in StepSpec's types; simulate config-loaded data that bypassed validation.
    const nested = { parallel: ["patterns"] } as unknown as string
    expect(() => resolve({ steps: ["implementer", { parallel: [nested, "security"] }] })).toThrow("nest a parallel block")
  })

  test("human steps can't run inside a parallel block", () => {
    expect(() => resolve({ steps: ["implementer", { parallel: ["patterns", "human-review"] }] })).toThrow("inside a parallel block")
    expect(() => resolve({ steps: ["implementer", { parallel: ["patterns", { agent: "human-review" }] }] })).toThrow("inside a parallel block")
    expect(() => resolve({ steps: ["implementer", { parallel: ["patterns", { type: "human", name: "planning" } as never] }] })).toThrow(
      "inside a parallel block",
    )
  })
})

describe("model fan-out", () => {
  test("slugifies provider/model#variant into a filesystem-safe suffix", () => {
    expect(slugifyModel("anthropic/claude-opus-4-7")).toBe("anthropic-claude-opus-4-7")
    expect(slugifyModel("openai/gpt-5.5#xhigh")).toBe("openai-gpt-5-5-xhigh")
  })

  test("fans a step out across models, one forced-read-only invocation per model, sharing groupId/stepName", () => {
    const [clean1, clean2] = agentSteps({
      steps: [{ agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
    })

    expect(clean1?.stepName).toBe("clean-code")
    expect(clean2?.stepName).toBe("clean-code")
    expect(clean1?.groupId).toBe(clean2?.groupId)
    expect(clean1?.name).toBe("clean-code__anthropic-claude-opus-4-7")
    expect(clean2?.name).toBe("clean-code__openai-gpt-5-5-xhigh")
    expect(clean1).toMatchObject({ model: "anthropic/claude-opus-4-7" })
    expect(clean2).toMatchObject({ model: "openai/gpt-5.5", variant: "xhigh" })
    expect(clean1?.reportPath).toBe("reports/clean-code__anthropic-claude-opus-4-7.md")
    expect(clean1?.readOnly).toBe(true)
    expect(clean2?.readOnly).toBe(true)
    expect(clean1?.agentName).toBe("implementer__ro")
  })

  test("a models: fan-out also strips bash from a verifying step", () => {
    const [first] = resolvePipeline({
      name: "test",
      spec: { steps: [{ agent: "review-validator", name: "validator", verify: true, models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }] },
      agents: builtInAgents,
    }).steps as AgentStep[]

    expect(first?.readOnly).toBe(true)
    expect(first?.verify).toBeUndefined()
    expect(first?.agentName).toBe("review-validator")
  })

  test("reports: [stepName] on a fanned-out step expands to every model variant", () => {
    const steps = agentSteps({
      steps: [
        { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
        { agent: "adversarial", name: "triage", reports: ["clean-code"] },
      ],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/clean-code__anthropic-claude-opus-4-7.md", "reports/clean-code__openai-gpt-5-5-xhigh.md"])
  })

  test("a fanned-out step can also be targeted by one specific variant's full name", () => {
    const steps = agentSteps({
      steps: [
        { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
        { agent: "adversarial", name: "triage", reports: ["clean-code__anthropic-claude-opus-4-7"] },
      ],
    })
    const triage = steps.find((step) => step.name === "triage")
    expect(triage?.inputFiles).toEqual(["prd.md", "reports/clean-code__anthropic-claude-opus-4-7.md"])
  })

  test("models needs at least 2 entries", () => {
    expect(() => resolve({ steps: [{ agent: "implementer", models: ["anthropic/claude-opus-4-7"] }] })).toThrow("at least 2 entries")
  })

  test("can't set both model and models", () => {
    expect(() =>
      resolve({
        steps: [{ agent: "implementer", model: "anthropic/claude-opus-4-7", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
      }),
    ).toThrow('both "model" and "models"')
  })

  test("models inside a parallel block compose: fan-out members join the block's shared group", () => {
    const steps = agentSteps({
      steps: [
        "implementer",
        {
          parallel: ["patterns", { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] }],
        },
      ],
    })
    expect(steps.length).toBe(4) // implementer + patterns + 2 clean-code variants
    const groupIds = new Set(steps.slice(1).map((step) => step.groupId))
    expect(groupIds.size).toBe(1)
  })
})

describe("synthesizeReadOnlyAgents", () => {
  test("builds one forced-read-only agent spec per distinct base agent referenced, deduped", () => {
    const pipeline = resolve({
      steps: [
        "implementer",
        { parallel: ["patterns", "security"] },
        { agent: "implementer", name: "clean-code", models: ["anthropic/claude-opus-4-7", "openai/gpt-5.5#xhigh"] },
      ],
    })
    const synthesized = synthesizeReadOnlyAgents(pipeline, builtInAgents)
    expect(synthesized.map((agent) => agent.name).sort()).toEqual(["implementer__ro", "pattern-auditor__ro", "security-auditor__ro"])
    expect(synthesized.every((agent) => agent.readOnly)).toBe(true)
  })

  test("returns nothing when no step needed a synthesized variant", () => {
    expect(synthesizeReadOnlyAgents(defaultPipeline(), builtInAgents)).toEqual([])
  })
})

describe("step-level verify", () => {
  test("a read-only agent only gets bash when the step asks", () => {
    const [checking, staticScope] = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", verify: true },
        { agent: "review-scope", name: "scope-static" },
      ],
    })

    expect(checking).toMatchObject({ agentName: `review-scope${verifyAgentSuffix}`, readOnly: true, verify: true })
    expect(staticScope).toMatchObject({ agentName: "review-scope", readOnly: true })
    expect(staticScope?.verify).toBeUndefined()
  })

  test("verify on a writable agent is ignored", () => {
    const [step] = agentSteps({ steps: [{ agent: "implementer", verify: true }] })
    expect(step?.readOnly).toBeUndefined()
    expect(step?.verify).toBeUndefined()
    expect(step?.agentName).toBe("implementer")
  })

  test("an exclusive verifying use keeps the base agent name", () => {
    const [scope] = agentSteps({ steps: [{ agent: "review-scope", name: "scope", verify: true }] })
    expect(scope?.agentName).toBe("review-scope")
    expect(scope?.verify).toBe(true)
  })

  test("agentsForPipeline sets verify on exclusive uses and synthesizes mixed ones", () => {
    const pipeline = resolvePipeline({
      name: "test",
      spec: {
        steps: [
          { agent: "review-scope", name: "scope", verify: true },
          { agent: "review-scope", name: "scope-static" },
          { agent: "quality-score-report", name: "score-report", verify: true },
        ],
      },
      agents: builtInAgents,
    })
    const agents = agentsForPipeline(pipeline, builtInAgents)
    const byName = Object.fromEntries(agents.map((agent) => [agent.name, agent]))

    expect(byName["review-scope"]?.verify).toBeUndefined()
    expect(byName[`review-scope${verifyAgentSuffix}`]).toMatchObject({ readOnly: true, verify: true })
    expect(byName["quality-score-report"]?.verify).toBe(true)
    expect(synthesizeVerifyingAgents(pipeline, builtInAgents).map((agent) => agent.name)).toEqual([`review-scope${verifyAgentSuffix}`])
  })
})

describe("claude-code runner steps", () => {
  test("propagates runner and passes the model verbatim (claude CLI aliases allowed)", () => {
    const steps = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", model: "openai/gpt-5.5#xhigh", reports: "none", diff: true },
        { agent: "security-reviewer", name: "external-security", runner: "claude-code", model: "opus", reports: ["scope"] },
      ],
    })

    const external = steps.find((step) => step.name === "external-security")
    expect(external?.runner).toBe("claude-code")
    expect(external?.model).toBe("opus")
    expect(external?.variant).toBeUndefined()
    expect(external?.readOnly).toBe(true)
  })

  test("defaults to the claude CLI's own model when the step has none", () => {
    const steps = agentSteps({
      steps: [{ agent: "bug-auditor", name: "bugs", runner: "claude-code", reports: "none", diff: true }],
    })

    expect(steps[0]?.runner).toBe("claude-code")
    expect(steps[0]?.model).toBe("")
  })

  test("normalizes and validates Claude models for programmatic pipeline specs", () => {
    const steps = agentSteps({
      steps: [{ agent: "bug-auditor", runner: "claude-code", model: "anthropic/claude-opus-4-8", reports: "none", diff: true }],
    })

    expect(steps[0]?.model).toBe("claude-opus-4-8")
    expect(() =>
      agentSteps({ steps: [{ agent: "bug-auditor", runner: "claude-code", model: "openai/gpt-5.6", reports: "none", diff: true }] }),
    ).toThrow("runner claude-code executes Anthropic models")
  })

  test("opencode steps carry no runner field", () => {
    const steps = agentSteps({ steps: [{ agent: "bug-auditor", name: "bugs", reports: "none", diff: true }] })
    expect(steps[0]?.runner).toBeUndefined()
  })

  test("an explicit runner: opencode resolves like the default", () => {
    const steps = agentSteps({ steps: [{ agent: "bug-auditor", name: "bugs", runner: "opencode", reports: "none", diff: true }] })
    expect(steps[0]?.runner).toBeUndefined()
    expect(steps[0]?.model).toContain("/")
  })

  test("rejects claude-code on a step that can write (v1 is audit-only)", () => {
    expect(() => agentSteps({ steps: [{ agent: "implementer", runner: "claude-code" }] })).toThrow(/read-only/)
  })

  test("accepts claude-code inside a parallel block (forced read-only)", () => {
    const steps = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", reports: "none", diff: true },
        {
          parallel: [
            { agent: "bug-auditor", name: "bugs", reports: ["scope"] },
            { agent: "bug-auditor", name: "bugs-claude", runner: "claude-code", reports: ["scope"] },
          ],
        },
      ],
    })

    const claude = steps.find((step) => step.name === "bugs-claude")
    expect(claude?.runner).toBe("claude-code")
    expect(claude?.readOnly).toBe(true)
  })

  test("rejects claude-code on a verifying step, which needs bash it cannot give", () => {
    expect(() => agentSteps({ steps: [{ agent: "review-validator", name: "validator", runner: "claude-code", verify: true }] })).toThrow(/can't run commands/)
  })

  test("accepts claude-code on a verifying step forced read-only, where bash is dropped anyway", () => {
    const steps = agentSteps({
      steps: [
        { agent: "review-scope", name: "scope", reports: "none", diff: true },
        {
          parallel: [
            { agent: "bug-auditor", name: "bugs", reports: ["scope"] },
            { agent: "review-validator", name: "validator-claude", runner: "claude-code", reports: ["scope"], verify: true },
          ],
        },
      ],
    })

    const claude = steps.find((step) => step.name === "validator-claude")
    expect(claude?.readOnly).toBe(true)
    expect(claude?.verify).toBeUndefined()
  })

  test("rejects claude-code combined with a models: fan-out", () => {
    expect(() =>
      agentSteps({
        steps: [{ agent: "bug-auditor", runner: "claude-code", models: ["openai/gpt-5.5#xhigh", "anthropic/claude-opus-4-8"] }],
      }),
    ).toThrow(/models/)
  })
})

describe("advisor resolution", () => {
  const withAdvisor = (spec: PipelineSpec, advisor?: string, maxCalls?: number) =>
    resolvePipeline({
      name: "test",
      spec,
      agents: builtInAgents,
      defaultAdvisor: advisor,
      defaultAdvisorMaxCalls: maxCalls,
    }).steps.filter((step): step is AgentStep => step.type === "agent")

  test("absent everywhere means no advisor, so an untouched config costs the same as before", () => {
    const [step] = agentSteps({ steps: ["implementer"] })

    expect(step?.advisor).toBeUndefined()
    expect(step?.advisorVariant).toBeUndefined()
    expect(step?.advisorMaxCalls).toBeUndefined()
  })

  test("splits the advisor's variant like any other model", () => {
    const [step] = agentSteps({ steps: [{ agent: "implementer", advisor: "anthropic/claude-opus-5#high" }] })

    expect(step?.advisor).toBe("anthropic/claude-opus-5")
    expect(step?.advisorVariant).toBe("high")
  })

  test("precedence runs step > agent > defaults", () => {
    const agents = builtInAgents.map((agent) => (agent.name === "implementer" ? { ...agent, advisor: "anthropic/claude-opus-4-8" } : agent))
    const steps = resolvePipeline({
      name: "test",
      spec: {
        steps: [
          { agent: "implementer", name: "from-step", advisor: "anthropic/claude-opus-5" },
          { agent: "implementer", name: "from-agent" },
          { agent: "tests", name: "from-defaults" },
        ],
      },
      agents,
      defaultAdvisor: "openai/gpt-5.6-sol",
    }).steps.filter((step): step is AgentStep => step.type === "agent")

    expect(steps.find((step) => step.name === "from-step")?.advisor).toBe("anthropic/claude-opus-5")
    expect(steps.find((step) => step.name === "from-agent")?.advisor).toBe("anthropic/claude-opus-4-8")
    expect(steps.find((step) => step.name === "from-defaults")?.advisor).toBe("openai/gpt-5.6-sol")
  })

  test("advisor: false cuts the chain so one step can opt out of a broader default", () => {
    const steps = withAdvisor(
      { steps: [{ agent: "implementer", name: "advised" }, { agent: "tests", name: "solo", advisor: false }] },
      "anthropic/claude-opus-5",
    )

    expect(steps.find((step) => step.name === "advised")?.advisor).toBe("anthropic/claude-opus-5")
    expect(steps.find((step) => step.name === "solo")?.advisor).toBeUndefined()
  })

  test("advisorMaxCalls comes from the step, else defaults, and only with an advisor", () => {
    const steps = withAdvisor(
      { steps: [{ agent: "implementer", name: "capped", advisorMaxCalls: 1 }, { agent: "tests", name: "inherited" }] },
      "anthropic/claude-opus-5",
      4,
    )

    expect(steps.find((step) => step.name === "capped")?.advisorMaxCalls).toBe(1)
    expect(steps.find((step) => step.name === "inherited")?.advisorMaxCalls).toBe(4)
    expect(() => agentSteps({ steps: [{ agent: "implementer", advisorMaxCalls: 2 }] })).toThrow("advisorMaxCalls without an advisor")
  })

  test("an advisor named on a claude-code step is an error; an inherited one is dropped", () => {
    expect(() =>
      agentSteps({ steps: [{ agent: "bug-auditor", runner: "claude-code", advisor: "anthropic/claude-opus-5", reports: "none" }] }),
    ).toThrow(/runner: claude-code does not support/)

    const steps = withAdvisor({ steps: [{ agent: "bug-auditor", runner: "claude-code", reports: "none" }] }, "anthropic/claude-opus-5")
    expect(steps[0]?.runner).toBe("claude-code")
    expect(steps[0]?.advisor).toBeUndefined()
  })

  test("every variant of a models: fan-out inherits the same advisor", () => {
    const steps = withAdvisor(
      { steps: [{ agent: "bug-auditor", name: "bugs", models: ["openai/gpt-5.6-sol", "anthropic/claude-opus-5"], reports: "none" }] },
      "anthropic/claude-opus-5",
    )

    expect(steps).toHaveLength(2)
    for (const step of steps) expect(step.advisor).toBe("anthropic/claude-opus-5")
  })
})
