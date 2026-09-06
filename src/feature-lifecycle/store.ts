import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { dirname, join } from "node:path"

import { execFile } from "../git"

/**
 * The lifecycle store (capability `feature-lifecycle`, design D1): a
 * versioned, repository-local record set under the canonical Git common
 * directory, shared by every worktree of one repository.
 *
 * Layout:
 *
 *   <git-common-dir>/convoy/
 *     repository.json                            # repository UUID + schema version
 *     features/<feature-id>/feature.json         # current association + revision
 *     features/<feature-id>/attempts/<attempt-id>/journal.json
 *     features/<feature-id>/receipts/<attempt-id>.json
 *
 * Identities are opaque UUIDs — branch/change spellings are never encoded into
 * filenames, so renames and reused names cannot alias records. Reads are
 * strictly read-only: nothing in this module creates the repository UUID,
 * locks, or any other file as a side effect of inspection (design D1: reads do
 * not create).
 */

export const lifecycleSchemaVersion = 1

/**
 * Every read returns a typed result (task 1.1): missing, corrupt
 * (parseable-but-invalid), unsupported (a newer schema we must not
 * interpret), and unreadable (I/O or permission failure) are distinct —
 * they are never collapsed into absence, because several safety decisions
 * (fail-closed preflights, "unknown ≠ empty") depend on the difference.
 */
export type StoreRead<T> =
  | { status: "found"; value: T }
  | { status: "missing" }
  | { status: "corrupt"; reason: string }
  | { status: "unsupported"; schemaVersion: unknown }
  | { status: "unreadable"; reason: string }

export type StoreReadError = Extract<StoreRead<never>, { status: "corrupt" | "unsupported" | "unreadable" }>

/** True when a read proves the record exists and validated; false otherwise. */
export function isFound<T>(read: StoreRead<T>): read is { status: "found"; value: T } {
  return read.status === "found"
}

/** The repository UUID record (D1): membership proof for everything under `convoy/`. */
export type RepositoryRecord = {
  schemaVersion: number
  /** Opaque UUID for this repository's shared record set. */
  repositoryId: string
  createdAt: number
}

/** Whether `path` exists (file or directory). */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Parses one JSON document against a validator. `unsupported` is decided by
 * the caller's schema gate — usually a `schemaVersion` comparison — while
 * malformed JSON is `corrupt` and I/O failure is `unreadable`.
 */
export async function readJsonFile<T>(
  path: string,
  validate: (value: unknown) => T | undefined,
  options: { unsupported?: (value: Record<string, unknown>) => boolean } = {},
): Promise<StoreRead<T>> {
  let raw: string
  try {
    raw = await readFile(path, "utf8")
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === "ENOENT") return { status: "missing" }
    return { status: "unreadable", reason: error instanceof Error ? error.message : String(error) }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { status: "corrupt", reason: error instanceof Error ? error.message : String(error) }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "corrupt", reason: "record is not a JSON object" }
  }
  if (options.unsupported?.(parsed as Record<string, unknown>)) {
    return { status: "unsupported", schemaVersion: (parsed as Record<string, unknown>).schemaVersion }
  }
  const value = validate(parsed)
  if (value === undefined) return { status: "corrupt", reason: "record failed validation" }
  return { status: "found", value }
}

/**
 * Writes a JSON document atomically: content lands at `<path>.<uuid>.tmp`
 * first and is renamed into place, so a crash mid-write never exposes a torn
 * record. The caller is responsible for conflict detection (see
 * `withFeatureLock`) and for refusing to write when required evidence
 * cannot be persisted (design D1: required persistence failures stop before
 * the corresponding mutation).
 */
export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${crypto.randomUUID()}.tmp`
  try {
    await Bun.write(tmp, JSON.stringify(value, null, 2) + "\n")
    await rename(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/**
 * Removes a file best-effort (force: true, errors swallowed): used only for
 * superseded scratch state, never for receipts or journals (ordinary cleanup
 * MUST NOT delete recovery evidence — capability feature-lifecycle).
 */
export async function removePath(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true }).catch(() => {})
}

/**
 * The repository's Git common dir, or undefined outside a repository. Every
 * worktree of one repository shares it, which is what makes the record set
 * common (capability feature-lifecycle: worktrees sharing a Git common
 * directory share the records).
 */
export async function lifecycleCommonDir(cwd: string): Promise<string | undefined> {
  return execFile("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, allowFailure: true }).then(
    (result) => (result.exitCode === 0 ? result.stdout.trim() || undefined : undefined),
    () => undefined,
  )
}

/** `<commonDir>/convoy` — the record set root. */
export function lifecycleRoot(commonDir: string): string {
  return join(commonDir, "convoy")
}

function repositoryRecordPath(commonDir: string): string {
  return join(lifecycleRoot(commonDir), "repository.json")
}

export function validateRepositoryRecord(value: unknown): RepositoryRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.repositoryId !== "string" || !isUuid(record.repositoryId)) return undefined
  if (typeof record.createdAt !== "number") return undefined
  return { schemaVersion: lifecycleSchemaVersion, repositoryId: record.repositoryId, createdAt: record.createdAt }
}

/**
 * Reads the repository record. Missing means the store has never been
 * initialized — callers that only inspect (board, specs viewer) must treat
 * that as "no registered features" and never create the file (design D1).
 */
export async function readRepositoryRecord(commonDir: string): Promise<StoreRead<RepositoryRecord>> {
  return readJsonFile(repositoryRecordPath(commonDir), validateRepositoryRecord, {
    unsupported: (value) => typeof value.schemaVersion === "number" && value.schemaVersion > lifecycleSchemaVersion,
  })
}

/**
 * Creates the repository record exactly once. An existing record of any
 * version is returned untouched — even an unreadable one, because
 * overwriting it would silently orphan every feature recorded under the old
 * identity (fail closed).
 */
export async function ensureRepositoryRecord(commonDir: string): Promise<StoreRead<RepositoryRecord>> {
  const existing = await readRepositoryRecord(commonDir)
  if (existing.status !== "missing") return existing
  const record: RepositoryRecord = {
    schemaVersion: lifecycleSchemaVersion,
    repositoryId: crypto.randomUUID(),
    createdAt: Date.now(),
  }
  try {
    await writeJsonFile(repositoryRecordPath(commonDir), record)
  } catch (error) {
    return { status: "unreadable", reason: error instanceof Error ? error.message : String(error) }
  }
  return { status: "found", value: record }
}

/** Opaque UUID form used for repository/feature/attempt identities. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

/**
 * True when `value` is a single, safe path segment: non-empty, not `.`/`..`,
 * not absolute (POSIX or Windows drive), and containing no path separator.
 * Used to validate persisted change ids and capability names on every load —
 * a corrupt or malicious record must never escape the planning root when a
 * read joins it onto a checkout path (design D1/D7: validate relative paths
 * on every load).
 */
export function isSafePathSegment(value: string): boolean {
  if (value === "" || value === "." || value === "..") return false
  if (value.startsWith("/") || value.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return !value.includes("/") && !value.includes("\\")
}

/**
 * True when `value` is a repo-relative path that stays within its root: not
 * absolute (POSIX or Windows drive), and containing no `..` segment. A
 * persisted source path must never escape when joined onto a checkout (design
 * D7: never interpolate unchecked paths; validate relative paths on load).
 */
export function isSafeRelativePath(value: string): boolean {
  if (value === "" || value.startsWith("/") || value.startsWith("\\")) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return !value.split(/[\\/]/).some((segment) => segment === "..")
}

// ── association conflict detection ───────────────────────────────────────

/**
 * Serializes read-modify-write cycles on one feature record (capability
 * feature-lifecycle: concurrent association edits — only one update
 * succeeds, the other requests refreshed inspection). The lock is an
 * exclusive-create sidecar next to the record; it is held only for the
 * duration of the callback and always released, including on throw. A stale
 * lock from a crashed writer is stolen after `staleMs` so recovery is always
 * possible.
 */
export async function withFeatureLock<T>(
  featureDir: string,
  fn: () => Promise<T>,
  options: { staleMs?: number } = {},
): Promise<T> {
  const lockPath = join(featureDir, ".lock")
  await mkdir(featureDir, { recursive: true })
  const staleMs = options.staleMs ?? 30_000
  let handle
  for (;;) {
    try {
      handle = await open(lockPath, "wx")
      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      if (code !== "EEXIST") throw error
      let age = 0
      try {
        age = Date.now() - (await stat(lockPath)).mtimeMs
      } catch {
        continue
      }
      if (age <= staleMs) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 25))
        continue
      }
      await rm(lockPath, { force: true }).catch(() => {})
    }
  }
  try {
    await handle!.write(`${process.pid}\n`)
    return await fn()
  } finally {
    await handle!.close().catch(() => {})
    await rm(lockPath, { force: true }).catch(() => {})
  }
}
