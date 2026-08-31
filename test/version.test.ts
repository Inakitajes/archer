import { describe, expect, test } from "bun:test"

import { compareSemVer, parseSemVer } from "../src/update"
import { formatVersion, majorMinorVersion, shortVersion, versionDetails, versionInfo } from "../src/version"

const released = { version: "0.1.1", commit: "a".repeat(40), platform: "darwin-arm64", release: true }

describe("version formatting", () => {
  test("the header tag marks source checkouts so a dev build never reads as the release", () => {
    expect(shortVersion(released)).toBe("v0.1.1")
    expect(shortVersion({ ...released, release: false })).toBe("v0.1.1-dev")
    // `bun src/main.ts` sets no npm_package_version, so the triple falls all
    // the way through: "v0.0.0-development-dev" would be noise, not a version.
    expect(shortVersion({ ...released, version: "0.0.0-development", release: false })).toBe("dev")
  })

  test("Home condenses a semantic version to its major-minor release line", () => {
    expect(majorMinorVersion(released)).toBe("v0.1")
    expect(majorMinorVersion({ ...released, version: "12.34.56-local+abcdef0", release: false })).toBe("v12.34")
    expect(majorMinorVersion({ ...released, version: "0.0.0-development", release: false })).toBe("dev")
  })

  // install.sh and the self-updater both parse this line to confirm a staged
  // binary is really convoy before it replaces the installed one, so the shape
  // is part of the release contract, not just cosmetics.
  test("--version keeps the shape the installer and self-updater parse", () => {
    expect(formatVersion(released)).toBe(`convoy 0.1.1 (commit ${"a".repeat(40)}, darwin-arm64)`)
    expect(formatVersion(released)).toMatch(/^convoy\s+([^\s(]+)/m)
  })

  // scripts/build.ts injects a `-local` prerelease suffix into local builds, so
  // `make install` shows the same shape but is never confused with the release.
  test("a local build reads as its own prerelease, not the release", () => {
    const local = { ...released, version: "0.1.1-local" }
    expect(shortVersion(local)).toBe("v0.1.1-local")
    expect(formatVersion(local)).toBe(`convoy 0.1.1-local (commit ${"a".repeat(40)}, darwin-arm64)`)
  })

  // scripts/build.ts appends the short commit as SemVer build metadata so a
  // local build names the commit it was built from: `0.1.1-local+aaaaaaa`. The
  // build metadata is ignored for precedence, so such a build still sorts below
  // the matching release and a numeric-only hash with a leading zero (which
  // would be invalid as a prerelease identifier) stays valid SemVer.
  test("a local build carries the short commit as build metadata", () => {
    const local = { ...released, version: "0.1.1-local+aaaaaaa" }
    expect(parseSemVer(local.version)).toBeDefined()
    expect(shortVersion(local)).toBe("v0.1.1-local+aaaaaaa")
    expect(formatVersion(local)).toBe(`convoy 0.1.1-local+aaaaaaa (commit ${"a".repeat(40)}, darwin-arm64)`)
    // Build metadata is ignored: a `-local+<commit>` build is still the same
    // prerelease as a `-local` build, and both sort below the stable release.
    expect(compareSemVer("0.1.1", local.version)).toBeGreaterThan(0)
    expect(compareSemVer(local.version, "0.1.1-local")).toBe(0)
    // A numeric-only short hash with a leading zero stays valid as build
    // metadata (it would be invalid as a prerelease identifier).
    expect(parseSemVer("0.1.1-local+0123456")).toBeDefined()
  })

  // The masthead shows a glanceable short fragment, not the diagnostic hash:
  // git's short-hash convention, matching what scripts/build.ts embeds as
  // local build metadata. A suffix fragment can't be fed to git tooling.
  describe("versionDetails", () => {
    test("the masthead build line keeps a short commit fragment, not the full hash", () => {
      expect(versionDetails(released)).toBe("0.1.1 (aaaaaaa, darwin-arm64)")
    })

    test("an unknown commit renders the unknown fragment", () => {
      expect(versionDetails({ ...released, commit: "unknown" })).toBe("0.1.1 (unknown, darwin-arm64)")
    })

    test("no masthead rendering carries the commit label or a long hash", () => {
      expect(versionDetails(released)).not.toContain("commit")
      expect(versionDetails(released)).not.toMatch(/[0-9a-f]{8,}/)
    })
  })

  test("a source checkout still reports a usable version triple", () => {
    expect(versionInfo.version.length).toBeGreaterThan(0)
    expect(versionInfo.platform).toContain("-")
    expect(typeof versionInfo.release).toBe("boolean")
  })
})
