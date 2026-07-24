export type ClipboardResult = "copied-native" | "copied-osc52" | "unsupported" | "transport-failed"

export type ClipboardOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  which?: (command: string) => string | null
  runNative?: (command: string[], text: string) => Promise<boolean>
}

/** Copies a report without feeding large local payloads through OpenTUI's fixed OSC52 buffer. */
export async function copyReportToClipboard(text: string, copyOSC52: (text: string) => boolean, options: ClipboardOptions = {}): Promise<ClipboardResult> {
  const env = options.env ?? process.env
  const remote = Boolean(env.SSH_CONNECTION || env.SSH_TTY || env.MOSH_CONNECTION)
  if (!remote) {
    const command = nativeClipboardCommand(options.platform ?? process.platform, options.which ?? Bun.which)
    if (command) {
      const copied = await (options.runNative ?? runNativeClipboard)(command, text).catch(() => false)
      if (copied) return "copied-native"
    }
  }
  try {
    if (copyOSC52(text)) return "copied-osc52"
  } catch {
    return "transport-failed"
  }
  return Buffer.byteLength(text, "utf8") > 750 ? "transport-failed" : "unsupported"
}

export function nativeClipboardCommand(platform: NodeJS.Platform, which: (command: string) => string | null): string[] | undefined {
  if (platform === "darwin" && which("pbcopy")) return ["pbcopy"]
  if (platform === "linux") {
    if (which("wl-copy")) return ["wl-copy"]
    if (which("xclip")) return ["xclip", "-selection", "clipboard"]
  }
  if (platform === "win32" && which("clip.exe")) return ["clip.exe"]
  return undefined
}

/** Dynamic OSC52 writer; unlike OpenTUI 0.3.0 it does not truncate at a 1 KiB native buffer. */
export function writeClipboardOSC52(text: string, output: Pick<NodeJS.WriteStream, "write" | "isTTY"> = process.stdout): boolean {
  if (!output.isTTY) return false
  // A false return from write() is backpressure — the payload was accepted and
  // still flushes — never a transport failure. Only a synchronous throw (which
  // copyReportToClipboard maps to "transport-failed") means the terminal
  // couldn't receive the sequence.
  output.write(`\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}\u0007`)
  return true
}

async function runNativeClipboard(command: string[], text: string): Promise<boolean> {
  const child = Bun.spawn(command, { stdin: "pipe", stdout: "ignore", stderr: "ignore" })
  child.stdin.write(text)
  child.stdin.end()
  return (await child.exited) === 0
}
