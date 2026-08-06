import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test"

import { parseAndRun, parseArgs, parseCommand, resolveRunOptions } from "../src/cli"
import { addWorktree } from "../src/git"
import { stepNames } from "../src/pipeline"

const homeDirs: string[] = []
let savedHome: string | undefined

beforeEach(async () => {
  savedHome = process.env.CONVOY_HOME
  const root = await mkdtemp(join(tmpdir(), "convoy-cli-home-"))
  homeDirs.push(root)
  await mkdir(join(root, ".convoy"), { recursive: true })
  process.env.CONVOY_HOME = root
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.CONVOY_HOME
  else process.env.CONVOY_HOME = savedHome
})

afterAll(async () => {
  await Promise.all(homeDirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("cli parsing", () => {
  test("parses pipeline flags without side effects", () => {
    const parsed = parseArgs([
      "--only",
      "implementer,tests",
      "--skip=design",
      "--file",
      "lib/onboarding",
      "--include-dirty",
      "add",
      "onboarding",
    ])

    expect(parsed.onlySteps).toEqual(["implementer", "tests"])
    expect(parsed.skipSteps).toEqual(["design"])
    expect(parsed.files).toEqual(["lib/onboarding"])
    expect(parsed.includeDirty).toBe(true)
    expect(parsed.prompt).toBe("add onboarding")
  })

  test("parses gateway and review flags and rejects invalid combinations", () => {
    expect(parseArgs(["--gateway", "vercel", "--plan", "--no-confirm", "prompt"])).toMatchObject({
      gateway: "vercel",
      planOnly: true,
      noConfirm: true,
      prompt: "prompt",
    })
    expect(() => parseArgs(["--gateway", "automatic", "prompt"])).toThrow("--gateway must be")
    expect(() => parseArgs(["--plan=json", "prompt"])).toThrow("--plan does not take a value")
    expect(() => parseArgs(["--no-confirm=yes", "prompt"])).toThrow("--no-confirm does not take a value")
  })

  test("parses the advisor flags, letting the last one win so the eval configs stay unambiguous", () => {
    expect(parseArgs(["--advisor", "anthropic/claude-opus-5", "prompt"])).toMatchObject({
      advisorOverride: "anthropic/claude-opus-5",
      advisorDisabled: false,
    })
    expect(parseArgs(["--no-advisor", "prompt"])).toMatchObject({ advisorDisabled: true, advisorOverride: undefined })
    expect(parseArgs(["--advisor", "anthropic/claude-opus-5", "--no-advisor", "prompt"])).toMatchObject({
      advisorDisabled: true,
      advisorOverride: undefined,
    })
    expect(parseArgs(["--no-advisor", "--advisor", "anthropic/claude-opus-5", "prompt"])).toMatchObject({
      advisorDisabled: false,
      advisorOverride: "anthropic/claude-opus-5",
    })
    expect(() => parseArgs(["--no-advisor=yes", "prompt"])).toThrow("--no-advisor does not take a value")
  })

  test("returns help as a command", async () => {
    const command = await parseCommand(["--help"])

    expect(command.type).toBe("help")
    if (command.type === "help") expect(command.text).toContain("convoy [prompt]")
  })

  test("parses version and update commands without requiring a prompt", async () => {
    expect(await parseCommand(["--version"])).toEqual({ type: "version" })
    expect(await parseCommand(["-V"])).toEqual({ type: "version" })
    expect(await parseCommand(["update"])).toEqual({ type: "update", checkOnly: false })
    expect(await parseCommand(["update", "--check"])).toEqual({ type: "update", checkOnly: true })
    await expect(parseCommand(["update", "--bogus"])).rejects.toThrow("usage: convoy update")
  })

  test("parses the auth subcommand grammar", async () => {
    expect(await parseCommand(["auth"])).toEqual({ type: "auth", provider: "openrouter", action: "status" })
    expect(await parseCommand(["auth", "status"])).toEqual({ type: "auth", provider: "openrouter", action: "status" })
    expect(await parseCommand(["auth", "openrouter"])).toEqual({ type: "auth", provider: "openrouter", action: "set" })
    expect(await parseCommand(["auth", "openrouter", "--remove"])).toEqual({ type: "auth", provider: "openrouter", action: "remove" })

    await expect(parseCommand(["auth", "anthropic"])).rejects.toThrow("usage: convoy auth")
    await expect(parseCommand(["auth", "openrouter", "--bogus"])).rejects.toThrow("usage: convoy auth")
  })

  test("requires prompt unless resuming", async () => {
    await expect(parseCommand([])).rejects.toThrow("need a prompt")

    // Building the resumed plan reads the run's frozen metadata, so the run
    // must exist at parse time.
    const runDir = join(process.env.CONVOY_HOME!, ".convoy", "runs", "20260519-103045-x7q2")
    await mkdir(runDir, { recursive: true })
    await writeFile(
      join(runDir, "metadata.json"),
      JSON.stringify({ schemaVersion: 2, runID: "20260519-103045-x7q2", targetDir: "/repo", createdAt: 0, updatedAt: 0, phases: {} }),
    )
    await writeFile(join(runDir, "prd.md"), "original prompt")

    const command = await parseCommand(["--resume", "20260519-103045-x7q2"])
    expect(command.type).toBe("run")
    if (command.type === "run") {
      expect(command.options.resumeRunID).toBe("20260519-103045-x7q2")
      expect(command.options.prompt).toBe("original prompt")
      expect(command.options.plan?.prompt.source).toBe("resume")
    }

    await expect(parseCommand(["--resume", "20260519-103045-zz99"])).rejects.toThrow("doesn't exist")
  })

  test("rejects unknown step names against the resolved pipeline", async () => {
    await expect(parseCommand(["--only", "secuirty", "prompt"])).rejects.toThrow('unknown step "secuirty"')
    await expect(parseCommand(["--skip", "desing", "prompt"])).rejects.toThrow('unknown step "desing"')

    // human-review is a legacy human step name; referencing it stays valid even when
    // the gate was dropped from the pipeline (non-interactive runs).
    const command = await parseCommand(["--skip", "human-review", "prompt"])
    expect(command.type).toBe("run")
  })

  test("rejects a flag where a value is expected", () => {
    expect(() => parseArgs(["--prompt-file", "--only"])).toThrow("--prompt-file requires a value")
  })

  test("rejects conflicting prompt sources", async () => {
    await expect(parseCommand(["--prompt-file", "prd.md", "inline prompt"])).rejects.toThrow("not both")
    await expect(parseCommand(["--resume", "20260519-103045-x7q2", "new prompt"])).rejects.toThrow("--resume")
  })

  test("parses human step flags", () => {
    const parsed = parseArgs(["--human-step", "--no-tui", "prompt"])

    expect(parsed.humanReview).toBe(true)
    expect(parsed.tui).toBe(false)
    expect(parseArgs(["--no-human-step", "prompt"]).humanReview).toBe(false)
  })

  test("parses worktree flags", () => {
    expect(parseArgs(["prompt"]).worktree).toBeUndefined()
    expect(parseArgs(["--worktree", "prompt"]).worktree).toBe(true)
    expect(parseArgs(["--no-worktree", "prompt"]).worktree).toBe(false)
    expect(parseArgs(["--branch", "feat/thing", "prompt"]).branch).toBe("feat/thing")
    expect(() => parseArgs(["--worktree=yes", "prompt"])).toThrow("--worktree does not take a value")
    expect(() => parseArgs(["--no-worktree=yes", "prompt"])).toThrow("--no-worktree does not take a value")
  })

  test("a resumed run never creates a second worktree, even with --worktree", async () => {
    // It continues in the directory its metadata recorded, which already is the
    // worktree when the original run made one.
    const parsed = parseArgs(["--worktree"])
    parsed.resumeRunID = "20260519-103045-x7q2"

    expect((await resolveRunOptions(parsed)).worktree).toBe(false)
  })

  test("yolo is opt-in", async () => {
    const plain = await parseCommand(["prompt"])
    if (plain.type === "run") expect(plain.options.yolo).toBe(false)

    const yolo = await parseCommand(["--yolo", "prompt"])
    if (yolo.type === "run") expect(yolo.options.yolo).toBe(true)
  })

  test("smart auto-accept is opt-in and resolves a judge model", async () => {
    const plain = await parseCommand(["prompt"])
    // Unset, the judge model still resolves (falls back to the run's model).
    if (plain.type === "run") {
      expect(plain.options.smart).toBe(false)
      expect(plain.options.smartJudgeModel.length).toBeGreaterThan(0)
    }

    const smart = await parseCommand(["--smart", "--smart-model", "anthropic/claude-haiku-4-5", "prompt"])
    if (smart.type === "run") {
      expect(smart.options.smart).toBe(true)
      expect(smart.options.smartJudgeModel).toBe("anthropic/claude-haiku-4-5")
    }
  })

  test("parses the runs subcommand", async () => {
    const bare = await parseCommand(["runs"])
    expect(bare.type).toBe("runs")
    if (bare.type === "runs") expect(bare.runID).toBeUndefined()

    const withID = await parseCommand(["runs", "20260519-103045-x7q2"])
    expect(withID.type).toBe("runs")
    if (withID.type === "runs") expect(withID.runID).toBe("20260519-103045-x7q2")
  })

  test("rejects bad runs subcommand arguments", async () => {
    await expect(parseCommand(["runs", "latest"])).rejects.toThrow("invalid run id")
    await expect(parseCommand(["runs", "20260519-103045-x7q2", "extra"])).rejects.toThrow("usage: convoy runs")
  })
})

describe("config precedence", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function projectWithConfig() {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-config-"))
    dirs.push(dir)
    await mkdir(join(dir, ".convoy"), { recursive: true })
    await writeFile(join(dir, "docs.md"), "# notes")
    await writeFile(
      join(dir, ".convoy", "config.yaml"),
      [
        "defaults:",
        "  baseRef: develop",
        "  pipeline: quick",
        "pipelines:",
        "  quick:",
        "    steps:",
        "      - implementer",
        "      - tests",
        "attachments:",
        "  - docs.md",
      ].join("\n"),
    )
    return dir
  }

  test("config defaults apply when flags are absent", async () => {
    const dir = await projectWithConfig()
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("develop")
    expect(command.options.pipeline.name).toBe("quick")
    expect(stepNames(command.options.pipeline)).toEqual(["implementer", "tests"])
    expect(command.options.files).toEqual(["docs.md"])
  })

  test("CLI flags always win over config defaults", async () => {
    const dir = await projectWithConfig()
    const command = await parseCommand([
      "--dir",
      dir,
      "--base",
      "main",
      "--pipeline",
      "implement",
      "prompt",
    ])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("main")
    expect(command.options.pipeline.name).toBe("implement")
  })

  test("keeps an absent notification flag distinct from explicit --notify and --no-notify", async () => {
    const dir = await projectWithConfig()
    await writeFile(join(dir, ".convoy", "config.yaml"), "notifications:\n  enabled: false\n")

    const defaulted = await parseCommand(["--dir", dir, "prompt"])
    const enabled = await parseCommand(["--dir", dir, "--notify", "prompt"])
    const disabled = await parseCommand(["--dir", dir, "--no-notify", "prompt"])

    expect(defaulted.type).toBe("run")
    expect(enabled.type).toBe("run")
    expect(disabled.type).toBe("run")
    if (defaulted.type !== "run" || enabled.type !== "run" || disabled.type !== "run") return

    // The runner must be able to distinguish the config-driven default from an
    // explicit CLI override before merging the final notification settings.
    expect(defaulted.options.notify).toBeUndefined()
    expect(enabled.options.notify).toBe(true)
    expect(disabled.options.notify).toBe(false)
    expect(enabled.options.notifications).toEqual({ enabled: false })
  })

  test("gateway precedence is CLI, then project, then global", async () => {
    const dir = await projectWithConfig()
    await writeFile(join(process.env.CONVOY_HOME!, ".convoy", "config.yaml"), "modelRouting:\n  gateway: openrouter\n")
    await writeFile(join(dir, ".convoy", "config.yaml"), "modelRouting:\n  gateway: configured\n")

    const project = await parseCommand(["--dir", dir, "prompt"])
    expect(project.type).toBe("run")
    if (project.type === "run") {
      expect(project.options.gateway).toBe("configured")
      expect(project.options.plan?.modelRouting.gateway).toBe("configured")
    }

    const cli = await parseCommand(["--dir", dir, "--gateway", "vercel", "prompt"])
    expect(cli.type).toBe("run")
    if (cli.type === "run") {
      expect(cli.options.gateway).toBe("vercel")
      expect(cli.options.gatewayExplicit).toBe(true)
      expect(cli.options.plan?.modelRouting.gateway).toBe("vercel")
    }
  })

  test("an unknown pipeline lists what exists", async () => {
    const dir = await projectWithConfig()
    await expect(parseCommand(["--dir", dir, "--pipeline", "ghost", "prompt"])).rejects.toThrow(
      'unknown pipeline "ghost" (available: fixer, hunter, hunter-max, implement, implement-advised, implement-lite, quick, refine, review, review-cc, review-lite, ship, ultra-implement, ultra-refine)',
    )
  })
})

describe("base ref auto-detection", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function repoOn(branch: string) {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-base-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", branch], dir)
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    return dir
  }

  test("auto-detects the base ref when flag and config are absent", async () => {
    const dir = await repoOn("develop")
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("develop")
  })

  test("falls back to HEAD outside a git repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-base-"))
    dirs.push(dir)
    const command = await parseCommand(["--dir", dir, "prompt"])

    expect(command.type).toBe("run")
    if (command.type !== "run") return
    expect(command.options.baseRef).toBe("HEAD")
  })

  test("worktree runs detect against the original repo, not the worktree", async () => {
    const repo = await repoOn("squad-x")
    const worktree = await mkdtemp(join(tmpdir(), "convoy-cli-base-wt-"))
    await rm(worktree, { recursive: true, force: true })
    dirs.push(worktree)
    await addWorktree(worktree, "agent-branch", "HEAD", repo)

    const parsed = parseArgs(["prompt"])
    parsed.targetDir = worktree
    parsed.baseDetectionDir = repo

    const options = await resolveRunOptions(parsed)
    expect(options.baseRef).toBe("squad-x")
  })
})

describe("worktree default", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function git(args: string[], cwd: string) {
    const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "convoy-test",
        GIT_AUTHOR_EMAIL: "convoy-test@example.invalid",
        GIT_COMMITTER_NAME: "convoy-test",
        GIT_COMMITTER_EMAIL: "convoy-test@example.invalid",
      },
    })
    if ((await proc.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(proc.stderr).text()}`)
  }

  async function repoOn(branch: string) {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-worktree-"))
    dirs.push(dir)
    await git(["init", "-q", "-b", "main"], dir)
    await git(["commit", "-q", "--allow-empty", "-m", "init"], dir)
    if (branch !== "main") await git(["checkout", "-q", "-b", branch], dir)
    return dir
  }

  const worktreeFor = async (argv: string[]) => {
    const command = await parseCommand(argv)
    if (command.type !== "run") throw new Error(`expected a run command, got ${command.type}`)
    return command.options.worktree
  }

  test("isolates on a trunk and runs in place on a branch, with no flag or config", async () => {
    expect(await worktreeFor(["--dir", await repoOn("main"), "prompt"])).toBe(true)
    expect(await worktreeFor(["--dir", await repoOn("feat/thing"), "prompt"])).toBe(false)
  })

  test("flags override the branch default in both directions", async () => {
    const trunk = await repoOn("main")
    const branch = await repoOn("feat/thing")

    expect(await worktreeFor(["--dir", trunk, "--no-worktree", "prompt"])).toBe(false)
    expect(await worktreeFor(["--dir", branch, "--worktree", "prompt"])).toBe(true)
  })

  test("an explicit defaults.worktree still wins over the branch", async () => {
    await writeFile(join(process.env.CONVOY_HOME!, ".convoy", "config.yaml"), "version: 1\ndefaults:\n  worktree: false\n")

    // On a trunk, where the branch alone would have isolated.
    expect(await worktreeFor(["--dir", await repoOn("main"), "prompt"])).toBe(false)
    // And the flag still beats the config.
    expect(await worktreeFor(["--dir", await repoOn("main"), "--worktree", "prompt"])).toBe(true)
  })
})

describe("init command", () => {
  const dirs: string[] = []

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("parses init options without requiring a prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-init-"))
    dirs.push(dir)

    const local = await parseCommand(["init", "--dir", dir, "--force", "--quiet"])
    expect(local.type).toBe("init")
    if (local.type === "init") {
      expect(local.options).toMatchObject({ targetDir: dir, global: false, force: true, quiet: true })
    }

    const global = await parseCommand(["init", "--global", "--force"])
    expect(global.type).toBe("init")
    if (global.type === "init") expect(global.options).toMatchObject({ global: true, force: true })
  })

  test("rejects incompatible init options", async () => {
    await expect(parseCommand(["init", "--global", "--dir", "."])).rejects.toThrow("either --global or --dir")
    await expect(parseCommand(["init", "extra"])).rejects.toThrow("usage: convoy init")
  })

  test("parses agents eject, reusing init's flags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-eject-"))
    dirs.push(dir)

    const local = await parseCommand(["agents", "eject", "implementer", "--dir", dir, "--force"])
    expect(local.type).toBe("agents")
    if (local.type === "agents") {
      expect(local.agentName).toBe("implementer")
      expect(local.options).toMatchObject({ targetDir: dir, global: false, force: true })
    }

    const global = await parseCommand(["agents", "eject", "design-polisher", "--global"])
    expect(global.type).toBe("agents")
    if (global.type === "agents") {
      expect(global.agentName).toBe("design-polisher")
      expect(global.options).toMatchObject({ global: true })
    }
  })

  test("agents without an ejectable target prints help instead of failing", async () => {
    const bare = await parseCommand(["agents"])
    expect(bare.type).toBe("help")
    // The help has to name the agents, since it is the only place they are listed.
    if (bare.type === "help") expect(bare.text).toContain("implementer")

    await expect(parseCommand(["agents", "eject"])).rejects.toThrow("usage: convoy agents eject")
    await expect(parseCommand(["agents", "list"])).rejects.toThrow("usage: convoy agents eject")
  })

  test("creates project config without overwriting unless forced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-init-write-"))
    dirs.push(dir)
    const path = join(dir, ".convoy", "config.yaml")

    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("version: 1")
    expect(await readFile(path, "utf8")).toContain("#   implementer:")
    expect(existsSync(join(dir, ".convoy", "agents"))).toBe(false)

    await writeFile(path, "version: 1\nattachments:\n  - custom.md\n")
    await parseAndRun(["init", "--dir", dir, "--quiet"])
    expect(await readFile(path, "utf8")).toContain("custom.md")

    await parseAndRun(["init", "--dir", dir, "--force", "--quiet"])
    expect(await readFile(path, "utf8")).not.toContain("custom.md")
  })

  test("agents eject writes only the requested prompt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-cli-eject-write-"))
    dirs.push(dir)
    const prompt = join(dir, ".convoy", "agents", "implementer.md")

    await parseAndRun(["agents", "eject", "implementer", "--dir", dir, "--quiet"])
    expect(await readFile(prompt, "utf8")).toContain("# Implementer")
    expect(existsSync(join(dir, ".convoy", "agents", "design-polisher.md"))).toBe(false)

    await writeFile(prompt, "# Mine\n")
    await parseAndRun(["agents", "eject", "implementer", "--dir", dir, "--quiet"])
    expect(await readFile(prompt, "utf8")).toBe("# Mine\n")

    await parseAndRun(["agents", "eject", "implementer", "--dir", dir, "--force", "--quiet"])
    expect(await readFile(prompt, "utf8")).toContain("# Implementer")
  })
})
