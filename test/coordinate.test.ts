import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, test } from "bun:test"

import {
  convoyCoordinateArgv,
  assertInternalLaunchPath,
  forwardCoordinatorLogs,
  launchPayload,
  readLaunchFile,
  rmPendingLaunch,
  spawnCoordinator,
  sweepPendingLaunches,
  waitForCoordinatorReady,
  writePendingLaunch,
} from "../src/coordinate"
import type { RunOptions } from "../src/types"

const dirs: string[] = []
afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "convoy-coordinate-"))
  dirs.push(dir)
  return dir
}

describe("convoyCoordinateArgv", () => {
  test("a standalone executable passes execPath --coordinate <launch>", () => {
    const argv = convoyCoordinateArgv("/tmp/launch.json")
    // Bun source invocations run process.argv[1] (this script); the standalone
    // branch is covered structurally: no "run" wrapper is ever inserted.
    expect(argv[0]).toBe(process.execPath)
    expect(argv).toContain("--coordinate")
    expect(argv[argv.length - 1]).toBe("/tmp/launch.json")
  })
})

describe("launch file round-trip", () => {
  test("drops the progress function before persisting", async () => {
    const dir = await scratch()
    const options: RunOptions = {
      prompt: "do the thing",
      files: [],
      onlySteps: [],
      skipSteps: [],
      resumeRunID: "",
      keepRunDir: true,
      modelOverride: "",
      advisorOverride: "",
      advisorDisabled: false,
      tui: true,
      notify: undefined,
      notifications: {},
      humanReview: false,
      baseRef: "main",
      targetDir: "/tmp/repo",
      worktree: false,
      includeDirty: false,
      yolo: false,
      smart: false,
      smartJudgeModel: "openai/gpt-5",
      pipeline: { name: "implement", steps: [] },
      agents: [],
      permissions: { allow: [], deny: [] },
      hooks: { pre: [], post: [], pipelines: {} },
      prdHistory: true,
      planOnly: false,
      noConfirm: false,
    }
    const payload = launchPayload(options, undefined, undefined)
    const pending = await writePendingLaunch(payload, dir)
    const loaded = await readLaunchFile(pending.launchPath)

    expect(loaded.schemaVersion).toBe(1)
    expect(loaded.options.targetDir).toBe("/tmp/repo")
    expect("progress" in loaded.options).toBe(false)
    expect(loaded.plan).toBeUndefined()
  })

  test("rejects a malformed launch file", async () => {
    const dir = await scratch()
    await writeFile(join(dir, "bad.json"), "{}")
    await expect(readLaunchFile(join(dir, "bad.json"))).rejects.toThrow(/invalid convoy launch/)
  })

  test("--coordinate only accepts launch files under the pending root", () => {
    const root = "/home/user/.convoy/pending"
    // A pending launch dir is a child of the root.
    expect(() => assertInternalLaunchPath(join(root, "abc", "launch.json"), root)).not.toThrow()
    // Anything else — /tmp, a sibling directory, or a path that merely starts
    // with the same prefix — is refused: a launch file carries full RunOptions
    // (hooks, target dir, permission policy) and must not be hand-fed.
    expect(() => assertInternalLaunchPath("/tmp/launch.json", root)).toThrow(/must live under/)
    expect(() => assertInternalLaunchPath("/home/user/.convoy/pending-evil/launch.json", root)).toThrow(/must live under/)
    expect(() => assertInternalLaunchPath("/etc/passwd", root)).toThrow(/must live under/)
  })
})

describe("waitForCoordinatorReady", () => {
  test("parses the ready file", async () => {
    const dir = await scratch()
    const readyPath = join(dir, "ready")
    await writeFile(readyPath, JSON.stringify({ runID: "20260101-000000-ab12", controlUrl: "http://127.0.0.1:1234" }))
    expect(await waitForCoordinatorReady(readyPath)).toEqual({ runID: "20260101-000000-ab12", controlUrl: "http://127.0.0.1:1234" })
  })

  test("times out when the coordinator never writes it", async () => {
    const dir = await scratch()
    await expect(waitForCoordinatorReady(join(dir, "never"), 120)).rejects.toThrow(/did not become ready/)
  })
})

describe("spawnCoordinator", () => {
  test("records the child pid so the sweep can tell live coordinators from orphans", async () => {
    const root = await scratch()
    const pending = await writePendingLaunch(launchPayload({ ...minimalOptions() } as RunOptions, undefined, undefined), root)
    const fakeSpawn = (() =>
      ({
        pid: 424242,
        unref: () => {},
        exited: Promise.resolve(0),
      })) as unknown as typeof Bun.spawn
    const result = await spawnCoordinator(pending, { spawn: fakeSpawn, isStandalone: () => false })
    expect(result.pid).toBe(424242)
    expect(await readFile(join(pending.dir, "pid"), "utf8")).toBe("424242")
  })
})

describe("sweepPendingLaunches", () => {
  test("removes dead-pid and stale pid-less dirs, keeps live-pid and young dirs", async () => {
    const root = await scratch()
    const live = "11111111-1111-4111-8111-111111111111"
    const dead = "22222222-2222-4222-8222-222222222222"
    const young = "33333333-3333-4333-8333-333333333333"
    const stale = "44444444-4444-4444-8444-444444444444"
    const foreign = "not-a-uuid"
    for (const name of [live, dead, young, stale, foreign]) {
      const dir = join(root, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, "launch.json"), "{}")
    }

    await writeFile(join(root, live, "pid"), String(process.pid))
    const gone = Bun.spawn(["true"])
    await gone.exited
    await writeFile(join(root, dead, "pid"), String(gone.pid))
    // No pid file: young dirs survive (spawn may be in flight), old ones go.
    const ancient = new Date(Date.now() - 48 * 60 * 60 * 1000)
    await utimes(join(root, stale), ancient, ancient)

    await sweepPendingLaunches(root)

    expect((await readdir(root)).sort()).toEqual([foreign, live, young].sort())
  })
})

describe("forwardCoordinatorLogs", () => {
  test("streams appended bytes and drains the tail on stop", async () => {
    const dir = await scratch()
    const logPath = join(dir, "coordinator.log")
    await writeFile(logPath, "first line\n")
    const chunks: string[] = []
    const forwarder = await forwardCoordinatorLogs(logPath, (chunk) => chunks.push(chunk), 20)

    await Bun.sleep(60)
    await writeFile(logPath, "first line\nsecond line\n")
    await Bun.sleep(60)

    // Content appended after the last pump but before the child's exit is
    // drained by stop(), which is why the parent calls it after exited.
    await writeFile(logPath, "first line\nsecond line\nthird line\n")
    await forwarder.stop()

    expect(chunks.join("")).toBe("first line\nsecond line\nthird line\n")
  })

  test("rmPendingLaunch deletes the dir and tolerates it being gone already", async () => {
    const dir = await scratch()
    await rmPendingLaunch(dir)
    await expect(readdir(dir)).rejects.toThrow()
    await rmPendingLaunch(dir) // no throw the second time
  })
})

function minimalOptions(): Partial<RunOptions> {
  return {
    prompt: "sweep",
    files: [],
    onlySteps: [],
    skipSteps: [],
    resumeRunID: "",
    keepRunDir: true,
    modelOverride: "",
    advisorOverride: "",
    advisorDisabled: false,
    tui: false,
    humanReview: false,
    baseRef: "main",
    targetDir: "/tmp/repo",
    worktree: false,
    includeDirty: false,
    yolo: false,
    smart: false,
    pipeline: { name: "implement", steps: [] },
    agents: [],
    permissions: { allow: [], deny: [] },
    hooks: { pre: [], post: [], pipelines: {} },
    prdHistory: true,
    planOnly: false,
    noConfirm: false,
  }
}
