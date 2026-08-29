import { readFile } from "node:fs/promises"

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg, t } from "@opentui/core"

import { copyReportToClipboard, writeClipboardOSC52, type ClipboardResult } from "./clipboard"
import type { FeatureRow, WorktreeWithoutSpec } from "./control-board"
import { parseMarkdown, renderMarkdownDoc, type MarkdownDoc } from "./markdown-render"
import { stripYamlFrontmatter } from "./openspec"
import { groupChangeArtifacts, specGroupSource, type SpecGroup, type SpecsChangeEntry, type SpecsResolution, type SpecsView } from "./specs"
import {
  clipChunks,
  hintsRow,
  joinLines,
  moreHintsMarker,
  padBetween,
  paletteForTerminal,
  plain,
  raw,
  setTheme,
  shortPath,
  terminalBackgroundHex,
  theme,
  truncate,
} from "./tui-theme"
import { shortVersion } from "./version"

import type { BoxOptions, CliRenderer, KeyEvent, TextChunk } from "@opentui/core"
import type { Hint } from "./tui-theme"

/** Below this width the list and details stack vertically (same breakpoint as runs). */
const compactSpecsMaxWidth = 84

/**
 * One row of the navigation list. The three board sections — Active Changes,
 * Worktrees without spec, Canonical Specs — are peers, separated by headers
 * so each is independently reachable while scrolling.
 */
type ListRow =
  | { kind: "header"; label: string; section: "changes" | "worktrees" | "specs" }
  | { kind: "change"; change: SpecsChangeEntry }
  | { kind: "worktree"; worktree: WorktreeWithoutSpec }
  | { kind: "spec"; path: string }

export class SpecsBrowser {
  readonly result: Promise<SpecsResolution>

  private resolveResult!: (resolution: SpecsResolution) => void
  /** "root": the three-section entity list; "detail": one subject's reading pane. */
  private level: "root" | "detail" = "root"
  /** Set while the immersive reader replaces the chrome (detail level only). */
  private fullscreen = false
  // The first selectable row sits under the leading header when changes exist;
  // the constructor moves the cursor past any header so an empty first section
  // still opens on a reachable row (same rule as runs).
  private selectedRow = 1
  private scroll = 0
  /** Set while a change/spec was entered: the detail level's subject. */
  private subject?: { kind: "change"; change: SpecsChangeEntry } | { kind: "spec"; path: string }
  private groups: SpecGroup[] = []
  private selectedGroup = 0
  private detailScroll = 0
  /** Outcome of the last copy attempt, reported in the reader's title bar. */
  private copyStatus?: ClipboardResult
  /** Scroll position for the fullscreen reader's title bar (`top` / `end` / `%` / `all`). */
  private readerPosition = ""
  /** Artifact markdown read lazily, keyed by repo-relative file; failures become placeholders. */
  private readonly bodies = new Map<string, string>()
  private readonly docs = new Map<string, MarkdownDoc>()

  private readonly headerText: TextRenderable
  private readonly headerBox: BoxRenderable
  private readonly bodyBox: BoxRenderable
  private readonly listText: TextRenderable
  private readonly listBox: BoxRenderable
  private readonly detailsText: TextRenderable
  private readonly detailsBox: BoxRenderable
  private readonly footerText: TextRenderable
  private readonly footerBox: BoxRenderable
  private readonly paletteTargets: Array<{ box: BoxRenderable; background: "bg"; border?: "border" | "borderDim" }> = []

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
    key.preventDefault()
    key.stopPropagation()
    if (this.level === "root") this.handleRootKey(key)
    else this.handleDetailKey(key)
  }

  constructor(
    private readonly renderer: CliRenderer,
    private readonly view: SpecsView,
    // Clipboard deps are constructor-injected exactly like the dashboard's
    // copyReport, so tests swap the transport instead of shelling out.
    private readonly copyReport: typeof copyReportToClipboard = copyReportToClipboard,
  ) {
    this.result = new Promise((resolve) => {
      this.resolveResult = resolve
    })
    // Land on the first non-header row (the first change, or the first spec
    // when there are no changes). A header is a dead row — enter/apply/iterate
    // no-op on it — so the browser must never park the cursor there.
    const firstSelectable = this.rows.findIndex((row) => row.kind !== "header")
    this.selectedRow = firstSelectable >= 0 ? firstSelectable : 0

    const shell = new BoxRenderable(renderer, {
      id: "convoy-specs-shell",
      width: "100%",
      height: "100%",
      backgroundColor: theme.bg,
      flexDirection: "column",
      paddingX: 1,
      gap: 0,
    })

    // Minimal chrome (one header content line): the live counts ride a single
    // row; there is no static location line.
    const header = this.panel({
      id: "convoy-specs-header",
      height: 3,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: ` convoy control ${shortVersion()} `,
      titleAlignment: "left",
    })

    const body = new BoxRenderable(renderer, {
      id: "convoy-specs-body",
      width: "100%",
      flexGrow: 1,
      flexDirection: "row",
      gap: 1,
    })

    const wheel = (event: WheelEvent) => {
      const delta = wheelDelta(event)
      if (delta === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (this.level === "root") this.moveSelection(delta)
      else this.detailScroll += delta
      this.render()
    }

    const list = this.panel({
      id: "convoy-specs-list",
      height: "100%",
      flexGrow: 1,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " browse ",
      titleAlignment: "left",
      onMouseScroll: wheel,
    })
    list.text.onMouseScroll = wheel

    const details = this.panel({
      id: "convoy-specs-details",
      width: this.detailsWidth(),
      height: "100%",
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
      title: " details ",
      titleAlignment: "left",
      onMouseScroll: wheel,
    })
    details.text.onMouseScroll = wheel

    const footer = this.panel({
      id: "convoy-specs-footer",
      height: 3,
      borderColor: theme.borderDim,
      backgroundColor: theme.bg,
    })

    this.headerText = header.text
    this.headerBox = header.box
    this.bodyBox = body
    this.listText = list.text
    this.listBox = list.box
    this.detailsText = details.text
    this.detailsBox = details.box
    this.footerText = footer.text
    this.footerBox = footer.box

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

    renderer.keyInput.on("keypress", this.handleKeyPress)
    renderer.on("theme_mode", this.handleThemeMode)
    this.render()
  }

  // ── keys ────────────────────────────────────────────────────────────────

  private handleRootKey(key: KeyEvent) {
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
        this.jumpSelection(-this.rows.length)
        break
      case "end":
        this.jumpSelection(this.rows.length)
        break
      case "g":
        this.jumpSelection(key.shift ? this.rows.length : -this.rows.length)
        break
      case "return":
      case "linefeed":
      case "o":
        this.enterSelected()
        break
      case "a": {
        const change = this.selectedChange()
        if (change) this.finish({ type: "apply-change", changeID: change.id })
        break
      }
      case "i": {
        const change = this.selectedChange()
        if (change) this.finish({ type: "iterate-change", changeID: change.id })
        break
      }
      case "s": {
        const change = this.selectedChange()
        if (change && this.featureFor(change)?.stage === "stranded") this.finish({ type: "spin-change", changeID: change.id })
        break
      }
      case "c": {
        const feature = this.selectedFeature()
        if (feature?.worktreeDir && feature.branch) {
          this.finish({ type: "continue-change", changeID: feature.id, worktreeDir: feature.worktreeDir, branch: feature.branch })
        }
        break
      }
      case "x": {
        const feature = this.selectedFeature()
        if (feature?.worktreeDir && feature.branch) {
          this.finish({ type: "close-change", changeID: feature.id, worktreeDir: feature.worktreeDir, branch: feature.branch })
        }
        break
      }
      case "m": {
        const feature = this.selectedFeature()
        if (feature?.probablyMerged) this.finish({ type: "archive-change-main", changeID: feature.id })
        break
      }
      case "q":
      case "escape":
        this.finish({ type: "exit" })
        break
    }
  }

  private handleDetailKey(key: KeyEvent) {
    // Digits 1–9 jump straight to a tab (the strip labels the numbers).
    if (this.digitTab(key)) {
      this.render()
      return
    }
    // Tabs: arrows/h/l switch. Inside the reader they still work, resetting
    // the pane's scroll; the reader's own close keys come first.
    const tabCount = this.groups.length
    switch (key.name) {
      case "right":
      case "l":
        if (tabCount > 1) this.switchTab(1)
        break
      case "left":
      case "h":
        if (tabCount > 1) this.switchTab(-1)
        break
      case "up":
      case "k":
        this.detailScroll -= 1
        break
      case "down":
      case "j":
        this.detailScroll += 1
        break
      case "pageup":
        this.detailScroll -= this.detailsHeight()
        break
      case "pagedown":
      case "space":
        this.detailScroll += this.detailsHeight()
        break
      case "home":
        this.detailScroll = 0
        break
      case "end":
        this.detailScroll = Number.MAX_SAFE_INTEGER
        break
      case "g":
        this.detailScroll = key.shift ? Number.MAX_SAFE_INTEGER : 0
        break
      case "v":
        // The fullscreen reader exists only at the detail level, so a plain
        // toggle here is exactly the reader's open/close key.
        this.toggleFullscreen()
        return
      case "c":
        if (this.fullscreen) {
          void this.copyActiveTab()
          return
        }
        break
      case "a": {
        const subject = this.subject
        if (subject?.kind === "change") this.finish({ type: "apply-change", changeID: subject.change.id })
        return
      }
      case "i": {
        const subject = this.subject
        if (subject?.kind === "change") this.finish({ type: "iterate-change", changeID: subject.change.id })
        return
      }
      case "escape":
      case "q":
        if (this.fullscreen) {
          this.toggleFullscreen()
          return
        }
        this.leaveSubject()
        break
      case "b":
        if (!this.fullscreen) this.leaveSubject()
        break
    }
    this.render()
  }

  /** Digits 1–9 jump straight to a tab; the strip labels the numbers. */
  private digitTab(key: KeyEvent): boolean {
    if (!key.sequence || !/^[1-9]$/.test(key.sequence)) return false
    const index = Number(key.sequence) - 1
    if (index >= this.groups.length) return true
    this.selectedGroup = index
    this.detailScroll = 0
    void this.loadSelectedGroup().then(() => this.render())
    return true
  }

  private switchTab(delta: number) {
    const next = Math.max(0, Math.min(this.groups.length - 1, this.selectedGroup + delta))
    if (next === this.selectedGroup) return
    this.selectedGroup = next
    this.detailScroll = 0
    void this.loadSelectedGroup().then(() => this.render())
  }

  private toggleFullscreen() {
    this.fullscreen = !this.fullscreen
    this.render()
  }

  /** Copies the active tab's shared source through the dashboard's pipeline. */
  private async copyActiveTab() {
    const group = this.groups[this.selectedGroup]
    if (!group) return
    const source = specGroupSource(group, (file) => this.bodies.get(file) ?? "")
    this.copyStatus = await this.copyReport(source, writeClipboardOSC52)
    this.render()
  }

  // ── navigation ──────────────────────────────────────────────────────────

  private moveSelection(delta: number) {
    const last = this.rows.length - 1
    let next = Math.max(0, Math.min(last, this.selectedRow + delta))
    if (this.rows[next]?.kind === "header") {
      // Headers are dead rows: continue in the movement direction, and when a
      // list boundary blocks that, take the nearest selectable row the other
      // way (the view always has at least one non-header row).
      const direction = Math.sign(delta) || 1
      let forward = next
      while (forward >= 0 && forward <= last && this.rows[forward]!.kind === "header") forward += direction
      if (forward >= 0 && forward <= last) next = forward
      else {
        let backward = next
        while (backward >= 0 && backward <= last && this.rows[backward]!.kind === "header") backward -= direction
        if (backward >= 0 && backward <= last) next = backward
      }
    }
    this.selectedRow = next
    this.render()
  }

  private jumpSelection(delta: number) {
    this.moveSelection(delta)
  }

  private selectedChange(): SpecsChangeEntry | undefined {
    const row = this.rows[this.selectedRow]
    return row?.kind === "change" ? row.change : undefined
  }

  private selectedFeature(): FeatureRow | undefined {
    const change = this.selectedChange()
    return change ? this.featureFor(change) : undefined
  }

  private featureFor(change: SpecsChangeEntry): FeatureRow | undefined {
    return this.view.rows?.find((row) => row.id === change.id)
  }

  /** Enters a change (its reading pane) or a spec (its rendered content). */
  private enterSelected() {
    const row = this.rows[this.selectedRow]
    if (!row || row.kind === "header") return
    if (row.kind === "change") {
      this.subject = { kind: "change", change: row.change }
      this.groups = groupChangeArtifacts(row.change)
    } else if (row.kind === "worktree") {
      return
    } else {
      this.subject = { kind: "spec", path: row.path }
      this.groups = [{ label: "Spec", delta: false, entries: [{ file: row.path }] }]
    }
    this.level = "detail"
    this.selectedGroup = 0
    this.detailScroll = 0
    void this.loadSelectedGroup().then(() => this.render())
    this.render()
  }

  private leaveSubject() {
    if (!this.subject) return
    this.subject = undefined
    this.level = "root"
    this.fullscreen = false
    this.render()
  }

  // ── loading ─────────────────────────────────────────────────────────────

  /** Reads the selected group's markdown lazily — nothing loads until entered. */
  private async loadSelectedGroup() {
    const group = this.groups[this.selectedGroup]
    if (!group) return
    await Promise.all(group.entries.map((entry) => this.loadBody(entry.file)))
  }

  /** Unreadable files degrade to a placeholder instead of failing the browser. */
  private async loadBody(file: string): Promise<string> {
    const cached = this.bodies.get(file)
    if (cached !== undefined) return cached
    let body: string
    try {
      body = stripYamlFrontmatter(await readFile(file, "utf8"))
    } catch {
      const name = file.replaceAll("\\", "/").split("/").pop() ?? file
      body = `(couldn't read ${name})`
    }
    this.bodies.set(file, body.replace(/\r\n/g, "\n"))
    return this.bodies.get(file)!
  }

  // ── layout ──────────────────────────────────────────────────────────────

  private get rows(): ListRow[] {
    const rows: ListRow[] = [{ kind: "header", label: "Active Changes", section: "changes" }]
    for (const change of this.view.changes) rows.push({ kind: "change", change })
    rows.push({ kind: "header", label: "Worktrees without spec", section: "worktrees" })
    for (const worktree of this.view.worktreesWithoutSpec ?? []) rows.push({ kind: "worktree", worktree })
    rows.push({ kind: "header", label: "Canonical Specs", section: "specs" })
    for (const path of this.view.specs) rows.push({ kind: "spec", path })
    return rows
  }

  private detailsWidth() {
    return Math.max(40, Math.min(62, this.renderer.width - 44))
  }

  private bodyHeight() {
    return Math.max(8, this.renderer.height - 6)
  }

  private compactListHeight(bodyHeight: number) {
    return Math.max(5, Math.min(9, Math.floor(bodyHeight * 0.35)))
  }

  private listHeight() {
    // Header (3) + footer (3) + list panel borders (2); compact stacks instead.
    if (this.renderer.width <= compactSpecsMaxWidth) return Math.max(3, this.compactListHeight(this.bodyHeight()) - 2)
    return Math.max(3, this.renderer.height - 8)
  }

  private detailsHeight() {
    return Math.max(4, this.bodyHeight() - 2)
  }

  // Markdown re-wraps on resize but must not re-parse every frame.
  private docFor(source: string, width: number): StyledText[] {
    let doc = this.docs.get(source)
    if (!doc) {
      doc = parseMarkdown(source.split("\n"))
      this.docs.set(source, doc)
    }
    return renderMarkdownDoc(doc, width)
  }

  // ── rendering ───────────────────────────────────────────────────────────

  private render() {
    if (this.renderer.isDestroyed) return
    const innerWidth = Math.max(40, this.renderer.width - 6)
    const compact = this.renderer.width <= compactSpecsMaxWidth
    const detail = this.level === "detail"
    // The fullscreen reader replaces the header, footer, and tab chrome with
    // its title bar (the details panel's border title) plus the full-width pane.
    const reader = detail && this.fullscreen
    this.headerBox.visible = !reader
    this.footerBox.visible = !reader
    const detailsWidth = this.detailsWidth()
    const listWidth = Math.max(36, this.renderer.width - detailsWidth - 7)
    const bodyHeight = this.bodyHeight()

    this.bodyBox.flexDirection = !detail && compact ? "column" : "row"
    if (detail) {
      // The reading pane is full width: the navigation list is hidden and the
      // details panel takes the whole body.
      this.listBox.visible = false
      this.detailsBox.width = "100%"
      this.detailsBox.height = "100%"
    } else if (compact) {
      this.listBox.visible = true
      const listHeight = this.compactListHeight(bodyHeight)
      this.listBox.width = "100%"
      this.listBox.height = listHeight
      this.detailsBox.width = "100%"
      this.detailsBox.height = Math.max(3, bodyHeight - listHeight)
    } else {
      this.listBox.visible = true
      this.listBox.width = "auto"
      this.listBox.height = "100%"
      this.detailsBox.width = detailsWidth
      this.detailsBox.height = "100%"
    }

    this.headerText.content = this.headerContent(innerWidth)
    this.listBox.title = " browse "
    this.listText.content = detail ? "" : this.listContent(compact ? innerWidth : listWidth)
    this.detailsText.content = this.detailsContent((compact && !detail ? innerWidth : detail ? innerWidth : detailsWidth) - 4)
    this.detailsBox.title = this.detailsTitle()
    this.footerText.content = this.footerContent(innerWidth)
    this.renderer.requestRender()
  }

  /** The header's only content line: the live counts, nothing static. */
  private headerContent(width: number) {
    const summary: TextChunk[] = [
      fg(theme.text)(`${this.view.changes.length} change${this.view.changes.length === 1 ? "" : "s"}`),
      fg(theme.faint)("  ·  "),
      fg(theme.text)(`${this.view.specs.length} spec${this.view.specs.length === 1 ? "" : "s"}`),
    ]
    return joinLines([new StyledText(clipChunks(summary, width))])
  }

  /** The details panel's border title doubles as the reader's title bar. */
  private detailsTitle(): string {
    if (this.level !== "detail") return " details "
    const group = this.groups[this.selectedGroup]
    if (this.fullscreen) {
      const subject = this.subject
      const name = subject?.kind === "change" ? subject.change.id : subject ? specDisplayPath(subject.path) : ""
      const status = this.copyStatus ? ` · ${copyStatusLabel(this.copyStatus)}` : ""
      const position = this.readerPosition ? ` · ${this.readerPosition}` : ""
      return ` ${name} · ${group?.label.toLowerCase() ?? "read"}${status} · c copy · v/esc close${position} `
    }
    return group ? ` ${group.label.toLowerCase()} ` : " details "
  }

  private listContent(width: number) {
    const rows = this.rows
    const visible = this.listHeight()
    if (this.selectedRow < this.scroll) this.scroll = this.selectedRow
    if (this.selectedRow >= this.scroll + visible) this.scroll = this.selectedRow - visible + 1

    const slice = rows.slice(this.scroll, this.scroll + visible)
    return joinLines(
      slice.map((row, offset) => {
        const absolute = this.scroll + offset
        const selected = absolute === this.selectedRow
        return this.rowLine(row, selected, width)
      }),
    )
  }

  private rowLine(row: ListRow, selected: boolean, width: number): StyledText {
    if (row.kind === "header") {
      const left: TextChunk[] = [bold(fg(theme.accent)(` ${truncate(row.label.toUpperCase(), width)}`))]
      const count =
        row.section === "changes"
          ? this.view.changes.length
          : row.section === "worktrees"
            ? (this.view.worktreesWithoutSpec?.length ?? 0)
            : this.view.specs.length
      if (count > 0) return new StyledText(left)
      return padBetween(left, [fg(theme.dim)("none")], width)
    }
    if (row.kind === "change") {
      const change = row.change
      const feature = this.featureFor(change)
      const iconColor = feature ? stageColor(feature.stage, feature.liveRuns > 0) : theme.accent
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(iconColor)("◆"), raw(" ")]
      const heading = change.title === change.id ? change.id : `${change.id} — ${change.title}`
      // Title keeps the left; padBetween clips the state column so the name
      // is the thing the eye lands on, matching the runs list.
      const title = truncate(heading, Math.max(12, width - 18))
      left.push(selected ? bold(fg(theme.text)(title)) : fg(theme.text)(title))
      const state = feature ? featureSummaryChunks(feature) : [fg(theme.dim)(artifactCounts(change))]
      return padBetween(left, state, width)
    }
    if (row.kind === "worktree") {
      const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.teal)("◇"), raw(" ")]
      const name = row.worktree.branch ?? shortPath(row.worktree.dir, Math.max(12, width - 4))
      const state = `${row.worktree.runCount} run${row.worktree.runCount === 1 ? "" : "s"}`
      const title = truncate(name, Math.max(12, width - 4 - state.length - 1))
      left.push(selected ? bold(fg(theme.text)(title)) : fg(theme.text)(title))
      return padBetween(left, [fg(theme.dim)(state)], width)
    }
    const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.teal)("◆"), raw(" ")]
    const name = truncate(specDisplayPath(row.path), Math.max(12, width - 4))
    left.push(selected ? bold(fg(theme.text)(name)) : fg(theme.text)(name))
    return padBetween(left, [], width)
  }

  /**
   * The reading pane. Its first content rows are the title row and — when the
   * subject spans more than one group — the tab strip; below them the active
   * tab's markdown scrolls. Single-group subjects render no strip at all.
   */
  private detailsContent(width: number): StyledText {
    if (this.level !== "detail") {
      this.readerPosition = ""
      const row = this.rows[this.selectedRow]
      if (!row || row.kind === "header") return plain("")
      const lines: StyledText[] = []
      if (row.kind === "change") {
        const change = row.change
        const feature = this.featureFor(change)
        lines.push(t`${bold(fg(theme.text)(truncate(change.title, width)))}`)
        lines.push(t`${fg(theme.dim)(`openspec/changes/${change.id}`)}`)
        if (feature) {
          lines.push(plain(""))
          for (const line of featureDetailLines(feature, width)) lines.push(line)
        }
        lines.push(plain(""))
        lines.push(t`${fg(theme.faint)("─".repeat(Math.max(1, width)))}`)
        if (change.artifacts.length === 0) {
          lines.push(t`${fg(theme.dim)("no markdown artifacts found for this change")}`)
        } else {
          for (const group of groupChangeArtifacts(change)) {
            lines.push(new StyledText([fg(theme.text)(group.label)]))
            for (const entry of group.entries) {
              lines.push(new StyledText([raw("  "), fg(theme.dim)(truncate(artifactDisplayPath(entry.file, change.id), Math.max(8, width - 2)))]))
            }
          }
        }
        return joinLines(lines)
      }
      if (row.kind === "worktree") {
        const lines: StyledText[] = []
        lines.push(t`${bold(fg(theme.text)(truncate(row.worktree.branch ?? "worktree", width)))}`)
        lines.push(t`${fg(theme.dim)(shortPath(row.worktree.dir, width))}`)
        lines.push(plain(""))
        lines.push(new StyledText([fg(theme.faint)("runs    "), fg(theme.text)(`${row.worktree.runCount} run${row.worktree.runCount === 1 ? "" : "s"}`)]))
        lines.push(t`${fg(theme.dim)("no OpenSpec change")}`)
        return joinLines(lines)
      }
      const name = specDisplayPath(row.path)
      lines.push(t`${bold(fg(theme.text)(truncate(name, width)))}`)
      lines.push(t`${fg(theme.dim)(shortPath(row.path, width))}`)
      return joinLines(lines)
    }

    const group = this.groups[this.selectedGroup]
    if (!group) {
      this.readerPosition = ""
      return plain("")
    }
    const subject = this.subject
    const lines: StyledText[] = []

    // Title row identifying the subject.
    const name = subject?.kind === "change" ? (subject.change.title === subject.change.id ? subject.change.id : `${subject.change.id} — ${subject.change.title}`) : subject ? specDisplayPath(subject.path) : ""
    lines.push(new StyledText([bold(fg(theme.accent)(` ${truncate(name, width)}`))]))

    // The tab strip: content rows, never a new box; hidden for single groups
    // and inside the fullscreen reader (which has no tab chrome).
    if (this.groups.length > 1 && !this.fullscreen) {
      const tabs: TextChunk[] = [raw(" ")]
      this.groups.forEach((candidate, index) => {
        if (index > 0) tabs.push(fg(theme.faint)("  "))
        tabs.push(fg(theme.faint)(`${index + 1} `))
        tabs.push(index === this.selectedGroup ? bold(fg(theme.accent)(candidate.label)) : fg(theme.dim)(candidate.label))
      })
      lines.push(new StyledText(tabs))
      lines.push(plain(""))
    }

    // Sources that are still loading stay out of the pane so a pending read
    // doesn't flash the error placeholder; failures are written by loadBody.
    const source = specGroupSource(group, (file) => this.bodies.get(file) ?? "(loading…)")
    const known = group.entries.every((entry) => this.bodies.has(entry.file))
    if (!known && source.includes("(loading…)")) {
      this.readerPosition = this.fullscreen ? "all" : ""
      const blank: StyledText[] = []
      while (blank.length < this.detailsHeight()) blank.push(plain(""))
      return joinLines(lines.concat(blank).slice(0, this.detailsHeight()))
    }
    const rendered = this.docFor(source, Math.max(20, width))
    const contentHeight = Math.max(1, this.detailsHeight() - lines.length)
    const maxScroll = Math.max(0, rendered.length - contentHeight)
    this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll))
    this.readerPosition = this.fullscreen ? readerScrollPosition(this.detailScroll, maxScroll) : ""
    const body = rendered.slice(this.detailScroll, this.detailScroll + contentHeight)
    lines.push(...body)
    while (lines.length < this.detailsHeight()) lines.push(plain(""))
    return joinLines(lines.slice(0, this.detailsHeight()))
  }

  /** Only actions that are not universal navigation conventions get hints. */
  private footerContent(width: number) {
    if (this.level === "detail") {
      const subject = this.subject
      const hints: Hint[] = [
        ...(subject?.kind === "change"
          ? ([
              { keys: "a", label: "pply", priority: 2, style: "glued" },
              { keys: "i", label: "terate", priority: 5, style: "glued" },
            ] as Hint[])
          : []),
        { keys: "v", label: "full", priority: 3, style: "glued" },
        { keys: "esc", label: "back", priority: 4 },
        { keys: "q", label: "uit", priority: 1, style: "glued" },
      ]
      const position = `${this.selectedGroup + 1}/${Math.max(1, this.groups.length)}`
      return hintsRow(hints, [[fg(theme.faint)(position)]], width, { style: "spaced", overflow: moreHintsMarker })
    }

    const feature = this.selectedFeature()
    const selected = this.rows[this.selectedRow]
    const canRead = selected?.kind === "change" || selected?.kind === "spec"
    const hints: Hint[] = [
      ...(canRead ? ([{ keys: "enter", label: "read", priority: 2 }] as Hint[]) : []),
      ...(this.selectedChange()
        ? ([
            { keys: "a", label: "pply", priority: 4, style: "glued" },
            { keys: "i", label: "terate", priority: 5, style: "glued" },
            ...(feature?.stage === "stranded" ? ([{ keys: "s", label: "pin out", priority: 6, style: "glued" }] as Hint[]) : []),
            ...(feature?.worktreeDir && feature.branch ? ([{ keys: "c", label: "ontinue", priority: 6, style: "glued" }, { keys: "x", label: "close", priority: 7 }] as Hint[]) : []),
            ...(feature?.probablyMerged ? ([{ keys: "m", label: "archive", priority: 7 }] as Hint[]) : []),
          ] as Hint[])
        : []),
      { keys: "q", label: "uit", priority: 1, style: "glued" },
    ]
    const selectable = this.rows.filter((row) => row.kind !== "header").length
    const ordinal = this.rows.slice(0, this.selectedRow + 1).filter((row) => row.kind !== "header").length
    const right: TextChunk[] = [fg(theme.faint)(`${Math.max(1, ordinal)}/${selectable}`)]
    return hintsRow(hints, [right], width, { style: "spaced", overflow: moreHintsMarker })
  }

  private finish(resolution: SpecsResolution) {
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
}

/** Interactive specs browser: the control board — browse, read, apply, iterate, spin, continue, close. */
export async function browseSpecsTui(view: SpecsView): Promise<SpecsResolution> {
  // No backgroundColor yet: the palette is only chosen after the terminal
  // answers the background query, so a light terminal never flashes dark.
  const renderer = await createCliRenderer({
    screenMode: "alternate-screen",
    consoleMode: "console-overlay",
    exitOnCtrlC: false,
  })
  const mode = await renderer.waitForThemeMode(1_000).catch(() => null)
  setTheme(paletteForTerminal(mode, terminalBackgroundHex(renderer)))
  return new SpecsBrowser(renderer, view).result
}

/** Stage color follows the runs list: attention in yellow, live/ready in green, uncertain in orange. */
function stageColor(stage: FeatureRow["stage"], live: boolean): string {
  switch (stage) {
    case "stranded":
      return theme.yellow
    case "proposing":
      return theme.dim
    case "implementing":
      return live ? theme.green : theme.cyan
    case "ready":
      return theme.green
    case "probably-merged":
      return theme.orange
  }
}

/** The right-column state summary of a feature row: colored stage first, then dim signals. */
function featureSummaryChunks(feature: FeatureRow): TextChunk[] {
  const chunks: TextChunk[] = [fg(stageColor(feature.stage, feature.liveRuns > 0))(stageLabel(feature.stage))]
  const rest: string[] = []
  if (feature.tasks && feature.tasks.total > 0) rest.push(`${feature.tasks.done}/${feature.tasks.total}`)
  if (feature.runs.length > 0) {
    rest.push(feature.liveRuns > 0 ? `${feature.runs.length} runs (${feature.liveRuns} live)` : `${feature.runs.length} run${feature.runs.length === 1 ? "" : "s"}`)
  }
  if (feature.uncommittedProposal) rest.push("uncommitted")
  if (feature.synced !== undefined) rest.push(feature.synced ? "synced" : "unsynced")
  if (rest.length > 0) chunks.push(fg(theme.dim)(` · ${rest.join(" · ")}`))
  return chunks
}

function stageLabel(stage: FeatureRow["stage"]): string {
  switch (stage) {
    case "stranded":
      return "stranded on main"
    case "proposing":
      return "proposing"
    case "implementing":
      return "implementing"
    case "ready":
      return "ready to close"
    case "probably-merged":
      return "probably merged"
  }
}

/** The detail pane's lifecycle block for a change — faint labels, colored values, same words as the list. */
function featureDetailLines(feature: FeatureRow, width: number): StyledText[] {
  const lines: StyledText[] = []
  const add = (label: string, value: string, color = theme.text) => {
    lines.push(new StyledText([fg(theme.faint)(`${label}: `), fg(color)(truncate(value, Math.max(8, width - label.length - 2)))]))
  }
  add("stage", stageLabel(feature.stage), stageColor(feature.stage, feature.liveRuns > 0))
  if (feature.branch) add("branch", feature.branch)
  if (feature.worktreeDir) add("worktree", shortPath(feature.worktreeDir, Math.max(12, width - 10)))
  if (feature.tasks && feature.tasks.total > 0) add("tasks", `${feature.tasks.done}/${feature.tasks.total} complete`)
  if (feature.runs.length > 0) {
    add("runs", `${feature.runs.length}${feature.liveRuns > 0 ? ` (${feature.liveRuns} live)` : ""}`)
  }
  if (feature.uncommittedProposal) add("proposal", "uncommitted", theme.yellow)
  if (feature.synced !== undefined) {
    add("sync", feature.synced ? "contains the base tip (synced)" : "behind the base tip (unsynced)", feature.synced ? theme.dim : theme.yellow)
  }
  if (feature.probablyMerged) add("merged", "probably (patch equivalence) — archive on main", theme.orange)
  return lines
}

/** Same labels the run dashboard's fullscreen reader uses: `all` / `top` / `end` / `%`. */
function readerScrollPosition(offset: number, maxScroll: number): string {
  if (maxScroll <= 0) return "all"
  if (offset <= 0) return "top"
  if (offset >= maxScroll) return "end"
  return `${Math.round((offset / maxScroll) * 100)}%`
}

/** Path under `openspec/specs/`, whether the loader stored it relative or absolute. */
function specDisplayPath(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  const marker = "/openspec/specs/"
  const at = normalized.indexOf(marker)
  if (at >= 0) return normalized.slice(at + marker.length)
  if (normalized.startsWith("openspec/specs/")) return normalized.slice("openspec/specs/".length)
  return normalized
}

function copyStatusLabel(status: ClipboardResult): string {
  switch (status) {
    case "copied-native":
      return "copied"
    case "copied-osc52":
      return "copied (osc52)"
    case "unsupported":
      return "no clipboard mechanism"
    case "transport-failed":
      return "clipboard failed"
  }
}

function artifactCounts(change: SpecsChangeEntry): string {
  const count = change.artifacts.length
  if (count === 0) return "—"
  return `${count} artifact${count === 1 ? "" : "s"}`
}

/** Change-relative path so the filename survives a narrow details pane. */
function artifactDisplayPath(file: string, changeId: string): string {
  const normalized = file.replaceAll("\\", "/")
  const nested = `/openspec/changes/${changeId}/`
  const nestedAt = normalized.indexOf(nested)
  if (nestedAt >= 0) return normalized.slice(nestedAt + nested.length)
  const prefix = `openspec/changes/${changeId}/`
  if (normalized.startsWith(prefix)) return normalized.slice(prefix.length)
  return specDisplayPath(normalized)
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
