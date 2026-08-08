import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

const workflowsDirectory = join(import.meta.dir, "..", ".github", "workflows")

function workflow(name: string) {
  return readFile(join(workflowsDirectory, name), "utf8")
}

function expectPinnedActionLines(contents: string) {
  const actionLines = contents
    .split("\n")
    .filter((line) => line.trimStart().startsWith("uses:") && !line.includes("uses: ./"))
  expect(actionLines.length).toBeGreaterThan(0)
  for (const line of actionLines) {
    expect(line).toMatch(/uses:\s+[^@\s]+@[a-f0-9]{40}\s+# v\d/i)
  }
}

describe("release workflow", () => {
  test("publishes prerelease tags without making them latest", async () => {
    const release = await workflow("release.yml")

    expect(release).toContain("prerelease: ${{ contains(github.ref_name, '-') }}")
    expect(release).toContain("make_latest: ${{ !contains(github.ref_name, '-') }}")
  })

  test("smoke-tests native Linux and Darwin release binaries", async () => {
    const release = await workflow("release.yml")

    expect(release).toContain("./dist/convoy-linux-x64 --version")
    expect(release).toContain("./dist/convoy-darwin-arm64 --version")
    expect(release).toContain("darwin-x64")
    expect(release).toContain("linux-arm64")
  })
})

describe("pull-request CI workflow", () => {
  test("validates main and pull requests on both supported runner platforms", async () => {
    const ci = await workflow("ci.yml")
    const verify = await workflow("verify.yml")

    expect(ci).toContain("pull_request:\n    branches:\n      - main")
    expect(ci).toContain("push:\n    branches:\n      - main")
    expect(ci).toContain("permissions:\n  contents: read")
    expect(ci).toContain("concurrency:")
    expect(ci).toContain("cancel-in-progress: true")
    expect(ci).toContain("uses: ./.github/workflows/verify.yml")
    expect(verify).toContain("matrix:")
    expect(verify).toContain("ubuntu-latest")
    expect(verify).toContain("macos-14")
    expect(verify).toContain("bun-version: 1.3.14")
    expect(verify).toContain("bun install --frozen-lockfile --os='*' --cpu='*'")
    expect(verify).toContain("for target in darwin-arm64 darwin-x64 linux-arm64 linux-x64; do")
    expect(verify).toContain("bun run typecheck")
    expect(verify).toContain("bun test --coverage")
    expect(verify).toContain("bun run build")
  })
})

describe("GitHub Action supply-chain pins", () => {
  test("uses version-commented immutable action SHAs and enables Dependabot", async () => {
    expectPinnedActionLines(await workflow("release.yml"))
    expectPinnedActionLines(await workflow("verify.yml"))

    const dependabot = await readFile(join(import.meta.dir, "..", ".github", "dependabot.yml"), "utf8")
    expect(dependabot).toContain('package-ecosystem: "github-actions"')
    expect(dependabot).toContain('directory: "/"')
  })
})
