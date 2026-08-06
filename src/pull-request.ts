import { log } from "./log"

/** Resolves the PR number for whatever branch is checked out in `targetDir`. */
export type PullRequestLookup = (targetDir: string, signal: AbortSignal) => Promise<number | undefined>

export type PullRequestLookupOptions = {
  targetDir: string
  onFound: (pr: number) => void
  lookup?: PullRequestLookup
  hasGh?: () => boolean
  timeoutMs?: number
}

const defaultTimeoutMs = 10_000

async function ghPullRequestNumber(targetDir: string, signal: AbortSignal): Promise<number | undefined> {
  const proc = Bun.spawn(["gh", "pr", "view", "--json", "number"], {
    cwd: targetDir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    signal,
  })
  const stdout = await new Response(proc.stdout).text()
  // Non-zero simply means "this branch has no PR" (or gh is not authenticated).
  if ((await proc.exited) !== 0) return undefined
  const parsed = JSON.parse(stdout) as { number?: unknown }
  return typeof parsed.number === "number" ? parsed.number : undefined
}

/**
 * One-shot background lookup of the run's pull request.
 *
 * Deliberately not a poller: a branch's PR number cannot change while the run
 * is going, and the only thing that opens a PR — the finish screen — does so
 * after the run is already over. So asking once at startup is the whole job.
 *
 * Nothing blocks on this; the title simply gains `#52` if and when it lands.
 * The returned cancel() gates a slow answer so it cannot arrive after teardown.
 */
export function startPullRequestLookup(options: PullRequestLookupOptions): () => void {
  const { targetDir, onFound } = options
  const lookup = options.lookup ?? ghPullRequestNumber
  const hasGh = options.hasGh ?? (() => Boolean(Bun.which("gh")))

  // Same probe finish.ts uses before offering to open a PR at all.
  if (!hasGh()) return () => {}

  let cancelled = false
  const controller = new AbortController()
  const timeout = AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs)

  void (async () => {
    try {
      const pr = await lookup(targetDir, AbortSignal.any([controller.signal, timeout]))
      if (!cancelled && pr !== undefined) onFound(pr)
    } catch (error) {
      if (cancelled) return
      log.warn(`couldn't resolve the run's pull request: ${error instanceof Error ? error.message : String(error)}`)
    }
  })()

  return () => {
    cancelled = true
    controller.abort()
  }
}
