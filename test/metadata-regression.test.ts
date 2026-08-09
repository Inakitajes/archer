import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import { openRunMetadata, readRunMetadata } from "../src/metadata"
import { defaultPipeline } from "../src/pipeline"
import type { AgentStep, Pipeline } from "../src/types"
import type { Workspace } from "../src/workspace"

const dirs: string[] = []

async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-metadata-regression-"))
  dirs.push(dir)
  return { dir, runID: "20260612-103045-ab12" }
}

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

const implementer: AgentStep = {
  type: "agent",
  name: "implementer",
  agentName: "implementer",
  description: "Implements",
  model: "openai/gpt-5.5",
  variant: "xhigh",
  inputFiles: ["prd.md"],
  inputDiff: false,
  reportPath: "reports/implementer.md",
  groupId: "g1",
  stepName: "implementer",
}

const quick: Pipeline = {
  name: "quick",
  steps: [implementer],
}

describe("frozen run metadata regressions", () => {
  test("the first open freezes the pipeline and later opens replay it", async () => {
    const ws = await workspace()

    const first = await openRunMetadata(ws, "/repo", quick)
    expect(first.pipeline.name).toBe("quick")
    await first.flush()

    const resumed = await openRunMetadata(ws, "/repo", defaultPipeline())
    expect(resumed.pipeline.name).toBe("quick")
    expect(resumed.pipeline.steps).toHaveLength(1)
  })

  test("a filtered resume preserves the complete frozen pipeline", async () => {
    const ws = await workspace()
    const full: Pipeline = {
      ...quick,
      steps: [
        implementer,
        { ...implementer, name: "tests", stepName: "tests", agentName: "tests", reportPath: "reports/tests.md", groupId: "g2" },
      ],
    }
    const first = await openRunMetadata(ws, "/repo", full, { gateway: "vercel" })
    await first.flush()

    const reviewed: Pipeline = { ...full, steps: [full.steps[1]!] }
    const resumed = await openRunMetadata(ws, "/repo", reviewed, { useExecutionPipeline: true })
    expect(resumed.pipeline.steps.map((step) => step.name)).toEqual(["tests"])
    await resumed.flush()

    const persisted = await readRunMetadata(join(ws.dir, "metadata.json"))
    expect(persisted?.pipeline?.steps.map((step) => step.name)).toEqual(["implementer", "tests"])
  })

  test("a resume model override changes only unfinished phases", async () => {
    const ws = await workspace()
    const oldModel = {
      configured: "openai/gpt-old",
      logical: "openai/gpt-old",
      gateway: "vercel" as const,
      providerID: "vercel",
      modelID: "openai/gpt-old",
      target: "vercel/openai/gpt-old",
    }
    const full: Pipeline = {
      ...quick,
      steps: [
        { ...implementer, resolvedModel: oldModel },
        {
          ...implementer,
          name: "tests",
          stepName: "tests",
          agentName: "tests",
          reportPath: "reports/tests.md",
          groupId: "g2",
          resolvedModel: oldModel,
        },
      ],
    }
    const first = await openRunMetadata(ws, "/repo", full, { gateway: "vercel" })
    await first.phaseEnded("implementer", "completed")
    await first.flush()

    const overridden: Pipeline = {
      ...full,
      steps: full.steps.map((step) =>
        step.type === "agent"
          ? {
              ...step,
              model: "vercel/openai/gpt-new",
              resolvedModel: {
                configured: "openai/gpt-new",
                logical: "openai/gpt-new",
                gateway: "vercel",
                providerID: "vercel",
                modelID: "openai/gpt-new",
                target: "vercel/openai/gpt-new",
              },
            }
          : step,
      ),
    }
    const resumed = await openRunMetadata(ws, "/repo", overridden, {
      gateway: "vercel",
      modelOverride: true,
      useExecutionPipeline: true,
    })
    await resumed.flush()

    const persisted = await readRunMetadata(join(ws.dir, "metadata.json"))
    const targets = persisted?.pipeline?.steps.map((step) => (step.type === "agent" ? step.resolvedModel?.target : undefined))
    expect(targets).toEqual(["vercel/openai/gpt-old", "vercel/openai/gpt-new"])
    expect(persisted?.modelRouting?.gateway).toBe("vercel")
  })

  test("fails closed when a repository baseline cannot be persisted", async () => {
    const ws = await workspace()
    const store = await openRunMetadata(ws, "/repo", quick)
    await store.flush()
    await rm(ws.dir, { recursive: true, force: true })

    await expect(store.phaseRepositoryBaseline("implementer", { head: "abc123", ref: "main" })).rejects.toThrow()
  })

  test("persists lifecycle and baselines for Object.prototype step names", async () => {
    const ws = await workspace()
    const step = { ...implementer, name: "constructor", stepName: "constructor", reportPath: "reports/constructor.md" }
    const pipeline: Pipeline = { name: "collision", steps: [step] }
    const store = await openRunMetadata(ws, "/repo", pipeline)

    await store.phaseStarted(step.name)
    await store.phaseRepositoryBaseline(step.name, { head: "abc123", ref: "main" })
    await store.phaseEnded(step.name, "failed")
    await store.flush()

    const resumed = await openRunMetadata(ws, "/repo", pipeline)
    expect(resumed.phaseStatus(step.name)).toBe("failed")
    expect(resumed.repositoryBaseline(step.name)).toEqual({ head: "abc123", ref: "main" })
  })
})

describe("malicious frozen metadata regressions", () => {
  test("rejects artifact paths that escape the run directory", async () => {
    const ws = await workspace()
    const path = join(ws.dir, "metadata.json")
    const metadata = (step: object) => ({
      schemaVersion: 2,
      runID: ws.runID,
      targetDir: "/repo",
      createdAt: 0,
      updatedAt: 0,
      phases: {},
      pipeline: { ...quick, steps: [step] },
    })

    await writeFile(path, JSON.stringify(metadata({ ...implementer, reportPath: "../../../../tmp/owned.md" })))
    await expect(openRunMetadata(ws, "/repo", defaultPipeline())).rejects.toThrow("unsafe frozen pipeline")

    await writeFile(path, JSON.stringify(metadata({ ...implementer, inputFiles: ["../../../../tmp/secret"] })))
    await expect(openRunMetadata(ws, "/repo", defaultPipeline())).rejects.toThrow("unsafe frozen pipeline")
  })

  test("rejects unknown frozen step types before artifact validation can be bypassed", async () => {
    const ws = await workspace()
    await writeFile(
      join(ws.dir, "metadata.json"),
      JSON.stringify({
        schemaVersion: 2,
        runID: ws.runID,
        targetDir: "/repo",
        createdAt: 0,
        updatedAt: 0,
        phases: {},
        pipeline: {
          ...quick,
          steps: [{ ...implementer, type: "unknown", reportPath: "../../../../tmp/owned.md" }],
        },
      }),
    )

    await expect(openRunMetadata(ws, "/repo", defaultPipeline())).rejects.toThrow("unknown step type")
  })
})
