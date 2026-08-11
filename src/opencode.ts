import "./polyfills"

import { stat } from "node:fs/promises"
import { createServer } from "node:net"
import { homedir } from "node:os"

import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk/v2"

import type { Config, OpencodeClient } from "@opencode-ai/sdk/v2"

export type OpencodeHandle = {
  client: OpencodeClient
  url: string
  close(): void
}

type StartOpencodeDeps = {
  getFreePort(): Promise<number>
  createServer(options: Parameters<typeof createOpencodeServer>[0]): Promise<{ url: string; close(): void }>
  createClient(options: Parameters<typeof createOpencodeClient>[0]): OpencodeClient
}

export async function startOpencode(
  config: Config,
  signal?: AbortSignal,
  deps?: Partial<StartOpencodeDeps>,
): Promise<OpencodeHandle> {
  const port = await (deps?.getFreePort ?? freePort)()
  const server = await (deps?.createServer ?? createOpencodeServer)({
    hostname: "127.0.0.1",
    port,
    timeout: 30_000,
    signal,
    config,
  })
  const client = (deps?.createClient ?? createOpencodeClient)({ baseUrl: server.url, fetch: fetchWithoutIdleTimeout as typeof fetch })

  return {
    client,
    url: server.url,
    close: server.close,
  }
}

// A client for an opencode server already running elsewhere (a live run's
// server), so `convoy runs` can attach and mirror its event stream.
export function connectOpencode(url: string): OpencodeClient {
  return createOpencodeClient({ baseUrl: url, fetch: fetchWithoutIdleTimeout as typeof fetch })
}

// Bun kills fetch sockets that stay quiet for 5 minutes by default; the SSE
// event stream must outlive that during long tool runs. Bun honors the
// non-standard `timeout: false` since 1.1; on older versions it's ignored,
// which is why no single request is ever relied on for a whole phase.
function fetchWithoutIdleTimeout(request: Request) {
  return fetch(request, { timeout: false } as RequestInit)
}

export type SessionWindowBackend = "zellij" | "ghostty" | "terminal"

// Async on purpose: this is called from the TUI's render path, and a sync
// osascript call would freeze the dashboard while macOS opens the window.
// Inside Zellij it creates a sibling pane. Elsewhere it prefers Ghostty when
// installed; Terminal.app is the fallback that always works on macOS.
// CONVOY_TERMINAL=zellij|ghostty|terminal forces a backend.
export async function openOpencodeSessionWindow(input: {
  url: string
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(
    ["opencode", "attach", input.url, "--dir", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "),
    input.targetDir,
  )
}

// `run --interactive` needs a message and exits immediately without one, so
// the window attaches the full TUI to the run's server instead; --continue
// resumes the run's latest session with its context.
export async function openInteractiveOpencodeWindow(input: {
  url: string
  targetDir: string
}): Promise<SessionWindowBackend> {
  const args = ["opencode", "attach", input.url, "--dir", input.targetDir, "--continue"]
  return openSessionCommand(args.map(shellQuote).join(" "), input.targetDir)
}

// Opens a standalone opencode TUI on a stored session — it starts its own
// server and reads the session from disk — for runs whose live server is gone
// (so `[o]` in a re-opened finished-run dashboard still works).
export async function openStoredSessionWindow(input: {
  targetDir: string
  sessionID: string
}): Promise<SessionWindowBackend> {
  return openSessionCommand(["opencode", input.targetDir, "--session", input.sessionID].map(shellQuote).join(" "), input.targetDir)
}

// Opens a standalone opencode TUI on a brand-new session seeded with an
// initial prompt (--prompt submits it on startup). Standalone on purpose: the
// run's server dies when the finish screen closes, and this window must
// outlive convoy so the user can keep iterating.
export async function openIterateOpencodeWindow(input: {
  targetDir: string
  prompt: string
}): Promise<SessionWindowBackend> {
  const coreCommand = ["opencode", input.targetDir, "--prompt", input.prompt].map(shellQuote).join(" ")
  return openSessionCommand(coreCommand, input.targetDir)
}

/** Builds an iterate-window command that makes the target project the shell's working directory. */
export function iterateSessionShellCommand(input: { targetDir: string; prompt: string }, path = process.env.PATH): string {
  const coreCommand = ["opencode", input.targetDir, "--prompt", input.prompt].map(shellQuote).join(" ")
  return sessionShellCommand(coreCommand, input.targetDir, path)
}

/** Opens a command in a Zellij pane or a new macOS terminal window. Shared with the claude-code runner. */
export async function openSessionCommand(coreCommand: string, cwd?: string): Promise<SessionWindowBackend> {
  return openShellCommand(sessionShellCommand(coreCommand, cwd), cwd)
}

async function openShellCommand(command: string, cwd?: string): Promise<SessionWindowBackend> {
  const forced = process.env.CONVOY_TERMINAL?.toLowerCase()
  // Zellij exports ZELLIJ for every process in a session (usually "0"). Check
  // for presence rather than truthiness so that value is not mistaken for false.
  // Explicit terminal choices still win, which leaves an escape hatch for users
  // who intentionally want a separate macOS window from a Zellij pane.
  if (forced === "zellij" || (!forced && process.env.ZELLIJ !== undefined)) {
    await openInZellij(command, cwd)
    return "zellij"
  }
  if (process.platform !== "darwin") {
    throw new Error("opening a new terminal window is implemented for macOS only; run Convoy inside Zellij to open a session pane")
  }

  if (forced === "terminal") {
    await openInTerminalApp(command)
    return "terminal"
  }
  if (forced === "ghostty" || (await ghosttyInstalled())) {
    try {
      await openInGhostty(command)
      return "ghostty"
    } catch (error) {
      if (forced === "ghostty") throw error
      // Best effort: Ghostty's macOS CLI has no window/tab IPC, so launch
      // failures here are expected on some setups; Terminal always works.
    }
  }
  await openInTerminalApp(command)
  return "terminal"
}

// `zellij action new-pane` launches the command in the current session and
// focuses it. A POSIX shell executes the command string built above, while
// --cwd keeps the pane in the target project, and --close-on-exit removes it
// when OpenCode exits so focus returns to Convoy under Zellij's normal rules.
async function openInZellij(command: string, cwd?: string) {
  await spawnChecked(["zellij", "action", "new-pane", "--close-on-exit", ...(cwd ? ["--cwd", cwd] : []), "--", "sh", "-lc", command])
}

/** Builds the login-shell command, stopping before launch if setup or `cd` fails. */
export function sessionShellCommand(coreCommand: string, cwd?: string, path = process.env.PATH): string {
  return [
    path ? `export PATH=${shellQuote(path)}:$PATH` : "",
    cwd ? `cd ${shellQuote(cwd)}` : "",
    coreCommand,
  ]
    .filter(Boolean)
    .join(" && ")
}

async function ghosttyInstalled() {
  const bundles = ["/Applications/Ghostty.app", `${homedir()}/Applications/Ghostty.app`]
  for (const bundle of bundles) {
    if (await exists(bundle)) return true
  }
  return Bun.which("ghostty") !== null
}

// `open -na` asks macOS to launch a new Ghostty instance; `-e` makes Ghostty
// run the command. A login shell keeps the user's PATH for `opencode`.
async function openInGhostty(command: string) {
  await spawnChecked(["open", "-na", "Ghostty", "--args", "-e", "zsh", "-lc", command])
}

async function openInTerminalApp(command: string) {
  const script = `tell application "Terminal"\nactivate\ndo script ${appleScriptString(command)}\nend tell`
  await spawnChecked(["osascript", "-e", script])
}

async function spawnChecked(cmd: string[]) {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
  const [status, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
  if (status !== 0) throw new Error(stderr.trim() || `${cmd[0]} exited with status ${status}`)
}

async function exists(path: string) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close()
        reject(new Error("couldn't find a free port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function appleScriptString(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}
