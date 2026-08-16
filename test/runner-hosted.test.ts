import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { ProgressUI, RunOutcome } from "../src/progress"
import type { RunOptions } from "../src/types"

import { run as realRun, hostedTeardownFromError, type RunDeps } from "../src/runner"
import { noopProgress } from "../src/progress"
import { builtInAgents } from "../src/pipeline"

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
