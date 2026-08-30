import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough } from "node:stream"

import {
  applyCloseEvent,
  closeHelp,
  closeSurface,
  confirmCloseMessage,
  formatCloseEvents,
  formatCloseFollowUps,
  initialCloseChecklistState,
  offerCloseFollowUps,
  renderCloseChecklist,
  resolveCloseFollowUps,
  type CloseChecklistState,
  type CloseIO,
} from "../src/feature-close-command"
import type { CloseEvent, ClosePreflightBlocker } from "../src/feature-close"

const dirs: string[] = []

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
    expect(help).toContain("confirm, edit")
    expect(help).toContain("fast-forward")
    expect(help).toContain("upstream")
    expect(help).toContain("Headless")
    expect(help).toContain("--resume")
    expect(help).toContain("--message")
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
      "  ○ squash",
      "  ○ merge",
    ])
  })

  test("a completed fast-forward frame narrates the shape and the close", () => {
    const frame = renderCloseChecklist(
      stateThrough([
        preflight,
        { type: "step-skipped", step: "sync", reason: "main is already an ancestor" },
        { type: "step-completed", step: "archive", detail: "archived add-widget" },
        { type: "step-completed", step: "squash", detail: "2 commits → abcd1234" },
        { type: "merge-shape", shape: "fast-forward" },
        { type: "step-completed", step: "merge", detail: "merged (fast-forward)" },
        {
          type: "result",
          result: { changeID: "add-widget", branch: "feat/add-widget", worktreeDir: "/wt", baseRef: "main", squashed: { sha: "abcd1234", replaced: 2 }, merged: true, mergeShape: "fast-forward" },
        },
      ]),
    )
    expect(frame.at(-3)).toContain("✓ merge — merged (fast-forward)")
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
})

// -- task 3.1: the headless formatter ---------------------------------------------

describe("formatCloseEvents", () => {
  const successEvents: CloseEvent[] = [
    { type: "preflight", summary: "clean tree · 2/2 tasks · no live runs" },
    { type: "step-skipped", step: "sync", reason: "main is already an ancestor of feat/add-widget" },
    { type: "step-completed", step: "archive", detail: "archived add-widget" },
    { type: "step-completed", step: "squash", detail: "2 commits → abcd1234" },
    { type: "merge-shape", shape: "fast-forward" },
    { type: "step-completed", step: "merge", detail: "merged (fast-forward)" },
    {
      type: "result",
      result: { changeID: "add-widget", branch: "feat/add-widget", worktreeDir: "/wt", baseRef: "main", merged: true, mergeShape: "fast-forward" },
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
    expect(text).toContain("merge: merged (fast-forward)")
    expect(text).toContain("closed add-widget: feat/add-widget → main")
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
    const followUps = await resolveCloseFollowUps({ targetDir: fixture.mainDir, baseRef: "main", branch: "feat/add-widget", worktreeDir: fixture.worktreeDir })
    // The printed commands carry git -C <main-repo> and only quote unsafe paths,
    // so they stay executable from inside the feature worktree (SC-2).
    const main = await realPath(fixture.mainDir)
    expect(followUps.push).toEqual({ remote: "origin", refspec: "main:main", command: `git -C ${main} push origin main:main` })
    expect(followUps.pushRemediation).toBeUndefined()
    expect(followUps.worktreeRemoval).toBe(`git -C ${main} worktree remove ${fixture.worktreeDir}`)
    expect(followUps.branchDelete).toBe(`git -C ${main} branch -d feat/add-widget`)
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

  test("edit-then-accept lands the edited message", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "convoy-close-editor-"))
    dirs.push(binDir)
    const editor = join(binDir, "replace-editor")
    await writeFile(editor, "#!/bin/sh\nprintf 'edited subject\\n\\n- edited body\\n' > \"$1\"\n")
    await chmod(editor, 0o755)
    const saved = process.env.GIT_EDITOR
    process.env.GIT_EDITOR = editor
    try {
      const io = createIO(["e"])
      const result = await confirmCloseMessage(proposal, { ...io })
      expect(result).toBe("edited subject\n\n- edited body")
    } finally {
      if (saved === undefined) delete process.env.GIT_EDITOR
      else process.env.GIT_EDITOR = saved
    }
  })

  test("an editor cancellation re-asks; a declined prompt returns undefined", async () => {
    const binDir = await mkdtemp(join(tmpdir(), "convoy-close-editor-"))
    dirs.push(binDir)
    const editor = join(binDir, "failing-editor")
    await writeFile(editor, "#!/bin/sh\nexit 1\n")
    await chmod(editor, 0o755)
    const saved = process.env.GIT_EDITOR
    process.env.GIT_EDITOR = editor
    try {
      // e → editor dies → re-ask → EOF resolves as "" → declined.
      const io = createIO(["e"])
      const result = await confirmCloseMessage(proposal, { ...io })
      expect(result).toBeUndefined()
      expect(cleaned(io.chunks)).toContain("editor cancelled — nothing has landed")
    } finally {
      if (saved === undefined) delete process.env.GIT_EDITOR
      else process.env.GIT_EDITOR = saved
    }
  })
})

// -- task 3.4: the cleanup dependency graph ------------------------------------------

describe("offerCloseFollowUps", () => {
  test("declined worktree removal keeps branch deletion unavailable and prints both commands", async () => {
    const fixture = await makeFixture()
    const io = createIO(["n"])
    await offerCloseFollowUps(
      {
        branchDelete: "git branch -d feat/add-widget",
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
    expect(text).toContain("next (after the worktree is removed): git branch -d feat/add-widget")
    // The branch still exists and still has its worktree.
    expect((await stat(fixture.worktreeDir)).isDirectory()).toBe(true)
    expect(await git(fixture.mainDir, "rev-parse", "--verify", "feat/add-widget")).toBeTruthy()
  })

  test("an accepted worktree removal is what enables the branch deletion offer", async () => {
    const fixture = await makeFixture()
    const io = createIO(["y", "n"])
    await offerCloseFollowUps(
      {
        branchDelete: "git branch -d feat/add-widget",
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
    expect(text).toContain("next: git branch -d feat/add-widget")
    expect(await git(fixture.mainDir, "rev-parse", "--verify", "feat/add-widget")).toBeTruthy()
  })

  test("branch deletion runs only after the worktree removal succeeded", async () => {
    const fixture = await makeFixture()
    const io = createIO(["y", "y"])
    await offerCloseFollowUps(
      {
        branchDelete: "git branch -d feat/add-widget",
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
        branchDelete: "git branch -d feat/add-widget",
        baseRef: "main",
        branch: "feat/add-widget",
        worktreeDir: fixture.worktreeDir,
        targetDir: fixture.mainDir,
      },
      io,
    )
    const text = cleaned(io.chunks)
    // The branch is deletable now — the immediate command, not a wait.
    expect(text).toContain("next: git branch -d feat/add-widget")
    expect(text).not.toContain("after the worktree is removed")
  })
})

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})
