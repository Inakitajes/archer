import { describe, expect, test } from "bun:test"

import { assessLifecycle, closeStartPrerequisites, type LifecycleObservations } from "../src/feature-lifecycle/assessment"
import type { FeatureRecord } from "../src/feature-lifecycle/records"

/**
 * Task 2.1: the pure assessment — orthogonal facts, unknown/unreadable
 * evidence modeled explicitly, summary precedence (recovery/unknown favored
 * over claimed readiness), and "ready to close" derived from prerequisites,
 * never from task counts alone.
 */

const feature: FeatureRecord = {
  schemaVersion: 1,
  featureId: "aaaaaaaa-0000-4000-8000-000000000001",
  repositoryId: "bbbbbbbb-0000-4000-8000-000000000001",
  displayName: "add-widget",
  associationRevision: 1,
  contracts: [{ changeId: "add-widget", kind: "active", sourcePath: "openspec/changes/add-widget", provenance: "adopt", selectedAtRevision: 1 }],
  intendedBaseRef: "main",
  context: { branch: "feat/add-widget", checkoutPath: "/wt" },
  runIds: [],
  closeAttemptIds: [],
  history: [],
  createdAt: 1,
  updatedAt: 1,
}

function baseObservations(overrides: Partial<LifecycleObservations> = {}): LifecycleObservations {
  return {
    feature,
    context: { verification: "verified", branch: "feat/add-widget", checkoutPath: "/wt" },
    contracts: [{ changeId: "add-widget", state: "active", tasks: { done: 3, total: 11 } }],
    execution: { kind: "known", liveRunIds: [], totalRuns: 0 },
    integration: "pending",
    publication: { kind: "known", published: false },
    cleanup: { kind: "known", worktreePresent: false, branchPresent: false },
    ...overrides,
  }
}

describe("pure lifecycle assessment (task 2.1)", () => {
  test("no feature → association needed with adopt/spin offered", () => {
    const assessment = assessLifecycle(baseObservations({ feature: undefined }))
    expect(assessment.summary).toBe("Association needed")
    expect(assessment.closeStartPrerequisitesPass).toBe(false)
    expect(assessment.actions.map((action) => action.id)).toContain("adopt")
    const adopt = assessment.actions.find((action) => action.id === "adopt")!
    expect(adopt.enabled).toBe(true)
  })

  test("complete tasks with a live run are 'In implementation', never ready to close", () => {
    const assessment = assessLifecycle(
      baseObservations({
        contracts: [{ changeId: "add-widget", state: "active", tasks: { done: 11, total: 11 } }],
        execution: { kind: "known", liveRunIds: ["run-1"], totalRuns: 2 },
      }),
    )
    expect(assessment.summary).toBe("In implementation")
    expect(assessment.closeStartPrerequisitesPass).toBe(false)
    expect(assessment.liveRuns).toBe(1)
    const close = assessment.actions.find((action) => action.id === "close")!
    expect(close.enabled).toBe(false)
    expect(close.blockers.join(" ")).toMatch(/live run/)
  })

  test("ready to close requires verified context, complete tasks, readable contracts, no live runs", () => {
    const assessment = assessLifecycle(
      baseObservations({ contracts: [{ changeId: "add-widget", state: "active", tasks: { done: 11, total: 11 } }] }),
    )
    expect(assessment.summary).toBe("Ready to close")
    expect(assessment.closeStartPrerequisitesPass).toBe(true)
    expect(assessment.actions.find((action) => action.id === "close")!.enabled).toBe(true)
  })

  test("unknown task evidence blocks readiness instead of counting as zero (D5)", () => {
    const assessment = assessLifecycle(
      baseObservations({ contracts: [{ changeId: "add-widget", state: "active", tasks: "unknown" }] }),
    )
    expect(assessment.summary).toBe("In implementation")
    expect(assessment.closeStartPrerequisitesPass).toBe(false)
    expect(assessment.blockers.join(" ")).toMatch(/task completion unknown/)
  })

  test("unreadable run state is unknown, never an empty live-run set (task 2.2)", () => {
    const assessment = assessLifecycle(
      baseObservations({
        contracts: [{ changeId: "add-widget", state: "active", tasks: { done: 11, total: 11 } }],
        execution: { kind: "unknown", reason: "run history unreadable" },
      }),
    )
    expect(assessment.closeStartPrerequisitesPass).toBe(false)
    expect(assessment.blockers.join(" ")).toMatch(/live-run state unknown/)
  })

  test("verified-archived contracts without integration read 'archive verified', with review still discoverable", () => {
    const assessment = assessLifecycle(
      baseObservations({
        contracts: [{ changeId: "add-widget", state: "verified-archived", tasks: { done: 11, total: 11 } }],
      }),
    )
    expect(assessment.summary).toBe("Implementation complete · archive verified")
    expect(assessment.closeStartPrerequisitesPass).toBe(false)
    expect(assessment.actions.find((action) => action.id === "close")!.applicable).toBe(true)
  })

  test("verified integration reports cleanup pending or completed, with push gated on upstream", () => {
    const pending = assessLifecycle(
      baseObservations({
        integration: "verified",
        contracts: [{ changeId: "add-widget", state: "verified-archived" }],
        cleanup: { kind: "known", worktreePresent: true, branchPresent: true },
        publication: { kind: "known", upstream: "origin/main", published: true },
      }),
    )
    expect(pending.summary).toBe("Integrated locally · cleanup pending")
    expect(pending.actions.find((action) => action.id === "push")!.enabled).toBe(true)

    const noUpstream = assessLifecycle(
      baseObservations({
        integration: "verified",
        contracts: [{ changeId: "add-widget", state: "verified-archived" }],
        cleanup: { kind: "known", worktreePresent: true, branchPresent: true },
        publication: { kind: "known", published: false },
      }),
    )
    const push = noUpstream.actions.find((action) => action.id === "push")!
    expect(push.enabled).toBe(false)
    expect(push.blockers.join(" ")).toMatch(/upstream/)
  })

  test("probable integration stays probabilistic and offers archive-on-main (D5/D8)", () => {
    const assessment = assessLifecycle(
      baseObservations({ integration: "probable" }),
    )
    expect(assessment.summary).toBe("Probably merged")
    expect(assessment.actions.find((action) => action.id === "archive-on-main")!.applicable).toBe(true)
  })

  test("missing contract sources are surfaced with their reasons", () => {
    const assessment = assessLifecycle(
      baseObservations({
        contracts: [{ changeId: "add-widget", state: "missing", reason: "directory absent" }],
      }),
    )
    expect(assessment.summary).toBe("Contract sources need review")
    expect(assessment.blockers.join(" ")).toMatch(/directory absent/)
  })

  test("closeStartPrerequisites separates per-contract task deficits", () => {
    const prerequisites = closeStartPrerequisites(
      baseObservations({
        contracts: [
          { changeId: "one", state: "active", tasks: { done: 8, total: 11 } },
          { changeId: "two", state: "active", tasks: { done: 2, total: 2 } },
        ],
      }),
    )
    expect(prerequisites.pass).toBe(false)
    expect(prerequisites.blockers.join(" ")).toMatch(/contract one: 3 of 11 tasks incomplete/)
    expect(prerequisites.blockers.join(" ")).not.toMatch(/contract two/)
  })

  test("stale integration evidence wins precedence over readiness (D8)", () => {
    const assessment = assessLifecycle(baseObservations({ integration: "stale" }))
    expect(assessment.summary).toBe("Integration evidence stale")
    expect(assessment.closeStartPrerequisitesPass).toBe(false)
  })

  test("blocked close actions remain applicable/inspectable with remediation (D6)", () => {
    const assessment = assessLifecycle(baseObservations({ contracts: [{ changeId: "add-widget", state: "active", tasks: { done: 3, total: 11 } }] }))
    const close = assessment.actions.find((action) => action.id === "close")!
    expect(close.applicable).toBe(true)
    expect(close.enabled).toBe(false)
    expect(close.remediation.length).toBeGreaterThan(0)
  })
})
