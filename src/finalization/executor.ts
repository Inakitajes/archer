import { findSuspiciousStagedFiles, statusPorcelain, currentHead } from "../git"

/**
 * The bounded, non-interactive commit executor for automatic finalization
 * (design D4, task 2.5). Unlike `commitAsUser`, whose inherited terminal lets
 * signing or hooks wait on a human forever, this executor:
 *
 * - keeps the user's whole git config — identity, `commit.gpgsign`, hooks —
 *   so the resulting commit is operator-authored and signed exactly like a
 *   hand-written one, with no `--no-verify` or unsigned fallback;
 * - closes stdin and disables terminal credential prompts, so an unattended
 *   coordinator can never hang waiting for input;
 * - bounds the operation with a deadline (default 120s) and terminates the
 *   git process on timeout, capturing its diagnostics for the outcome.
 *
 * Interactive-only signing or a hook that needs a terminal therefore fails
 * visibly within the deadline instead of silently degrading protection.
 */

export const defaultGitOperationTimeoutMs = 120_000

export type BoundedCommitResult = {
  sha: string
}

export type BoundedCommitOptions = {
  timeoutMs?: number
}

export class BoundedCommitError extends Error {
  constructor(
    message: string,
    readonly diagnostics: string,
  ) {
    super(message)
    this.name = "BoundedCommitError"
  }
}

/**
 * Commits whatever is already staged, as the operator, under a hard deadline.
 * Secret-file protection runs here too: the staged set is scanned before the
 * commit, and a suspicious path aborts the commit without leaving history
 * half-written (the caller still owns any reset it promised).
 */
export async function boundedCommitAsOperator(message: string, cwd: string, options: BoundedCommitOptions = {}): Promise<BoundedCommitResult> {
  const before = await currentHead(cwd)
  const status = await statusPorcelain(cwd)
  const suspicious = findSuspiciousStagedFiles(status)
  if (suspicious.length > 0) {
    throw new BoundedCommitError(
      `refusing to commit files that look like they contain secrets: ${suspicious.join(", ")}. Add them to .gitignore (or remove them) and retry.`,
      "",
    )
  }

  const { stdout, stderr, exitCode } = await boundedExec(["commit", "-m", message], cwd, options.timeoutMs ?? defaultGitOperationTimeoutMs)
  if (exitCode !== 0) {
    throw new BoundedCommitError(`git commit failed (exit ${exitCode})`, (stderr || stdout).trim())
  }

  const sha = await currentHead(cwd)
  if (!sha || sha === before) {
    throw new BoundedCommitError("git commit reported success but HEAD did not advance", (stderr || stdout).trim())
  }
  return { sha }
}

export type BoundedExecResult = {
  stdout: string
  stderr: string
  exitCode: number
}

/** Exit codes observed when the spawned process was killed by a signal (SIGTERM). */
const killedExitCodes = new Set([143, 271, -1])

/**
 * Runs one git command under the executor's contract: closed stdin, no
 * terminal credential prompts, captured output, deadline with process kill.
 */
export async function boundedExec(args: string[], cwd: string, timeoutMs = defaultGitOperationTimeoutMs): Promise<BoundedExecResult> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    // Closed stdin: nothing downstream can block on input.
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  })
  proc.stdin?.end()

  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // Already exited.
    }
  }, timeoutMs)
  timer.unref?.()

  let exitCode: number
  try {
    exitCode = await proc.exited
  } finally {
    clearTimeout(timer)
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  if (killedExitCodes.has(exitCode)) {
    throw new BoundedCommitError(`git ${args.join(" ")} was terminated after ${Math.round(timeoutMs / 1000)}s`, (stderr || stdout).trim())
  }
  return { stdout, stderr, exitCode }
}
