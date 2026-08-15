declare const __CONVOY_VERSION__: string | undefined
declare const __CONVOY_COMMIT__: string | undefined
declare const __CONVOY_PLATFORM__: string | undefined

export type VersionInfo = {
  version: string
  commit: string
  platform: string
  /** False on `bun run src/main.ts`, where nothing was injected at build time. */
  release: boolean
}

// The release build replaces these constants from package.json and Git; a local
// `make install` build injects the same constants but with a `-local` prerelease
// suffix on the version (see scripts/build.ts), so a local binary never reads as
// the release that shares its number. The environment fallbacks keep
// `bun run src/main.ts` useful during development.
const injectedVersion = typeof __CONVOY_VERSION__ === "string" ? __CONVOY_VERSION__ : undefined
const injectedCommit = typeof __CONVOY_COMMIT__ === "string" ? __CONVOY_COMMIT__ : undefined
const injectedPlatform = typeof __CONVOY_PLATFORM__ === "string" ? __CONVOY_PLATFORM__ : undefined

const developmentVersion = "0.0.0-development"

export const versionInfo: VersionInfo = {
  version: injectedVersion ?? process.env.npm_package_version ?? developmentVersion,
  commit: injectedCommit ?? process.env.CONVOY_COMMIT ?? "unknown",
  platform: injectedPlatform ?? process.env.CONVOY_PLATFORM ?? `${process.platform}-${process.arch}`,
  release: injectedVersion !== undefined,
}

export function formatVersion(info: VersionInfo = versionInfo) {
  return `convoy ${info.version} (commit ${info.commit}, ${info.platform})`
}

// The TUI header has room for a tag, not a build line. Source checkouts fall
// back to package.json's version, so they are marked: a dev build must never
// read as the release that shares its number. When even that fallback is
// missing there is no number worth showing, just the fact that it's a checkout.
export function shortVersion(info: VersionInfo = versionInfo) {
  if (info.release) return `v${info.version}`
  return info.version === developmentVersion ? "dev" : `v${info.version}-dev`
}
