/**
 * Integration tests for finish-command.ts that need mock.module.
 * Kept separate so mock.module doesn't leak into other test files.
 */
import { describe, expect, mock, test } from "bun:test"

async function setupRepo(): Promise<string> {
  const { mkdtempSync } = await import("node:fs")
  const { writeFileSync, mkdirSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const { execSync } = await import("node:child_process")

  const tmp = mkdtempSync(join(tmpdir(), "convoy-finish-cmd-"))

  mkdirSync(join(tmp, ".convoy"), { recursive: true })
  writeFileSync(join(tmp, ".convoy/config.yaml"), "defaults:\n  baseRef: main\n")

  execSync("git init -b main", { cwd: tmp })
  execSync("git config user.email test@test.com", { cwd: tmp })
  execSync("git config user.name Tester", { cwd: tmp })
  execSync("git add -A", { cwd: tmp })
  execSync("git commit -m 'chore: initial' --author='User <user@test.com>'", { cwd: tmp })
  execSync("git checkout -b feat/test-login", { cwd: tmp })
  execSync("git commit --allow-empty -m 'feat: add login (1/2)' --author='Convoy <convoy@local>'", { cwd: tmp })
  execSync("git commit --allow-empty -m 'fix: typo (2/2)' --author='Convoy <convoy@local>'", { cwd: tmp })

  return tmp
}

describe("runFinishCommand integration with git", () => {
  test("--dry-run prints the plan and exits without modifying the repo", async () => {
    const tmp = await setupRepo()
    const { execSync } = require("node:child_process") as typeof import("node:child_process")

    // Mock the commit-message module so proposeCommitMessage doesn't try
    // to connect to a real opencode server
    mock.module("../src/commit-message", () => ({
      formatCommitMessage: (msg: { subject: string; body: string[] }) =>
        `${msg.subject}\n\n${msg.body.map((l: string) => `- ${l}`).join("\n")}`,
      proposeCommitMessage: () =>
        Promise.resolve({
          message: { subject: "feat: add login (1/2)", body: ["Convoy commit message"] },
          source: "template" as const,
        }),
    }))

    const { runFinishCommand } = await import("../src/finish-command")
    const writes: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      await runFinishCommand({ targetDir: tmp, dryRun: true, baseRef: "main" })
      const allOutput = writes.join("")
      expect(allOutput).toContain("--dry-run: nothing was changed")
      expect(allOutput).toContain("feat:")
      expect(allOutput).toContain("2 convoy commits")
    } finally {
      process.stdout.write = origWrite
      execSync("rm -rf " + tmp)
    }
  })

  test("non-interactive without --yes prints hint", async () => {
    const tmp = await setupRepo()
    const { execSync } = require("node:child_process") as typeof import("node:child_process")

    mock.module("../src/commit-message", () => ({
      formatCommitMessage: (msg: { subject: string; body: string[] }) =>
        `${msg.subject}\n\n${msg.body.map((l: string) => `- ${l}`).join("\n")}`,
      proposeCommitMessage: () =>
        Promise.resolve({
          message: { subject: "feat: add login (1/2)", body: ["Convoy commit message"] },
          source: "template" as const,
        }),
    }))

    const { runFinishCommand } = await import("../src/finish-command")
    const writes: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      writes.push(chunk)
      return true
    }) as typeof process.stdout.write

    try {
      await runFinishCommand({ targetDir: tmp })
      const allOutput = writes.join("")
      expect(allOutput).toContain("not an interactive terminal")
    } finally {
      process.stdout.write = origWrite
      execSync("rm -rf " + tmp)
    }
  })
})