import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

import { log } from "./log"

/** The injectable terminal I/O a single-key confirmation can target, kept
 * structurally compatible with the process streams so key-driver tests can
 * feed answers and capture prompts (shared by `convoy finish` and `close`). */
export type AskIo = {
  input?: NodeJS.ReadableStream
  output?: {
    write(text: string): unknown
  }
}

/**
 * Single-key confirmation in the style finish originally owned: raw-mode
 * SIGINT handling (Ctrl+C resolves the prompt) and an EOF-must-resolve rule —
 * a stdin that reaches EOF (a pipe, a closed terminal) resolves rather than
 * leaving the close/finish hanging. Code, not prose: one prompt implementation
 * shared by `finish` and `close`, so their SIGINT/EOF semantics cannot drift
 * (SC-3).
 */
export async function ask(question: string, io: AskIo = {}): Promise<string> {
  // Bun's readline types only accept the exact process streams; the injectable
  // I/O is structurally compatible, so the cast stays at this one boundary.
  const prompt = createInterface({ input: (io.input ?? stdin) as typeof stdin, output: (io.output ?? stdout) as typeof stdout })
  const controller = new AbortController()
  let interrupted = false
  prompt.on("SIGINT", () => {
    interrupted = true
    controller.abort()
  })
  const closed = new Promise<string>((resolve) => prompt.once("close", () => resolve("")))
  try {
    const answer = await Promise.race([prompt.question(question, { signal: controller.signal }), closed])
    return answer.trim().toLowerCase()
  } catch (error) {
    if (interrupted && error instanceof Error && error.name === "AbortError") {
      ;(io.output ?? stdout).write("\n")
      return ""
    }
    throw error
  } finally {
    prompt.close()
  }
}

/** Whether convoy can still ask the user anything in this invocation. */
export function isInteractiveTerminal(): boolean {
  return Boolean(stdin.isTTY && stdout.isTTY)
}

/** A single question asked on the terminal under the current input lock. */
export type TerminalPrompt = {
  ask(question: string, options?: { signal?: AbortSignal }): Promise<string>
}

/**
 * Serializes terminal input across the phase gate and the permission gate.
 *
 * A `--no-tui` parallel run can have a failed member holding its decision gate
 * on stdin while a live sibling in the same `models:`/`parallel` batch raises a
 * permission prompt. Without an arbiter the two readlines race for the same
 * stdin, so one input can answer the wrong prompt and the two prompts
 * interleave. `withInput` hands each block an exclusive prompt handle, so only
 * one readline is ever open at a time across both flows.
 */
export type TerminalInput = {
  withInput<T>(fn: (prompt: TerminalPrompt) => Promise<T>): Promise<T>
}

/** Ctrl+C at a terminal prompt; the caller maps it to an action (e.g. abort). */
export class TerminalInterrupt extends Error {
  constructor() {
    super("terminal interrupt")
    this.name = "TerminalInterrupt"
  }
}

export function createTerminalInput(): TerminalInput {
  // A promise chain acting as a mutex: each block runs only after the previous
  // one settles, whether it resolved or rejected, so a failed prompt never
  // wedges the next one waiting on stdin.
  let tail: Promise<void> = Promise.resolve()
  return {
    withInput(fn) {
      const result = tail.then(() => fn(realPrompt))
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
}

const realPrompt: TerminalPrompt = {
  ask(question, options) {
    return askReadline(question, options?.signal)
  },
}

/**
 * One readline question. Ctrl+C is surfaced as `TerminalInterrupt` so callers
 * can distinguish "the user wants out" from a real prompt failure and map it
 * to the right action instead of leaving a request unanswered or a gate hung.
 */
function askReadline(question: string, signal?: AbortSignal): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  let interrupted = false
  // Raw-mode input never raises a process SIGINT; readline surfaces Ctrl+C
  // here, so without this listener the question would just hang.
  rl.on("SIGINT", () => {
    interrupted = true
    rl.close()
  })
  return (signal ? rl.question(question, { signal }) : rl.question(question))
    .catch((error: unknown) => {
      if (interrupted) throw new TerminalInterrupt()
      // An aborted signal surfaces as an AbortError; treat it as a deliberate
      // interrupt too, so a shutdown during a prompt doesn't read as success.
      if (error instanceof Error && error.name === "AbortError") throw new TerminalInterrupt()
      throw error
    })
    .finally(() => {
      try {
        rl.close()
      } catch (error) {
        log.warn(`[terminal-input] couldn't close readline: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
}
