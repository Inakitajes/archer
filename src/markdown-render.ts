import { Lexer, lexer } from "marked"
import { StyledText, bold, fg, italic, link, strikethrough, underline } from "@opentui/core"

import type { Token, Tokens, TokensList } from "marked"
import type { TextChunk } from "@opentui/core"

import {
  chunksLength,
  displayWidth,
  indentRows,
  indentStyled,
  plain,
  raw,
  takeDisplayCells,
  theme,
  truncate,
  wrapStyled,
} from "./tui-theme"

// Rendering runs on every repaint; parsing does not have to. A resize
// invalidates the wrapping but never the parse, and a report can run to
// thousands of lines, so the two are separable on purpose.
export type MarkdownDoc = { readonly tokens: TokensList | undefined; readonly source: string; readonly overflow?: string[] }

type Ink = { color: string; bold?: boolean; italic?: boolean; strike?: boolean; underline?: boolean; href?: string }
type Ctx = { width: number; color: string; italic?: boolean }
type Align = "left" | "right" | "center"

const lexerOptions = { gfm: true, breaks: false, pedantic: false } as const

/** Bullets change per nesting level so a deep list reads as a hierarchy. */
const bulletGlyphs = ["•", "◦", "▪"]

// marked's lexer re-slices the remaining source for each token it emits, so its
// cost grows faster than the document does. Real reports sit two orders of
// magnitude under this bound — the largest across 173 recorded runs was 165
// lines — but a report that embeds a whole log or diff must not stall a frame
// for seconds. Past the cap the tail still shows, just without block styling.
const blockGrammarLineCap = 2_000

export function parseMarkdown(markdown: string | string[]): MarkdownDoc {
  // Model responses and reports are untrusted terminal content, and OpenTUI
  // keeps chunk text verbatim. Sanitizing *before* the lexer is what makes the
  // guarantee total: a control byte cannot reach the renderer through prose, a
  // fenced block, a table cell or a link label, because none of those exist yet.
  const lines = (Array.isArray(markdown) ? markdown.join("\n") : markdown).replace(/\r\n?/g, "\n").split("\n").map(sanitizeMarkdownLine)
  const capped = lines.length > blockGrammarLineCap
  const source = (capped ? lines.slice(0, blockGrammarLineCap) : lines).join("\n")
  const overflow = capped ? lines.slice(blockGrammarLineCap) : undefined
  try {
    // `gfm` is what buys tables. `breaks: false` is what keeps a lone newline a
    // soft break, which is the entire basis of paragraph reflow below — with
    // `breaks: true` every source line would become a hard break instead.
    // `silent` is deliberately not set: marked's silent path writes to
    // console.error, which would smear raw bytes across the alternate screen.
    return { tokens: lexer(source, lexerOptions), source, overflow }
  } catch {
    return { tokens: undefined, source, overflow }
  }
}

export function renderMarkdownDoc(doc: MarkdownDoc, width: number, baseColor = theme.text): StyledText[] {
  const columns = Math.max(1, Math.floor(width))
  const rows = renderDocBody(doc, columns, baseColor)
  // Whatever sat past the block-grammar cap still has to be readable.
  if (doc.overflow) for (const line of doc.overflow) rows.push(...wrapStyled(plain(line), columns))
  // Callers join rows into a single TextRenderable, and an empty list would let
  // the panel's layout collapse, so an empty document still keeps its row.
  return rows.length > 0 ? rows : [plain("")]
}

function renderDocBody(doc: MarkdownDoc, columns: number, baseColor: string): StyledText[] {
  // This renders untrusted input on every frame, so neither a lexer failure nor
  // a token tree deep enough to exhaust the stack (nesting recurses) may take
  // the dashboard down with it: both degrade to plain wrapped text.
  if (doc.tokens) {
    try {
      return renderBlocks(doc.tokens, { width: columns, color: baseColor }, 0)
    } catch {
      // fall through to the plain-text rendering below
    }
  }
  return doc.source.split("\n").flatMap((line) => wrapStyled(plain(line), columns))
}

/**
 * Render the Markdown reports and model messages use into styled terminal rows.
 * Keeping this as StyledText (rather than a separate renderable) lets the
 * dashboard retain its existing paging, group previews, and text selection.
 */
export function markdownLines(markdown: string | string[], width: number, baseColor = theme.text): StyledText[] {
  return renderMarkdownDoc(parseMarkdown(markdown), width, baseColor)
}

/**
 * Inline-only rendering for a single line of prose. A log message is a message,
 * not a document: one that happens to start with "- " is not a bullet and one
 * containing "---" is not a horizontal rule, so the block grammar stays out of
 * it and only typography (code spans, emphasis, links) is honored.
 */
export function markdownInlineChunks(text: string, color = theme.text): TextChunk[] {
  const line = sanitizeMarkdownLine(text.replace(/\r\n?/g, "\n")).replace(/\n/g, " ")
  try {
    return inlineChunks(Lexer.lexInline(line, lexerOptions), { color })
  } catch {
    return [fg(color)(line)]
  }
}

export function sanitizeMarkdownLine(line: string) {
  // Preserve tabs as indentation without passing a tab control to the terminal.
  return line.replace(/\t/g, "    ").replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "")
}

export function safeHyperlinkUrl(value: string): string | undefined {
  // Terminal link handlers can open arbitrary URI schemes. Markdown supplied by
  // a model may only produce network links, and a bounded normalized URL also
  // prevents OSC-8 control-sequence injection through the link target.
  if (value.length > 2_048) return undefined
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined
  } catch {
    return undefined
  }
}

// ── blocks ──────────────────────────────────────────────────────────────────

function renderBlocks(tokens: Token[], ctx: Ctx, depth: number): StyledText[] {
  const out: StyledText[] = []
  let gap = false
  for (const token of tokens) {
    const rows = renderBlock(token, ctx, depth)
    if (rows.length > 0) {
      // The gap only ever separates content, so a leading blank line, a run of
      // several, and a `def` that renders nothing all collapse away.
      if (gap && out.length > 0) out.push(plain(""))
      out.push(...rows)
      gap = false
    }
    if (trailingBlankRows(token.raw ?? "") > 0) gap = true
  }
  return out
}

// Headings, fenced code and link definitions swallow their trailing blank line
// into their own `raw` instead of emitting a `space` token, so the gap after a
// block has to be derived from the raw text uniformly. Runs collapse to a single
// row: a report padding its sections with four newlines shouldn't waste four.
function trailingBlankRows(source: string) {
  const trailing = /\n*$/.exec(source)?.[0].length ?? 0
  return Math.min(1, Math.max(0, trailing - 1))
}

function renderBlock(token: Token, ctx: Ctx, depth: number): StyledText[] {
  switch (token.type) {
    case "space":
      return []
    case "heading": {
      const heading = token as Tokens.Heading
      // Setext headings arrive here too, so `Title` over `===` is an h1 rather
      // than a paragraph followed by a rule.
      const color = heading.depth <= 2 ? theme.accent : theme.magenta
      return wrapStyled(new StyledText(blockInline(heading, { color, bold: true })), ctx.width)
    }
    case "hr":
      return [new StyledText([fg(theme.faint)("─".repeat(ctx.width))])]
    case "code":
      return renderCode(token as Tokens.Code, ctx)
    case "blockquote": {
      const quoted = (token as Tokens.Blockquote).tokens
      const bar = [fg(theme.teal)("▎ ")]
      const room = ctx.width - chunksLength(bar)
      const inner = { width: room, color: theme.dim, italic: true }
      // Deeply nested quotes would otherwise stack bars past the panel edge, so
      // once there is no room left the content wins — the same trade
      // `indentStyled` makes, and what keeps every row inside `width`.
      if (room < 1) return renderBlocks(quoted, { ...inner, width: ctx.width }, depth)
      // The bar repeats on every row, and nesting composes for free: an inner
      // quote simply adds its own bar inside the outer one's indent.
      return indentRows(renderBlocks(quoted, inner, depth), bar, bar)
    }
    case "list":
      return renderList(token as Tokens.List, ctx, depth)
    case "table":
      return renderTable(token as Tokens.Table, ctx)
    case "def":
      // Link definitions are metadata: marked already resolved the references
      // that point at them, so there is nothing left to show.
      return []
    case "html":
      return renderHtmlBlock(token as Tokens.HTML, ctx)
    case "paragraph":
    case "text":
      return wrapStyled(new StyledText(blockInline(token as Tokens.Paragraph, { color: ctx.color, italic: ctx.italic })), ctx.width)
    default:
      // Never throw on a token type a future marked introduces — show its
      // source and let the reader decide what it was.
      return wrapStyled(new StyledText([fg(ctx.color)(softBreaks(token.raw ?? ""))]), ctx.width)
  }
}

function renderCode(token: Tokens.Code, ctx: Ctx): StyledText[] {
  const language = (token.lang ?? "").trim()
  // Info strings can be arbitrarily long (```python { .annotate }); keep the
  // fence row inside the panel width instead of overflowing it.
  const head = takeDisplayCells(language ? `┄ ${language} ` : "┄", ctx.width).head
  const gutter = [fg(theme.faint)("│ ")]
  return [
    new StyledText([fg(theme.faint)(head), fg(theme.faint)("┄".repeat(Math.max(0, ctx.width - displayWidth(head))))]),
    // The gutter is a wrap-time prefix rather than a leading content chunk, so
    // every continuation row of an over-wide code line keeps its bar.
    ...indentStyled(new StyledText([fg(theme.yellow)(token.text)]), ctx.width, gutter, gutter),
    new StyledText([fg(theme.faint)("┄".repeat(Math.max(1, ctx.width)))]),
  ]
}

function renderHtmlBlock(token: Tokens.HTML, ctx: Ctx): StyledText[] {
  // A terminal cannot render markup, so the tags go and their text stays.
  const text = token.text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim()
  if (!text) return []
  return wrapStyled(new StyledText([fg(theme.dim)(text)]), ctx.width)
}

function renderList(token: Tokens.List, ctx: Ctx, depth: number): StyledText[] {
  const out: StyledText[] = []
  const start = Number(token.start || 1)
  // One marker column for the whole list, so `9.` and `10.` stay aligned.
  const numberWidth = token.ordered ? String(start + token.items.length - 1).length : 0
  token.items.forEach((item, index) => {
    const marker = itemMarker(token, item, start + index, numberWidth, depth)
    // The checkbox is already spoken for by the marker; leaving it in the body
    // would print a literal `[x]` after the glyph.
    const body = item.tokens.filter((child) => child.type !== "checkbox")
    // No room for the marker means a deep nesting has eaten the panel; the item
    // text is worth more than its bullet, so the marker is what gets dropped.
    const room = ctx.width - chunksLength(marker)
    const inner = { width: room < 1 ? ctx.width : room, color: ctx.color, italic: ctx.italic }
    // A nested list is just a block inside the item, so the hanging indent and
    // the per-level bullet both fall out of this one composition.
    const rendered = renderBlocks(body, inner, depth + 1)
    const itemRows = rendered.length > 0 ? rendered : [plain("")]
    out.push(...(room < 1 ? itemRows : indentRows(itemRows, marker)))
    if (token.loose && index < token.items.length - 1) out.push(plain(""))
  })
  return out
}

function itemMarker(list: Tokens.List, item: Tokens.ListItem, ordinal: number, numberWidth: number, depth: number): TextChunk[] {
  if (item.task) return [fg(theme.teal)(item.checked ? "☑ " : "☐ ")]
  // marked exposes the ordinal but not whether the source wrote `1.` or `1)`,
  // so one convention is applied to both.
  if (list.ordered) return [fg(theme.teal)(`${String(ordinal).padStart(numberWidth)}. `)]
  return [fg(theme.teal)(`${bulletGlyphs[depth % bulletGlyphs.length]} `)]
}

// ── tables ──────────────────────────────────────────────────────────────────

type Cell = { chunks: TextChunk[]; width: number; longest: number }

// A terminal table is a fitting problem before it is a drawing problem: the
// columns a report wants are rarely the columns the panel has. Narrowest column
// that still reads, and the cap that stops one column of paths from claiming
// the whole table.
const minColumnWidth = 5
const columnFloorCap = 12

function renderTable(token: Tokens.Table, ctx: Ctx): StyledText[] {
  const header = token.header ?? []
  const bodyRows = token.rows ?? []
  const columns = Math.max(header.length, 0, ...bodyRows.map((row) => row.length))
  if (columns === 0) return []

  const headerCells = measureRow(header, columns, { color: theme.text, bold: true })
  const bodyCells = bodyRows.map((row) => measureRow(row, columns, { color: ctx.color, italic: ctx.italic }))
  const natural: number[] = []
  const floor: number[] = []
  for (let column = 0; column < columns; column++) {
    const group = [headerCells[column]!, ...bodyCells.map((row) => row[column]!)]
    natural[column] = Math.max(1, ...group.map((cell) => cell.width))
    // A column's floor is the longest run it cannot break anyway, capped so a
    // single URL column can't starve its neighbours.
    const unbreakable = Math.max(0, ...group.map((cell) => cell.longest))
    floor[column] = Math.min(natural[column]!, Math.max(minColumnWidth, Math.min(unbreakable, columnFloorCap)))
  }

  // One `│` per boundary plus a space of padding either side of every cell.
  const available = ctx.width - (3 * columns + 1)
  if (sum(floor) > available) return renderTableRecords(headerCells, bodyCells, ctx)
  const widths = sum(natural) <= available ? natural : fitColumns(natural, floor, available)
  return drawTable(headerCells, bodyCells, widths, alignments(token, columns), ctx)
}

function measureRow(row: Tokens.TableCell[], columns: number, style: Ink): Cell[] {
  const out: Cell[] = []
  for (let column = 0; column < columns; column++) {
    // marked pads short rows to the header length, but a hand-written table
    // read by some other path must not index past the end.
    const cell = row[column]
    const chunks = cell ? blockInline(cell, style) : []
    out.push({ chunks, width: chunksLength(chunks), longest: longestUnbrokenRun(chunks) })
  }
  return out
}

function longestUnbrokenRun(chunks: TextChunk[]) {
  let longest = 0
  for (const word of plainText(chunks).split(/\s+/)) longest = Math.max(longest, displayWidth(word))
  return longest
}

function alignments(token: Tokens.Table, columns: number): Align[] {
  const out: Align[] = []
  for (let column = 0; column < columns; column++) out.push(token.align?.[column] ?? "left")
  return out
}

// Shrink proportionally, then settle the rounding one cell at a time: take from
// whichever column has the most slack above its floor, give to whichever sits
// furthest below its natural width. Each pass moves the total by exactly one, so
// both loops are bounded by the initial error.
function fitColumns(natural: number[], floor: number[], available: number): number[] {
  const total = sum(natural)
  const widths = natural.map((width, index) => clamp(Math.floor((width * available) / total), floor[index]!, width))
  let current = sum(widths)
  while (current > available) {
    const index = argmax(widths.map((width, i) => width - floor[i]!))
    if (index < 0 || widths[index]! <= floor[index]!) break
    widths[index] = widths[index]! - 1
    current--
  }
  while (current < available) {
    const index = argmax(widths.map((width, i) => natural[i]! - width))
    if (index < 0 || widths[index]! >= natural[index]!) break
    widths[index] = widths[index]! + 1
    current++
  }
  return widths
}

function drawTable(header: Cell[], rows: Cell[][], widths: number[], align: Align[], ctx: Ctx): StyledText[] {
  const rule = (left: string, join: string, right: string, color: string) =>
    new StyledText([fg(color)(left + widths.map((width) => "─".repeat(width + 2)).join(join) + right)])

  const wrappedRows = rows.map((row) => wrapCells(row, widths))
  const out: StyledText[] = [rule("┌", "┬", "┐", theme.border)]
  out.push(...cellRows(wrapCells(header, widths), widths, align))
  // A header rule with nothing under it reads as a broken box.
  if (wrappedRows.length > 0) out.push(rule("├", "┼", "┤", theme.border))
  // Without a separator, two records that each wrapped to three rows are
  // indistinguishable; a table whose rows all fit one line stays compact.
  const anyWrapped = wrappedRows.some((row) => rowHeight(row) > 1)
  wrappedRows.forEach((row, index) => {
    if (anyWrapped && index > 0) out.push(rule("├", "┼", "┤", theme.borderDim))
    out.push(...cellRows(row, widths, align))
  })
  out.push(rule("└", "┴", "┘", theme.border))
  return out
}

function wrapCells(row: Cell[], widths: number[]): StyledText[][] {
  return row.map((cell, column) => wrapStyled(new StyledText(cell.chunks), widths[column]!))
}

function rowHeight(row: StyledText[][]) {
  return Math.max(1, ...row.map((cell) => cell.length))
}

function cellRows(row: StyledText[][], widths: number[], align: Align[]): StyledText[] {
  const height = rowHeight(row)
  const out: StyledText[] = []
  for (let line = 0; line < height; line++) {
    const chunks: TextChunk[] = [fg(theme.border)("│")]
    row.forEach((cell, column) => {
      chunks.push(raw(" "), ...padCell(cell[line]?.chunks ?? [], widths[column]!, align[column] ?? "left"), raw(" "), fg(theme.border)("│"))
    })
    out.push(new StyledText(chunks))
  }
  return out
}

function padCell(chunks: TextChunk[], width: number, align: Align): TextChunk[] {
  const slack = Math.max(0, width - chunksLength(chunks))
  if (slack === 0) return chunks
  if (align === "right") return [raw(" ".repeat(slack)), ...chunks]
  if (align === "center") {
    const left = Math.floor(slack / 2)
    return [raw(" ".repeat(left)), ...chunks, raw(" ".repeat(slack - left))]
  }
  return [...chunks, raw(" ".repeat(slack))]
}

/**
 * At a comparison card's twenty cells a four-column box is unreadable, so the
 * table degrades into one labelled record per row: the same information, read
 * down instead of across.
 */
function renderTableRecords(header: Cell[], rows: Cell[][], ctx: Ctx): StyledText[] {
  const labels = header.map((cell) => plainText(cell.chunks).trim())
  // The label column never takes more than half of what's left after its own
  // padding: a full-width `Verification` label at twenty cells would leave the
  // value it describes wrapping two characters at a time.
  const widest = Math.max(0, ...labels.slice(1).map((label) => displayWidth(label)))
  const labelWidth = Math.min(widest, 12, Math.max(4, Math.floor((ctx.width - 4) / 2)))
  const out: StyledText[] = []
  rows.forEach((row, index) => {
    if (index > 0) out.push(plain(""))
    const title = row[0]?.chunks ?? []
    const heading = title.length > 0 ? title.map((chunk) => bold(chunk)) : [fg(theme.dim)(`row ${index + 1}`)]
    out.push(...indentStyled(new StyledText(heading), ctx.width, [fg(theme.teal)("▸ ")]))
    for (let column = 1; column < row.length; column++) {
      const cell = row[column]!
      if (plainText(cell.chunks).trim() === "") continue
      const gutter = [raw("  "), fg(theme.dim)(truncate(labels[column] ?? "", labelWidth).padEnd(labelWidth)), raw("  ")]
      // Too narrow even for a label column: fall back to inline `label: value`
      // prose, which the wrapper still guarantees fits.
      if (ctx.width - chunksLength(gutter) < 2) {
        out.push(...wrapStyled(new StyledText([fg(theme.dim)(`${labels[column] ?? ""}: `), ...cell.chunks]), ctx.width))
        continue
      }
      out.push(...indentStyled(new StyledText(cell.chunks), ctx.width, gutter))
    }
  })
  return out
}

// ── inline ──────────────────────────────────────────────────────────────────

function blockInline(token: { tokens?: Token[]; text?: string }, style: Ink): TextChunk[] {
  const chunks = inlineChunks(token.tokens, style)
  if (chunks.length > 0) return chunks
  return token.text ? [ink(softBreaks(token.text), style)] : []
}

function inlineChunks(tokens: Token[] | undefined, style: Ink): TextChunk[] {
  if (!tokens) return []
  const out: TextChunk[] = []
  for (const token of tokens) pushInline(token, style, out)
  return out
}

function pushInline(token: Token, style: Ink, out: TextChunk[]) {
  switch (token.type) {
    case "text": {
      const nested = (token as Tokens.Text).tokens
      if (nested && nested.length > 0) {
        out.push(...inlineChunks(nested, style))
        return
      }
      out.push(ink(softBreaks((token as Tokens.Text).text), style))
      return
    }
    case "escape":
      // marked already resolved `\*` to the literal character.
      out.push(ink((token as Tokens.Escape).text, style))
      return
    case "codespan":
      out.push(ink((token as Tokens.Codespan).text, { ...style, color: theme.yellow }))
      return
    case "strong":
      out.push(...inlineChunks((token as Tokens.Strong).tokens, { ...style, bold: true }))
      return
    case "em":
      out.push(...inlineChunks((token as Tokens.Em).tokens, { ...style, italic: true }))
      return
    case "del":
      out.push(...inlineChunks((token as Tokens.Del).tokens, { ...style, strike: true, color: theme.dim }))
      return
    case "br":
      // The one place a newline survives into the wrapper's input, where it
      // becomes the row break the author asked for.
      out.push(raw("\n"))
      return
    case "link": {
      const anchor = token as Tokens.Link
      // The label always reads as a link, but only a web URL becomes a real
      // OSC-8 hyperlink — a file: or javascript: target is never handed to the
      // terminal. Autolinks and bare URLs arrive here too, so a URL sitting in
      // prose becomes clickable without any markup around it.
      const href = safeHyperlinkUrl(anchor.href)
      out.push(...inlineChunks(anchor.tokens, { ...style, color: theme.cyan, underline: true, href }))
      return
    }
    case "image": {
      const image = token as Tokens.Image
      // No pictorial glyph: the obvious candidates are ambiguous-width and
      // would break the "every row fits the panel" invariant on some terminals.
      const label = image.text || image.title || "image"
      out.push(ink(`[image: ${label}]`, { ...style, color: theme.faint, href: safeHyperlinkUrl(image.href) }))
      return
    }
    case "html": {
      // Tags arrive as their own tokens with the content in sibling text
      // tokens, so dropping them leaves clean prose behind. `<br>` is the one
      // tag that carries layout rather than presentation.
      if (/^<br\s*\/?>$/i.test((token as Tokens.Tag).text.trim())) out.push(raw("\n"))
      return
    }
    default: {
      const generic = token as Tokens.Generic
      if (generic.tokens && generic.tokens.length > 0) {
        out.push(...inlineChunks(generic.tokens, style))
        return
      }
      const text = typeof generic.text === "string" ? generic.text : (generic.raw ?? "")
      if (text) out.push(ink(softBreaks(text), style))
    }
  }
}

function ink(text: string, style: Ink): TextChunk {
  let chunk = fg(style.color)(text)
  if (style.bold) chunk = bold(chunk)
  if (style.italic) chunk = italic(chunk)
  if (style.underline) chunk = underline(chunk)
  if (style.strike) chunk = strikethrough(chunk)
  return style.href ? link(style.href)(chunk) : chunk
}

// CommonMark reads a lone newline inside a paragraph as a space, and marked
// keeps it inside the text token. The wrapper flushes a row on a newline, so
// without this every hard-wrapped source paragraph would keep whatever ragged
// breaks its author happened to type instead of reflowing to the panel.
function softBreaks(text: string) {
  return text.replace(/\n/g, " ")
}

function plainText(chunks: readonly TextChunk[]) {
  return chunks.map((chunk) => chunk.text).join("")
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0)
}

function clamp(value: number, low: number, high: number) {
  return Math.max(low, Math.min(high, value))
}

function argmax(values: number[]) {
  let best = -1
  let bestValue = Number.NEGATIVE_INFINITY
  values.forEach((value, index) => {
    if (value > bestValue) {
      bestValue = value
      best = index
    }
  })
  return best
}
