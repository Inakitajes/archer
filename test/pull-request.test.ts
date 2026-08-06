import { expect, test } from "bun:test"

import { startPullRequestLookup } from "../src/pull-request"

/** The lookup runs detached; give its microtasks a turn before asserting. */
const settle = () => Bun.sleep(5)

test("resolves the PR number once and reports it", async () => {
  const found: number[] = []
  let calls = 0
  const cancel = startPullRequestLookup({
    targetDir: "/repo",
    onFound: (pr) => found.push(pr),
    hasGh: () => true,
    lookup: async () => {
      calls++
      return 52
    },
  })

  await settle()
  cancel()

  expect(found).toEqual([52])
  // A branch's PR number cannot change mid-run, so asking once is the whole job.
  expect(calls).toBe(1)
})

test("a branch with no PR is simply left without one", async () => {
  const found: number[] = []
  let calls = 0
  startPullRequestLookup({
    targetDir: "/repo",
    onFound: (pr) => found.push(pr),
    hasGh: () => true,
    lookup: async () => {
      calls++
      return undefined
    },
  })

  await settle()
  expect(found).toEqual([])
  expect(calls).toBe(1)
})

test("does nothing at all when gh is not installed", async () => {
  let calls = 0
  startPullRequestLookup({
    targetDir: "/repo",
    onFound: () => {},
    hasGh: () => false,
    lookup: async () => {
      calls++
      return 1
    },
  })

  await settle()
  expect(calls).toBe(0)
})

test("a failing lookup is swallowed, never surfaced into the run", async () => {
  const found: number[] = []
  startPullRequestLookup({
    targetDir: "/repo",
    onFound: (pr) => found.push(pr),
    hasGh: () => true,
    lookup: async () => {
      throw new Error("gh exploded")
    },
  })

  await settle()
  expect(found).toEqual([])
})

test("cancel() prevents a slow answer from landing after teardown", async () => {
  const found: number[] = []
  let release!: (pr: number) => void
  const cancel = startPullRequestLookup({
    targetDir: "/repo",
    onFound: (pr) => found.push(pr),
    hasGh: () => true,
    lookup: () => new Promise<number>((resolve) => (release = resolve)),
  })

  await Bun.sleep(1)
  cancel()
  release(52)
  await settle()

  expect(found).toEqual([])
})

test("cancel() aborts the signal handed to the lookup, so gh is actually killed", async () => {
  let aborted = false
  const cancel = startPullRequestLookup({
    targetDir: "/repo",
    onFound: () => {},
    hasGh: () => true,
    lookup: (_dir, signal) =>
      new Promise<number>(() => {
        signal.addEventListener("abort", () => (aborted = true))
      }),
  })

  await Bun.sleep(1)
  cancel()
  await settle()

  expect(aborted).toBe(true)
})
