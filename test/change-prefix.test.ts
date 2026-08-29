import { describe, expect, test } from "bun:test"

import { branchNameForChange, deltaOperationsIn, inferChangePrefix } from "../src/worktree"

describe("delta operation markers", () => {
  test("reads the OpenSpec requirement-operation headers", () => {
    const body = [
      "# cli delta",
      "## ADDED Requirements",
      "### Requirement: One",
      "## MODIFIED Requirements",
      "### Requirement: Two",
    ].join("\n")
    expect(deltaOperationsIn(body)).toEqual(["ADDED", "MODIFIED"])
  })

  test("RENAMED counts as a modification, duplicates collapse, prose never matches", () => {
    expect(deltaOperationsIn("## RENAMED Requirements\n## MODIFIED Requirements")).toEqual(["MODIFIED"])
    // Not a header: the marker must open the line (allowing list/blockquote/hash decoration).
    expect(deltaOperationsIn("Requirements were ADDED here")).toEqual([])
    expect(deltaOperationsIn("- **ADDED** Requirements")).toEqual(["ADDED"])
  })

  test("a body without markers yields nothing", () => {
    expect(deltaOperationsIn("# just a spec\n### Requirement: plain")).toEqual([])
  })
})

describe("inferChangePrefix", () => {
  test("any ADDED requirement resolves to feat", () => {
    expect(inferChangePrefix(["## ADDED Requirements"])).toBe("feat")
    expect(inferChangePrefix(["## MODIFIED Requirements", "## ADDED Requirements"])).toBe("feat")
    expect(inferChangePrefix(["## REMOVED Requirements", "## ADDED Requirements"])).toBe("feat")
  })

  test("only MODIFIED resolves to change", () => {
    expect(inferChangePrefix(["## MODIFIED Requirements"])).toBe("change")
    expect(inferChangePrefix(["## RENAMED Requirements"])).toBe("change")
  })

  test("only REMOVED resolves to fix", () => {
    expect(inferChangePrefix(["## REMOVED Requirements"])).toBe("fix")
  })

  test("mixed operations without an addition resolve to feat", () => {
    expect(inferChangePrefix(["## MODIFIED Requirements", "## REMOVED Requirements"])).toBe("feat")
  })

  test("no delta specs falls back to feat", () => {
    expect(inferChangePrefix([])).toBe("feat")
    expect(inferChangePrefix(["# a delta with no operation headers"])).toBe("feat")
  })
})

describe("branchNameForChange", () => {
  test("joins prefix and change id verbatim", () => {
    expect(branchNameForChange("specs-viewer-tabbed-reading", "feat")).toBe("feat/specs-viewer-tabbed-reading")
    expect(branchNameForChange("add-foo", "change")).toBe("change/add-foo")
    expect(branchNameForChange("drop-legacy", "fix")).toBe("fix/drop-legacy")
  })

  test("infers the prefix from delta contents in one step", () => {
    expect(branchNameForChange("drop-legacy", inferChangePrefix(["## REMOVED Requirements"]))).toBe("fix/drop-legacy")
  })
})
