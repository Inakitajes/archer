import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  commitSidecarSchemaVersion,
  composeStepCommitDescription,
  descriptionFromStagedEvidence,
  isGenericReportLabel,
  loadCommitSidecar,
  maxStepDetailLength,
  renderStepCommitMessage,
  sidecarPathFor,
  stepCommitMessageFactory,
  subjectFromReport,
  validateCommitDescription,
  writeCommitSidecar,
} from "../src/step-commit"
import { parseStagedEvidence, stagedChangeEvidence } from "../src/git"
import type { Workspace } from "../src/workspace"

const runID = "20260101-120000-abcd"

describe("validateCommitDescription", () => {
  test("accepts a subject with or without details and trims both", () => {
    expect(validateCommitDescription({ subject: " preserve report sessions " })).toEqual({
      commit: { subject: "preserve report sessions" },
    })
    expect(validateCommitDescription({ subject: "s", details: [" a ", "b"] })).toEqual({
      commit: { subject: "s", details: ["a", "b"] },
    })
  })

  const errorOf = (result: ReturnType<typeof validateCommitDescription>) => ("error" in result ? result.error : "")

  test("rejects empty, multiline, over-count, and oversized input", () => {
    expect(errorOf(validateCommitDescription({ subject: "   " }))).toContain("non-empty")
    expect(errorOf(validateCommitDescription({ subject: "two\nlines" }))).toContain("single line")
    expect(errorOf(validateCommitDescription({ subject: "ok", details: ["1", "2", "3", "4"] }))).toContain("at most 3")
    expect(errorOf(validateCommitDescription({ subject: "ok", details: ["x\ny"] }))).toContain("single line")
    expect(errorOf(validateCommitDescription({ subject: "ok", details: [""] }))).toContain("non-empty")
    expect(errorOf(validateCommitDescription({ subject: "x".repeat(301) }))).toContain("300")
    expect(errorOf(validateCommitDescription("nope"))).toContain("must be an object")
    expect(errorOf(validateCommitDescription({ subject: 42 }))).toContain("must be a string")
  })
})

describe("renderStepCommitMessage", () => {
  const base = { runID, step: "implementer" }

  test("renders subject, bullet details, and exactly one Convoy-Run trailer", () => {
    const message = renderStepCommitMessage({
      ...base,
      description: {
        subject: "preserve report sessions across human gates",
        details: ["Keep report and advisor handles alive during manual iteration", "Cover reopened OpenCode sessions"],
      },
    })
    expect(message).toBe(
      [
        "convoy(implementer): preserve report sessions across human gates",
        "",
        "- Keep report and advisor handles alive during manual iteration",
        "- Cover reopened OpenCode sessions",
        "",
        "Convoy-Run: 20260101-120000-abcd",
      ].join("\n"),
    )
  })

  test("caps the complete subject line at 72 characters on a word boundary", () => {
    const message = renderStepCommitMessage({
      ...base,
      description: { subject: "implement a very long feature that describes everything this change does and then some more", details: [] },
    })
    const subject = message.split("\n")[0]!
    expect(subject.length).toBeLessThanOrEqual(72)
    expect(subject.startsWith("convoy(implementer): ")).toBe(true)
    expect(subject.endsWith(" more")).toBe(false)
    expect(subject.endsWith(" and")).toBe(false)
  })

  test("sanitizes heading markers, control bytes, line breaks, and repeated whitespace", () => {
    const message = renderStepCommitMessage({
      ...base,
      description: { subject: "# Fix\x1b[31m the\u0000 parser\n\nfile read\u0007 crashes", details: [] },
    })
    const subject = message.split("\n")[0]!
    expect(subject).toBe("convoy(implementer): Fix the parser file read crashes")
    expect(subject).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/)
  })

  test("bounds details to three lines of at most 120 characters", () => {
    const message = renderStepCommitMessage({
      ...base,
      description: {
        subject: "update",
        details: Array.from({ length: 5 }, (_, i) => `detail ${i} ${"x".repeat(maxStepDetailLength)}`),
      },
    })
    const details = message.split("\n").filter((line) => line.startsWith("- "))
    expect(details.length).toBe(3)
    for (const detail of details) expect(detail.length).toBeLessThanOrEqual(maxStepDetailLength + 2)
  })

  test("a detail shaped as a Git trailer is normalized away, leaving one authoritative trailer", () => {
    const message = renderStepCommitMessage({
      ...base,
      description: { subject: "update", details: ["Convoy-Run: 19990101-000000-fake"] },
    })
    const trailers = message.split("\n").filter((line) => /^Convoy-Run:/.test(line))
    expect(trailers).toEqual([`Convoy-Run: ${runID}`])
    expect(message).not.toContain("19990101")
  })

  test("rejects a malformed run ID — the trailer value is never agent-chosen", () => {
    expect(() => renderStepCommitMessage({ runID: "not-a-run-id", step: "x", description: { subject: "s", details: [] } })).toThrow(/invalid run id/)
  })

  test("an empty subject still yields a valid bounded commit", () => {
    const message = renderStepCommitMessage({ ...base, description: { subject: "   ", details: [] } })
    expect(message.split("\n")[0]).toBe("convoy(implementer): update")
    expect(message).toContain(`Convoy-Run: ${runID}`)
  })
})

describe("isGenericReportLabel / subjectFromReport", () => {
  test("rejects the role/process labels exactly", () => {
    for (const label of ["Implementer report", "Test report", "Tests report", "Security audit", "Adversarial review", "Design polish", "report"]) {
      expect(isGenericReportLabel(label)).toBe(true)
      expect(subjectFromReport(`# ${label}\n`)).toBeUndefined()
    }
  })

  test("rejects the phase's own name with and without a report suffix", () => {
    expect(isGenericReportLabel("Implementer report", "implementer")).toBe(true)
    expect(isGenericReportLabel("implementer", "implementer")).toBe(true)
    expect(isGenericReportLabel("Implementer report", "tests")).toBe(true) // role word, not the phase
  })

  test("a label followed by a concrete suffix remains useful", () => {
    expect(isGenericReportLabel("Implementer report: preserved sessions across gates")).toBe(false)
    expect(subjectFromReport("# Implementer report: preserved sessions across gates\n")).toBe(
      "Implementer report: preserved sessions across gates",
    )
  })

  test("a specific repository outcome is useful", () => {
    expect(subjectFromReport("# preserve report sessions across human gates\n\nBody.")).toBe("preserve report sessions across human gates")
  })

  test("an unreadable or empty report has no subject", () => {
    expect(subjectFromReport("")).toBeUndefined()
    expect(subjectFromReport("\n \n")).toBeUndefined()
  })
})

describe("descriptionFromStagedEvidence", () => {
  test("one changed path names it", () => {
    expect(descriptionFromStagedEvidence({ paths: ["src/foo.ts"], statuses: ["M"] })).toEqual({
      subject: "update src/foo.ts",
      details: ["M src/foo.ts"],
    })
  })

  test("several paths use their common directory when one exists", () => {
    const evidence = { paths: ["src/cli/a.ts", "src/cli/b.ts", "src/cli/deep/c.ts"], statuses: ["M", "A", "A"] }
    expect(descriptionFromStagedEvidence(evidence)).toMatchObject({ subject: "update src/cli/" })
    expect(descriptionFromStagedEvidence(evidence)!.details).toHaveLength(3)
  })

  test("paths without a shared area fall back to the file count", () => {
    expect(descriptionFromStagedEvidence({ paths: ["a.ts", "b/c.md", "d/e/f.txt"], statuses: ["M", "M", "A"] })).toMatchObject({
      subject: "update 3 files",
    })
  })

  test("no evidence produces nothing", () => {
    expect(descriptionFromStagedEvidence({ paths: [], statuses: [] })).toBeUndefined()
  })
})

describe("composeStepCommitDescription", () => {
  const evidence = { paths: ["src/foo.ts", "src/bar.ts"], statuses: ["M", "M"] }

  test("structured data wins over everything", () => {
    const description = composeStepCommitDescription(
      { runID, step: "implementer", mode: "phase", report: "# real outcome", structured: { subject: "structured subject", details: ["d"] } },
      evidence,
    )
    expect(description).toEqual({ subject: "structured subject", details: ["d"] })
  })

  test("a useful report heading becomes the subject with staged evidence as details", () => {
    const description = composeStepCommitDescription(
      { runID, step: "implementer", mode: "phase", report: "# preserve report sessions\n" },
      evidence,
    )
    expect(description.subject).toBe("preserve report sessions")
    expect(description.details).toEqual(["M src/foo.ts", "M src/bar.ts"])
  })

  test("a generic report heading falls through to the staged evidence", () => {
    const description = composeStepCommitDescription(
      { runID, step: "implementer", mode: "phase", phaseName: "implementer", report: "# Implementer report\n" },
      evidence,
    )
    expect(description.subject).toBe("update src/")
  })

  test("recovery without stronger sources states what happened honestly", () => {
    expect(composeStepCommitDescription({ runID, step: "implementer", mode: "recovery" })).toEqual({
      subject: "recover interrupted phase changes",
    })
  })

  test("human iterations describe the changed paths and fall back only when git cannot help", () => {
    expect(composeStepCommitDescription({ runID, step: "human-review", mode: "human" }, evidence).subject).toBe("update src/")
    expect(composeStepCommitDescription({ runID, step: "human-review", mode: "human" }).subject).toBe("apply manual changes")
  })
})

describe("report sidecar", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function reportFixture() {
    const dir = await mkdtemp(join(tmpdir(), "convoy-step-commit-"))
    dirs.push(dir)
    const reportPath = join(dir, "reports", "implementer.md")
    await mkdir(join(dir, "reports"), { recursive: true })
    await writeFile(reportPath, "# preserve report sessions\n")
    return { dir, reportPath }
  }

  test("writes an envelope beside the report and loads a hash-matched description", async () => {
    const { reportPath } = await reportFixture()
    await writeCommitSidecar(reportPath, { subject: "preserve report sessions", details: ["one detail"] })

    const sidecar = JSON.parse(await readFile(sidecarPathFor(reportPath), "utf8"))
    expect(sidecar.schemaVersion).toBe(commitSidecarSchemaVersion)
    expect(sidecar.reportSha256).toMatch(/^[0-9a-f]{64}$/)

    expect(await loadCommitSidecar(reportPath)).toEqual({ subject: "preserve report sessions", details: ["one detail"] })
  })

  test("a report revised after the sidecar invalidates the description", async () => {
    const { reportPath } = await reportFixture()
    await writeCommitSidecar(reportPath, { subject: "stale" })
    await writeFile(reportPath, "# revised\n")
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
  })

  test("a corrected write without commit metadata clears the previous description", async () => {
    const { reportPath } = await reportFixture()
    await writeCommitSidecar(reportPath, { subject: "first" })
    await writeFile(reportPath, "# first\n")
    await writeCommitSidecar(reportPath) // same content, no commit this time
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
    expect(JSON.parse(await readFile(sidecarPathFor(reportPath), "utf8")).commit).toBeUndefined()
  })

  test("missing, malformed, and schema-mismatched sidecars are ignored", async () => {
    const { dir, reportPath } = await reportFixture()
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
    await writeFile(sidecarPathFor(reportPath), "{not json")
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
    await writeFile(sidecarPathFor(reportPath), JSON.stringify({ schemaVersion: 99, reportSha256: "x", commit: { subject: "s" } }))
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
    await writeFile(sidecarPathFor(reportPath), "[]")
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
    void dir
  })

  test("a sidecar commit with malformed fields is rejected even when the hash matches", async () => {
    const { reportPath } = await reportFixture()
    const sha = createHash("sha256").update(await readFile(reportPath)).digest("hex")
    await writeFile(sidecarPathFor(reportPath), JSON.stringify({ schemaVersion: 1, reportSha256: sha, commit: { subject: "" } }))
    expect(await loadCommitSidecar(reportPath)).toBeUndefined()
  })
})

describe("stepCommitMessageFactory", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function factoryFixture(options: { report?: string } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "convoy-step-commit-factory-"))
    dirs.push(dir)
    const workspace: Workspace = { dir, runID }
    const reportPath = options.report === undefined ? undefined : join(dir, "reports", "implementer.md")
    if (reportPath && options.report !== undefined) {
      await mkdir(join(dir, "reports"), { recursive: true })
      await writeFile(reportPath, options.report)
    }
    return { workspace, reportPath }
  }

  test("prefers the hash-matched sidecar, then the report, then the evidence", async () => {
    const { workspace, reportPath } = await factoryFixture({ report: "structured wins\n" })
    await writeCommitSidecar(reportPath!, { subject: "structured subject" })
    const withSidecar = await stepCommitMessageFactory({ workspace, step: "implementer", mode: "phase", reportPath })({ paths: ["a.ts"], statuses: ["M"] })
    expect(withSidecar).toContain("convoy(implementer): structured subject")

    // A report whose hash no longer matches the sidecar degrades to the report text.
    await writeFile(reportPath!, "report outcome\n")
    const reportOnly = await stepCommitMessageFactory({ workspace, step: "implementer", mode: "phase", reportPath })({ paths: [], statuses: [] })
    expect(reportOnly).toContain("convoy(implementer): report outcome")

    const evidenceOnly = await stepCommitMessageFactory({ workspace, step: "implementer", mode: "human" })({ paths: ["src/x.ts"], statuses: ["A"] })
    expect(evidenceOnly).toContain("convoy(implementer): update src/x.ts")
    expect(evidenceOnly).toContain(`Convoy-Run: ${runID}`)
  })

  test("without a report or evidence, the mode's honest fallback renders", async () => {
    const { workspace } = await factoryFixture()
    const message = await stepCommitMessageFactory({ workspace, step: "human-review", mode: "human" })({ paths: [], statuses: [] })
    expect(message).toBe(`convoy(human-review): apply manual changes\n\nConvoy-Run: ${runID}`)
  })
})

describe("staged evidence parsing", () => {
  const dirs: string[] = []
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("parses NUL-delimited name-status records including the trailing NUL", () => {
    expect(parseStagedEvidence("M\0src/a.ts\0A\0src/b.ts\0")).toEqual({
      paths: ["src/a.ts", "src/b.ts"],
      statuses: ["M", "A"],
    })
  })

  test("a rename contributes its new path (original first, new second)", () => {
    expect(parseStagedEvidence("R100\0old.txt\0new.txt\0")).toEqual({
      paths: ["new.txt"],
      statuses: ["R100"],
    })
  })

  test("reads real staged evidence from a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "convoy-evidence-repo-"))
    dirs.push(dir)
    const git = async (args: string[]) => {
      const proc = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" })
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      if (code !== 0) throw new Error(`git ${args.join(" ")} failed`)
      return out
    }
    await git(["init", "-q"])
    await git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "init"])
    await writeFile(join(dir, "one.txt"), "1\n")
    await writeFile(join(dir, "two.txt"), "2\n")
    await git(["add", "-A"])
    const evidence = await stagedChangeEvidence(dir)
    expect(evidence.paths.sort()).toEqual(["one.txt", "two.txt"])
    expect(evidence.statuses).toEqual(["A", "A"])
  })
})
