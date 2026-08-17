import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, join } from "node:path"

export type PrdHistoryEntry = {
  runID: string
  pipeline: string
  /** Absent when HEAD was detached when the run started. */
  branch?: string
  timestamp: number
  /** Basename of the verbatim prompt file in the history directory. */
  file: string
}

export function prdHistoryDir(targetDir: string): string {
  return join(targetDir, ".convoy", "prd-history")
}

export async function ensurePrdHistoryGitignore(dir: string): Promise<void> {
  const path = join(dir, ".gitignore")
  try {
    if ((await readFile(path, "utf8")) === "*\n") return
  } catch (error) {
    if (!isErrno(error, "ENOENT")) throw error
    try {
      await writeFile(path, "*\n", { flag: "wx" })
    } catch (writeError) {
      // A concurrent run may have created it after the read above.
      if (!isErrno(writeError, "EEXIST")) throw writeError
    }
    return
  }

  // Restore the invariant if a user or a previous version left a stale file.
  await writeFile(path, "*\n")
}

export async function writePrdHistory(input: {
  targetDir: string
  runID: string
  prompt: string
  pipeline: string
  branch?: string
}): Promise<void> {
  const dir = prdHistoryDir(input.targetDir)
  await mkdir(dir, { recursive: true })
  await ensurePrdHistoryGitignore(dir)

  const file = `${input.runID}.prd.md`
  await writeFile(join(dir, file), input.prompt, { mode: 0o600 })

  const entry: PrdHistoryEntry = {
    runID: input.runID,
    pipeline: input.pipeline,
    ...(input.branch ? { branch: input.branch } : {}),
    timestamp: Date.now(),
    file,
  }
  // appendFile opens in append mode, keeping each small JSONL record one append.
  // Mode 0o600 on creation matches the prompt files: the index records branch and
  // pipeline names the user may not want exposed to other local accounts.
  await appendFile(join(dir, "index.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
}

/** Returns an empty index when history has not been created yet, and skips corrupt JSONL records. */
export async function readPrdHistoryIndex(targetDir: string): Promise<PrdHistoryEntry[]> {
  let body: string
  try {
    body = await readFile(join(prdHistoryDir(targetDir), "index.jsonl"), "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return []
    throw error
  }

  const entries: PrdHistoryEntry[] = []
  for (const line of body.split("\n")) {
    if (!line.trim()) continue
    try {
      const entry = parseEntry(JSON.parse(line))
      if (entry) entries.push(entry)
    } catch {
      // One incomplete or manually edited line must not hide the remaining history.
    }
  }
  return entries
}

export function pickPrdHistory(
  entries: readonly PrdHistoryEntry[],
  options: { branch?: string; excludeRunID?: string; fileExists: (entry: PrdHistoryEntry) => boolean },
): PrdHistoryEntry | undefined {
  if (!options.branch) return undefined

  let oldest: PrdHistoryEntry | undefined
  for (const entry of entries) {
    if (entry.runID === options.excludeRunID || entry.branch !== options.branch || !options.fileExists(entry)) continue
    if (!oldest || entry.timestamp < oldest.timestamp || (entry.timestamp === oldest.timestamp && entry.runID < oldest.runID)) {
      oldest = entry
    }
  }
  return oldest
}

export function prdHistoryFile(targetDir: string, entry: PrdHistoryEntry): string {
  if (!isHistoryFileName(entry.file)) throw new Error(`invalid PRD history file name: ${entry.file}`)
  return join(prdHistoryDir(targetDir), entry.file)
}

function parseEntry(value: unknown): PrdHistoryEntry | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.runID !== "string" ||
    typeof record.pipeline !== "string" ||
    typeof record.timestamp !== "number" ||
    !Number.isFinite(record.timestamp) ||
    typeof record.file !== "string" ||
    !isHistoryFileName(record.file) ||
    (record.branch !== undefined && typeof record.branch !== "string")
  ) {
    return undefined
  }
  return {
    runID: record.runID,
    pipeline: record.pipeline,
    ...(typeof record.branch === "string" ? { branch: record.branch } : {}),
    timestamp: record.timestamp,
    file: record.file,
  }
}

function isHistoryFileName(value: string): boolean {
  return value === basename(value) && value.endsWith(".prd.md") && value.length > ".prd.md".length
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === code
}
