import { describe, expect, test } from "bun:test"

import { formatVersion, shortVersion, versionInfo } from "../src/version"

const released = { version: "0.1.1", commit: "a".repeat(40), platform: "darwin-arm64", release: true }

describe("version formatting", () => {
  test("the header tag marks source checkouts so a dev build never reads as the release", () => {
    expect(shortVersion(released)).toBe("v0.1.1")
    expect(shortVersion({ ...released, release: false })).toBe("v0.1.1-dev")
    // `bun src/main.ts` sets no npm_package_version, so the triple falls all
    // the way through: "v0.0.0-development-dev" would be noise, not a version.
    expect(shortVersion({ ...released, version: "0.0.0-development", release: false })).toBe("dev")
  })

  // install.sh and the self-updater both parse this line to confirm a staged
  // binary is really convoy before it replaces the installed one, so the shape
  // is part of the release contract, not just cosmetics.
  test("--version keeps the shape the installer and self-updater parse", () => {
    expect(formatVersion(released)).toBe(`convoy 0.1.1 (commit ${"a".repeat(40)}, darwin-arm64)`)
    expect(formatVersion(released)).toMatch(/^convoy\s+([^\s(]+)/m)
  })

  test("a source checkout still reports a usable version triple", () => {
    expect(versionInfo.version.length).toBeGreaterThan(0)
    expect(versionInfo.platform).toContain("-")
    expect(typeof versionInfo.release).toBe("boolean")
  })
})
