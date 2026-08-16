import { stdout } from "node:process"

import { BoxRenderable, StyledText, TextRenderable, bold, fg, t } from "@opentui/core"

import { startLimitsPoller } from "./limits"
import { parseMarkdown, renderMarkdownDoc, type MarkdownDoc } from "./markdown-render"
import { loadRunSummary } from "./runs"
import {
  formatElapsed,
  formatMoney,
  hintsRow,
  joinLines,
  limitsRow,
  moreHintsMarker,
  padBetween,
  paletteForTerminal,
  plain,
  raw,
  setTheme,
  statusIcon,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import { shortVersion } from "./version"
import { runsRoot } from "./workspace"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { LimitsSnapshot } from "./limits"
import type { RunEntry, RunStatusKind, RunsResolution } from "./runs"
import type { Hint, PaletteColor } from "./tui-theme"

const runStatusStyles: Record<RunStatusKind, { icon: string; color: PaletteColor }> = {
  completed: { icon: "✓", color: "green" },
  failed: { icon: "✗", color: "red" },
  incomplete: { icon: "◐", color: "yellow" },
  empty: { icon: "○", color: "faint" },
  unknown: { icon: "·", color: "faint" },
}

const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const dateColumnWidth = 12 // "10 Jun 12:00"

export class RunsBrowser {
  readonly result: Promise<RunsResolution>

  private resolveResult!: (resolution: RunsResolution) => void
  private selected: number
  private scroll = 0
  private summary?: { runID: string; lines: string[]; scroll: number }
  private summaryLines?: { source: string[]; doc: MarkdownDoc; width: number; value: StyledText[] }
  // A pending retry confirmation: keeps the selected run's id/target until the
  // user answers y/n. Lives in the same modal as the summary (only one modal at
  // a time), so it's set/cleared together with the overlay visibility.
  private confirm?: { runID: string; targetDir?: string; title: string }
  // A subshell owns the terminal while the renderer is suspended; ignore keys.
  private inSubshell = false
  private readonly ticker: ReturnType<typeof setInterval>
  private readonly stopLimits: () => void
  private limits?: LimitsSnapshot
  private readonly headerText: TextRenderable
  private readonly listText: TextRenderable
  private readonly detailsText: TextRenderable
  private readonly footerText: TextRenderable
  private readonly detailsBox: BoxRenderable
  private readonly overlay: BoxRenderable
  private readonly modal: BoxRenderable
  private readonly modalText: TextRenderable
  // Panels repainted when the terminal reports a theme change mid-session.
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: PaletteColor; border?: PaletteColor }> = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    if ((key.ctrl && key.name === "c") || key.raw === "\u0003") {
      key.preventDefault()
      key.stopPropagation()
      this.finish({ type: "exit" })
      return
    }
    if (this.inSubshell) return
    key.preventDefault()
    key.stopPropagation()
    if (this.confirm) this.handleConfirmKey(key)
    else if (this.summary) this.handleSummaryKey(key)
    else this.handleListKey(key)
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly runs: RunEntry[],
    initialIndex: number,
  ) {
    this.selected = initialIndex
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })

    const shell = new BoxRenderable(renderer, {
      id: "convoy-runs-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })

    const header = this.panel({
      id: "convoy-runs-header",
      height: 5,
      borderColor: theme.border,
      backgroundColor: theme.bg,
    })

    const body = new BoxRenderable(renderer, {
      id: "convoy-runs-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const selectFromList = (event: { y: number; preventDefault(): void; stopPropagation(): void }) => {
      event.preventDefault()
      event.stopPropagation()
      if (this.summary) return
      const row = this.scroll + event.y - this.listText.y
      if (row < 0 || row >= this.runs.length) return
      this.selected = row
      this.render()
    }

    // The wheel steps the run selection, one row per tick, list and details alike.
    const wheelFromList = (event: WheelEvent) => {
      const delta = wheelDelta(event)
      if (delta === 0 || this.summary) return
      event.preventDefault()
      event.stopPropagation()
      this.moveSelection(Math.sign(delta))
    }

    const list = this.panel({
      id: "convoy-runs-list",
      height: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " runs ",
      titleAlignment: "left",
      onMouseDown: selectFromList,
      onMouseScroll: wheelFromList,
    })
    list.text.onMouseDown = selectFromList
    list.text.onMouseScroll = wheelFromList

    const details = this.panel({
      id: "convoy-runs-details",
      width: this.detailsWidth(),
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " details ",
      titleAlignment: "left",
      onMouseScroll: wheelFromList,
    })
    details.text.onMouseScroll = wheelFromList

    const footer = this.panel({
      id: "convoy-runs-footer",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
    })

    this.headerText = header.text
    this.listText = list.text
    this.detailsText = details.text
    this.detailsBox = details.box
    this.footerText = footer.text

    this.paletteTargets.push(
      { box: shell, background: "bg" },
      { box: header.box, background: "bg", border: "border" },
      { box: list.box, background: "bg", border: "borderDim" },
      { box: details.box, background: "bg", border: "borderDim" },
      { box: footer.box, background: "bg", border: "borderDim" },
    )

    body.add(list.box)
    body.add(details.box)
    shell.add(header.box)
    shell.add(body)
    shell.add(footer.box)
    renderer.root.add(shell)

    this.overlay = new BoxRenderable(renderer, {
      id: "convoy-runs-summary-overlay",
      position: "absolute",
      left: 0,
      top: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      alignItems: "center",
      justifyContent: "center",
      visible: false,
    })
    this.modal = new BoxRenderable(renderer, {
      id: "convoy-runs-summary-modal",
      border: true,
      borderStyle: "rounded",
      borderColor: theme.accent,
      backgroundColor: theme.overlay,
      title: " summary ",
      titleAlignment: "left",
      paddingX: 2,
      paddingY: 1,
    })
    this.modalText = new TextRenderable(renderer, { content: "", fg: theme.text, width: "100%", height: "100%" })
    this.modal.add(this.modalText)
    this.overlay.add(this.modal)
    renderer.root.add(this.overlay)
    this.paletteTargets.push({ box: this.modal, background: "overlay", border: "accent" })

    // While the summary is up its full-screen overlay owns the wheel.
    const wheelFromSummary = (event: WheelEvent) => {
      const summary = this.summary
      const delta = wheelDelta(event)
      if (!summary || delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      summary.scroll += delta
      this.render()
    }
    this.overlay.onMouseScroll = wheelFromSummary
    this.modal.onMouseScroll = wheelFromSummary
    this.modalText.onMouseScroll = wheelFromSummary

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)

    this.ticker = setInterval(() => this.render(), 250)
    this.stopLimits = startLimitsPoller((snapshot) => {
      this.limits = snapshot
    })
    this.render()
  }

  private handleListKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        this.moveSelection(-1)
        break
      case "down":
      case "j":
        this.moveSelection(1)
        break
      case "pageup":
        this.moveSelection(-this.listHeight())
        break
      case "pagedown":
        this.moveSelection(this.listHeight())
        break
      case "home":
        this.moveSelection(-this.runs.length)
        break
      case "end":
        this.moveSelection(this.runs.length)
        break
      case "g":
        this.moveSelection(key.shift ? this.runs.length : -this.runs.length)
        break
      case "return":
      case "linefeed":
      case "o": {
        // Re-enter the run's dashboard: attach if it's live, else inspect it.
        const run = this.selectedRun()
        this.finish({ type: "open", runID: run.runID, targetDir: run.targetDir })
        break
      }
      case "r": {
        // `r` retries: a brand-new run from step 0 with the original config,
        // gated by a confirmation modal. `R` (shift+r) keeps the old resume
        // behavior, which continues the run from where it stopped.
        const run = this.selectedRun()
        if (key.shift) {
          this.finish({ type: "resume", runID: run.runID, targetDir: run.targetDir })
        } else {
          this.confirm = { runID: run.runID, targetDir: run.targetDir, title: run.title }
          this.render()
        }
        break
      }
      case "s":
        this.openSummary()
        break
      case "d":
        void this.openSubshell()
        break
      case "q":
      case "escape":
        this.finish({ type: "exit" })
        break
    }
  }

  private handleSummaryKey(key: KeyEvent) {
    const summary = this.summary
    if (!summary) return
    const page = Math.max(1, this.summaryHeight())
    switch (key.name) {
      case "up":
      case "k":
        summary.scroll -= 1
        break
      case "down":
      case "j":
        summary.scroll += 1
        break
      case "pageup":
        summary.scroll -= page
        break
      case "pagedown":
      case "space":
        summary.scroll += page
        break
      case "home":
        summary.scroll = 0
        break
      case "end":
        summary.scroll = Number.MAX_SAFE_INTEGER
        break
      case "g":
        summary.scroll = key.shift ? Number.MAX_SAFE_INTEGER : 0
        break
      case "q":
      case "escape":
      case "s":
      case "b":
        this.summary = undefined
        break
    }
    this.render()
  }

  private handleConfirmKey(key: KeyEvent) {
    const confirm = this.confirm
    if (!confirm) return
    switch (key.name) {
      case "y":
      case "return":
      case "linefeed":
        this.finish({ type: "retry", runID: confirm.runID, targetDir: confirm.targetDir })
        break
      case "n":
      case "escape":
      case "q":
        this.confirm = undefined
        this.render()
        break
    }
  }

  private moveSelection(delta: number) {
    this.selected = Math.max(0, Math.min(this.runs.length - 1, this.selected + delta))
    this.render()
  }

  private selectedRun() {
    return this.runs[this.selected]!
  }

  private openSummary() {
    const run = this.selectedRun()
    this.summary = { runID: run.runID, lines: ["loading…"], scroll: 0 }
    this.render()
    loadRunSummary(run)
      .then((body) => {
        if (this.summary?.runID !== run.runID) return
        this.summary.lines = body.replace(/\r\n/g, "\n").split("\n")
        this.render()
      })
      .catch((error: unknown) => {
        if (this.summary?.runID !== run.runID) return
        this.summary.lines = [`couldn't read summary: ${error instanceof Error ? error.message : String(error)}`]
        this.render()
      })
  }

  // A child process can't change the parent shell's cwd, so "go to the run dir"
  // means dropping the user into their own shell already positioned there.
  private async openSubshell() {
    const run = this.selectedRun()
    const shell = process.env.SHELL || "/bin/sh"
    this.inSubshell = true
    this.renderer.suspend()
    stdout.write(`opening ${shell} in ${run.dir}; type "exit" to return to convoy\n`)
    try {
      const proc = Bun.spawn([shell], {
        cwd: run.dir,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
        env: process.env,
      })
      await proc.exited
    } finally {
      this.inSubshell = false
      this.renderer.resume()
      this.render()
    }
  }

  private finish(resolution: RunsResolution) {
    clearInterval(this.ticker)
    this.stopLimits()
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    if (!this.renderer.isDestroyed) this.renderer.destroy()
    this.resolveResult(resolution)
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme[target.background]
      if (target.border) target.box.borderColor = theme[target.border]
    }
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: "rounded",
      paddingX: 1,
      paddingY: 0,
      ...options,
    })
    const text = new TextRenderable(this.renderer, {
      content: "",
      fg: theme.text,
      width: "100%",
      height: "100%",
    })
    box.add(text)
    return { box, text }
  }

  // Squeezes on narrow terminals so the run list always keeps the wider half.
  private detailsWidth() {
    return Math.max(30, Math.min(46, this.renderer.width - 64))
  }

  private listHeight() {
    // header (5) + footer (3) + list panel borders (2).
    return Math.max(3, this.renderer.height - 10)
  }

  private summaryHeight() {
    return Math.max(4, this.renderer.height - 8)
  }

  private summaryWidth() {
    return this.modalWidth() - 6
  }

  // The modal body and its scroll indicator both need the rendered summary, so
  // without a memo every frame parsed the same markdown twice. Keyed on the
  // loaded line array, and holding the parsed document so a resize re-wraps
  // without re-parsing.
  private summaryRows(lines: string[], width: number): StyledText[] {
    const memo = this.summaryLines
    if (memo?.source === lines && memo.width === width) return memo.value
    const doc = memo?.source === lines ? memo.doc : parseMarkdown(lines)
    const value = renderMarkdownDoc(doc, width)
    this.summaryLines = { source: lines, doc, width, value }
    return value
  }

  private render() {
    if (this.renderer.isDestroyed) return
    const now = Date.now()
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const detailsWidth = this.detailsWidth()
    const listWidth = Math.max(36, this.renderer.width - detailsWidth - 7)

    this.detailsBox.width = detailsWidth
    this.headerText.content = this.headerContent(innerWidth)
    this.listText.content = this.listContent(listWidth)
    this.detailsText.content = this.detailsContent(now, detailsWidth - 4)
    this.footerText.content = this.footerContent(innerWidth)
    this.renderSummaryModal()
    this.renderer.requestRender()
  }

  private headerContent(width: number) {
    const completed = this.runs.filter((run) => run.statusKind === "completed").length
    const failed = this.runs.filter((run) => run.statusKind === "failed").length
    const cost = this.runs.reduce((sum, run) => sum + (run.cost ?? 0), 0)

    const title: TextChunk[] = [
      bold(fg(theme.accent)("◆ convoy")),
      fg(theme.faint)(` ${shortVersion()}`),
      fg(theme.faint)("  ·  "),
      fg(theme.text)("run history"),
    ]
    const totals: TextChunk[] = [
      fg(theme.text)(`${this.runs.length} run${this.runs.length === 1 ? "" : "s"}`),
      fg(theme.faint)("  ·  "),
      fg(theme.green)(`✓ ${completed}`),
      raw("  "),
      fg(failed > 0 ? theme.red : theme.faint)(`✗ ${failed}`),
      fg(theme.faint)("  ·  "),
      fg(theme.green)(formatMoney(cost)),
    ]
    const line1 = padBetween(title, totals, width)
    const line2 = t`${fg(theme.dim)(truncate(runsRoot(), width))}`
    return joinLines([line1, line2, limitsRow(this.limits, Date.now(), width)])
  }

  private listContent(width: number) {
    const visible = this.listHeight()
    if (this.selected < this.scroll) this.scroll = this.selected
    if (this.selected >= this.scroll + visible) this.scroll = this.selected - visible + 1

    const slice = this.runs.slice(this.scroll, this.scroll + visible)
    return joinLines(slice.map((run, offset) => this.runRow(run, this.scroll + offset === this.selected, width)))
  }

  private runRow(run: RunEntry, selected: boolean, width: number) {
    const style = runStatusStyles[run.statusKind]
    const cost = run.cost !== undefined ? formatMoney(run.cost) : "—"
    // A live run reads as "running" with a green ● regardless of how many
    // phases have finished so far, so it stands out as attachable.
    const statusLabel = run.live ? "running" : run.status
    const statusColor = run.live ? theme.green : theme[style.color]
    const left: TextChunk[] = [
      selected ? fg(theme.accent)("▸ ") : raw("  "),
      run.live ? fg(theme.green)("●") : fg(theme[style.color])(style.icon),
      raw(" "),
      fg(selected ? theme.text : theme.dim)(formatRunDate(run).padEnd(dateColumnWidth)),
      raw("  "),
      fg(theme.dim)(cost.padStart(7)),
      raw("  "),
    ]
    const status = fg(statusColor)(statusLabel)
    // marker (2) + icon (2) + date + cost (9) + gaps; status keeps its column.
    const titleWidth = Math.max(12, width - dateColumnWidth - 16 - statusLabel.length)
    const title = truncate(run.title, titleWidth)
    left.push(selected ? bold(fg(theme.text)(title)) : fg(theme.text)(title))
    return padBetween(left, [status], width)
  }

  private detailsContent(now: number, width: number) {
    const run = this.selectedRun()
    const style = runStatusStyles[run.statusKind]
    const lines: StyledText[] = []

    lines.push(t`${bold(fg(theme.text)(truncate(run.title, width)))}`)
    lines.push(t`${fg(theme.dim)(run.runID)}`)
    lines.push(plain(""))

    const date = runDate(run)
    if (date) lines.push(new StyledText([fg(theme.faint)("started "), fg(theme.text)(formatRunDateLong(date))]))
    if (run.targetDir) lines.push(new StyledText([fg(theme.faint)("target  "), fg(theme.text)(truncatePath(run.targetDir, width - 8))]))
    lines.push(new StyledText([fg(theme.faint)("run dir "), fg(theme.text)(truncatePath(run.dir, width - 8))]))

    const statusChunks: TextChunk[] = [
      fg(theme.faint)("status  "),
      run.live ? fg(theme.green)("● running") : fg(theme[style.color])(`${style.icon} ${run.status}`),
    ]
    if (run.cost !== undefined) {
      statusChunks.push(fg(theme.faint)("  ·  "), fg(theme.green)(formatMoney(run.cost)))
      if (run.advisorCost) statusChunks.push(fg(theme.faint)(` · executor ${formatMoney(run.executorCost ?? 0)} + advisor ${formatMoney(run.advisorCost)}`))
    }
    lines.push(new StyledText(statusChunks))
    if (run.live) lines.push(new StyledText([fg(theme.faint)("        "), fg(theme.dim)("enter to attach live")]))

    lines.push(plain(""))
    lines.push(t`${fg(theme.faint)("─".repeat(Math.max(1, width)))}`)
    if (run.phases.length === 0) {
      lines.push(t`${fg(theme.dim)("no phase metadata for this run")}`)
    } else {
      for (const phase of run.phases) {
        const left: TextChunk[] = [statusIcon(phase.status, now), raw(" "), fg(theme.text)(truncate(phase.name, 16))]
        const right: TextChunk[] = []
        if (phase.durationMs !== undefined) right.push(fg(theme.dim)(formatElapsed(phase.durationMs)))
        if (phase.cost !== undefined) right.push(fg(theme.faint)(` ${formatMoney(phase.cost + (phase.advisorCost ?? 0))}`))
        if (phase.advisorCost) right.push(fg(theme.teal)(` (${formatMoney(phase.advisorCost)} adv)`))
        lines.push(padBetween(left, right, width))
      }
    }
    return joinLines(lines)
  }

  private footerContent(width: number) {
    if (this.confirm) {
      const hints: Hint[] = [
        { keys: "y", label: "retry", priority: 2 },
        { keys: "n/esc", label: "cancel", priority: 1 },
      ]
      return hintsRow(hints, [], width, { style: "spaced", overflow: moreHintsMarker })
    }
    if (this.summary) {
      const summary = this.summary
      const rendered = this.summaryRows(summary.lines, this.summaryWidth())
      const maxScroll = Math.max(0, rendered.length - this.summaryHeight())
      const position = maxScroll === 0 ? "all" : `${Math.min(100, Math.round((Math.min(summary.scroll, maxScroll) / maxScroll) * 100))}%`
      const hints: Hint[] = [
        { keys: "↑/↓", label: "scroll", priority: 2, tone: "dim" },
        { keys: "pgup/pgdn", label: "page", priority: 3 },
        { keys: "esc", label: "back", priority: 1 },
      ]
      return hintsRow(hints, [[fg(theme.faint)(position)]], width, { style: "spaced", overflow: moreHintsMarker })
    }

    const hints: Hint[] = [
      { keys: "↑/↓", label: "select", priority: 3, tone: "dim" },
      { keys: "enter", label: "open", priority: 2 },
      { keys: "r", label: "etry", priority: 4, style: "glued" },
      { keys: "R", label: "resume", priority: 5 },
      { keys: "s", label: "ummary", priority: 6, style: "glued" },
      { keys: "d", label: "ir", priority: 7, style: "glued" },
      { keys: "q", label: "uit", priority: 1, style: "glued" },
    ]
    const right: TextChunk[] = [fg(theme.faint)(`${this.selected + 1}/${this.runs.length}`)]
    return hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker })
  }

  private modalWidth() {
    return Math.max(44, this.renderer.width - 10)
  }

  private renderSummaryModal() {
    const summary = this.summary
    const confirm = this.confirm
    this.overlay.visible = Boolean(summary || confirm)
    if (!summary && !confirm) return

    const boxWidth = this.modalWidth()
    if (confirm) {
      this.renderConfirmModal(boxWidth)
      return
    }

    const visible = this.summaryHeight()
    const rendered = this.summaryRows(summary!.lines, this.summaryWidth())
    summary!.scroll = Math.max(0, Math.min(summary!.scroll, rendered.length - visible))

    const lines = rendered.slice(summary!.scroll, summary!.scroll + visible)
    while (lines.length < visible) lines.push(plain(""))

    this.modal.title = ` summary · ${summary!.runID} `
    this.modal.width = boxWidth
    this.modal.height = visible + 4
    this.modalText.content = joinLines(lines)
  }

  // The retry confirmation reuses the summary modal: it's a small, focused
  // prompt that spells out what "retry" does (a fresh run from step 0) so the
  // user doesn't confuse it with resume, which continues the old run.
  private renderConfirmModal(boxWidth: number) {
    const confirm = this.confirm!
    const innerWidth = Math.max(36, boxWidth - 6)
    const lines: StyledText[] = [
      t`${bold(fg(theme.text)("Retry this run from the start?"))}`,
      plain(""),
      t`${fg(theme.faint)("A new run starts at step 0 using the original")}`,
      t`${fg(theme.faint)("prompt and pipeline config — a fresh copy, not a resume.")}`,
      plain(""),
      new StyledText([fg(theme.faint)("run     "), fg(theme.dim)(confirm.runID)]),
      new StyledText([fg(theme.faint)("prompt  "), fg(theme.text)(truncate(confirm.title, innerWidth - 9))]),
      plain(""),
      t`${fg(theme.accent)("y")} ${fg(theme.text)("retry")}   ${fg(theme.faint)("n / esc")} ${fg(theme.dim)("cancel")}`,
    ]
    this.modal.title = " retry "
    this.modal.width = boxWidth
    this.modal.height = lines.length + 4
    this.modalText.content = joinLines(lines)
  }
}

// The run ID's timestamp is authoritative; createdAt only covers runs whose
// metadata survived.
function runDate(run: RunEntry): Date | undefined {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(run.runID)
  if (match) return new Date(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!, +match[6]!)
  if (run.createdAt) return new Date(run.createdAt)
  return undefined
}

function formatRunDate(run: RunEntry): string {
  const date = runDate(run)
  if (!date) return "—"
  return `${date.getDate()} ${months[date.getMonth()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function formatRunDateLong(date: Date): string {
  return `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

function pad2(value: number) {
  return value.toString().padStart(2, "0")
}

// Paths overflow on the left so the project/run name stays readable.
function truncatePath(value: string, max: number) {
  if (value.length <= max) return value
  return `…${value.slice(-(Math.max(1, max - 1)))}`
}

// Terminal wheel events arrive as mouse "scroll" with a direction and a tick
// count; normalized to a signed line delta (up = negative, like PgUp).
type WheelEvent = {
  scroll?: { direction: string; delta: number }
  preventDefault(): void
  stopPropagation(): void
}

function wheelDelta(event: WheelEvent): number {
  const scroll = event.scroll
  if (!scroll || (scroll.direction !== "up" && scroll.direction !== "down")) return 0
  const magnitude = Math.max(1, Math.round(scroll.delta || 1))
  return scroll.direction === "up" ? -magnitude : magnitude
}
