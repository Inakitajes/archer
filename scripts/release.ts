#!/usr/bin/env bun
/**
 * Local release script — bumps version, updates coverage badge, commits, tags, and pushes.
 *
 * The pushed tag triggers .github/workflows/release.yml, which builds the
 * binaries, smoke-tests them, and publishes the GitHub Release. This script
 * does NOT build or publish — it only prepares the repo and pushes the tag.
 *
 * Usage:
 *   bun run scripts/release.ts <patch|minor|major|version> [options]
 *
 * Options:
 *   --pre <id>     Append a prerelease suffix (e.g. --pre rc.1 → 0.6.0-rc.1)
 *   --dry-run      Preview without committing, tagging, or pushing
 *   --no-coverage  Skip the coverage threshold check (dangerous — bypasses the guard)
 *   --yes          Skip the confirmation prompt before pushing
 *
 * Examples:
 *   bun run scripts/release.ts patch                # 0.5.0 → 0.5.1
 *   bun run scripts/release.ts minor                # 0.5.0 → 0.6.0
 *   bun run scripts/release.ts major                # 0.5.0 → 1.0.0
 *   bun run scripts/release.ts 1.0.0                # explicit version
 *   bun run scripts/release.ts minor --pre rc.1     # 0.5.0 → 0.6.0-rc.1
 *   bun run scripts/release.ts patch --dry-run      # preview only
 */

import { execSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { resolve } from "node:path"

import { parseSemVer } from "../src/update"

const ROOT = resolve(import.meta.dirname, "..")

// ─── helpers ──────────────────────────────────────────────────────────

/** Run a git command, return trimmed stdout. Throws on non-zero exit. */
function git(args: string): string {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf-8" }).trim()
}

/** Run a git command, return trimmed stdout or null on failure. */
function gitOpt(args: string): string | null {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

/** Run a command, stream output to the terminal. Throws on non-zero exit. */
function run(cmd: string): void {
  execSync(cmd, { cwd: ROOT, stdio: "inherit" })
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = (await rl.question(question)).trim().toLowerCase()
    return answer === "y" || answer === "yes"
  } finally {
    rl.close()
  }
}

// ─── version bumping ──────────────────────────────────────────────────

function bumpVersion(current: string, type: string, prerelease?: string): string {
  const semver = parseSemVer(current)
  if (!semver) throw new Error(`Invalid current version in package.json: "${current}"`)

  let major: number
  let minor: number
  let patch: number
  let pre: string[] = []

  if (type === "major") {
    major = semver.major + 1
    minor = 0
    patch = 0
  } else if (type === "minor") {
    major = semver.major
    minor = semver.minor + 1
    patch = 0
  } else if (type === "patch") {
    major = semver.major
    minor = semver.minor
    patch = semver.patch + 1
  } else {
    // Explicit version — validate it
    const explicit = parseSemVer(type)
    if (!explicit) throw new Error(`Invalid version: "${type}"`)
    major = explicit.major
    minor = explicit.minor
    patch = explicit.patch
    pre = explicit.prerelease
  }

  // --pre overrides any prerelease component from an explicit version
  if (prerelease) {
    pre = prerelease.split(".")
  }

  const base = `${major}.${minor}.${patch}`
  return pre.length > 0 ? `${base}-${pre.join(".")}` : base
}

// ─── main ─────────────────────────────────────────────────────────────

async function main() {
  // ── parse args ──
  const args = process.argv.slice(2)
  const dryRun = args.includes("--dry-run")
  const skipCoverage = args.includes("--no-coverage")
  const skipConfirm = args.includes("--yes")
  let prerelease: string | undefined
  const positional: string[] = []

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--pre") {
      prerelease = args[++i]
      if (!prerelease) {
        console.error("❌ --pre requires a value")
        process.exit(1)
      }
    } else if (args[i] === "--dry-run" || args[i] === "--no-coverage" || args[i] === "--yes") {
      // flags already captured above
    } else if (args[i]?.startsWith("--")) {
      console.error(`❌ Unknown flag: ${args[i]}`)
      process.exit(1)
    } else {
      positional.push(args[i]!)
    }
  }

  const bumpType = positional[0]
  if (!bumpType) {
    console.error("Usage: bun run scripts/release.ts <patch|minor|major|version> [options]")
    console.error("")
    console.error("Options:")
    console.error("  --pre <id>     Append a prerelease suffix (e.g. --pre rc.1)")
    console.error("  --dry-run      Preview without committing, tagging, or pushing")
    console.error("  --no-coverage  Skip the coverage threshold check")
    console.error("  --yes          Skip the confirmation prompt")
    process.exit(1)
  }

  // ── read current version ──
  const pkgPath = `${ROOT}/package.json`
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string }
  const currentVersion = pkg.version
  const newVersion = bumpVersion(currentVersion, bumpType, prerelease)
  const tagName = `v${newVersion}`

  console.log("")
  console.log(`  🚀  Release:  v${currentVersion}  →  v${newVersion}`)
  if (dryRun) console.log("       (dry-run — nothing will be committed, tagged, or pushed)")
  if (skipCoverage) console.log("       ⚠️  coverage check SKIPPED (--no-coverage)")
  console.log("")

  // ── 1. pre-flight checks ──
  console.log("  📋  Pre-flight checks")

  // working tree clean
  const status = git("status --porcelain")
  if (status) {
    console.error("  ❌  Working tree is not clean:")
    console.error(status)
    process.exit(1)
  }
  console.log("       ✓ working tree clean")

  // on main
  const branch = git("branch --show-current")
  if (branch !== "main") {
    console.error(`  ❌  Not on main (current: "${branch}")`)
    process.exit(1)
  }
  console.log("       ✓ on main branch")

  // up to date with remote
  console.log("       · fetching origin...")
  git("fetch --quiet origin")
  const localHead = git("rev-parse main")
  const remoteHead = git("rev-parse origin/main")
  if (localHead !== remoteHead) {
    console.error("  ❌  Local main is not in sync with origin/main:")
    console.error(`       local:  ${localHead}`)
    console.error(`       remote: ${remoteHead}`)
    process.exit(1)
  }
  console.log("       ✓ in sync with origin/main")

  // tag doesn't exist
  if (gitOpt(`rev-parse -q --verify refs/tags/${tagName}`)) {
    console.error(`  ❌  Tag ${tagName} already exists`)
    process.exit(1)
  }
  console.log(`       ✓ tag ${tagName} is available`)

  // version is not lower than current
  const newSem = parseSemVer(newVersion)!
  const curSem = parseSemVer(currentVersion)!
  if (
    newSem.major < curSem.major ||
    (newSem.major === curSem.major && newSem.minor < curSem.minor) ||
    (newSem.major === curSem.major && newSem.minor === curSem.minor && newSem.patch < curSem.patch)
  ) {
    console.error(`  ⚠️  Warning: new version ${newVersion} is lower than current ${currentVersion}`)
    if (!skipConfirm) {
      const ok = await confirm("       Continue anyway? [y/N] ")
      if (!ok) process.exit(1)
    }
  }

  // ── 2. typecheck ──
  console.log("\n  🔍  Typecheck")
  run("bun run typecheck")
  console.log("       ✓ typecheck passed")

  // ── 3. tests + coverage ──
  if (skipCoverage) {
    console.log("\n  🧪  Tests (coverage check skipped)")
    run("bun test")
  } else {
    console.log("\n  🧪  Tests + coverage (90% threshold)")
    run("bun run scripts/coverage.ts")
  }
  console.log("       ✓ all tests passed")

  // ── 4. bump version ──
  console.log(`\n  📦  Bump package.json:  ${currentVersion}  →  ${newVersion}`)
  if (!dryRun) {
    pkg.version = newVersion
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf-8")
  }

  // ── 5. stage ──
  const files = ["package.json", "assets/coverage.svg"]
  console.log(`  📝  Stage:  ${files.join(", ")}`)
  if (!dryRun) {
    for (const f of files) git(`add "${f}"`)
  }

  // ── 6. commit ──
  const commitMsg = `chore(release): v${newVersion}`
  console.log(`  💬  Commit:  ${commitMsg}`)
  if (!dryRun) {
    git(`commit -m "${commitMsg}"`)
  }

  // ── 7. tag ──
  console.log(`  🏷️  Tag:  ${tagName}`)
  if (!dryRun) {
    git(`tag ${tagName}`)
  }

  // ── 8. confirm ──
  if (!skipConfirm && !dryRun) {
    const ok = await confirm(`\n  Push ${tagName} to origin? [y/N] `)
    if (!ok) {
      console.log("\n  Aborted. The commit and tag are local. Undo with:")
      console.log(`    git tag -d ${tagName}`)
      console.log("    git reset --hard HEAD~1")
      process.exit(1)
    }
  }

  // ── 9. push ──
  console.log("\n  📤  Pushing to origin...")
  if (!dryRun) {
    git("push origin main")
    git(`push origin ${tagName}`)
  }

  // ── done ──
  console.log("")
  console.log(`  ✅  Released ${tagName}`)
  console.log("")
  console.log("  CI will build the binaries and publish the GitHub Release:")
  console.log("    https://github.com/Inakitajes/convoy/actions")
  console.log(`    https://github.com/Inakitajes/convoy/releases/tag/${tagName}`)
  console.log("")
}

main().catch((err) => {
  console.error(`\n  ❌  ${err.message}`)
  process.exit(1)
})
