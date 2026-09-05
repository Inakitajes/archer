import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import {
  applyCloseEvent,
  buildCloseFollowUpsView,
  closeHelp,
  closeSurface,
  confirmCloseMessage,
  formatCloseEvents,
  formatCloseFollowUps,
  initialCloseChecklistState,
  offerCloseFollowUps,
  parseCloseArgs,
  renderCloseChecklist,
  resolveCloseFollowUps,
  type CloseChecklistState,
  type CloseIO,
  type CloseInteractiveFollowUpState,
  type FollowUpOffers,
} from "../src/feature-close-command"
import type { CloseEvent, ClosePreflightBlocker } from "../src/feature-close"

const dirs: string[] = []

/** Verified-receipt fixture for deletion offers: the tip is its own landing. */
async function evidenceFor(mainDir: string) {
  const tip = await git(mainDir, "rev-parse", "feat/add-widget")
  return { evidence: { landingSha: tip, featureTip: tip } }
}

/** git reports repo paths in the kernel's canonical form (/private/var on macOS). */
async function realPath(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises")
  return realpath(path)
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`)
  return stdout.trim()
}

/** A repo with a worktree on `feat/add-widget`, no upstream, and a clean tree. */
async function makeFixture(): Promise<{ mainDir: string; worktreeDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "convoy-close-cmd-"))
  dirs.push(root)
  const mainDir = join(root, "main")
  const worktreeDir = join(root, "wt")
  await mkdir(mainDir, { recursive: true })
  const user = { GIT_AUTHOR_NAME: "Operator", GIT_AUTHOR_EMAIL: "operator@example.com", GIT_COMMITTER_NAME: "Operator", GIT_COMMITTER_EMAIL: "operator@example.com" }
  await git(mainDir, "init", "-b", "main")
  await git(mainDir, "config", "user.email", "operator@example.com")
  await git(mainDir, "config", "user.name", "Operator")
  await writeFile(join(mainDir, "README.md"), "# repo\n")
  await git(mainDir, "add", ".")
  await git(mainDir, "commit", "-m", "chore: init")
  await git(mainDir, "worktree", "add", "-b", "feat/add-widget", worktreeDir, "main")
  return { mainDir, worktreeDir }
}

/** A stdout capture and a stdin that feeds the next answer the moment a
 * question appears — readline interfaces swallow pre-buffered input, so the
 * answers must arrive after their question is printed. */
function createIO(answers: string[]): CloseIO & { chunks: string[]; input: PassThrough } {
  const chunks: string[] = []
  const input = new PassThrough()
  let next = 0
  const output = {
    write: (text: string) => {
      chunks.push(text)
      if (next < answers.length && text.includes("[y")) input.write(`${answers[next++]!}\n`)
      // After the last buffered answer, EOF: any further ask resolves
      // immediately (the same path a closed terminal takes).
      if (next >= answers.length) setImmediate(() => input.end())
      return true
    },
  }
  return { chunks, input, output }
}

const cleaned = (chunks: string[]) => chunks.join("")

// -- task 3.6: mode selection ---------------------------------------------------

describe("closeSurface", () => {
  test("a TTY gets the checklist; a pipe gets the headless formatter", () => {
    expect(closeSurface(true)).toBe("tty")
    expect(closeSurface(false)).toBe("headless")
  })
})

// -- task 4.1: the help contract ---------------------------------------------------

describe("closeHelp", () => {
  const help = closeHelp()

  test("documents the interactive and headless contracts", () => {
    expect(help).toContain("full-screen TUI")
    expect(help).toContain("inline multiline editor")
    expect(help).toContain("Ctrl+S")
    expect(help).toContain("deferred cleanup")
    expect(help).toContain("fast-forward")
    expect(help).toContain("upstream")
    expect(help).toContain("Headless")
    expect(help).toContain("--resume")
    expect(help).toContain("--message")
  })
})

// -- task 4.1: the close argument surface ---------------------------------------

describe("parseCloseArgs", () => {
  test("empty argv targets the current directory with no options", () => {
    expect(parseCloseArgs([])).toEqual({ targetDir: process.cwd() })
  })

  test("--branch accepts both space and = forms", () => {
    expect(parseCloseArgs(["--branch", "feat/x"])).toMatchObject({ branch: "feat/x" })
    expect(parseCloseArgs(["--branch=feat/y"])).toMatchObject({ branch: "feat/y" })
  })

  test("--change accepts both space and = forms", () => {
    expect(parseCloseArgs(["--change", "add-widget"])).toMatchObject({ changeID: "add-widget" })
    expect(parseCloseArgs(["--change=add-gadget"])).toMatchObject({ changeID: "add-gadget" })
  })

  test("--message carries through verbatim, including an empty override (SC-8)", () => {
    expect(parseCloseArgs(["--message", "feat(cli): exact"])).toMatchObject({ message: "feat(cli): exact" })
    expect(parseCloseArgs(["--message=feat(cli): equals"])).toMatchObject({ message: "feat(cli): equals" })
    // Presence, not truthiness: an empty --message= still reaches runClose as an
    // explicit override and never falls through to the writer (SC-8).
    expect(parseCloseArgs(["--message="])).toMatchObject({ message: "" })
    // The space form treats an empty value as missing — a deliberate CLI
    // convention predating this change (git rejects an empty message anyway).
    expect(() => parseCloseArgs(["--message", ""])).toThrow(/requires a value/)
  })

  test("--resume, --dry-run, and --worktree-dir parse", () => {
    expect(parseCloseArgs(["--resume"])).toMatchObject({ resume: true })
    expect(parseCloseArgs(["--resume", "--dry-run"])).toMatchObject({ resume: true, dryRun: true })
    expect(parseCloseArgs(["--worktree-dir", "/wt"])).toMatchObject({ worktreeDir: "/wt" })
  })

  test("combined flags keep every option", () => {
    expect(parseCloseArgs(["--branch", "feat/close-ui", "--change", "close-ui", "--resume", "--message", "feat(cli): done"])).toEqual({
      targetDir: process.cwd(),
      branch: "feat/close-ui",
      changeID: "close-ui",
      resume: true,
      message: "feat(cli): done",
    })
  })

  test("an unknown argument and a missing value both throw the usage error", () => {
    expect(() => parseCloseArgs(["--bogus"])).toThrow(/usage: convoy close/)
    expect(() => parseCloseArgs(["--branch"])).toThrow(/requires a value/)
    expect(() => parseCloseArgs(["--message"])).toThrow(/requires a value/)
  })
})

// -- task 3.2: the checklist frames ----------------------------------------------

describe("renderCloseChecklist", () => {
  const preflight: CloseEvent = { type: "preflight", summary: "clean tree · 2/2 tasks · no live runs" }

  const stateThrough = (events: CloseEvent[]): CloseChecklistState => events.reduce(applyCloseEvent, initialCloseChecklistState())

  test("a running frame shows the preflight line, checked skips, and the running step", () => {
    const frame = renderCloseChecklist(
      stateThrough([
        preflight,
        { type: "step-skipped", step: "sync", reason: "main is already an ancestor of feat/add-widget" },
        { type: "step-started", step: "archive" },
      ]),
    )
    expect(frame).toEqual([
      "preflight: clean tree · 2/2 tasks · no live runs",
      "  ⊘ sync — skipped: main is already an ancestor of feat/add-widget",
      "  ▸ archive…",
      "  ○ squash-merge",
    ])
  })

  test("a completed fast-forward frame narrates the shape and the close", () => {
    const frame = renderCloseChecklist(
      stateThrough([
        preflight,
        { type: "step-skipped", step: "sync", reason: "main is already an ancestor" },
        { type: "step-completed", step: "archive", detail: "archived add-widget" },
        { type: "step-completed", step: "squash-merge", detail: "landed abcd1234 on main" },
        {
          type: "result",
          result: { changeID: "add-widget", branch: "feat/add-widget", worktreeDir: "/wt", baseRef: "main", disposition: "landed", landing: { sha: "abcd1234" } },
        },
      ]),
    )
    expect(frame.at(-3)).toContain("✓ squash-merge — landed abcd1234 on main")
    expect(frame.at(-2)).toBe("")
    expect(frame.at(-1)).toBe("closed add-widget: feat/add-widget → main")
    expect(frame.some((line) => line.includes("⊘ sync — skipped:"))).toBe(true)
  })

  test("a stopped frame keeps the failed step and its remediation visible", () => {
    const frame = renderCloseChecklist(
      stateThrough([
        preflight,
        { type: "step-started", step: "archive" },
        { type: "step-failed", step: "archive", message: "archive: openspec archive add-widget failed\nstderr detail" },
      ]),
    )
    expect(frame).toContain("  ✗ archive — openspec archive add-widget failed")
    expect(frame.some((line) => line.includes("stopped"))).toBe(false)
    expect(frame.some((line) => line.includes("▸"))).toBe(false)
  })

  test("a preflight failure renders the blockers instead of a checklist", () => {
    const blockers: ClosePreflightBlocker[] = [{ check: "tasks", message: "2 of 3 tasks are incomplete — finish them before closing" }]
    const frame = renderCloseChecklist(stateThrough([{ type: "preflight-failed", blockers }]))
    expect(frame).toEqual(["close preflight failed:", "  2 of 3 tasks are incomplete — finish them before closing"])
  })

  test("a squash phase names the sub-phase on a running squash row", () => {
    const frame = renderCloseChecklist(stateThrough([preflight, { type: "step-started", step: "squash-merge" }, { type: "squash-phase", phase: "composing-message" }]))
    expect(frame).toContain("  ▸ squash-merge — composing the commit message")
    const review = renderCloseChecklist(stateThrough([{ type: "step-started", step: "squash-merge" }, { type: "squash-phase", phase: "awaiting-message-review" }]))
    expect(review).toContain("  ▸ squash-merge — awaiting message review")
    const creating = renderCloseChecklist(stateThrough([{ type: "step-started", step: "squash-merge" }, { type: "squash-phase", phase: "creating-commit" }]))
    expect(creating).toContain("  ▸ squash-merge — creating the one-parent landing commit")
  })

  test("a step-failed squash replaces the phase detail with the remediation", () => {
    const frame = renderCloseChecklist(
      stateThrough([
        { type: "step-started", step: "squash-merge" },
        { type: "squash-phase", phase: "awaiting-message-review" },
        { type: "step-failed", step: "squash-merge", message: "squash-merge: signature declined" },
      ]),
    )
    expect(frame).toContain("  ✗ squash-merge — signature declined")
    expect(frame.some((line) => line.includes("awaiting message review"))).toBe(false)
  })
})

// -- task 3.1: the headless formatter ---------------------------------------------

describe("formatCloseEvents", () => {
  const successEvents: CloseEvent[] = [
    { type: "preflight", summary: "clean tree · 2/2 tasks · no live runs" },
    { type: "step-skipped", step: "sync", reason: "main is already an ancestor of feat/add-widget" },
    { type: "step-completed", step: "archive", detail: "archived add-widget" },
    { type: "step-completed", step: "squash-merge", detail: "landed abcd1234 on main" },
    {
      type: "result",
      result: { changeID: "add-widget", branch: "feat/add-widget", worktreeDir: "/wt", baseRef: "main", disposition: "landed", landing: { sha: "abcd1234" } },
    },
  ]

  test("a successful close prints per-step facts and executable follow-ups in safe order", () => {
    const followUps = {
      push: { remote: "origin", refspec: "main:main", command: "git push origin main:main" },
      worktreeRemoval: "git worktree remove /wt",
      branchDelete: "git branch -d feat/add-widget",
    }
    const text = formatCloseEvents(successEvents, { followUps })
    expect(text).toContain("preflight: clean tree · 2/2 tasks · no live runs")
    expect(text).toContain("sync: skipped — main is already an ancestor of feat/add-widget")
    expect(text).toContain("squash-merge: landed abcd1234 on main")
    // One landing result, named base and commit — never a merge shape (design D8).
    expect(text).toContain("closed add-widget: feat/add-widget → main (one commit abcd1234)")
    expect(text).not.toContain("fast-forward")
    expect(text).not.toContain("merge commit")
    // Push names remote and refspec explicitly, and worktree removal is
    // printed before branch deletion (design D7's safe execution order).
    const pushAt = text.indexOf("git push origin main:main")
    const worktreeAt = text.indexOf("git worktree remove /wt")
    const deleteAt = text.indexOf("git branch -d feat/add-widget")
    expect(pushAt).toBeGreaterThan(-1)
    expect(worktreeAt).toBeGreaterThan(pushAt)
    expect(deleteAt).toBeGreaterThan(worktreeAt)
  })

  test("a missing upstream prints the remediation and never an invalid push command", () => {
    const followUps = {
      pushRemediation: "main has no configured upstream — set one first: git branch --set-upstream-to=<remote>/<branch> main",
      worktreeRemoval: "git worktree remove /wt",
      branchDelete: "git branch -d feat/add-widget",
    }
    const text = formatCloseEvents(successEvents, { followUps })
    expect(text).toContain("push unavailable — main has no configured upstream")
    expect(text).not.toMatch(/git push\s+main\s*$/m)
    expect(text).not.toContain("git push main\n")
  })

  test("a mid-sequence stop prints the failed step and never a close line", () => {
    const text = formatCloseEvents(
      [
        { type: "preflight", summary: "clean tree" },
        { type: "step-started", step: "archive" },
        { type: "step-failed", step: "archive", message: "archive: openspec archive add-widget failed\nthe stderr" },
      ],
      { failure: "archive: openspec archive add-widget failed\nthe stderr" },
    )
    expect(text).toContain("archive: failed — archive: openspec archive add-widget failed")
    expect(text).not.toContain("closed ")
    expect(text).not.toContain("optional follow-ups")
  })

  test("intermediate squash phases never reach the stdout summary", () => {
    const text = formatCloseEvents([
      { type: "preflight", summary: "clean tree" },
      { type: "step-started", step: "squash-merge" },
      { type: "squash-phase", phase: "composing-message" },
      { type: "squash-phase", phase: "awaiting-message-review" },
      { type: "squash-phase", phase: "creating-commit" },
      { type: "step-completed", step: "squash-merge", detail: "landed abcd1234 on main" },
    ])
    expect(text).toContain("squash-merge: landed abcd1234 on main")
    expect(text).not.toContain("composing")
    expect(text).not.toContain("awaiting message review")
  })
})

// -- task 3.4: upstream-aware follow-ups -------------------------------------------

describe("resolveCloseFollowUps", () => {
  test("a configured upstream becomes an explicit remote + refspec push", async () => {
    const fixture = await makeFixture()
    // Configure main's upstream without a real remote: git resolves the
    // symbolic name from the remote config plus the tracking ref alone.
    await git(fixture.mainDir, "config", "remote.origin.url", "/tmp/fake-origin.git")
    await git(fixture.mainDir, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*")
    await git(fixture.mainDir, "config", "branch.main.remote", "origin")
    await git(fixture.mainDir, "config", "branch.main.merge", "refs/heads/main")
    await git(fixture.mainDir, "update-ref", "refs/remotes/origin/main", "HEAD")
    // Without a verified receipt there is no delete command at all — only the
    // remediation (design D7, task 6.3).
    const unevidenced = await resolveCloseFollowUps({ targetDir: fixture.mainDir, baseRef: "main", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir })
    expect(unevidenced.branchDelete).toBeUndefined()
    expect(unevidenced.branchDeleteRemediation).toContain("receipt")
    // With the receipt the deletion is offered as a guarded command that
    // re-checks the exact tip and landing reachability right before `branch -D`.
    const tip = await git(fixture.mainDir, "rev-parse", "feat/add-widget")
    const followUps = await resolveCloseFollowUps({
      targetDir: fixture.mainDir,
      baseRef: "main",
      branch: "feat/add-widget",
      worktreeDir: fixture.worktreeDir,
      evidence: { landingSha: tip, featureTip: tip },
    })
    // The printed commands carry git -C <main-repo> and only quote unsafe paths,
    // so they stay executable from inside the feature worktree (SC-2).
    const main = await realPath(fixture.mainDir)
    expect(followUps.push).toEqual({ remote: "origin", refspec: "main:main", command: `git -C ${main} push origin main:main` })
    expect(followUps.pushRemediation).toBeUndefined()
    expect(followUps.worktreeRemoval).toBe(`git -C ${main} worktree remove ${fixture.worktreeDir}`)
    expect(followUps.branchDelete).toBe(
      `git -C ${main} rev-parse --verify refs/heads/feat/add-widget | grep -qx ${tip} && ` +
      `git -C ${main} merge-base --is-ancestor ${tip} main && ` +
      `git -C ${main} branch -D feat/add-widget`,
    )
  })

  test("a feature tip that moved past the landing withdraws the deletion command", async () => {
    const fixture = await makeFixture()
    const tip = await git(fixture.mainDir, "rev-parse", "feat/add-widget")
    await git(fixture.worktreeDir, "commit", "--allow-empty", "-m", "feat: new work after the landing")
    const followUps = await resolveCloseFollowUps({
      targetDir: fixture.mainDir,
      baseRef: "main",
      branch: "feat/add-widget",
      worktreeDir: fixture.worktreeDir,
      evidence: { landingSha: tip, featureTip: tip },
    })
    expect(followUps.branchDelete).toBeUndefined()
    expect(followUps.branchDeleteRemediation).toContain("moved past the landed state")
  })

  test("a missing upstream yields the remediation and no push", async () => {
    const fixture = await makeFixture()
    const followUps = await resolveCloseFollowUps({ targetDir: fixture.mainDir, baseRef: "main", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir })
    expect(followUps.push).toBeUndefined()
    expect(followUps.pushRemediation).toContain("no configured upstream")
    expect(followUps.pushRemediation).toContain("branch --set-upstream-to=")
  })

  test("a worktree that is the main checkout offers no removal", async () => {
    const fixture = await makeFixture()
    const followUps = await resolveCloseFollowUps({ targetDir: fixture.mainDir, baseRef: "main", branch: "main", worktreeDir: fixture.mainDir })
    expect(followUps.worktreeRemoval).toBeUndefined()
  })

  test("formatCloseFollowUps keeps push, worktree removal, then branch deletion in order", () => {
    const lines = formatCloseFollowUps({
      push: { remote: "origin", refspec: "main:main", command: "git push origin main:main" },
      worktreeRemoval: "git worktree remove /wt",
      branchDelete: "git branch -d feat/x",
    })
    const at = (needle: string) => lines.findIndex((line) => line.includes(needle))
    expect(at("git push origin main:main")).toBeGreaterThan(-1)
    expect(at("git worktree remove /wt")).toBeGreaterThan(at("git push origin main:main"))
    expect(at("git branch -d feat/x")).toBeGreaterThan(at("git worktree remove /wt"))
  })
})

// -- task 3.3: the message gate key-driver ------------------------------------------

describe("confirmCloseMessage", () => {
  const proposal = { message: "feat(cli): improve the close flow\n\n- change add-widget", source: "model" as const }

  test("accept returns the proposal unchanged and no commit ran before it", async () => {
    const io = createIO(["y"])
    const result = await confirmCloseMessage(proposal, { ...io })
    expect(result).toBe(proposal.message)
    expect(cleaned(io.chunks)).toContain("feat(cli): improve the close flow")
  })

  test("a declined prompt returns undefined", async () => {
    const io = createIO(["N"])
    const result = await confirmCloseMessage(proposal, { ...io })
    expect(result).toBeUndefined()
  })

  test("no external editor participates: an 'e' answer declines without launching $EDITOR (design D4)", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "convoy-close-editor-"))
    dirs.push(binDir)
    const editor = join(binDir, "would-run-editor")
    await writeFile(editor, "#!/bin/sh\nprintf 'editor must never run for close' > \"$1\"\nexit 0\n")
    await chmod(editor, 0o755)
    const saved = process.env.GIT_EDITOR
    process.env.GIT_EDITOR = editor
    try {
      // The prompt is accept-or-decline now; editing lives in the Close TUI.
      const io = createIO(["e"])
      const result = await confirmCloseMessage(proposal, { ...io })
      expect(result).toBeUndefined()
    } finally {
      if (saved === undefined) delete process.env.GIT_EDITOR
      else process.env.GIT_EDITOR = saved
    }
  })
})

// -- task 3.4: the cleanup dependency graph ------------------------------------------

// -- task 3.1: actions, same-session dependencies, and deferred cleanup ------------

describe("buildCloseFollowUpsView", () => {
  const offersFor = (fixture: { mainDir: string; worktreeDir: string }): FollowUpOffers => ({
    push: { remote: "origin", refspec: "main:main", command: `git -C ${fixture.mainDir} push origin main:main` },
    worktreeRemoval: `git -C ${fixture.mainDir} worktree remove '${fixture.worktreeDir}'`,
    branchDelete: `git -C ${fixture.mainDir} branch -d feat/add-widget`,
    baseRef: "main",
    branch: "feat/add-widget",
    worktreeDir: fixture.worktreeDir,
    targetDir: fixture.mainDir,
  })

  test("launched outside the worktree: push and removal are actions, branch deletion is blocked (same-session dependency)", async () => {
    const fixture = await makeFixture()
    const view = await buildCloseFollowUpsView({ followUps: offersFor(fixture), cwdInside: false })
    expect(view.deferred).toBeUndefined()
    expect(view.actions.map((action) => `${action.id}:${action.status}`)).toEqual([
      "push:available",
      "worktree:available",
      "branch:blocked",
    ])
    // The blocked row keeps its explicit command for later use.
    expect(view.actions[2]!.command).toContain("branch -d feat/add-widget")
  })

  test("launched inside the worktree: only push is an action; cleanup is ordered deferred guidance naming the shell location", async () => {
    const fixture = await makeFixture()
    const view = await buildCloseFollowUpsView({ followUps: offersFor(fixture), cwdInside: true })
    expect(view.actions.map((action) => action.id)).toEqual(["push"])
    expect(view.deferred).toBeDefined()
    expect(view.deferred!.reason).toContain("launched from inside")
    expect(view.deferred!.steps.map((step) => step.command)).toEqual([
      `git -C ${fixture.mainDir} worktree remove '${fixture.worktreeDir}'`,
      `git -C ${fixture.mainDir} branch -d feat/add-widget`,
    ])
  })

  test("a missing upstream becomes a notice with the setup step, never a push action", async () => {
    const fixture = await makeFixture()
    const offers = { ...offersFor(fixture), push: undefined, pushRemediation: "main has no configured upstream — set one first: git branch --set-upstream-to=<remote>/<branch> main" }
    const view = await buildCloseFollowUpsView({ followUps: offers, cwdInside: false })
    expect(view.actions.find((action) => action.id === "push")).toBeUndefined()
    expect(view.notice).toContain("no configured upstream")
  })

  test("a failed removal keeps the worktree action retryable; branch deletion stays blocked", async () => {
    const fixture = await makeFixture()
    const failed: CloseInteractiveFollowUpState = { worktree: { status: "failed", error: "worktree remove: permission denied" } }
    const view = await buildCloseFollowUpsView({ followUps: offersFor(fixture), cwdInside: false, state: failed })
    const worktree = view.actions.find((action) => action.id === "worktree")!
    expect(worktree.status).toBe("failed")
    expect(worktree.error).toContain("permission denied")
    expect(view.actions.find((action) => action.id === "branch")!.status).toBe("blocked")
  })

  test("branch deletion unlocks once the worktree is gone, with the removal action omitted", async () => {
    const fixture = await makeFixture()
    const gone = { ...fixture, worktreeDir: join(fixture.mainDir, "no-such-wt") }
    const view = await buildCloseFollowUpsView({
      followUps: { ...offersFor(gone), worktreeRemoval: undefined },
      cwdInside: false,
      state: { worktree: { status: "completed" } },
    })
    expect(view.actions.find((action) => action.id === "worktree")!.status).toBe("completed")
    expect(view.actions.find((action) => action.id === "branch")!.status).toBe("available")
  })
})

describe("offerCloseFollowUps", () => {
  test("declined worktree removal keeps branch deletion unavailable and prints both commands", async () => {
    const fixture = await makeFixture()
    const io = createIO(["n"])
    await offerCloseFollowUps(
      {
        branchDelete: "git branch -D feat/add-widget",
        ...(await evidenceFor(fixture.mainDir)),
        worktreeRemoval: `git worktree remove ${fixture.worktreeDir}`,
        baseRef: "main",
        branch: "feat/add-widget",
        worktreeDir: fixture.worktreeDir,
        targetDir: fixture.mainDir,
      },
      io,
    )
    const text = cleaned(io.chunks)
    expect(text).toContain(`next: git worktree remove ${fixture.worktreeDir}`)
    expect(text).toContain("next (after the worktree is removed): git branch -D feat/add-widget")
    // The branch still exists and still has its worktree.
    expect((await stat(fixture.worktreeDir)).isDirectory()).toBe(true)
    expect(await git(fixture.mainDir, "rev-parse", "--verify", "feat/add-widget")).toBeTruthy()
  })

  test("an accepted worktree removal is what enables the branch deletion offer", async () => {
    const fixture = await makeFixture()
    const io = createIO(["y", "n"])
    await offerCloseFollowUps(
      {
        branchDelete: "git branch -D feat/add-widget",
        ...(await evidenceFor(fixture.mainDir)),
        worktreeRemoval: `git worktree remove ${fixture.worktreeDir}`,
        baseRef: "main",
        branch: "feat/add-widget",
        worktreeDir: fixture.worktreeDir,
        targetDir: fixture.mainDir,
      },
      io,
    )
    const text = cleaned(io.chunks)
    expect(text).toContain("worktree removed")
    // The worktree is gone, so the branch-delete offer appeared (declined here).
    await expect(stat(fixture.worktreeDir)).rejects.toThrow()
    expect(text).toContain("next: git branch -D feat/add-widget")
    expect(await git(fixture.mainDir, "rev-parse", "--verify", "feat/add-widget")).toBeTruthy()
  })

  test("branch deletion runs only after the worktree removal succeeded", async () => {
    const fixture = await makeFixture()
    // Simulate the landing: the feature tip reaches main (a fast-forward of
    // the base onto the one candidate), so the evidence gate can pass.
    await git(fixture.mainDir, "merge", "--ff-only", "feat/add-widget")
    const io = createIO(["y", "y"])
    await offerCloseFollowUps(
      {
        branchDelete: "git branch -D feat/add-widget",
        ...(await evidenceFor(fixture.mainDir)),
        worktreeRemoval: `git worktree remove ${fixture.worktreeDir}`,
        baseRef: "main",
        branch: "feat/add-widget",
        worktreeDir: fixture.worktreeDir,
        targetDir: fixture.mainDir,
      },
      io,
    )
    expect(cleaned(io.chunks)).toContain("branch feat/add-widget deleted")
    await expect(stat(fixture.worktreeDir)).rejects.toThrow()
    await expect(git(fixture.mainDir, "rev-parse", "--verify", "feat/add-widget")).rejects.toThrow()
  })

  test("an already-removed worktree makes branch deletion immediately available (SC-9)", async () => {
    const fixture = await makeFixture()
    // Remove the worktree out from under close (by hand / a prior run), so
    // resolveCloseFollowUps returns no removal command.
    await git(fixture.mainDir, "worktree", "remove", fixture.worktreeDir)
    await expect(stat(fixture.worktreeDir)).rejects.toThrow()
    const io = createIO([])
    await offerCloseFollowUps(
      {
        branchDelete: "git branch -D feat/add-widget",
        ...(await evidenceFor(fixture.mainDir)),
        baseRef: "main",
        branch: "feat/add-widget",
        worktreeDir: fixture.worktreeDir,
        targetDir: fixture.mainDir,
      },
      io,
    )
    const text = cleaned(io.chunks)
    // The branch is deletable now — the immediate command, not a wait.
    expect(text).toContain("next: git branch -D feat/add-widget")
    expect(text).not.toContain("after the worktree is removed")
  })
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})
