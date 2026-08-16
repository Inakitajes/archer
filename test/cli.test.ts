import { describe, expect, test } from "bun:test"
import { afterAll, afterEach, beforeEach } from "bun:test"

import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { goalModeFor, goalModeRejectionError, parseArgs, parseCommand, resolveRunOptions } from "../src/cli"
import { builtInAgents, builtInPipelines, resolvePipeline } from "../src/pipeline"
import type { Pipeline, RunPlan } from "../src/types"

const validRunID = "20240101-120000-abcd"

describe("parseArgs", () => {
  test("parses a positional prompt", () => {
    const result = parseArgs(["add onboarding"])
    expect(result.prompt).toBe("add onboarding")
  })

  test("parses --prompt-file", () => {
    const result = parseArgs(["--prompt-file", "prd.md"])
    expect(result.promptFile).toBe("prd.md")
  })

  test("parses --file", () => {
    const result = parseArgs(["--file", "lib/main.dart", "-f", "test/main_test.dart"])
    expect(result.files).toEqual(["lib/main.dart", "test/main_test.dart"])
  })

  test("parses --pipeline", () => {
    const result = parseArgs(["-p", "bug-fix"])
    expect(result.pipeline).toBe("bug-fix")
  })

  test("parses --only and --skip with comma-separated values", () => {
    const result = parseArgs(["--only", "design,security", "--skip", "tests"])
    expect(result.onlySteps).toEqual(["design", "security"])
    expect(result.skipSteps).toEqual(["tests"])
  })

  test("parses --resume", () => {
    const result = parseArgs(["--resume", "run-abc123"])
    expect(result.resumeRunID).toBe("run-abc123")
  })

  test("parses --model", () => {
    const result = parseArgs(["--model", "anthropic/claude-sonnet-4-5#thinking"])
    expect(result.modelOverride).toBe("anthropic/claude-sonnet-4-5#thinking")
  })

  test("parses --advisor", () => {
    const result = parseArgs(["--advisor", "openai/gpt-5"])
    expect(result.advisorOverride).toBe("openai/gpt-5")
    expect(result.advisorDisabled).toBe(false)
  })

  test("parses --no-advisor", () => {
    const result = parseArgs(["--no-advisor"])
    expect(result.advisorDisabled).toBe(true)
    expect(result.advisorOverride).toBeUndefined()
  })

  test("parses --gateway", () => {
    const result = parseArgs(["--gateway", "openrouter"])
    expect(result.gateway).toBe("openrouter")
  })

  test("throws for invalid --gateway", () => {
    expect(() => parseArgs(["--gateway", "invalid"])).toThrow()
  })

  test("parses --goal with its iteration and plateau controls", () => {
    const result = parseArgs(["--goal", "90", "--goal-max-iterations", "5", "--goal-plateau", "2"])
    expect(result.goal).toBe(90)
    expect(result.goalMaxIterations).toBe(5)
    expect(result.goalPlateau).toBe(2)
  })

  test("rejects invalid --goal values", () => {
    expect(() => parseArgs(["--goal", "101"])).toThrow("--goal must be an integer from 1 to 100")
    expect(() => parseArgs(["--goal", "0"])).toThrow("--goal must be an integer from 1 to 100")
    expect(() => parseArgs(["--goal", "abc"])).toThrow("--goal must be an integer from 1 to 100")
    expect(() => parseArgs(["--goal-max-iterations", "0"])).toThrow("--goal-max-iterations must be a positive integer")
  })

  test("parses --goal with strict integer parsing", () => {
    // A goal is a whole number between 1 and 100; anything else must be
    // rejected instead of silently coerced by parseInt.
    expect(() => parseArgs(["--goal", "90abc"])).toThrow(/--goal/)
    expect(() => parseArgs(["--goal", "1.5"])).toThrow(/--goal/)
    expect(() => parseArgs(["--goal", "90 "])).toThrow(/--goal/)
  })

  test("parses --plan", () => {
    const result = parseArgs(["--plan"])
    expect(result.planOnly).toBe(true)
  })

  test("parses --no-confirm", () => {
    const result = parseArgs(["--no-confirm"])
    expect(result.noConfirm).toBe(true)
  })

  test("parses --tui and --no-tui", () => {
    expect(parseArgs(["--tui"]).tui).toBe(true)
    expect(parseArgs(["--no-tui"]).tui).toBe(false)
  })

  test("parses --worktree and --no-worktree", () => {
    expect(parseArgs(["--worktree"]).worktree).toBe(true)
    expect(parseArgs(["--no-worktree"]).worktree).toBe(false)
  })

  test("parses --branch", () => {
    const result = parseArgs(["--branch", "feat/my-feature"])
    expect(result.branch).toBe("feat/my-feature")
  })

  test("parses --base", () => {
    const result = parseArgs(["--base", "develop"])
    expect(result.baseRef).toBe("develop")
  })

  test("parses --include-dirty", () => {
    const result = parseArgs(["--include-dirty"])
    expect(result.includeDirty).toBe(true)
  })

  test("parses --yolo", () => {
    const result = parseArgs(["--yolo"])
    expect(result.yolo).toBe(true)
  })

  test("parses --smart", () => {
    const result = parseArgs(["--smart"])
    expect(result.smart).toBe(true)
  })

  test("parses --smart-model", () => {
    const result = parseArgs(["--smart-model", "anthropic/claude-opus-5"])
    expect(result.smartModel).toBe("anthropic/claude-opus-5")
  })

  test("parses --notify and --no-notify", () => {
    expect(parseArgs(["--notify"]).notify).toBe(true)
    expect(parseArgs(["--no-notify"]).notify).toBe(false)
  })

  test("parses --human-review", () => {
    expect(parseArgs(["--human-review"]).humanReview).toBe(true)
    expect(parseArgs(["--no-human-review"]).humanReview).toBe(false)
  })

  test("parses --max-concurrent", () => {
    const result = parseArgs(["--max-concurrent", "5"])
    expect(result.maxConcurrent).toBe(5)
  })

  test("throws for invalid --max-concurrent", () => {
    expect(() => parseArgs(["--max-concurrent", "0"])).toThrow()
    expect(() => parseArgs(["--max-concurrent", "abc"])).toThrow()
  })

  test("parses --keep-run-dir and --no-keep-run-dir", () => {
    expect(parseArgs(["--keep-run-dir"]).keepRunDir).toBe(true)
    expect(parseArgs(["--no-keep-run-dir"]).keepRunDir).toBe(false)
  })

  test("parses --dir", () => {
    const result = parseArgs(["--dir", "/some/repo"])
    expect(result.targetDir).toBe("/some/repo")
  })

  test("parses --help", () => {
    expect(parseArgs(["--help"]).help).toBe(true)
    expect(parseArgs(["-h"]).help?.toString()).toBe("true")
  })

  test("stops parsing at -- and treats everything after as positional", () => {
    const result = parseArgs(["--", "add", "login", "--verbose"])
    expect(result.prompt).toBe("add login --verbose")
  })

  test("throws for unknown flags", () => {
    expect(() => parseArgs(["--foobar"])).toThrow("unknown flag")
  })

  test("parses --model with = syntax", () => {
    const result = parseArgs(["--model=anthropic/claude-sonnet-4-5"])
    expect(result.modelOverride).toBe("anthropic/claude-sonnet-4-5")
  })

  test("parses --pipeline with = syntax", () => {
    const result = parseArgs(["--pipeline=bug-fix"])
    expect(result.pipeline).toBe("bug-fix")
  })

  test("parses --base with = syntax", () => {
    const result = parseArgs(["--base=main"])
    expect(result.baseRef).toBe("main")
  })

  test("parses --branch with = syntax", () => {
    const result = parseArgs(["--branch=feat/foo"])
    expect(result.branch).toBe("feat/foo")
  })

  test("parses --dir with = syntax", () => {
    const result = parseArgs(["--dir=/some/repo"])
    expect(result.targetDir).toBe("/some/repo")
  })

  test("parses --gateway with = syntax", () => {
    const result = parseArgs(["--gateway=direct"])
    expect(result.gateway).toBe("direct")
  })

  test("parses --only with = syntax", () => {
    const result = parseArgs(["--only=design,security"])
    expect(result.onlySteps).toEqual(["design", "security"])
  })

  test("parses --advisor with = syntax", () => {
    const result = parseArgs(["--advisor=openai/gpt-5"])
    expect(result.advisorOverride).toBe("openai/gpt-5")
  })

  test("parses --resume with = syntax", () => {
    const result = parseArgs(["--resume=run-abc123"])
    expect(result.resumeRunID).toBe("run-abc123")
  })

  test("parses -f with = syntax", () => {
    const result = parseArgs(["-f=lib/main.dart"])
    expect(result.files).toEqual(["lib/main.dart"])
  })

  test("--no-advisor does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-advisor=foo"])).toThrow("--no-advisor does not take a value")
  })

  test("--no-worktree does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-worktree=true"])).toThrow("--no-worktree does not take a value")
  })

  test("--plan does not take a value with = syntax", () => {
    expect(() => parseArgs(["--plan=1"])).toThrow("--plan does not take a value")
  })

  test("--no-confirm does not take a value with = syntax", () => {
    expect(() => parseArgs(["--no-confirm=1"])).toThrow("--no-confirm does not take a value")
  })

  test("--notify does not take a value with = syntax", () => {
    expect(() => parseArgs(["--notify=1"])).toThrow("--notify does not take a value")
  })

  test("--worktree does not take a value with = syntax", () => {
    expect(() => parseArgs(["--worktree=1"])).toThrow("--worktree does not take a value")
  })

  test("stops parsing at -- with just separator and positional", () => {
    const result = parseArgs(["--", "some prompt"])
    expect(result.prompt).toBe("some prompt")
  })

  test("-- separator with no positional args", () => {
    const result = parseArgs(["--model", "gpt-4", "--"])
    expect(result.modelOverride).toBe("gpt-4")
    expect(result.prompt).toBeUndefined()
  })

  test("-- separator with no args at all", () => {
    const result = parseArgs([])
    expect(result.prompt).toBeUndefined()
    expect(result.files).toEqual([])
    expect(result.onlySteps).toEqual([])
    expect(result.skipSteps).toEqual([])
  })
})

describe("parseCommand", () => {
  test("--help returns help text", async () => {
    const cmd = await parseCommand(["--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy [prompt]")
      expect(cmd.text).toContain("Commands:")
      expect(cmd.text).toContain("Flags:")
    }
  })

  test("-h returns help text", async () => {
    const cmd = await parseCommand(["-h"])
    expect(cmd.type).toBe("help")
  })

  test("parses --version", async () => {
    const cmd = await parseCommand(["--version"])
    expect(cmd.type).toBe("version")
  })

  test("parses -V", async () => {
    const cmd = await parseCommand(["-V"])
    expect(cmd.type).toBe("version")
  })

  test("parses update command", async () => {
    const cmd = await parseCommand(["update"])
    expect(cmd.type).toBe("update")
    expect((cmd as { checkOnly: boolean }).checkOnly).toBe(false)
  })

  test("parses update --check", async () => {
    const cmd = await parseCommand(["update", "--check"])
    expect(cmd.type).toBe("update")
    expect((cmd as { checkOnly: boolean }).checkOnly).toBe(true)
  })

  test("parses update --help", async () => {
    const cmd = await parseCommand(["update", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy update [--check]")
      expect(cmd.text).toContain("--check")
    }
  })

  test("parses update -h", async () => {
    const cmd = await parseCommand(["update", "-h"])
    expect(cmd.type).toBe("help")
  })

  test("throws for unknown update args", async () => {
    await expect(parseCommand(["update", "--unknown"])).rejects.toThrow("usage: convoy update")
  })

  test("parses auth status", async () => {
    const cmd = await parseCommand(["auth"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("status")
    }
  })

  test("parses auth openrouter", async () => {
    const cmd = await parseCommand(["auth", "openrouter"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("set")
    }
  })

  test("parses auth openrouter --remove", async () => {
    const cmd = await parseCommand(["auth", "openrouter", "--remove"])
    expect(cmd.type).toBe("auth")
    if (cmd.type === "auth") {
      expect(cmd.provider).toBe("openrouter")
      expect(cmd.action).toBe("remove")
    }
  })

  test("throws for invalid auth subcommand", async () => {
    await expect(parseCommand(["auth", "invalid"])).rejects.toThrow("usage: convoy auth")
  })

  test("parses init", async () => {
    const cmd = await parseCommand(["init"])
    expect(cmd.type).toBe("init")
  })

  test("parses init --global", async () => {
    const cmd = await parseCommand(["init", "--global"])
    expect(cmd.type).toBe("init")
    if (cmd.type === "init") {
      expect(cmd.options.global).toBe(true)
    }
  })

  test("parses init --help", async () => {
    const cmd = await parseCommand(["init", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy init [--global]")
    }
  })

  test("parses init -h", async () => {
    const cmd = await parseCommand(["init", "-h"])
    expect(cmd.type).toBe("help")
  })

  test("parses runs", async () => {
    const cmd = await parseCommand(["runs"])
    expect(cmd.type).toBe("runs")
    if (cmd.type === "runs") {
      expect(cmd.runID).toBeUndefined()
    }
  })

  test("parses runs with a run ID", async () => {
    const cmd = await parseCommand(["runs", validRunID])
    expect(cmd.type).toBe("runs")
    if (cmd.type === "runs") {
      expect(cmd.runID).toBe(validRunID)
    }
  })

  test("throws for runs with extra args", async () => {
    await expect(parseCommand(["runs", validRunID, "extra"])).rejects.toThrow("usage: convoy runs")
  })

  test("throws for an invalid run ID", async () => {
    await expect(parseCommand(["runs", "../../malicious"])).rejects.toThrow("invalid run id")
  })

  test("parses config", async () => {
    const cmd = await parseCommand(["config"])
    expect(cmd.type).toBe("config")
  })

  test("throws for config with extra args", async () => {
    await expect(parseCommand(["config", "extra"])).rejects.toThrow("usage: convoy config")
  })

  test("agents without subcommand shows help", async () => {
    const cmd = await parseCommand(["agents"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy agents eject")
    }
  })

  test("agents --help shows help", async () => {
    const cmd = await parseCommand(["agents", "--help"])
    expect(cmd.type).toBe("help")
  })

  test("agents eject with no agent name throws", async () => {
    await expect(parseCommand(["agents", "eject"])).rejects.toThrow("usage: convoy agents eject")
  })

  test("agents eject with --help shows help", async () => {
    const cmd = await parseCommand(["agents", "eject", "--help"])
    expect(cmd.type).toBe("help")
  })

  test("agents with invalid subcommand throws", async () => {
    await expect(parseCommand(["agents", "invalid"])).rejects.toThrow("usage: convoy agents eject")
  })

  test("finish --help returns help", async () => {
    const cmd = await parseCommand(["finish", "--help"])
    expect(cmd.type).toBe("help")
    if (cmd.type === "help") {
      expect(cmd.text).toContain("convoy finish")
    }
  })

  test("rejects both --prompt and --prompt-file", async () => {
    await expect(parseCommand(["prompt arg", "--prompt-file", "prd.md"])).rejects.toThrow("use either a positional prompt or --prompt-file")
  })

  test("rejects --resume with a new prompt", async () => {
    await expect(parseCommand(["--resume", validRunID, "new prompt"])).rejects.toThrow("can't take a new prompt")
  })

  test("parses a run command with prompt", async () => {
    const cmd = await parseCommand(["add login"])
    expect(cmd.type).toBe("run")
  })
})

// The fallback resolves the pipeline through the merged config, so these tests
// point CONVOY_HOME at a throwaway home: a real global config could shadow a
// built-in pipeline or set defaults.pipeline and flip the expectations.
describe("parseCommand default prompt fallback", () => {
  const dirs: string[] = []
  let savedHome: string | undefined

  beforeEach(async () => {
    savedHome = process.env.CONVOY_HOME
    const root = await mkdtemp(join(tmpdir(), "convoy-cli-prompt-home-"))
    dirs.push(root)
    process.env.CONVOY_HOME = root
  })

  afterEach(() => {
    if (savedHome === undefined) delete process.env.CONVOY_HOME
    else process.env.CONVOY_HOME = savedHome
  })

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("uses the pipeline's defaultPrompt when no prompt is given", async () => {
    const cmd = await parseCommand(["-p", "review"])
    expect(cmd.type).toBe("run")
    if (cmd.type === "run") {
      expect(cmd.options.prompt).toBe(
        "Review the current branch against its base and report prioritized findings with a verified quality score.",
      )
      expect(cmd.options.plan?.prompt.source).toBe("default")
    }
  })

  test("rejects a run without prompt when the default pipeline has no defaultPrompt", async () => {
    // implement (the default) has no defaultPrompt, so a bare invocation still errors.
    await expect(parseCommand([])).rejects.toThrow("need a prompt")
  })

  test("still errors when the selected pipeline has no defaultPrompt", async () => {
    await expect(parseCommand(["-p", "implement"])).rejects.toThrow("need a prompt")
  })

  test("a positional prompt beats the defaultPrompt", async () => {
    const cmd = await parseCommand(["-p", "review", "my own prompt"])
    expect(cmd.type).toBe("run")
    if (cmd.type === "run") {
      expect(cmd.options.prompt).toBe("my own prompt")
      expect(cmd.options.plan?.prompt.source).toBe("inline")
    }
  })

  test("--prompt-file beats the defaultPrompt and is marked as file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-prompt-"))
    dirs.push(dir)
    const promptFile = join(dir, "prd.md")
    await writeFile(promptFile, "from file")
    const cmd = await parseCommand(["-p", "review", "--prompt-file", promptFile])
    expect(cmd.type).toBe("run")
    if (cmd.type === "run") {
      expect(cmd.options.prompt).toBe("from file")
      expect(cmd.options.plan?.prompt.source).toBe("file")
    }
  })
})

describe("resolveRunOptions", () => {
  test("uses explicit maxConcurrentAgents", async () => {
    const parsed = parseArgs(["--max-concurrent", "5"])
    const options = await resolveRunOptions(parsed)
    expect(options.maxConcurrentAgents).toBe(5)
  })

  test("resolves humanReview from TTY", async () => {
    const parsed = parseArgs(["--no-human-review"])
    const options = await resolveRunOptions(parsed)
    expect(options.humanReview).toBe(false)
  })

  test("resolves planOnly from flag", async () => {
    const parsed = parseArgs(["--plan"])
    const options = await resolveRunOptions(parsed)
    expect(options.planOnly).toBe(true)
  })

  test("resolves noConfirm from flag", async () => {
    const parsed = parseArgs(["--no-confirm"])
    const options = await resolveRunOptions(parsed)
    expect(options.noConfirm).toBe(true)
  })
})

describe("goalModeFor", () => {
  // A pipeline is goal-eligible only when it has a quality-score-report step
  // (consensus) AND a writable step. report-only scored pipelines (review) have
  // the consensus step but no writable step, so --goal is refused — the
  // goal-fixer would mutate a pipeline whose contract says "makes no changes".
  const ship = resolvePipeline({ name: "ship", spec: builtInPipelines.ship!, agents: builtInAgents })
  const reviewScored = resolvePipeline({ name: "review", spec: builtInPipelines.review!, agents: builtInAgents })
  const implement = resolvePipeline({ name: "implement", spec: builtInPipelines.implement!, agents: builtInAgents })
  const goalFix = resolvePipeline({ name: "goal-fix", spec: builtInPipelines["goal-fix"]!, agents: builtInAgents })

  function planWith(pipeline: Pipeline): RunPlan {
    return { pipeline } as RunPlan
  }

  test("is off when no goal is set", () => {
    expect(goalModeFor({}, planWith(ship))).toEqual({ mode: "off" })
  })

  test("is on for a scored pipeline with a writable step and a resolved fix pipeline", () => {
    const decision = goalModeFor({ goal: 90, goalFixPipeline: goalFix }, planWith(ship))
    expect(decision).toEqual({ mode: "on", goal: 90 })
  })

  test("rejects --goal on a report-only scored pipeline (no writable step)", () => {
    // review ends in a quality-score-report step but every step is
    // read-only, so --goal would run the writable goal-fixer against a pipeline
    // documented as "makes no changes" — refuse it with a clear reason.
    const decision = goalModeFor({ goal: 90, goalFixPipeline: goalFix }, planWith(reviewScored))
    expect(decision.mode).toBe("rejected")
    if (decision.mode === "rejected") expect(decision.reason).toBe("not-writable")
  })

  test("rejects --goal on a pipeline with no consensus step", () => {
    const decision = goalModeFor({ goal: 90, goalFixPipeline: goalFix }, planWith(implement))
    expect(decision.mode).toBe("rejected")
    if (decision.mode === "rejected") expect(decision.reason).toBe("no-consensus")
  })

  test("rejects --goal when the goal-fix pipeline could not be resolved", () => {
    const decision = goalModeFor({ goal: 90 }, planWith(ship))
    expect(decision.mode).toBe("rejected")
    if (decision.mode === "rejected") expect(decision.reason).toBe("no-fix-pipeline")
  })

  test("rejects --goal when the fix pipeline lacks a goal-fixer step", () => {
    // A project override of goal-fix that drops the goal-fixer step would leave
    // the fixer running blind (no brief reaches it); reject so the
    // misconfiguration is surfaced, not silently swallowed.
    const badFix = { ...goalFix, steps: goalFix.steps.filter((s) => !(s.type === "agent" && s.agentName === "goal-fixer")) }
    const decision = goalModeFor({ goal: 90, goalFixPipeline: badFix }, planWith(ship))
    expect(decision.mode).toBe("rejected")
    if (decision.mode === "rejected") expect(decision.reason).toBe("bad-fix-pipeline")
  })

  test("rejects --goal when the fix pipeline lacks a consensus step", () => {
    const noConsensus = { ...goalFix, steps: goalFix.steps.filter((s) => !(s.type === "agent" && s.agentName === "quality-score-report")) }
    const decision = goalModeFor({ goal: 90, goalFixPipeline: noConsensus }, planWith(ship))
    expect(decision.mode).toBe("rejected")
    if (decision.mode === "rejected") expect(decision.reason).toBe("bad-fix-pipeline")
  })

  test("the bad-fix-pipeline rejection error mentions the project override", () => {
    const badFix = { ...goalFix, steps: [] }
    const decision = goalModeFor({ goal: 90, goalFixPipeline: badFix }, planWith(ship))
    if (decision.mode === "rejected") {
      const error = goalModeRejectionError(decision, planWith(ship))
      expect(error.message).toContain("goal-fixer step")
      expect(error.message).toContain("quality-score-report step")
    }
  })
})
