import { readFile } from "node:fs/promises"

import { BoxRenderable, StyledText, TextRenderable, bold, createCliRenderer, fg, t } from "@opentui/core"

import { parseMarkdown, renderMarkdownDoc, type MarkdownDoc } from "./markdown-render"
import { stripYamlFrontmatter } from "./openspec"
import { specArtifactLabel, type SpecsChangeEntry, type SpecsResolution, type SpecsView } from "./specs"
import {
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
 * One row of the navigation list. Headers are drawn between the two root
 * sections so Active Changes and Canonical Specs stay visually distinct while
 * sharing one scroll window.
 */
type ListRow =
  | { kind: "header"; label: string }
  | { kind: "change"; change: SpecsChangeEntry }
  | { kind: "spec"; path: string }

/** One labeled section of a change's artifacts (delta specs group per capability). */
type ArtifactGroup = { label: string; files: string[] }

export class SpecsBrowser {
  readonly result: Promise<SpecsResolution>

  private resolveResult!: (resolution: SpecsResolution) => void
  /** "root": the two-section entity list; "detail": one change's artifact sections or one spec. */
  private level: "root" | "detail" = "root"
  // The first selectable row sits under the leading header when changes exist;
  // the constructor moves the cursor past any header so a changes-empty repo
  // (canonical specs only) still opens on a reachable row (same rule as runs).
  private selectedRow = 1
  private scroll = 0
  /** Set while a change/spec was entered: the detail level's subject. */
  private subject?: SpecsChangeEntry | { kind: "spec"; path: string }
  private groups: ArtifactGroup[] = []
  private selectedGroup = 0
  private detailScroll = 0
  /** Artifact markdown read lazily, keyed by repo-relative file; failures become placeholders. */
  private readonly bodies = new Map<string, string>()
  private readonly docs = new Map<string, MarkdownDoc>()

  private readonly headerText: TextRenderable
  private readonly bodyBox: BoxRenderable
  private readonly listText: TextRenderable
  private readonly listBox: BoxRenderable
  private readonly detailsText: TextRenderable
  private readonly detailsBox: BoxRenderable
  private readonly footerText: TextRenderable
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

    const header = this.panel({
      id: "convoy-specs-header",
      height: 4,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      title: ` convoy specs ${shortVersion()} `,
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
    this.bodyBox = body
    this.listText = list.text
    this.listBox = list.box
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
      case "q":
      case "escape":
        this.finish({ type: "exit" })
        break
    }
  }

  private handleDetailKey(key: KeyEvent) {
    switch (key.name) {
      case "up":
      case "k":
        if (this.groups.length > 1) {
          this.selectedGroup = Math.max(0, this.selectedGroup - 1)
          this.detailScroll = 0
          this.enteredGroup()
        }
        break
      case "down":
      case "j":
        if (this.groups.length > 1) {
          this.selectedGroup = Math.min(this.groups.length - 1, this.selectedGroup + 1)
          this.detailScroll = 0
          this.enteredGroup()
        }
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
      case "a": {
        const subject = this.subject
        if (subject?.kind === "change") this.finish({ type: "apply-change", changeID: subject.id })
        return
      }
      case "i": {
        const subject = this.subject
        if (subject?.kind === "change") this.finish({ type: "iterate-change", changeID: subject.id })
        return
      }
      case "escape":
      case "q":
      case "b":
        this.leaveSubject()
        break
    }
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
    this.moveSelection(delta > 0 ? this.rows.length : -this.rows.length)
  }

  private selectedChange(): SpecsChangeEntry | undefined {
    const row = this.rows[this.selectedRow]
    return row?.kind === "change" ? row.change : undefined
  }

  /** Enters a change (its artifact sections) or a spec (its rendered content). */
  private enterSelected() {
    const row = this.rows[this.selectedRow]
    if (!row || row.kind === "header") return
    if (row.kind === "change") {
      this.subject = row.change
      this.groups = groupArtifacts(row.change)
    } else {
      this.subject = { kind: "spec", path: row.path }
      this.groups = [{ label: "Spec", files: [row.path] }]
    }
    this.level = "detail"
    this.selectedGroup = 0
    this.detailScroll = 0
    void this.loadSelectedGroup().then(() => this.render())
    this.render()
  }

  /** Loads the artifacts of the group the selection just moved to. */
  private enteredGroup() {
    void this.loadSelectedGroup().then(() => this.render())
  }

  private leaveSubject() {
    if (!this.subject) return
    this.subject = undefined
    this.level = "root"
    this.render()
  }

  // ── loading ─────────────────────────────────────────────────────────────

  /** Reads the selected group's markdown lazily — nothing loads until entered. */
  private async loadSelectedGroup() {
    const group = this.groups[this.selectedGroup]
    if (!group) return
    await Promise.all(group.files.map((file) => this.loadBody(file)))
  }

  /** Unreadable files degrade to a placeholder instead of failing the browser. */
  private async loadBody(file: string): Promise<string> {
    const cached = this.bodies.get(file)
    if (cached !== undefined) return cached
    let body: string
    try {
      body = stripYamlFrontmatter(await readFile(file, "utf8"))
    } catch {
      body = `(couldn't read ${file})`
    }
    this.bodies.set(file, body.replace(/\r\n/g, "\n"))
    return this.bodies.get(file)!
  }

  // ── layout ──────────────────────────────────────────────────────────────

  private get rows(): ListRow[] {
    const rows: ListRow[] = [{ kind: "header", label: "Active Changes" }]
    for (const change of this.view.changes) rows.push({ kind: "change", change })
    rows.push({ kind: "header", label: "Canonical Specs" })
    for (const path of this.view.specs) rows.push({ kind: "spec", path })
    return rows
  }

  private detailsWidth() {
    return Math.max(40, Math.min(62, this.renderer.width - 44))
  }

  private bodyHeight() {
    return Math.max(8, this.renderer.height - 7)
  }

  private compactListHeight(bodyHeight: number) {
    return Math.max(5, Math.min(9, Math.floor(bodyHeight * 0.35)))
  }

  private listHeight() {
    // Header (4) + footer (3) + list panel borders (2); compact stacks instead.
    if (this.renderer.width <= compactSpecsMaxWidth) return Math.max(3, this.compactListHeight(this.bodyHeight()) - 2)
    return Math.max(3, this.renderer.height - 9)
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
    const detailsWidth = this.detailsWidth()
    const listWidth = Math.max(36, this.renderer.width - detailsWidth - 7)
    const bodyHeight = this.bodyHeight()

    this.bodyBox.flexDirection = compact ? "column" : "row"
    if (compact) {
      const listHeight = this.compactListHeight(bodyHeight)
      this.listBox.width = "100%"
      this.listBox.height = listHeight
      this.detailsBox.width = "100%"
      this.detailsBox.height = Math.max(3, bodyHeight - listHeight)
    } else {
      this.listBox.width = "auto"
      this.listBox.height = "100%"
      this.detailsBox.width = detailsWidth
      this.detailsBox.height = "100%"
    }

    this.headerText.content = this.headerContent(innerWidth)
    this.listBox.title = this.level === "detail" ? " sections " : " browse "
    this.listText.content = this.listContent(compact ? innerWidth : listWidth)
    this.detailsBox.title = this.level === "detail" && this.groups[this.selectedGroup] ? ` ${this.groups[this.selectedGroup]!.label.toLowerCase()} ` : " details "
    this.detailsText.content = this.detailsContent((compact ? innerWidth : detailsWidth) - 4)
    this.footerText.content = this.footerContent(innerWidth)
    this.renderer.requestRender()
  }

  private headerContent(width: number) {
    const summary: TextChunk[] = [
      fg(theme.text)(`${this.view.changes.length} change${this.view.changes.length === 1 ? "" : "s"}`),
      fg(theme.faint)("  ·  "),
      fg(theme.text)(`${this.view.specs.length} spec${this.view.specs.length === 1 ? "" : "s"}`),
    ]
    return joinLines([
      padBetween([fg(theme.text)("openspec")], summary, width),
      t`${fg(theme.dim)(truncate("openspec/changes · openspec/specs", width))}`,
    ])
  }

  private listContent(width: number) {
    if (this.level === "detail") return this.detailListContent(width)

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

  /** The detail level's left panel: the entered subject's sections, one per artifact group. */
  private detailListContent(width: number): StyledText {
    const subject = this.subject
    if (!subject) return plain("")
    const heading = subject.kind === "change" ? subject.id : "canonical spec"
    const lines: StyledText[] = [new StyledText([bold(fg(theme.accent)(` ${truncate(heading, width)}`))])]
    for (const [index, group] of this.groups.entries()) {
      const selected = index === this.selectedGroup
      const left: TextChunk[] = [
        selected ? fg(theme.accent)("▸ ") : raw("  "),
        fg(theme.dim)("◇"),
        raw(" "),
      ]
      const label = truncate(group.label, Math.max(12, width - 4))
      left.push(selected ? bold(fg(theme.text)(label)) : fg(theme.text)(label))
      // A trailing 1 on every planning file is noise; counts earn their column
      // when a delta capability actually has more than one file.
      const count = group.files.length
      lines.push(padBetween(left, count > 1 ? [fg(theme.dim)(`${count}`)] : [], width))
    }
    return joinLines(lines)
  }

  private rowLine(row: ListRow, selected: boolean, width: number): StyledText {
    if (row.kind === "header") {
      const left: TextChunk[] = [bold(fg(theme.accent)(` ${truncate(row.label.toUpperCase(), width)}`))]
      const empty =
        (row.label === "Active Changes" && this.view.changes.length === 0) ||
        (row.label === "Canonical Specs" && this.view.specs.length === 0)
      if (!empty) return new StyledText(left)
      return padBetween(left, [fg(theme.dim)("none")], width)
    }
    if (row.kind === "change") {
      const left: TextChunk[] = [
        selected ? fg(theme.accent)("▸ ") : raw("  "),
        fg(theme.accent)("◆"),
        raw(" "),
      ]
      const heading = row.change.title === row.change.id ? row.change.id : `${row.change.id} — ${row.change.title}`
      const counts = artifactCounts(row.change)
      const title = truncate(heading, Math.max(12, width - 4 - counts.length - 1))
      left.push(selected ? bold(fg(theme.text)(title)) : fg(theme.text)(title))
      return padBetween(left, [fg(theme.dim)(counts)], width)
    }
    const left: TextChunk[] = [selected ? fg(theme.accent)("▸ ") : raw("  "), fg(theme.teal)("◆"), raw(" ")]
    const name = truncate(specDisplayPath(row.path), Math.max(12, width - 4))
    left.push(selected ? bold(fg(theme.text)(name)) : fg(theme.text)(name))
    return padBetween(left, [], width)
  }

  private detailsContent(width: number): StyledText {
    if (this.level === "detail") {
      const group = this.groups[this.selectedGroup]
      if (!group) return plain("")
      // Unloaded files stay out of the pane so a pending read doesn't flash the
      // error placeholder; failures are written into `bodies` by loadBody.
      const sources = group.files.map((file) => this.bodies.get(file)).filter((body): body is string => body !== undefined)
      if (sources.length === 0) {
        const blank: StyledText[] = []
        while (blank.length < this.detailsHeight()) blank.push(plain(""))
        return joinLines(blank)
      }
      const rendered = this.docFor(sources.join("\n\n"), Math.max(20, width))
      const maxScroll = Math.max(0, rendered.length - this.detailsHeight())
      this.detailScroll = Math.max(0, Math.min(this.detailScroll, maxScroll))
      const lines = rendered.slice(this.detailScroll, this.detailScroll + this.detailsHeight())
      while (lines.length < this.detailsHeight()) lines.push(plain(""))
      return joinLines(lines)
    }

    const row = this.rows[this.selectedRow]
    if (!row || row.kind === "header") return plain("")
    const lines: StyledText[] = []
    if (row.kind === "change") {
      const change = row.change
      lines.push(t`${bold(fg(theme.text)(truncate(change.title, width)))}`)
      lines.push(t`${fg(theme.dim)(`openspec/changes/${change.id}`)}`)
      lines.push(plain(""))
      lines.push(t`${fg(theme.faint)("─".repeat(Math.max(1, width)))}`)
      if (change.artifacts.length === 0) {
        lines.push(t`${fg(theme.dim)("no markdown artifacts found for this change")}`)
      } else {
        for (const group of groupArtifacts(change)) {
          lines.push(new StyledText([fg(theme.text)(group.label)]))
          for (const file of group.files) {
            lines.push(new StyledText([raw("  "), fg(theme.dim)(truncate(artifactDisplayPath(file, change.id), Math.max(8, width - 2)))]))
          }
        }
      }
      return joinLines(lines)
    }
    const name = specDisplayPath(row.path)
    lines.push(t`${bold(fg(theme.text)(truncate(name, width)))}`)
    lines.push(t`${fg(theme.dim)(shortPath(row.path, width))}`)
    return joinLines(lines)
  }

  private footerContent(width: number) {
    if (this.level === "detail") {
      const hints: Hint[] = [
        { keys: "↑/↓", label: "section", priority: 3, tone: "dim" },
        { keys: "pgup/pgdn", label: "scroll", priority: 4, tone: "dim" },
        ...(this.subject?.kind === "change"
          ? ([
              { keys: "a", label: "pply", priority: 2, style: "glued" },
              { keys: "i", label: "terate", priority: 5, style: "glued" },
            ] as Hint[])
          : []),
        { keys: "esc", label: "back", priority: 1 },
      ]
      const position = `${this.selectedGroup + 1}/${Math.max(1, this.groups.length)}`
      return hintsRow(hints, [[fg(theme.faint)(position)]], width, { style: "spaced", overflow: moreHintsMarker })
    }

    const on = this.selectedRow < this.rows.length ? this.rows[this.selectedRow] : undefined
    const isChange = on?.kind === "change"
    const hints: Hint[] = [
      { keys: "↑/↓", label: "select", priority: 3, tone: "dim" },
      { keys: "enter", label: "read", priority: 2 },
      ...(isChange
        ? ([
            { keys: "a", label: "pply", priority: 4, style: "glued" },
            { keys: "i", label: "terate", priority: 5, style: "glued" },
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

/** Interactive specs browser: pick an entry, read artifacts, apply or iterate on a change. */
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

/** Groups a change's artifacts into labeled sections in stable display order. */
function groupArtifacts(change: SpecsChangeEntry): ArtifactGroup[] {
  const groups = new Map<string, ArtifactGroup>()
  for (const artifact of change.artifacts) {
    const label = specArtifactLabel(artifact.section, artifact.capability)
    let group = groups.get(label)
    if (!group) {
      group = { label, files: [] }
      groups.set(label, group)
    }
    group.files.push(artifact.file)
  }
  return [...groups.values()]
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

/** Path under `openspec/specs/`, whether the loader stored it relative or absolute. */
function specDisplayPath(path: string): string {
  const normalized = path.replaceAll("\\", "/")
  const marker = "/openspec/specs/"
  const at = normalized.indexOf(marker)
  if (at >= 0) return normalized.slice(at + marker.length)
  if (normalized.startsWith("openspec/specs/")) return normalized.slice("openspec/specs/".length)
  return normalized
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
