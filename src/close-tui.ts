import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg, t } from "@opentui/core"

import {
  applyCloseEvent,
  initialCloseChecklistState,
  type CloseChecklistState,
  type CloseChecklistRowStatus,
} from "./close-presentation"
import type { CloseEvent, CloseMessageProposal } from "./feature-close"
import {
  hintsRow,
  joinLines,
  paletteForTerminal,
  plain,
  raw,
  setTheme,
  shortPath,
  statusIcon,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import { shortVersion } from "./version"
import { sceneForRoute, type TuiRoute, type TuiScene } from "./tui-session"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { Hint } from "./tui-theme"

export type CloseMessageDecision = "accept" | "edit" | "cancel"
export type CloseFollowUpId = "push" | "worktree" | "branch"
export type CloseFollowUpStatus = "available" | "running" | "completed" | "failed" | "unavailable"

export type CloseFollowUpItem = {
  id: CloseFollowUpId
  label: string
  detail: string
  command?: string
  status: CloseFollowUpStatus
  error?: string
}

export type CloseFollowUpResolution = { type: "run"; id: CloseFollowUpId } | { type: "done" }

type CloseTuiMode = "progress" | "message" | "followups" | "failure"

type CloseTuiInput = {
  on(event: "end" | "close", listener: () => void): unknown
  off(event: "end" | "close", listener: () => void): unknown
}

/**
 * The real interactive close surface. Unlike the former cursor-up writer this
 * owns an OpenTUI alternate screen and keeps progress, the commit gate,
 * optional cleanup, and failures inside one coherent interface.
 */
export class CloseTui {
  private destroyed = false
  private state: CloseChecklistState
  private mode: CloseTuiMode = "progress"
  private message?: CloseMessageProposal
  private messageNotice?: string
  private messageChoice = 0
  private followUps: CloseFollowUpItem[] = []
  private selectedFollowUp = 0
  private failure?: string
  private inputClosed = false
  private resolveMessage?: (decision: CloseMessageDecision) => void
  private resolveFollowUp?: (resolution: CloseFollowUpResolution) => void
  private resolveDismiss?: () => void

  private readonly headerText: TextRenderable
  private readonly headerBox: BoxRenderable
  private readonly contentText: TextRenderable
  private readonly contentBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly footerBox: BoxRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; border?: "border" | "borderDim" }> = []

  private readonly handleThemeMode = (mode: unknown) => {
    if (mode !== "dark" && mode !== "light") return
    setTheme(paletteForTerminal(mode, terminalBackgroundHex(this.renderer)))
    this.applyPalette()
    this.render()
  }

  private readonly handleInputEnd = () => {
    if (this.inputClosed) return
    this.inputClosed = true
    if (this.mode === "message") this.finishMessage("cancel")
    else if (this.mode === "followups") this.finishFollowUp({ type: "done" })
    else if (this.mode === "failure") {
      const resolve = this.resolveDismiss
      this.resolveDismiss = undefined
      resolve?.()
    }
  }

  private readonly handleKeyPress = (key: KeyEvent) => {
    key.preventDefault()
    key.stopPropagation()
    const interrupted = (key.ctrl && key.name === "c") || key.raw === "\u0003"
    if (this.mode === "message") {
      if (interrupted || key.name === "escape" || key.name === "q" || key.name === "n") {
        if (interrupted) this.scene?.requestInterrupt()
        this.finishMessage("cancel")
        return
      }
      if (key.name === "y") {
        this.finishMessage("accept")
        return
      }
      if (key.name === "e") {
        this.finishMessage("edit")
        return
      }
      if (key.name === "left" || key.name === "h" || (key.name === "tab" && key.shift)) this.moveMessageChoice(-1)
      else if (key.name === "right" || key.name === "l" || key.name === "tab") this.moveMessageChoice(1)
      else if (key.name === "return" || key.name === "linefeed") this.finishMessage((["accept", "edit", "cancel"] as const)[this.messageChoice]!)
      return
    }
    if (this.mode === "followups") {
      if (interrupted || key.name === "escape" || key.name === "q") {
        if (interrupted) this.scene?.requestInterrupt()
        this.finishFollowUp({ type: "done" })
        return
      }
      if (key.name === "up" || key.name === "k") this.moveFollowUp(-1)
      else if (key.name === "down" || key.name === "j") this.moveFollowUp(1)
      else if (key.name === "return" || key.name === "linefeed") this.runSelectedFollowUp()
      else if (key.name === "p") this.runFollowUpShortcut("push")
      else if (key.name === "w") this.runFollowUpShortcut("worktree")
      else if (key.name === "b") this.runFollowUpShortcut("branch")
      return
    }
    if (this.mode === "failure" && (interrupted || key.name === "escape" || key.name === "q" || key.name === "return" || key.name === "linefeed")) {
      if (interrupted) this.scene?.requestInterrupt()
      const resolve = this.resolveDismiss
      this.resolveDismiss = undefined
      resolve?.()
    }
    // Progress intentionally ignores cancellation: git mutations cannot be
    // safely interrupted halfway through without a resumable engine signal.
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly targetDir: string,
    initialState: CloseChecklistState = initialCloseChecklistState(),
    private readonly input: CloseTuiInput = process.stdin,
    private readonly scene?: TuiScene,
  ) {
    this.state = initialState
    const mount = this.scene?.root ?? renderer.root

    const shell = new BoxRenderable(renderer, {
      id: "convoy-close-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })
    const header = this.panel({
      id: "convoy-close-header",
      height: 3,
      borderColor: theme.border,
      title: ` convoy close ${shortVersion()} `,
      titleAlignment: "left",
    })
    const content = this.panel({
      id: "convoy-close-content",
      flexGrow: 1,
      width: "100%",
      borderColor: theme.borderDim,
      title: " closing ",
      titleAlignment: "left",
    })
    const footer = this.panel({
      id: "convoy-close-footer",
      height: 3,
      borderColor: theme.borderDim,
    })

    this.headerText = header.text
    this.headerBox = header.box
    this.contentText = content.text
    this.contentBox = content.box
    this.footerText = footer.text
    this.footerBox = footer.box
    this.paletteTargets.push(
      { box: shell },
      { box: header.box, border: "border" },
      { box: content.box, border: "borderDim" },
      { box: footer.box, border: "borderDim" },
    )

    shell.add(header.box)
    shell.add(content.box)
    shell.add(footer.box)
    mount.add(shell)
    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    input.on("end", this.handleInputEnd)
    input.on("close", this.handleInputEnd)
    this.render()
  }

  onEvent(event: CloseEvent): void {
    this.state = applyCloseEvent(this.state, event)
    this.mode = "progress"
    this.render()
  }

  snapshot(): CloseChecklistState {
    return this.state
  }

  confirmMessage(proposal: CloseMessageProposal, notice?: string): Promise<CloseMessageDecision> {
    this.mode = "message"
    this.message = proposal
    this.messageNotice = notice
    this.messageChoice = 0
    this.render()
    if (this.inputClosed) return Promise.resolve("cancel")
    return new Promise((resolve) => {
      this.resolveMessage = resolve
    })
  }

  selectFollowUp(items: CloseFollowUpItem[]): Promise<CloseFollowUpResolution> {
    this.mode = "followups"
    this.setFollowUps(items)
    if (this.inputClosed) return Promise.resolve({ type: "done" })
    return new Promise((resolve) => {
      this.resolveFollowUp = resolve
    })
  }

  /** Refreshes action state while an operation runs, without opening a second input promise. */
  updateFollowUps(items: CloseFollowUpItem[]): void {
    this.mode = "followups"
    this.setFollowUps(items)
  }

  showFailure(message: string): Promise<void> {
    this.mode = "failure"
    // Preflight blockers are already present as structured rows. Repeating the
    // thrown aggregate below them would render every blocker twice.
    this.failure = this.state.preflightFailed ? undefined : message
    this.render()
    if (this.inputClosed) return Promise.resolve()
    return new Promise((resolve) => {
      this.resolveDismiss = resolve
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.renderer.keyInput.off("keypress", this.handleKeyPress)
    this.renderer.off("theme_mode", this.handleThemeMode)
    this.input.off("end", this.handleInputEnd)
    this.input.off("close", this.handleInputEnd)
    if (!this.scene && !this.renderer.isDestroyed) this.renderer.destroy()
  }

  /** Releases raw mode/alternate-screen ownership for git, $EDITOR, or credential prompts. */
  async withTerminal<T>(action: () => Promise<T>): Promise<T> {
    this.renderer.suspend()
    try {
      return await action()
    } finally {
      if (!this.renderer.isDestroyed) {
        this.renderer.resume()
        this.render()
      }
    }
  }

  private finishMessage(decision: CloseMessageDecision) {
    const resolve = this.resolveMessage
    if (!resolve) return
    this.resolveMessage = undefined
    this.mode = "progress"
    this.render()
    resolve(decision)
  }

  private moveMessageChoice(delta: number) {
    this.messageChoice = (this.messageChoice + delta + 3) % 3
    this.render()
  }

  private setFollowUps(items: CloseFollowUpItem[]) {
    const selectedId = this.followUps[this.selectedFollowUp]?.id
    this.followUps = items
    const retained = selectedId ? items.findIndex((item) => item.id === selectedId) : -1
    this.selectedFollowUp = retained >= 0 ? retained : Math.min(this.selectedFollowUp, Math.max(0, items.length - 1))
    this.render()
  }

  private moveFollowUp(delta: number) {
    if (this.followUps.length === 0) return
    this.selectedFollowUp = Math.max(0, Math.min(this.followUps.length - 1, this.selectedFollowUp + delta))
    this.render()
  }

  private runSelectedFollowUp() {
    const item = this.followUps[this.selectedFollowUp]
    if (!item || (item.status !== "available" && item.status !== "failed")) return
    this.finishFollowUp({ type: "run", id: item.id })
  }

  private runFollowUpShortcut(id: CloseFollowUpId) {
    const index = this.followUps.findIndex((item) => item.id === id)
    if (index < 0) return
    this.selectedFollowUp = index
    this.runSelectedFollowUp()
  }

  private finishFollowUp(resolution: CloseFollowUpResolution) {
    const resolve = this.resolveFollowUp
    if (!resolve) return
    this.resolveFollowUp = undefined
    resolve(resolution)
  }

  private render() {
    if (this.destroyed || this.renderer.isDestroyed || this.scene?.isClosed) return
    const width = Math.max(24, this.renderer.width - 6)
    this.headerText.content = t`${fg(theme.dim)("dir ")}${fg(theme.text)(shortPath(this.targetDir, Math.max(8, width - 4)))}`
    this.contentBox.title = this.contentTitle()
    this.contentText.content = this.content(width)
    this.footerText.content = this.footer(width)
    this.renderer.requestRender()
  }

  private contentTitle(): string {
    if (this.mode === "message") return " commit message "
    if (this.mode === "followups") return " optional follow-ups "
    if (this.mode === "failure") return " close stopped "
    return " closing "
  }

  private content(width: number): StyledText {
    if (this.mode === "message") return this.messageContent(width)
    if (this.mode === "followups") return this.followUpsContent(width)
    return this.progressContent(width)
  }

  private progressContent(width: number): StyledText {
    const lines: StyledText[] = []
    if (this.state.preflightFailed) {
      lines.push(t`${bold(fg(theme.red)("Preflight failed"))}`)
      lines.push(plain(""))
      for (const blocker of this.state.preflightFailed) lines.push(t`${fg(theme.red)("✗")} ${fg(theme.text)(truncate(blocker, Math.max(8, width - 2)))}`)
    } else {
      if (this.state.preflight) {
        lines.push(t`${fg(theme.dim)("preflight  ")}${fg(theme.text)(truncate(this.state.preflight, Math.max(8, width - 11)))}`)
        lines.push(plain(""))
      }
      for (const row of this.state.rows) {
        const detail = row.detail ? `— ${row.status === "skipped" ? "skipped: " : ""}${row.detail}` : row.status === "running" ? "…" : ""
        lines.push(
          new StyledText([
            raw("  "),
            statusIcon(row.status, Date.now()),
            raw(" "),
            statusLabel(row.status)(row.step),
            ...(detail ? [raw(row.status === "running" ? "" : " "), fg(theme.dim)(truncate(detail, Math.max(0, width - row.step.length - 6)))] : []),
          ]),
        )
      }
      if (this.state.result) {
        lines.push(plain(""))
        lines.push(t`${bold(fg(theme.green)("Closed"))} ${fg(theme.text)(truncate(`${this.state.result.changeID}: ${this.state.result.branch} → ${this.state.result.baseRef}`, Math.max(8, width - 7)))}`)
      }
    }
    if (this.failure) {
      lines.push(plain(""))
      for (const [index, line] of this.failure.split("\n").entries()) {
        lines.push(t`${index === 0 ? bold(fg(theme.red)(truncate(line, width))) : fg(theme.dim)(truncate(line, width))}`)
      }
    }
    return joinLines(lines)
  }

  private messageContent(width: number): StyledText {
    const proposal = this.message
    if (!proposal) return plain("")
    const lines: StyledText[] = [
      t`${bold(fg(theme.text)("Review the squashed commit message before it lands."))}`,
    ]
    if (proposal.error) lines.push(t`${fg(theme.yellow)("The writing model failed; this is the deterministic fallback.")}`)
    if (this.messageNotice) lines.push(t`${fg(theme.yellow)(truncate(this.messageNotice, width))}`)
    lines.push(plain(""), t`${fg(theme.faint)("─".repeat(Math.max(1, width)))}`)
    for (const line of proposal.message.split("\n")) lines.push(t`${fg(theme.text)(truncate(line, width))}`)
    lines.push(t`${fg(theme.faint)("─".repeat(Math.max(1, width)))}`, plain(""))
    const labels = ["Accept", "Edit in $EDITOR", "Cancel"]
    labels.forEach((label, index) => {
      const selected = index === this.messageChoice
      lines.push(new StyledText([selected ? fg(theme.accent)("▸ ") : raw("  "), selected ? bold(fg(theme.text)(label)) : fg(theme.dim)(label)]))
    })
    return joinLines(lines)
  }

  private followUpsContent(width: number): StyledText {
    const lines: StyledText[] = []
    if (this.state.result) {
      lines.push(t`${bold(fg(theme.green)("Closed"))} ${fg(theme.text)(truncate(`${this.state.result.changeID}: ${this.state.result.branch} → ${this.state.result.baseRef}`, Math.max(8, width - 7)))}`)
      lines.push(plain(""))
    }
    lines.push(t`${fg(theme.dim)("Nothing below runs automatically. Choose an action or press q when done.")}`, plain(""))
    this.followUps.forEach((item, index) => {
      const selected = index === this.selectedFollowUp
      const icon = followUpIcon(item.status)
      const status = followUpStatusLabel(item.status)
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), icon, raw(" "), selected ? bold(fg(theme.text)(item.label)) : fg(theme.text)(item.label)]
      lines.push(new StyledText([...left, fg(theme.dim)(`  ${status}`)]))
      if (selected) {
        lines.push(t`${fg(theme.dim)(`    ${truncate(item.detail, Math.max(8, width - 4))}`)}`)
        if (item.command) lines.push(t`${fg(theme.faint)(`    ${truncate(item.command, Math.max(8, width - 4))}`)}`)
        if (item.error) lines.push(t`${fg(theme.red)(`    ${truncate(item.error, Math.max(8, width - 4))}`)}`)
      }
    })
    return joinLines(lines)
  }

  private footer(width: number): StyledText {
    if (this.mode === "message") {
      const hints: Hint[] = [
        { keys: "←/→", label: "choose", priority: 4 },
        { keys: "enter", label: "confirm", priority: 1 },
        { keys: "e", label: "dit", priority: 2, style: "glued" },
        { keys: "esc", label: "cancel", priority: 3 },
      ]
      return hintsRow(hints, [], width, { style: "spaced" })
    }
    if (this.mode === "followups") {
      const hints: Hint[] = [
        { keys: "enter", label: "run / retry", priority: 1 },
        { keys: "p/w/b", label: "action", priority: 3 },
        { keys: "q", label: "done", priority: 2 },
      ]
      return hintsRow(hints, [], width, { style: "spaced" })
    }
    if (this.mode === "failure") {
      return hintsRow([{ keys: "enter/q", label: "close", priority: 1 }], [], width, { style: "spaced" })
    }
    return t`${fg(theme.dim)("Close is running. Git mutations finish before input is accepted.")}`
  }

  private applyPalette() {
    for (const target of this.paletteTargets) {
      target.box.backgroundColor = theme.bg
      if (target.border) target.box.borderColor = theme[target.border]
    }
  }

  private panel(options: BoxOptions) {
    const box = new BoxRenderable(this.renderer, {
      border: true,
      borderStyle: "rounded",
      paddingX: 1,
      paddingY: 0,
      backgroundColor: theme.bg,
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
}

export async function openCloseTui(targetDir: string, initialState?: CloseChecklistState, route?: TuiRoute): Promise<CloseTui> {
  if (route) {
    const scene = sceneForRoute(route, "convoy-close-scene")!
    return new CloseTui(route.session.renderer, targetDir, initialState, process.stdin, scene)
  }
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new CloseTui(renderer, targetDir, initialState)
}

function statusLabel(status: CloseChecklistRowStatus): ReturnType<typeof fg> {
  if (status === "completed") return fg(theme.green)
  if (status === "failed") return fg(theme.red)
  if (status === "running") return fg(theme.accent)
  if (status === "skipped") return fg(theme.dim)
  return fg(theme.faint)
}

function followUpIcon(status: CloseFollowUpStatus): TextChunk {
  if (status === "completed") return fg(theme.green)("✓")
  if (status === "running") return fg(theme.accent)("▸")
  if (status === "failed") return fg(theme.red)("✗")
  if (status === "unavailable") return fg(theme.faint)("⊘")
  return fg(theme.accent)("○")
}

function followUpStatusLabel(status: CloseFollowUpStatus): string {
  if (status === "available") return "available"
  if (status === "running") return "running…"
  if (status === "completed") return "done"
  if (status === "failed") return "failed — enter to retry"
  return "unavailable"
}
