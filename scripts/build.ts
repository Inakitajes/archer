import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

import { parseSemVer } from "../src/update"

type PackageManifest = { version?: unknown }

type BuildTarget = {
  bunTarget: Bun.Build.CompileTarget
  platform: string
  output: string
}

const localTarget: BuildTarget = {
  bunTarget: `bun-${process.platform}-${process.arch}` as Bun.Build.CompileTarget,
  platform: `${process.platform}-${process.arch}`,
  output: "convoy",
}

const releaseTargets: BuildTarget[] = [
  { bunTarget: "bun-darwin-arm64", platform: "darwin-arm64", output: "dist/convoy-darwin-arm64" },
  { bunTarget: "bun-darwin-x64", platform: "darwin-x64", output: "dist/convoy-darwin-x64" },
  { bunTarget: "bun-linux-arm64", platform: "linux-arm64", output: "dist/convoy-linux-arm64" },
  { bunTarget: "bun-linux-x64", platform: "linux-x64", output: "dist/convoy-linux-x64" },
]

const release = process.argv.slice(2).join(" ") === "--release"
if (!release && process.argv.length > 2) throw new Error("usage: bun run scripts/build.ts [--release]")

const manifest = (await Bun.file("package.json").json()) as PackageManifest
if (typeof manifest.version !== "string" || !parseSemVer(manifest.version)) {
  throw new Error("package.json must contain a valid SemVer version")
}

const commit = await gitCommit()
if (release) await mkdir("dist", { recursive: true })
// Local builds must never read as the release that shares their number: the
// injected version carries a `-local` prerelease suffix so the TUI header and
// `--version` show e.g. `v0.6.0-local+<short-commit>`. The short commit is
// appended as SemVer build metadata (`+...`), not as a prerelease identifier:
// a prerelease identifier that happens to be a purely-numeric hash with a
// leading zero (e.g. `0123456`) would be invalid SemVer, whereas build metadata
// has no such restriction and is ignored for precedence — so update checks
// still compare correctly (prerelease < stable) and the local build is never
// confused with the release. When Git is unavailable the suffix is dropped.
const shortCommit = commit !== "unknown" ? commit.slice(0, 7) : undefined
const localPrerelease = shortCommit ? `${manifest.version}-local+${shortCommit}` : `${manifest.version}-local`
const injectedVersion = release ? manifest.version : localPrerelease
for (const target of release ? releaseTargets : [localTarget]) {
  const result = await Bun.build({
    entrypoints: [resolve("src/main.ts")],
    compile: { target: target.bunTarget, outfile: resolve(target.output) },
    define: {
      __CONVOY_VERSION__: JSON.stringify(injectedVersion),
      __CONVOY_COMMIT__: JSON.stringify(commit),
      __CONVOY_PLATFORM__: JSON.stringify(target.platform),
    },
  })
  if (!result.success) {
    throw new Error(`failed to build ${target.output}:\n${result.logs.map((log) => log.message).join("\n")}`)
  }
  process.stdout.write(`built ${target.output} (${target.platform}) v${injectedVersion}\n`)
}

async function gitCommit() {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
  const stdout = new Response(child.stdout).text()
  if ((await child.exited) !== 0) return "unknown"
  const commit = (await stdout).trim()
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : "unknown"
}
