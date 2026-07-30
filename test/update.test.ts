import { chmod, copyFile, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import { afterEach, describe, expect, test } from "bun:test"

import {
  UpdateError,
  assetNameForPlatform,
  candidateDeclaresVersion,
  checkForUpdate,
  checksumForAsset,
  compareSemVer,
  fetchLatestRelease,
  githubLatestReleaseUrl,
  isOfficialStandaloneExecutable,
  parseSemVer,
  replaceExecutableAtomically,
  runUpdate,
  selectReleaseAssets,
  sha256,
  validateLatestRelease,
  verifyAssetBytes,
  type ReleaseAsset,
  type FetchLike,
  type UpdateFileOps,
} from "../src/update"

const tempDirs: string[] = []
const encoder = new TextEncoder()

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function releaseFor(bytes: Uint8Array, options: { digest?: string; tag?: string; draft?: boolean; prerelease?: boolean; assets?: unknown[] } = {}) {
  const binaryDigest = options.digest ?? `sha256:${sha256(bytes)}`
  const binary = {
    name: "convoy-darwin-arm64",
    browser_download_url: "https://github.com/Inakitajes/convoy/releases/download/v0.2.0/convoy-darwin-arm64",
    ...(options.digest === undefined || options.digest ? { digest: binaryDigest } : {}),
  }
  const checksum = {
    name: "SHA256SUMS",
    browser_download_url: "https://github.com/Inakitajes/convoy/releases/download/v0.2.0/SHA256SUMS",
  }
  return {
    tag_name: options.tag ?? "v0.2.0",
    draft: options.draft ?? false,
    prerelease: options.prerelease ?? false,
    published_at: "2026-07-30T15:30:00Z",
    assets: options.assets ?? [binary, checksum],
  }
}

function fetchFor(release: unknown, bytes: Uint8Array, checksum = `${sha256(bytes)}  convoy-darwin-arm64\n`): FetchLike {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url === githubLatestReleaseUrl) return new Response(JSON.stringify(release), { status: 200 })
    if (url.endsWith("SHA256SUMS")) return new Response(checksum, { status: 200 })
    if (url.endsWith("convoy-darwin-arm64")) return new Response(bytes as unknown as BodyInit, { status: 200 })
    return new Response("not found", { status: 404 })
  }) as FetchLike
}

describe("semantic versions", () => {
  test("parses and compares stable and prerelease versions", () => {
    expect(parseSemVer("v1.2.3")).toMatchObject({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseSemVer("1.2.3-alpha.1")?.prerelease).toEqual(["alpha", "1"])
    expect(parseSemVer("1.02.3")).toBeUndefined()
    expect(parseSemVer("1.2.3-01")).toBeUndefined()
    expect(compareSemVer("1.2.3", "1.2.3-rc.1")).toBe(1)
    expect(compareSemVer("1.2.3-beta.2", "1.2.3-beta.11")).toBe(-1)
    expect(compareSemVer("1.2.4", "1.2.3")).toBe(1)
  })
})

describe("release validation", () => {
  test("maps every supported runtime to the exact release asset", () => {
    expect(assetNameForPlatform("darwin", "arm64")).toBe("convoy-darwin-arm64")
    expect(assetNameForPlatform("darwin", "x64")).toBe("convoy-darwin-x64")
    expect(assetNameForPlatform("linux", "arm64")).toBe("convoy-linux-arm64")
    expect(assetNameForPlatform("linux", "x64")).toBe("convoy-linux-x64")
    expect(assetNameForPlatform("win32", "x64")).toBeUndefined()
  })

  test("rejects malformed, draft, prerelease, and incomplete releases", () => {
    const bytes = encoder.encode("new binary")
    expect(() => validateLatestRelease({})).toThrow(UpdateError)
    expect(() => validateLatestRelease(releaseFor(bytes, { draft: true }))).toThrow("not published")
    expect(() => validateLatestRelease(releaseFor(bytes, { prerelease: true }))).toThrow("prerelease")
    expect(() => validateLatestRelease(releaseFor(bytes, { tag: "v0.2.0-rc.1" }))).toThrow("stable semantic version")

    const withoutDigest = validateLatestRelease(releaseFor(bytes, { digest: "" }))
    expect(() => selectReleaseAssets(withoutDigest, "darwin", "arm64")).toThrow("missing a SHA-256 digest")

    const withoutBinary = validateLatestRelease(releaseFor(bytes, { assets: [] }))
    expect(() => selectReleaseAssets(withoutBinary, "darwin", "arm64")).toThrow("does not contain exactly one")
  })

  test("rejects asset download URLs that are not GitHub release hosts", () => {
    const bytes = encoder.encode("new binary")
    const offHost = releaseFor(bytes, {
      assets: [
        {
          name: "convoy-darwin-arm64",
          browser_download_url: "https://downloads.example.invalid/convoy-darwin-arm64",
          digest: `sha256:${sha256(bytes)}`,
        },
        {
          name: "SHA256SUMS",
          browser_download_url: "https://github.com/Inakitajes/convoy/releases/download/v0.2.0/SHA256SUMS",
        },
      ],
    })
    expect(() => validateLatestRelease(offHost)).toThrow("unsafe download URL")

    const httpUrl = releaseFor(bytes, {
      assets: [
        {
          name: "convoy-darwin-arm64",
          browser_download_url: "http://github.com/Inakitajes/convoy/releases/download/v0.2.0/convoy-darwin-arm64",
          digest: `sha256:${sha256(bytes)}`,
        },
        { name: "SHA256SUMS", browser_download_url: "https://github.com/Inakitajes/convoy/releases/download/v0.2.0/SHA256SUMS" },
      ],
    })
    expect(() => validateLatestRelease(httpUrl)).toThrow("unsafe download URL")
  })
})

describe("asset verification", () => {
  test("requires both GitHub's digest and SHA256SUMS to match", () => {
    const bytes = encoder.encode("verified binary")
    const binary: ReleaseAsset = {
      name: "convoy-darwin-arm64",
      browserDownloadUrl: "https://github.com/Inakitajes/convoy/releases/download/v0.2.0/convoy-darwin-arm64",
      digest: `sha256:${sha256(bytes)}`,
    }
    const sums = `${sha256(bytes)}  convoy-darwin-arm64\n`

    expect(() => verifyAssetBytes(bytes, binary, sums)).not.toThrow()
    expect(checksumForAsset(sums, binary.name)).toBe(sha256(bytes))
    expect(() => verifyAssetBytes(bytes, binary, `${"0".repeat(64)}  convoy-darwin-arm64\n`)).toThrow("SHA256SUMS verification failed")
    expect(() => verifyAssetBytes(bytes, { ...binary, digest: `sha256:${"0".repeat(64)}` }, sums)).toThrow("GitHub digest verification failed")
  })

  test("checks candidate --version output exactly", () => {
    expect(candidateDeclaresVersion("convoy 0.2.0 (commit abc, darwin-arm64)\n", "0.2.0")).toBe(true)
    expect(candidateDeclaresVersion("convoy 0.2.1 (commit abc, darwin-arm64)\n", "0.2.0")).toBe(false)
    expect(candidateDeclaresVersion("not convoy 0.2.0", "0.2.0")).toBe(false)
  })
})

describe("safe updater", () => {
  test("recognizes modern and Bun 1.3 standalone runtime signals", () => {
    expect(isOfficialStandaloneExecutable({ isStandaloneExecutable: true })).toBe(true)
    expect(isOfficialStandaloneExecutable({ isStandaloneExecutable: false, embeddedFiles: [{}] })).toBe(false)
    expect(isOfficialStandaloneExecutable({ main: "/$bunfs/root/probe.ts" })).toBe(true)
    expect(isOfficialStandaloneExecutable({ main: "C:\\$bunfs\\root\\probe.ts" })).toBe(true)
    expect(isOfficialStandaloneExecutable({ embeddedFiles: [{}] })).toBe(true)
    expect(isOfficialStandaloneExecutable({ embeddedFiles: [] })).toBe(false)
  })

  test("recognizes an actual compiled Bun executable", async () => {
    const directory = await mkdtemp(join(tmpdir(), "convoy-standalone-probe-"))
    tempDirs.push(directory)
    const entrypoint = join(directory, "probe.ts")
    const executable = join(directory, "probe")
    await writeFile(
      entrypoint,
      `import { isOfficialStandaloneExecutable } from ${JSON.stringify(resolve(process.cwd(), "src/update.ts"))}; process.stdout.write(String(isOfficialStandaloneExecutable()));`,
    )
    const result = await Bun.build({
      entrypoints: [entrypoint],
      compile: { target: `bun-${process.platform}-${process.arch}` as Bun.Build.CompileTarget, outfile: executable },
    })

    expect(result.success).toBe(true)
    const child = Bun.spawn([executable], { stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toBe("true")
  })

  test("does not query GitHub or modify a source checkout", async () => {
    let requests = 0
    const result = await runUpdate({
      standalone: false,
      fetch: (async () => {
        requests++
        return new Response()
      }) as FetchLike,
    })

    expect(result.status).toBe("source-install")
    expect(requests).toBe(0)
  })

  test("checks for a newer stable release without modifying the executable", async () => {
    const bytes = encoder.encode("new binary")
    const result = await checkForUpdate({
      currentVersion: "0.1.0",
      platform: "darwin",
      architecture: "arm64",
      fetch: fetchFor(releaseFor(bytes), bytes),
    })

    expect(result).toMatchObject({ status: "update-available", currentVersion: "0.1.0", latestVersion: "0.2.0" })
    expect(result.assets.binary.name).toBe("convoy-darwin-arm64")
  })

  test("reports up-to-date when the installed version is not older than the release", async () => {
    const bytes = encoder.encode("new binary")
    const same = await checkForUpdate({
      currentVersion: "0.2.0",
      platform: "darwin",
      architecture: "arm64",
      fetch: fetchFor(releaseFor(bytes), bytes),
    })
    expect(same).toMatchObject({ status: "up-to-date", currentVersion: "0.2.0", latestVersion: "0.2.0" })

    const newer = await checkForUpdate({
      currentVersion: "0.3.0",
      platform: "darwin",
      architecture: "arm64",
      fetch: fetchFor(releaseFor(bytes), bytes),
    })
    expect(newer.status).toBe("up-to-date")
  })

  test("fetchLatestRelease surfaces GitHub HTTP errors as UpdateError", async () => {
    const fetchImpl = (async () => new Response("rate limited", { status: 403, statusText: "Forbidden" })) as FetchLike
    await expect(fetchLatestRelease(fetchImpl)).rejects.toThrow(UpdateError)
    await expect(fetchLatestRelease(fetchImpl)).rejects.toThrow("403")
  })

  test("checkOnly never downloads or installs even when an update is available", async () => {
    const directory = await mkdtemp(join(tmpdir(), "convoy-update-checkonly-"))
    tempDirs.push(directory)
    const executablePath = join(directory, "convoy")
    const bytes = encoder.encode("new binary")
    await writeFile(executablePath, "old binary", { mode: 0o755 })
    await chmod(executablePath, 0o755)

    let downloads = 0
    const guardedFetch: FetchLike = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url === githubLatestReleaseUrl) return new Response(JSON.stringify(releaseFor(bytes)), { status: 200 })
      downloads++
      return new Response("not found", { status: 404 })
    }) as FetchLike

    const result = await runUpdate({
      standalone: true,
      checkOnly: true,
      currentVersion: "0.1.0",
      platform: "darwin",
      architecture: "arm64",
      executablePath,
      fetch: guardedFetch,
    })
    expect(result).toMatchObject({ status: "update-available", currentVersion: "0.1.0", latestVersion: "0.2.0" })
    expect(downloads).toBe(0)
    expect(await readFile(executablePath, "utf8")).toBe("old binary")
  })

  test("does not replace the executable when the candidate fails version validation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "convoy-update-badcandidate-"))
    tempDirs.push(directory)
    const executablePath = join(directory, "convoy")
    const bytes = encoder.encode("new binary")
    await writeFile(executablePath, "old binary", { mode: 0o755 })
    await chmod(executablePath, 0o755)

    await expect(
      runUpdate({
        standalone: true,
        currentVersion: "0.1.0",
        platform: "darwin",
        architecture: "arm64",
        executablePath,
        fetch: fetchFor(releaseFor(bytes), bytes),
        validateCandidate: async () => false,
        randomSuffix: () => "badcandidate",
      }),
    ).rejects.toThrow("did not report the expected version")
    expect(await readFile(executablePath, "utf8")).toBe("old binary")
    // No candidate or backup leftovers remain in the install directory.
    expect(await readdir(directory)).toEqual(["convoy"])
  })

  test("replaceExecutableAtomically restores the previous binary when the final rename fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "convoy-atomic-restore-"))
    tempDirs.push(directory)
    const executablePath = join(directory, "convoy")
    const candidatePath = join(directory, ".convoy.candidate-restore")
    await writeFile(executablePath, "original", { mode: 0o755 })
    await chmod(executablePath, 0o755)
    await writeFile(candidatePath, "replacement", { mode: 0o755 })

    let candidateRenames = 0
    const guardedFileOps: UpdateFileOps = {
      chmod,
      copyFile,
      rename: async (from, to) => {
        if (String(from).includes(".candidate-") && to === executablePath) {
          candidateRenames++
          throw new Error("rename blocked")
        }
        await rename(from, to)
      },
      rm,
      stat,
      writeFile,
    }

    await expect(
      replaceExecutableAtomically(executablePath, candidatePath, { fileOps: guardedFileOps, randomSuffix: () => "restore" }),
    ).rejects.toThrow("rename blocked")
    expect(candidateRenames).toBe(1)
    // The backup was restored over the executable, so the original content survives.
    expect(await readFile(executablePath, "utf8")).toBe("original")
    // The temporary backup is cleaned up; the candidate is left for the caller
    // (runUpdate owns candidate cleanup via removeIfPresent).
    expect(await readdir(directory)).toEqual([".convoy.candidate-restore", "convoy"])
  })

  test("installs a verified candidate through a same-directory atomic rename", async () => {
    const directory = await mkdtemp(join(tmpdir(), "convoy-update-"))
    tempDirs.push(directory)
    const executablePath = join(directory, "convoy")
    const bytes = encoder.encode("new binary")
    await writeFile(executablePath, "old binary", { mode: 0o755 })
    await chmod(executablePath, 0o755)

    const result = await runUpdate({
      standalone: true,
      currentVersion: "0.1.0",
      platform: "darwin",
      architecture: "arm64",
      executablePath,
      fetch: fetchFor(releaseFor(bytes), bytes),
      validateCandidate: async (candidate, expected) => {
        expect(candidate.startsWith(directory)).toBe(true)
        expect(expected).toBe("0.2.0")
        expect(await readFile(candidate, "utf8")).toBe("new binary")
        return true
      },
      randomSuffix: () => "test",
    })

    expect(result).toMatchObject({ status: "updated", latestVersion: "0.2.0" })
    expect(await readFile(executablePath, "utf8")).toBe("new binary")
    expect(await readdir(directory)).toEqual(["convoy"])
  })

  test("leaves the current executable intact after network, hash, or replacement failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "convoy-update-failure-"))
    tempDirs.push(directory)
    const executablePath = join(directory, "convoy")
    const bytes = encoder.encode("new binary")
    await writeFile(executablePath, "old binary", { mode: 0o755 })
    await chmod(executablePath, 0o755)

    const release = releaseFor(bytes)
    await expect(
      runUpdate({
        standalone: true,
        currentVersion: "0.1.0",
        platform: "darwin",
        architecture: "arm64",
        executablePath,
        fetch: (async (input: string | URL | Request) => {
          if (String(input) === githubLatestReleaseUrl) return new Response(JSON.stringify(release), { status: 200 })
          throw new Error("network unavailable")
        }) as FetchLike,
      }),
    ).rejects.toThrow("could not download")
    expect(await readFile(executablePath, "utf8")).toBe("old binary")

    await expect(
      runUpdate({
        standalone: true,
        currentVersion: "0.1.0",
        platform: "darwin",
        architecture: "arm64",
        executablePath,
        fetch: fetchFor(release, encoder.encode("tampered binary")),
      }),
    ).rejects.toThrow("digest verification failed")
    expect(await readFile(executablePath, "utf8")).toBe("old binary")

    const guardedFileOps: UpdateFileOps = {
      chmod,
      copyFile,
      rename: async (from, to) => {
        if (String(from).includes(".candidate-") && to === executablePath) throw new Error("permission denied")
        await rename(from, to)
      },
      rm,
      stat,
      writeFile,
    }
    await expect(
      runUpdate({
        standalone: true,
        currentVersion: "0.1.0",
        platform: "darwin",
        architecture: "arm64",
        executablePath,
        fetch: fetchFor(release, bytes),
        fileOps: guardedFileOps,
        validateCandidate: async () => true,
        randomSuffix: () => "failure",
      }),
    ).rejects.toThrow("could not install the update")
    expect(await readFile(executablePath, "utf8")).toBe("old binary")
  })
})
