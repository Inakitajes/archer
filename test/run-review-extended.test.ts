import { describe, expect, test } from "bun:test"

import { sanitizeReviewText, sanitizeReviewInline } from "../src/run-review"

describe("sanitizeReviewText", () => {
  test("removes ANSI escape sequences", () => {
    expect(sanitizeReviewText("hello\u001b[31m world")).toBe("hello world")
  })

  test("removes control characters", () => {
    expect(sanitizeReviewText("line\u0000break")).toBe("linebreak")
  })

  test("replaces tabs with spaces", () => {
    expect(sanitizeReviewText("col1\tcol2")).toBe("col1 col2")
  })

  test("handles empty string", () => {
    expect(sanitizeReviewText("")).toBe("")
  })

  test("preserves normal text", () => {
    expect(sanitizeReviewText("hello world")).toBe("hello world")
  })

  test("removes multiple ANSI sequences", () => {
    expect(sanitizeReviewText("\u001b[1mbold\u001b[0m \u001b[4munderline\u001b[0m")).toBe("bold underline")
  })

  test("removes the BEL character from OSC sequences (control char removal)", () => {
    // \u001b is in the control character range \u000e-\u001f so it gets removed
    expect(sanitizeReviewText("text\u001b]52;c;clipboard\u0007more")).toBe("text]52;c;clipboardmore")
  })
})

describe("sanitizeReviewInline", () => {
  test("collapses whitespace and trims", () => {
    expect(sanitizeReviewInline("  hello   world  ")).toBe("hello world")
  })

  test("removes ANSI and collapses whitespace", () => {
    expect(sanitizeReviewInline("  hello\u001b[31m   world  ")).toBe("hello world")
  })

  test("converts newlines to spaces and trims", () => {
    expect(sanitizeReviewInline("\nhello\nworld\n")).toBe("hello world")
  })

  test("handles empty string", () => {
    expect(sanitizeReviewInline("")).toBe("")
  })

  test("handles only whitespace", () => {
    expect(sanitizeReviewInline("   \n  \t  ")).toBe("")
  })

  test("preserves single word", () => {
    expect(sanitizeReviewInline("hello")).toBe("hello")
  })

  test("removes control characters and collapses whitespace", () => {
    // \u0000 is removed, \t is converted to space, then whitespace is collapsed
    expect(sanitizeReviewInline("hello\u0000world\ttest")).toBe("helloworld test")
  })
})