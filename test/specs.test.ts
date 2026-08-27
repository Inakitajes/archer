import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"

import {
  browseSpecs,
  classifySpecArtifact,
  loadSpecsView,
  printSpecsList,
  specArtifactLabel,
  specsIteratePrompt,
} from "../src/specs"

let root: string
let symlinkCreated = false

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "convoy-specs-test-"))
  const openspec = join(root, "openspec")
  const changes = join(openspec, "changes")

  await mkdir(join(changes, "archive", "old"), { recursive: true })
  await writeFile(join(changes, "archive", "old", "proposal.md"), "# Archived\n")
  await mkdir(join(changes, ".hidden"), { recursive: true })
  await writeFile(join(changes, ".hidden", "proposal.md"), "# Hidden\n")
  await writeFile(join(changes, "loose.md"), "# Stray\n")
  await mkdir(join(changes, "empty-change"), { recursive: true })

  // A symlink named like a change id is not a change (see openspec.ts).
  try {
    await symlink(join(changes, "add-login"), join(changes, "linked-change"))
    symlinkCreated = true
  } catch {
    symlinkCreated = false
  }

  await mkdir(join(changes, "add-login", "specs", "cli"), { recursive: true })
  await writeFile(join(changes, "add-login", "proposal.md"), "---\ntitle: ignored\n---\n# Add login\n\nwhy\n")
  await writeFile(join(changes, "add-login", "design.md"), "# Design\n\nhow\n")
  await writeFile(join(changes, "add-login", "tasks.md"), "# Tasks\n\n1. do\n")
  await writeFile(join(changes, "add-login", "specs", "cli", "spec.md"), "# Delta\n\n## ADDED Requirements\n")
  await writeFile(join(changes, "add-login", "notes.md"), "# Notes\n")

  await mkdir(join(changes, "empty-change"), { recursive: true })

  await mkdir(join(openspec, "specs", "api", "users"), { recursive: true })
  await writeFile(join(openspec, "specs", "api", "users", "spec.md"), "# Users\n")
  await writeFile(join(openspec, "specs", "core.md"), "# Core\n")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("classifySpecArtifact", () => {
  test("maps the planning trio by exact basename", () => {
    expect(classifySpecArtifact("proposal.md")).toEqual({ section: "proposal" })
    expect(classifySpecArtifact("design.md")).toEqual({ section: "design" })
    expect(classifySpecArtifact("tasks.md")).toEqual({ section: "tasks" })
  })

  test("groups delta files under their capability directory", () => {
    expect(classifySpecArtifact("specs/cli/spec.md")).toEqual({ section: "delta", capability: "cli" })
    expect(classifySpecArtifact("specs/web/deep/path/spec.md")).toEqual({ section: "delta", capability: "web" })
  })

  test("keeps a lone specs-level file in the delta group without a capability", () => {
    expect(classifySpecArtifact("spec.md")).toEqual({ section: "other" })
    expect(classifySpecArtifact("specs/spec.md")).toEqual({ section: "delta" })
  })

  test("lands unmatched files in the other group", () => {
    expect(classifySpecArtifact("notes.md")).toEqual({ section: "other" })
  })

  test("labels every section", () => {
    expect(specArtifactLabel("proposal")).toBe("Proposal")
    expect(specArtifactLabel("design")).toBe("Design")
    expect(specArtifactLabel("tasks")).toBe("Tasks")
    expect(specArtifactLabel("delta", "cli")).toBe("Delta Specs (cli)")
    expect(specArtifactLabel("delta")).toBe("Delta Specs")
    expect(specArtifactLabel("other")).toBe("Other")
  })
})

describe("loadSpecsView", () => {
  test("lists active changes with titles, artifacts, and canonical specs", async () => {
    const view = await loadSpecsView(root)

    expect(view.present).toBe(true)
    expect(view.changes.map((change) => change.id)).toEqual(["add-login", "empty-change"])

    const [login, empty] = view.changes
    expect(login!.title).toBe("Add login")
    expect(login!.artifacts.map((artifact) => [artifact.section, artifact.capability, artifact.file])).toEqual([
      ["proposal", undefined, join("openspec", "changes", "add-login", "proposal.md")],
      ["design", undefined, join("openspec", "changes", "add-login", "design.md")],
      ["tasks", undefined, join("openspec", "changes", "add-login", "tasks.md")],
      ["delta", "cli", join("openspec", "changes", "add-login", "specs", "cli", "spec.md")],
      ["other", undefined, join("openspec", "changes", "add-login", "notes.md")],
    ])

    expect(empty!.title).toBe("empty-change")
    expect(empty!.artifacts).toEqual([])

    expect(view.specs).toEqual([join("openspec", "specs", "api", "users", "spec.md"), join("openspec", "specs", "core.md")])
  })

  test("excludes archive, dotfiles, stray files, and symlinked change dirs", async () => {
    const view = await loadSpecsView(root)
    const ids = view.changes.map((change) => change.id)
    expect(ids).not.toContain("old")
    expect(ids).not.toContain(".hidden")
    expect(ids).not.toContain("loose.md")
    if (symlinkCreated) expect(ids).not.toContain("linked-change")
  })

  test("reports an absent openspec directory as not present", async () => {
    const bare = await mkdtemp(join(tmpdir(), "convoy-specs-bare-"))
    try {
      const view = await loadSpecsView(bare)
      expect(view.present).toBe(false)
      expect(view.changes).toEqual([])
      expect(view.specs).toEqual([])
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })

  test("an archive-only changes dir is present but has no active changes", async () => {
    // Spec scenario: `openspec/changes/` containing only `archive` must report
    // (or show) Active Changes empty while canonical specs remain browsable.
    const archived = await mkdtemp(join(tmpdir(), "convoy-specs-archived-"))
    try {
      await mkdir(join(archived, "openspec", "changes", "archive", "old"), { recursive: true })
      await writeFile(join(archived, "openspec", "changes", "archive", "old", "proposal.md"), "# Archived\n")
      await mkdir(join(archived, "openspec", "specs", "cli"), { recursive: true })
      await writeFile(join(archived, "openspec", "specs", "cli", "spec.md"), "# Cli\n")
      const view = await loadSpecsView(archived)
      expect(view.present).toBe(true)
      expect(view.changes).toEqual([])
      expect(view.specs).toEqual([join("openspec", "specs", "cli", "spec.md")])
    } finally {
      await rm(archived, { recursive: true, force: true })
    }
  })
})

describe("printSpecsList", () => {
  test("prints changes with artifact inventory, then canonical specs, without control sequences", async () => {
    const view = await loadSpecsView(root)
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      printSpecsList(view)
    } finally {
      spy.mockRestore()
    }
    const output = writes.join("")
    expect(output).toContain("active changes:")
    expect(output).toContain("add-login — Add login")
    expect(output).toContain("delta specs (cli): ")
    expect(output).toContain("empty-change")
    expect(output).toContain("canonical specs:")
    expect(output).toContain(join("openspec", "specs", "core.md"))
    expect(output).not.toContain("\u001b")
  })

  test("reports empty sections instead of crashing", async () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      printSpecsList({ present: true, changes: [], specs: [] })
    } finally {
      spy.mockRestore()
    }
    const output = writes.join("")
    expect(output).toContain("(none)")
  })
})

describe("browseSpecs outside a terminal", () => {
  test("pipes the plain listing and exits without opening any UI", async () => {
    const writes: string[] = []
    const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write)
    try {
      const resolution = await browseSpecs(root)
      expect(resolution).toEqual({ type: "exit" })
    } finally {
      spy.mockRestore()
    }
    const output = writes.join("")
    expect(output).toContain("add-login")
    expect(output).toContain("canonical specs:")
  })

  test("prints a single message and exits 0-style when there are no specs", async () => {
    const bare = await mkdtemp(join(tmpdir(), "convoy-specs-bare-"))
    try {
      const writes: string[] = []
      const spy = spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write)
      try {
        const resolution = await browseSpecs(bare)
        expect(resolution).toEqual({ type: "exit" })
      } finally {
        spy.mockRestore()
      }
      expect(writes.join("")).toContain("no specs found")
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})

describe("specsIteratePrompt", () => {
  test("lists the change's planning files as context", () => {
    const files = [
      join("openspec", "changes", "add-login", "proposal.md"),
      join("openspec", "changes", "add-login", "design.md"),
      join("openspec", "changes", "add-login", "tasks.md"),
      join("openspec", "changes", "add-login", "specs", "cli", "spec.md"),
    ]
    const prompt = specsIteratePrompt("add-login", files)
    expect(prompt).toContain("add-login")
    for (const file of files) expect(prompt).toContain(file)
    expect(prompt.split("\n")).toHaveLength(1)
  })

  test("falls back to the change directory when there are no files", () => {
    const prompt = specsIteratePrompt("bare-change", [])
    expect(prompt).toContain(join("openspec", "changes", "bare-change") + "/")
  })
})

describe("buildIterateSessionInput", () => {
  test("roots at the repo dir and lists the change's planning files", async () => {
    const { buildIterateSessionInput } = await import("../src/specs")
    const view = await loadSpecsView(root)
    const input = buildIterateSessionInput(root, view, "add-login")

    expect(input.targetDir).toBe(root)
    expect(input.runDir).toBe(root)
    expect(input.prompt).toContain("add-login")
    for (const file of [join("openspec", "changes", "add-login", "proposal.md"), join("openspec", "changes", "add-login", "specs", "cli", "spec.md")]) {
      expect(input.prompt).toContain(file)
    }
  })

  test("falls back to an empty prompt inventory for an unknown change id", async () => {
    const { buildIterateSessionInput } = await import("../src/specs")
    const view = await loadSpecsView(root)
    const input = buildIterateSessionInput(root, view, "not-a-change")
    expect(input.prompt).toContain(join("openspec", "changes", "not-a-change") + "/")
  })
})
