import { describe, expect, test } from "bun:test"

import { markdownInlineChunks, markdownLines, parseMarkdown, renderMarkdownDoc, safeHyperlinkUrl, sanitizeMarkdownLine } from "../src/markdown-render"
import { displayWidth } from "../src/tui-theme"

import type { StyledText } from "@opentui/core"

const text = (line: { chunks: { text: string }[] }) => line.chunks.map((chunk) => chunk.text).join("")
const rows = (markdown: string, width: number) => markdownLines(markdown, width).map(text)

describe("markdown rendering", () => {
  test("conceals common markdown markers while preserving document structure", () => {
    const lines = rows("# Heading\n\n- **bold** and `code`\n\n> quoted\n\n[docs](https://example.com)", 80)

    expect(lines).toEqual(["Heading", "", "• bold and code", "", "▎ quoted", "", "docs"])
  })

  test("wraps styled content to terminal cell width", () => {
    const lines = rows("**界界界**", 4)

    expect(lines).toEqual(["界界", "界"])
    expect(lines.every((line) => displayWidth(line) <= 4)).toBeTrue()
  })

  test("wraps prose between words, only splitting an unbroken over-wide token", () => {
    expect(rows("Pack words without splitting them", 10)).toEqual(["Pack words", "without", "splitting", "them"])
    expect(rows("supercalifragilistic", 8)).toEqual(["supercal", "ifragili", "stic"])
  })

  test("renders inline typography plus ordered, task, rule, and fenced-code blocks", () => {
    const inline = markdownLines("**strong** _emphasis_ ~~deleted~~ `code` [site](https://example.com)", 80)[0]!.chunks
    // `2)` renders as `2.`: marked reports the ordinal but not the delimiter the
    // source used, so one convention covers both.
    const blocks = rows("1. first\n2) second\n- [ ] queued\n* [x] done\n---\n```ts\nconst value = 1\n```", 20)

    expect(inline.find((chunk) => chunk.text === "strong")?.attributes).toBe(1)
    expect(inline.find((chunk) => chunk.text === "emphasis")?.attributes).toBe(4)
    expect(inline.find((chunk) => chunk.text === "deleted")?.attributes).toBe(128)
    expect(inline.find((chunk) => chunk.text === "site")?.link).toEqual({ url: "https://example.com/" })
    expect(blocks.slice(0, 4)).toEqual(["1. first", "2. second", "☐ queued", "☑ done"])
    expect(blocks[4]).toBe("─".repeat(20))
    expect(blocks[5]).toBe("┄ ts " + "┄".repeat(15))
    expect(blocks[6]).toBe("│ const value = 1")
    expect(blocks[7]).toBe("┄".repeat(20))
    expect(blocks.every((line) => displayWidth(line) <= 20)).toBeTrue()
  })

  test("sanitizes terminal controls and only creates web hyperlinks", () => {
    const lines = markdownLines("safe]52;c;dGVzdAtext\n[local](file:///etc/passwd)\n[web](https://example.com)", 80)
    const chunks = lines.flatMap((line) => line.chunks)

    expect(chunks.map((chunk) => chunk.text).join("")).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/)
    expect(chunks.find((chunk) => chunk.text === "local")?.link).toBeUndefined()
    expect(chunks.find((chunk) => chunk.text === "web")?.link).toEqual({ url: "https://example.com/" })
  })

  test("keeps intra-word underscores literal instead of italicizing identifiers", () => {
    const lines = rows("use foo_bar_baz or report_fullscreen_flag, but _real emphasis_ stays", 80)

    expect(lines).toEqual(["use foo_bar_baz or report_fullscreen_flag, but real emphasis stays"])
  })

  test("bounds fence rows to width even with long info strings", () => {
    const lines = rows("```python { .annotate }\nx = 1\n```", 20)

    expect(lines[0]!.startsWith("┄ python")).toBeTrue()
    expect(lines.every((line) => displayWidth(line) <= 20)).toBeTrue()
  })

  test("never loops on a glyph wider than the column", () => {
    expect(rows("界面", 1)).toEqual(["界", "面"])
  })
})

describe("markdown block structure", () => {
  test("renders setext headings without mistaking a list's rule for one", () => {
    expect(rows("Title\n===\n\nSub\n---", 20)).toEqual(["Title", "", "Sub"])
    // A rule under a list closes the list; it is not an underlined heading.
    expect(rows("- foo\n---", 6)).toEqual(["• foo", "──────"])
  })

  test("gives indented and tilde-fenced code the same gutter as a backtick fence", () => {
    expect(rows("    indented = 1", 20)).toEqual(["┄" + "┄".repeat(19), "│ indented = 1", "┄".repeat(20)])
    expect(rows("~~~py\nx = 1\n~~~", 20)).toEqual(["┄ py " + "┄".repeat(15), "│ x = 1", "┄".repeat(20)])
  })

  test("keeps the code gutter on every continuation row of an over-wide line", () => {
    const lines = rows("```\nconst aVeryLongIdentifier = somethingElseEntirely + more\n```", 24)
    const body = lines.slice(1, -1)

    expect(body.length).toBeGreaterThan(1)
    expect(body.every((line) => line.startsWith("│ "))).toBeTrue()
    expect(lines.every((line) => displayWidth(line) <= 24)).toBeTrue()
  })

  test("marks each list level differently and hangs wrapped text under its own column", () => {
    const lines = rows("- level one item that is long enough to wrap\n  - level two also long enough to wrap\n    - level three", 30)

    expect(lines[0]!.startsWith("• ")).toBeTrue()
    expect(lines[1]!.startsWith("  ")).toBeTrue()
    expect(lines.some((line) => line.startsWith("  ◦ "))).toBeTrue()
    expect(lines.some((line) => line.startsWith("    ▪ "))).toBeTrue()
    // The level-two continuation aligns with its own text column, not column 0.
    expect(lines.some((line) => line.startsWith("    ") && line.trim() === "to wrap")).toBeTrue()
  })

  test("shares one marker column across an ordered list and honors its start", () => {
    expect(rows("9. nine\n10. ten", 20)).toEqual([" 9. nine", "10. ten"])
    expect(rows("3. three\n4. four", 20)).toEqual(["3. three", "4. four"])
  })

  test("separates the items of a loose list", () => {
    expect(rows("- a\n\n- b", 20)).toEqual(["• a", "", "• b"])
    expect(rows("- a\n- b", 20)).toEqual(["• a", "• b"])
  })

  test("nests blockquote bars and keeps the bar on a blank quoted row", () => {
    expect(rows("> outer\n>\n> > inner", 20)).toEqual(["▎ outer", "▎", "▎ ▎ inner"])
  })

  test("collapses a run of blank lines to a single row", () => {
    expect(rows("alpha\n\n\n\n\nbeta", 20)).toEqual(["alpha", "", "beta"])
  })

  test("renders a link definition as nothing while still resolving its reference", () => {
    const lines = markdownLines("[ref]: https://example.com\n\nsee [ref]", 40)

    expect(lines.map(text)).toEqual(["see ref"])
    expect(lines.flatMap((line) => line.chunks).find((chunk) => chunk.text === "ref")?.link).toEqual({ url: "https://example.com/" })
  })
})

describe("markdown inline typography", () => {
  test("reflows a soft-wrapped paragraph but honors a hard break", () => {
    expect(rows("soft one\nsoft two", 40)).toEqual(["soft one soft two"])
    expect(rows("hard one  \nhard two", 40)).toEqual(["hard one", "hard two"])
    expect(rows("back one\\\nback two", 40)).toEqual(["back one", "back two"])
  })

  test("renders an escaped marker as its literal character", () => {
    const lines = markdownLines("literal \\*not italic\\* here", 40)

    expect(lines.map(text)).toEqual(["literal *not italic* here"])
    expect(lines[0]!.chunks.every((chunk) => chunk.attributes === 0 || chunk.attributes === undefined)).toBeTrue()
  })

  test("links autolinks and bare URLs without any markup around them", () => {
    const chunks = markdownLines("see <https://one.example> and https://two.example now", 60).flatMap((line) => line.chunks)

    expect(chunks.find((chunk) => chunk.text === "https://one.example")?.link).toEqual({ url: "https://one.example/" })
    expect(chunks.find((chunk) => chunk.text === "https://two.example")?.link).toEqual({ url: "https://two.example/" })
  })

  test("names an image instead of dropping it", () => {
    const lines = markdownLines("![a diagram](https://example.com/x.png)", 40)

    expect(lines.map(text)).toEqual(["[image: a diagram]"])
    expect(lines[0]!.chunks[0]?.link).toEqual({ url: "https://example.com/x.png" })
  })

  test("drops inline tags but keeps their text, and breaks on <br>", () => {
    expect(rows("plain <b>bold-ish</b> tail", 40)).toEqual(["plain bold-ish tail"])
    expect(rows("above<br>below", 40)).toEqual(["above", "below"])
  })

  test("never emits a newline inside a chunk", () => {
    const corpus = "# h\n\npara one\npara two\n\n- item\n\n> quote\n\n```js\nlet x = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nhard  \nbreak"
    for (const width of [12, 24, 48]) {
      const chunks = markdownLines(corpus, width).flatMap((line) => line.chunks)
      expect(chunks.some((chunk) => chunk.text.includes("\n"))).toBeFalse()
    }
  })

  test("treats a feed message as prose, not as a document", () => {
    // A log line starting with "- " is a message, not a bullet.
    expect(markdownInlineChunks("- not a bullet").map((chunk) => chunk.text).join("")).toBe("- not a bullet")
    expect(markdownInlineChunks("ran `bun test` twice").map((chunk) => chunk.text).join("")).toBe("ran bun test twice")
    expect(markdownInlineChunks("multi\nline").map((chunk) => chunk.text).join("")).toBe("multi line")
  })
})

describe("markdown tables", () => {
  test("draws a bordered box and honors column alignment", () => {
    const lines = rows("| left | mid | right |\n|:-----|:---:|------:|\n| a | b | c |", 40)

    expect(lines).toEqual([
      "┌──────┬─────┬───────┐",
      "│ left │ mid │ right │",
      "├──────┼─────┼───────┤",
      "│ a    │  b  │     c │",
      "└──────┴─────┴───────┘",
    ])
  })

  test("keeps the box inside the panel by wrapping cells, and rules between wrapped rows", () => {
    const width = 44
    const lines = rows(
      "| ID | Final status | Evidence |\n|---|---|---|\n| MF-1 | fixed | show_planned_program_journey.dart now uses planning |\n| SF-1 | fixed | ok |",
      width,
    )

    expect(lines.every((line) => displayWidth(line) <= width)).toBeTrue()
    expect(lines[0]!.startsWith("┌")).toBeTrue()
    expect(lines[lines.length - 1]!.startsWith("└")).toBeTrue()
    // A wrapped body row needs a rule after it, or two multi-row records read
    // as one.
    expect(lines.filter((line) => line.startsWith("├")).length).toBe(2)
    expect(lines.filter((line) => line.startsWith("│")).length).toBeGreaterThan(3)
  })

  test("degrades to one labelled record per row when no box can fit", () => {
    const width = 22
    const lines = rows("| ID | Status | Evidence | Verification |\n|---|---|---|---|\n| MF-1 | fixed | journey.dart | PASS |", width)

    expect(lines.every((line) => displayWidth(line) <= width)).toBeTrue()
    expect(lines.some((line) => line.includes("┌") || line.includes("│"))).toBeFalse()
    expect(lines[0]).toBe("▸ MF-1")
    expect(lines.some((line) => line.trimStart().startsWith("Status"))).toBeTrue()
    expect(lines.join("\n")).toContain("fixed")
    expect(lines.join("\n")).toContain("PASS")
  })

  test("renders a row with fewer cells than the header without throwing", () => {
    const lines = rows("| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 |", 40)

    expect(lines[0]!.startsWith("┌")).toBeTrue()
    expect(lines.every((line) => displayWidth(line) <= 40)).toBeTrue()
  })

  test("styles inline markdown inside a cell", () => {
    const chunks = markdownLines("| what | detail |\n|---|---|\n| **bold** | `code` |", 40).flatMap((line) => line.chunks)

    expect(chunks.find((chunk) => chunk.text === "bold")?.attributes).toBe(1)
    expect(chunks.find((chunk) => chunk.text === "code")).toBeDefined()
  })
})

describe("markdown safety", () => {
  test("strips terminal control bytes and keeps tabs as indentation", () => {
    expect(sanitizeMarkdownLine("a\tb")).toBe("a    b")
    expect(sanitizeMarkdownLine("safe]52;c;dGVzdAtext")).toBe("safe]52;c;dGVzdAtext")
    expect(sanitizeMarkdownLine("null byte")).toBe("nullbyte")
  })

  test("only turns http and https targets into terminal hyperlinks", () => {
    expect(safeHyperlinkUrl("https://example.com")).toBe("https://example.com/")
    expect(safeHyperlinkUrl("http://example.com/x")).toBe("http://example.com/x")
    expect(safeHyperlinkUrl("file:///etc/passwd")).toBeUndefined()
    expect(safeHyperlinkUrl("javascript:alert(1)")).toBeUndefined()
    expect(safeHyperlinkUrl("mailto:a@b.c")).toBeUndefined()
    expect(safeHyperlinkUrl("./relative")).toBeUndefined()
    expect(safeHyperlinkUrl(`https://example.com/${"x".repeat(2_100)}`)).toBeUndefined()
  })

  test("strips control bytes reaching through code, a table cell, or a link label", () => {
    const hostile = [
      "```\ncode]52;c;evilhere\n```",
      "| a | b |\n|---|---|\n| cell]0;titlex | y |",
      "[label](https://example.com)",
      "> quoted",
    ].join("\n\n")

    const chunks = markdownLines(hostile, 40).flatMap((line) => line.chunks)
    expect(chunks.map((chunk) => chunk.text).join("")).not.toMatch(/[\u0000-\u001F\u007F-\u009F]/)
  })
})

describe("markdown robustness", () => {
  const corpus = [
    "# heading\n\nprose that runs on for a while and needs to wrap somewhere sensible",
    "- one\n  - two\n    - three\n- [x] done",
    "> quoted\n>\n> > nested",
    "```ts\nconst value = someCall(withArguments, andMore)\n```",
    "| ID | Status | Evidence |\n|---|:-:|--:|\n| MF-1 | fixed | a/rather/long/path.dart |",
    "1. first\n2. second\n\n---\n\n[link](https://example.com) and ![img](https://example.com/x.png)",
  ]

  test("never exceeds the requested width and never throws", () => {
    for (const markdown of corpus) {
      for (let width = 1; width <= 40; width++) {
        const lines = markdownLines(markdown, width)
        for (const line of lines) expect(displayWidth(text(line))).toBeLessThanOrEqual(width)
      }
    }
  })

  test("survives pathological input", () => {
    const nasty = ["[".repeat(5_000), ">".repeat(2_000) + " deep", "```\n".repeat(500), "|".repeat(1_000), "*".repeat(3_000)]

    for (const markdown of nasty) {
      const lines = markdownLines(markdown, 40)
      expect(lines.length).toBeGreaterThan(0)
      for (const line of lines) expect(displayWidth(text(line))).toBeLessThanOrEqual(40)
    }
  })

  test("falls back to plain wrapped text when the document could not be lexed", () => {
    const lines: StyledText[] = renderMarkdownDoc({ tokens: undefined, source: "# not parsed\nsecond line" }, 40)

    expect(lines.map(text)).toEqual(["# not parsed", "second line"])
  })

  test("renders an empty document as a single empty row", () => {
    expect(markdownLines("", 40).map(text)).toEqual([""])
    expect(markdownLines([], 40).map(text)).toEqual([""])
  })

  test("bounds the block grammar on a huge document but still shows the tail", () => {
    // Past the cap the lexer is skipped, so the styling stops but no content is
    // lost and the cost of a report that embeds a whole log stays bounded.
    const huge = Array.from({ length: 2_400 }, (_, index) => (index === 2_300 ? "## late heading" : `line ${index}`)).join("\n")
    const started = Bun.nanoseconds()
    const lines = markdownLines(huge, 40).map(text)
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6

    expect(lines.some((line) => line.includes("line 2399"))).toBeTrue()
    // The tail keeps its markers because it never reached the block grammar.
    expect(lines.some((line) => line === "## late heading")).toBeTrue()
    expect(elapsedMs).toBeLessThan(1_500)
  })

  test("re-renders a parsed document at a new width without re-parsing", () => {
    const doc = parseMarkdown("prose that is long enough to wrap differently at two widths")

    expect(renderMarkdownDoc(doc, 60).length).toBeLessThan(renderMarkdownDoc(doc, 20).length)
  })
})
