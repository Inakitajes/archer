import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"

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
if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
  throw new Error("package.json must contain a valid SemVer version")
}

const commit = await gitCommit()
if (release) await mkdir("dist", { recursive: true })
for (const target of release ? releaseTargets : [localTarget]) {
  const result = await Bun.build({
    entrypoints: [resolve("src/main.ts")],
    compile: { target: target.bunTarget, outfile: resolve(target.output) },
    define: {
      __CONVOY_VERSION__: JSON.stringify(manifest.version),
      __CONVOY_COMMIT__: JSON.stringify(commit),
      __CONVOY_PLATFORM__: JSON.stringify(target.platform),
    },
  })
  if (!result.success) {
    throw new Error(`failed to build ${target.output}:\n${result.logs.map((log) => log.message).join("\n")}`)
  }
  process.stdout.write(`built ${target.output} (${target.platform})\n`)
}

async function gitCommit() {
  const child = Bun.spawn(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "pipe" })
  if ((await child.exited) !== 0) return "unknown"
  const commit = (await new Response(child.stdout).text()).trim()
  return /^[0-9a-f]{40}$/i.test(commit) ? commit : "unknown"
}
