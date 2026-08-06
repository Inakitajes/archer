/**
 * Terminal window/tab title, for runs that have no TUI.
 *
 * When the dashboard is up its renderer owns stdout, so the title goes through
 * OpenTUI's own setTerminalTitle (which serialises with the paint) instead of
 * anything here. These writers are for --no-tui runs, plus the save/restore
 * pair, which is only ever used outside the renderer's lifetime.
 */

export type TitleOutput = Pick<NodeJS.WriteStream, "write" | "isTTY">

const osc = "\u001b]"
const bel = "\u0007"
/** xterm window-manipulation: 22;2 pushes the window title, 23;2 pops it. */
const pushTitleSequence = "\u001b[22;2t"
const popTitleSequence = "\u001b[23;2t"

function write(sequence: string, output: TitleOutput): boolean {
  if (!output.isTTY || typeof output.write !== "function") return false
  try {
    output.write(sequence)
    return true
  } catch {
    // A closed or redirected stream must never take the run down with it.
    return false
  }
}

/** Sets the window/tab title. Control characters are stripped by the caller. */
export function writeTerminalTitle(title: string, output: TitleOutput = process.stdout): boolean {
  return write(`${osc}2;${title}${bel}`, output)
}

/**
 * Saves the terminal's current title so it can be restored on exit. Without
 * this the tab keeps Convoy's last title (`✓ 7/7 …`) long after the run is
 * gone. Supported by Ghostty, iTerm2, kitty and WezTerm; terminals that ignore
 * it simply keep the old behaviour.
 */
export function pushTerminalTitle(output: TitleOutput = process.stdout): boolean {
  return write(pushTitleSequence, output)
}

export function popTerminalTitle(output: TitleOutput = process.stdout): boolean {
  return write(popTitleSequence, output)
}
