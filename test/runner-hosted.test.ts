import { afterAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { PermissionPromptInfo, PermissionReply, ProgressUI, RunOutcome } from "../src/progress"
import type { RunOptions } from "../src/types"

import { preparePhaseRun, run as realRun, hostedTeardownFromError, type RunDeps } from "../src/runner"
import { buildRunPlan } from "../src/run-plan"
import { noopProgress } from "../src/progress"
import { builtInAgents } from "../src/pipeline"
import { prdHistoryDir, readPrdHistoryIndex, writePrdHistory } from "../src/prd-history"
import { prepareWorktreeForRun } from "../src/cli"

// The runner's run() spawns a real opencode server. Inject the fake through
// run()'s deps seam rather than `mock.module("../src/opencode", …)`: that mock
// is process-global under bun:test and would replace the *whole* opencode
// module for every other test file in the run, so test/opencode.test.ts would
// import the stub's identity `shellQuote`/empty `sessionShellCommand` instead
// of the real ones whenever test load order put this file first (which is
// exactly what flipped the ubuntu CI red while macOS stayed green). The deps
// seam keeps the fake local: only `startOpencode` is swapped, and only here.
const fakeClient = {
  event: { subscribe: async () => ({ stream: (async function* () {})() }) },
  session: { status: async () => ({ data: {} }), messages: async () => ({ data: [] }) },
  permission: { reply: async () => ({}) },
}

// SC-4: When this flag is set, startOpencode throws a primitive (not an Error)
// so the runner's catch-block wrapping can be tested against a real run().
let throwPrimitiveFromStart = false

const fakeStartOpencode: RunDeps["startOpencode"] = async () => {
  if (throwPrimitiveFromStart) throw "primitive boom"
  return {
    client: fakeClient as never,
    url: "http://127.0.0.1:41234",
    close: () => {},
  }
}

// Bind the fake opencode handle so every test in this file exercises the
// hosted-progress contract without spawning a real SDK server.
const run = (options: RunOptions) => realRun(options, { startOpencode: fakeStartOpencode })

const hostedHome = await mkdtemp(join(tmpdir(), "convoy-hosted-home-"))

afterAll(async () => {
  await rm(hostedHome, { recursive: true, force: true })
})

async function git(args: string[], cwd: string) {
  const proc = Bun.spawn(["git", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`)
  return out
}

async function cleanRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "convoy-hosted-repo-"))
  await git(["init", "-q"], dir)
  await Bun.write(join(dir, "keep.txt"), "base\n")
  await git(["add", "-A"], dir)
  await git(["commit", "-qm", "base"], dir)
  return dir
}

const emptyPipeline = { name: "hosted-test", steps: [] }

function makeOptions(repo: string, overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: "build it",
    prdHistory: true,
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    tui: false,
    notify: false,
    notifications: { enabled: false, terminalTitle: false },
    humanReview: false,
    baseRef: "HEAD",
    targetDir: repo,
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    smartJudgeModel: "openai/gpt-5.6-sol",
    pipeline: emptyPipeline,
    agents: [...builtInAgents],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    ...overrides,
  }
}

/** A dashboard recording the hosted-mode calls and never resolving the finish hold. */
function fakeDashboard() {
  const events: string[] = []
  const progress: ProgressUI = {
    ...noopProgress,
    start: () => void events.push("start"),
    serverReady: () => void events.push("serverReady"),
    message: () => void events.push("message"),
    setGoalLoop: () => void events.push("setGoalLoop"),
    resetPipeline: () => void events.push("resetPipeline"),
    setAbortHandler: (handler) => void events.push(handler ? "setAbortHandler" : "clearAbortHandler"),
    setHostControls: () => void events.push("setHostControls"),
    runFinished: (outcome: RunOutcome) => {
      events.push(`runFinished:${outcome.status}`)
      return new Promise<void>(() => {})
    },
    stop: () => void events.push("stop"),
  }
  return { progress, events }
}

describe("run() with a hosted progress", () => {
  const originalHome = process.env.CONVOY_HOME
  process.env.CONVOY_HOME = hostedHome

  test("never stops the shared UI and defers server teardown to release", async () => {
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    try {
      const result = await run(makeOptions(repo, { progress: dashboard.progress }))

      // Hosted mode: the dashboard is repointed at this run, never stopped, and
      // the run never holds a finish screen.
      expect(dashboard.events).toContain("resetPipeline")
      expect(dashboard.events).toContain("setHostControls")
      expect(dashboard.events).toContain("setAbortHandler")
      expect(dashboard.events).not.toContain("stop")
      expect(dashboard.events).not.toContain("runFinished:completed")
      expect(dashboard.events).not.toContain("runFinished:failed")
      // The abort handler is cleared on the way out, not left pointing at a dead run.
      expect(dashboard.events).toContain("clearAbortHandler")
      // Every OpenCode run receives the report shim, even without an advisor.
      expect(existsSync(join(hostedHome, ".convoy", "opencode", "tools", "write_report.ts"))).toBe(true)

      // The finally no longer closes the server/lease: those ride on release.
      expect(result.release).toBeFunction()
      const metadata = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
      expect(metadata.server).toBeDefined()

      await result.release?.()
      const after = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
      expect(after.server).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a failing hosted run never holds and hands its teardown back on the error", async () => {
    const repo = await cleanRepo()
    const dashboard = fakeDashboard()
    try {
      // A post-hook that exits non-zero fails the run after the server is up
      // and its metadata entry recorded, so the deferred teardown has something
      // observable to close.
      let failure: unknown
      try {
        await run(makeOptions(repo, {
          progress: dashboard.progress,
          hooks: { pre: [], post: [{ name: "boom", command: "exit 1" }], pipelines: {} },
        }))
        throw new Error("the failing run should have rejected")
      } catch (error) {
        failure = error
      }

      expect(String(failure)).toContain("exited with code 1")
      // Hosted failure: no failed hold on the shared dashboard (the goal loop
      // holds it, not this run) and the dashboard is never stopped.
      expect(dashboard.events).not.toContain("runFinished:failed")
      expect(dashboard.events).not.toContain("runFinished:completed")
      expect(dashboard.events).not.toContain("stop")
      // The abort handler is still cleared on the way out.
      expect(dashboard.events).toContain("clearAbortHandler")

      // The finally no longer closes the server/lease: that teardown rides on
      // the thrown error, tagged with the run dir the failed screen needs.
      const teardown = hostedTeardownFromError(failure)
      expect(teardown).toBeDefined()
      if (!teardown) return
      expect(teardown.runDir).not.toBe("")
      const metadata = JSON.parse(await readFile(join(teardown.runDir, "metadata.json"), "utf8"))
      expect(metadata.server).toBeDefined()

      await teardown.release()
      const after = JSON.parse(await readFile(join(teardown.runDir, "metadata.json"), "utf8"))
      expect(after.server).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("without a hosted progress the run still completes and owns its teardown", async () => {
    const repo = await cleanRepo()
    try {
      const result = await run(makeOptions(repo))
      expect(result.release).toBeUndefined()
      // A normal run closes its own server entry during cleanup.
      const metadata = JSON.parse(await readFile(join(result.dir, "metadata.json"), "utf8"))
      expect(metadata.server).toBeUndefined()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a hosted askPermission is honoured without a TTY — the run never auto-rejects it", async () => {
    const repo = await cleanRepo()
    // A coordinated run has no TTY on the coordinator: "interactive" there
    // means "a controller can answer", i.e. progress.askPermission exists.
    // Force the no-TTY world for the whole run window and prove the hosted
    // prompt is asked and its reply forwarded, not auto-rejected.
    const stdinTty = process.stdin.isTTY
    const stdoutTty = process.stdout.isTTY
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true })
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true })

    const asked: PermissionPromptInfo[] = []
    const replies: Array<{ reply: string }> = []
    let resolveAsk!: (reply: PermissionReply) => void
    const open = new Promise<PermissionReply>((resolve) => {
      resolveAsk = resolve
    })

    const permissionClient = {
      ...fakeClient,
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            yield {
              type: "permission.asked",
              properties: { id: "perm-hosted", sessionID: "sess-hosted", permission: "bash", patterns: ["bash"], metadata: { command: "ls -la" }, always: [] },
            }
          })(),
        }),
      },
      permission: {
        reply: async ({ reply }: { reply: string }) => {
          replies.push({ reply })
          return { data: undefined, error: undefined }
        },
      },
    }
    const gatedStart: RunDeps["startOpencode"] = async () => ({
      client: permissionClient as never,
      url: "http://127.0.0.1:41235",
      close: () => {},
    })

    const progress: ProgressUI = {
      ...noopProgress,
      askPermission: (info) => {
        asked.push(info)
        return open
      },
    }

    try {
      // The pre-hook keeps the run (and its permission gate) alive long enough
      // for the event pump to deliver permission.asked before teardown.
      const promise = realRun(
        makeOptions(repo, {
          progress,
          hooks: { pre: [{ name: "hold-gate-open", command: "sleep 0.3" }], post: [], pipelines: {} },
        }),
        { startOpencode: gatedStart },
      )

      const deadline = Date.now() + 5_000
      while (asked.length === 0 && Date.now() < deadline) await Bun.sleep(10)
      expect(asked).toMatchObject([{ id: "perm-hosted", permission: "bash", patterns: ["bash"] }])
      // Nothing auto-rejected while the controller had not answered.
      expect(replies).toEqual([])

      // The controller answers; the gate forwards the reply to OpenCode.
      resolveAsk("once")
      const replied = Date.now() + 5_000
      while (replies.length === 0 && Date.now() < replied) await Bun.sleep(10)
      expect(replies).toEqual([{ reply: "once" }])

      await promise
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: stdinTty, configurable: true })
      Object.defineProperty(process.stdout, "isTTY", { value: stdoutTty, configurable: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a nitro run injects throughput routing into its own OpenCode config", async () => {
    const repo = await cleanRepo()
    // Capture the config the runner hands the (fake) opencode server; the phase
    // itself then fails on the fake client's missing session API, which is fine
    // — the injection happens at server start, before any phase runs.
    let captured: Awaited<Parameters<RunDeps["startOpencode"]>[0]> | undefined
    const capturingStart: RunDeps["startOpencode"] = async (config) => {
      captured = config
      return { client: fakeClient as never, url: "http://127.0.0.1:41235", close: () => {} }
    }
    try {
      const options = makeOptions(repo, {
        gateway: "nitro",
        pipeline: {
          name: "nitro-test",
          steps: [
            {
              type: "agent",
              name: "scope",
              stepName: "scope",
              groupId: "g1",
              agentName: "review-scope",
              description: "Scope",
              model: "zai/glm-5.2#high",
              inputFiles: ["prd.md"],
              inputDiff: false,
              reportPath: "reports/scope.md",
            },
          ],
        },
      })
      try {
        await realRun({ ...options, plan: buildRunPlan(options) }, { startOpencode: capturingStart })
      } catch {
        // Expected: the fake client cannot run the phase.
      }

      expect(captured?.provider?.openrouter?.models?.["z-ai/glm-5.2"]).toEqual({
        options: { provider: { sort: "throughput" } },
      })
      // The provider-level timeout settings still ride along.
      expect(captured?.provider?.openrouter?.options?.timeout).toBe(false)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("a non-nitro run leaves the OpenCode config free of throughput routing", async () => {
    const repo = await cleanRepo()
    let captured: Awaited<Parameters<RunDeps["startOpencode"]>[0]> | undefined
    const capturingStart: RunDeps["startOpencode"] = async (config) => {
      captured = config
      return { client: fakeClient as never, url: "http://127.0.0.1:41236", close: () => {} }
    }
    try {
      const options = makeOptions(repo, {
        gateway: "openrouter",
        pipeline: {
          name: "openrouter-test",
          steps: [
            {
              type: "agent",
              name: "scope",
              stepName: "scope",
              groupId: "g1",
              agentName: "review-scope",
              description: "Scope",
              model: "zai/glm-5.2#high",
              inputFiles: ["prd.md"],
              inputDiff: false,
              reportPath: "reports/scope.md",
            },
          ],
        },
      })
      try {
        await realRun({ ...options, plan: buildRunPlan(options) }, { startOpencode: capturingStart })
      } catch {
        // Expected: the fake client cannot run the phase.
      }

      expect(Object.keys(captured?.provider?.openrouter?.models ?? {})).toEqual([])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("records fresh prompts in the target checkout and skips the duplicate on resume", async () => {
    const repo = await cleanRepo()
    try {
      const first = await run(makeOptions(repo, { prompt: "original PRD" }))
      const history = prdHistoryDir(repo)
      const entries = await readPrdHistoryIndex(repo)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatchObject({ runID: first.runID, pipeline: "hosted-test" })
      expect(await readFile(join(history, `${first.runID}.prd.md`), "utf8")).toBe("original PRD")

      await run(makeOptions(repo, { prompt: "disabled PRD", prdHistory: false }))
      expect(await readPrdHistoryIndex(repo)).toHaveLength(1)

      await run(makeOptions(repo, { prompt: "", resumeRunID: first.runID }))
      expect(await readPrdHistoryIndex(repo)).toHaveLength(1)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  test("writes a worktree run's history in the new worktree, not the launch checkout", async () => {
    const launchRepo = await cleanRepo()
    let isolated: RunOptions | undefined
    try {
      isolated = await prepareWorktreeForRun(
        launchRepo,
        makeOptions(launchRepo, { prompt: "worktree PRD", worktree: true, branch: "feat/prd-history-location" }),
      )
      expect(isolated.targetDir).not.toBe(launchRepo)

      const result = await run(isolated)
      expect(await readPrdHistoryIndex(isolated.targetDir)).toEqual([
        expect.objectContaining({ runID: result.runID, file: `${result.runID}.prd.md`, pipeline: "hosted-test" }),
      ])
      expect(existsSync(join(isolated.targetDir, ".convoy", "prd-history", `${result.runID}.prd.md`))).toBe(true)
      expect(existsSync(join(launchRepo, ".convoy", "prd-history", "index.jsonl"))).toBe(false)
    } finally {
      if (isolated) await git(["worktree", "remove", "--", isolated.targetDir], launchRepo)
      await rm(launchRepo, { recursive: true, force: true })
    }
  })

  test("attaches only the oldest historical PRD for an opted-in scope step", async () => {
    const repo = await cleanRepo()
    const workspace = await mkdtemp(join(tmpdir(), "convoy-history-phase-"))
    const phase = {
      type: "agent" as const,
      name: "scope",
      stepName: "scope",
      groupId: "g1",
      agentName: "review-scope",
      description: "scope",
      model: "openai/gpt-5.6-terra",
      inputFiles: [],
      inputDiff: false,
      reportPath: "reports/scope.md",
      readOnly: true,
      prdHistory: true,
    }
    try {
      const branch = (await git(["branch", "--show-current"], repo)).trim()
      await writePrdHistory({ targetDir: repo, runID: "original", prompt: "original PRD", pipeline: "implement", branch })
      await writePrdHistory({ targetDir: repo, runID: "current", prompt: "review request", pipeline: "review", branch })

      const prepared = await preparePhaseRun({ dir: workspace, runID: "current" }, phase, makeOptions(repo), [], [])
      expect(prepared.attachments).toHaveLength(1)
      expect(prepared.attachments[0]).toMatchObject({ filename: "original.prd.md" })
      expect(prepared.attachments[0]?.url).toStartWith("file:///")
      expect(prepared.attachments[0]?.url).toContain(".convoy/prd-history/original.prd.md")
      expect((await preparePhaseRun({ dir: workspace, runID: "current" }, phase, makeOptions(repo, { prdHistory: false }), [], [])).attachments).toEqual([])

      await rm(join(prdHistoryDir(repo), "index.jsonl"))
      await mkdir(join(prdHistoryDir(repo), "index.jsonl"))
      expect((await preparePhaseRun({ dir: workspace, runID: "current" }, phase, makeOptions(repo), [], [])).attachments).toEqual([])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await rm(repo, { recursive: true, force: true })
    }
  })

  // SC-4: A primitive thrown value (string, number, …) cannot key the WeakMap
  // the goal loop fetches the hosted teardown from. The runner wraps it in an
  // Error before storing, so the teardown survives any thrown value.
  test("SC-4: a primitive thrown by startOpencode is wrapped so the teardown is preserved", async () => {
    const repo = await cleanRepo()
    const dashboard: ProgressUI = { ...noopProgress }
    try {
      throwPrimitiveFromStart = true
      let failure: unknown
      try {
        await run(makeOptions(repo, { progress: dashboard }))
        throw new Error("the run should have rejected")
      } catch (error) {
        failure = error
      }

      // The primitive was wrapped in an Error (not the raw string).
      expect(failure).toBeInstanceOf(Error)
      expect((failure as Error).message).toBe("primitive boom")

      // The wrapped error can key the WeakMap, so the teardown is recoverable.
      // Without the SC-4 wrap, hostedTeardownFromError would return undefined
      // because a string cannot key a WeakMap.
      const teardown = hostedTeardownFromError(failure)
      expect(teardown).toBeDefined()
      if (!teardown) return
      expect(teardown.runDir).not.toBe("")
      // The release closure runs without throwing — it releases the lease
      // and flushes metadata.
      await teardown.release()
    } finally {
      throwPrimitiveFromStart = false
      await rm(repo, { recursive: true, force: true })
    }
  })
})
