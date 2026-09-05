import { closeSync, openSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { dlopen } from "bun:ffi"

/**
 * A repository-scoped mutation lease shared by automatic finalization and (in
 * later work) close and convoy's own cleanup/publication mutations (design D4).
 * It serializes Convoy's own history-mutating operations; it is not a claim
 * that arbitrary external git processes honor it, so every operation still
 * revalidates expected refs, HEAD, and tree state immediately before mutation.
 *
 * The lease is a kernel `flock` on `convoy/mutation-lease.lock`, held on an
 * open file description for the whole mutation:
 *
 * - **Ownership-safe by construction.** Acquiring, holding, and releasing are
 *   a single kernel operation; there is no read-decide-act window and no
 *   reclamation step, so no interleaving of contenders can move or delete a
 *   live holder's lease. The earlier userspace create/steal design had exactly
 *   such a window (a delayed contender's rename could move a lease acquired
 *   after its liveness check); it is gone structurally, not patched.
 * - **Crash-safe without reclamation.** The kernel releases the lock when the
 *   holding process dies, so a crashed coordinator can never wedge the lease
 *   and a dead holder needs no takeover logic at all.
 * - **Exclusive within a process too.** `flock` is per open file description,
 *   so two `acquire` calls in one process serialize like two processes.
 *
 * `convoy/mutation-lease.json` is a diagnostic sidecar naming the current
 * holder; it plays no correctness role, and a stale sidecar from a dead
 * process never blocks anyone. If the flock binding itself is unavailable,
 * acquisition fails closed rather than degrading to an unsafe userspace lock.
 */

type LeasePayload = {
  holder: string
  pid: number
  acquiredAt: number
}

export class LeaseUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LeaseUnavailableError"
  }
}

// flock(2) operations; see flock(3).
const LOCK_EX = 2
const LOCK_NB = 4
const LOCK_UN = 8

type FlockBinding = {
  symbols: {
    flock: (fd: number, operation: number) => number
  }
}

let flockBinding: FlockBinding | undefined

/** The libc providing flock(2) on this platform; undefined where none is known. */
function libcPath(): string | undefined {
  if (process.platform === "darwin") return "/usr/lib/libSystem.B.dylib"
  if (process.platform === "linux") return "libc.so.6"
  return undefined
}

function loadFlock(): FlockBinding {
  flockBinding ??= (() => {
    const path = libcPath()
    if (!path) throw new Error(`flock is unavailable on ${process.platform}`)
    return dlopen(path, {
      flock: { args: ["i32", "i32"], returns: "i32" },
    }) as unknown as FlockBinding
  })()
  return flockBinding
}

function tryLockExclusive(fd: number): boolean {
  return loadFlock().symbols.flock(fd, LOCK_EX | LOCK_NB) === 0
}

function unlock(fd: number): void {
  try {
    loadFlock().symbols.flock(fd, LOCK_UN)
  } catch {
    // Closing the descriptor releases the lock regardless.
  }
}

async function readInfo(infoPath: string): Promise<LeasePayload | undefined> {
  try {
    return JSON.parse(await readFile(infoPath, "utf8")) as LeasePayload
  } catch {
    return undefined
  }
}

/** Writes the diagnostic sidecar atomically; a failure never affects correctness. */
async function writeInfo(infoPath: string, payload: LeasePayload): Promise<void> {
  try {
    const tmp = `${infoPath}.${crypto.randomUUID()}.tmp`
    await writeFile(tmp, JSON.stringify(payload, null, 2), { flag: "wx" })
    await rename(tmp, infoPath)
  } catch {
    // Diagnostic only.
  }
}

export type MutationLease = {
  /** Releases the lease; removing someone else's sidecar is refused defensively. */
  release(): Promise<void>
}

/**
 * Acquires the repository mutation lease by taking an exclusive kernel lock.
 * The call is non-blocking: when another live holder exists (including another
 * acquire attempt in this same process, since `flock` is per open file
 * description) it fails immediately with `LeaseUnavailableError`. `timeoutMs`
 * is accepted for API compatibility and unused — waiting would only delay a
 * refusal that the caller reports anyway.
 */
export async function acquireMutationLease(commonDir: string, _options: { timeoutMs?: number } = {}): Promise<MutationLease> {
  const dir = join(commonDir, "convoy")
  await mkdir(dir, { recursive: true })
  const lockPath = join(dir, "mutation-lease.lock")
  const infoPath = join(dir, "mutation-lease.json")

  // "a+" creates the lock file when absent; the flock on its open file
  // description is the lease itself. The file's contents are irrelevant.
  const fd = openSync(lockPath, "a+")
  if (!tryLockExclusive(fd)) {
    closeSync(fd)
    const info = await readInfo(infoPath)
    throw new LeaseUnavailableError(
      `another convoy operation holds the repository mutation lease${info?.holder ? ` (${info.holder})` : ""}; retry once it finishes`,
    )
  }

  let released = false
  const payload: LeasePayload = { holder: `pid ${process.pid}`, pid: process.pid, acquiredAt: Date.now() }
  await writeInfo(infoPath, payload)

  return {
    async release() {
      if (released) return
      released = true
      unlock(fd)
      closeSync(fd)
      // Remove the diagnostic sidecar only when it is still ours.
      try {
        const current = await readInfo(infoPath)
        if (current?.pid === process.pid) await removeIfPresent(infoPath)
      } catch {
        // The sidecar is advisory; its absence is fine.
      }
    },
  }
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // Diagnostic only.
  }
}

/** Whether the mutation lease is currently held, probed through a fresh flock attempt. */
export async function mutationLeaseHeld(commonDir: string): Promise<boolean> {
  const lockPath = join(commonDir, "convoy", "mutation-lease.lock")
  let fd: number
  try {
    fd = openSync(lockPath, "a+")
  } catch {
    return false
  }
  try {
    if (tryLockExclusive(fd)) {
      unlock(fd)
      return false
    }
    return true
  } finally {
    closeSync(fd)
  }
}
