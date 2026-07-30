declare const __CONVOY_VERSION__: string | undefined
declare const __CONVOY_COMMIT__: string | undefined
declare const __CONVOY_PLATFORM__: string | undefined

export type VersionInfo = {
  version: string
  commit: string
  platform: string
}

// The release build replaces these constants from package.json and Git. The
// environment fallbacks keep `bun run src/main.ts` useful during development.
const injectedVersion = typeof __CONVOY_VERSION__ === "string" ? __CONVOY_VERSION__ : undefined
const injectedCommit = typeof __CONVOY_COMMIT__ === "string" ? __CONVOY_COMMIT__ : undefined
const injectedPlatform = typeof __CONVOY_PLATFORM__ === "string" ? __CONVOY_PLATFORM__ : undefined

export const versionInfo: VersionInfo = {
  version: injectedVersion ?? process.env.npm_package_version ?? "0.0.0-development",
  commit: injectedCommit ?? process.env.CONVOY_COMMIT ?? "unknown",
  platform: injectedPlatform ?? process.env.CONVOY_PLATFORM ?? `${process.platform}-${process.arch}`,
}

export function formatVersion(info: VersionInfo = versionInfo) {
  return `convoy ${info.version} (commit ${info.commit}, ${info.platform})`
}
