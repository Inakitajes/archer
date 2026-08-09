import { describe, expect, test } from "bun:test"

import { dirtyFilesPreview, dirtyTreeError, findSuspiciousStagedFiles, isSafeInitialBranch, unquotePorcelainPath } from "../src/git"

describe("unquotePorcelainPath", () => {
  test("returns unquoted path as-is", () => {
    expect(unquotePorcelainPath("src/index.ts")).toBe("src/index.ts")
  })

  test("decodes C-quoted paths with spaces", () => {
    expect(unquotePorcelainPath('"src/my file.ts"')).toBe("src/my file.ts")
  })

  test("decodes octal escapes as individual code points", () => {
    // \303\251 in git C-quoting = bytes 0xC3 0xA9 which String.fromCharCode
    // interprets as Ã (U+00C3) + © (U+00A9)
    expect(unquotePorcelainPath('"src/\\303\\251.ts"')).toBe("src/Ã©.ts")
  })

  test("decodes common escape sequences", () => {
    expect(unquotePorcelainPath('"src/\\tfile.ts"')).toBe("src/\tfile.ts")
    expect(unquotePorcelainPath('"src/\\nfile.ts"')).toBe("src/\nfile.ts")
  })
})

describe("isSafeInitialBranch", () => {
  test("returns true for valid branch names", () => {
    expect(isSafeInitialBranch("main")).toBe(true)
    expect(isSafeInitialBranch("feature/my-thing")).toBe(true)
    expect(isSafeInitialBranch("feat/convoy-123")).toBe(true)
  })

  test("returns false for HEAD", () => {
    expect(isSafeInitialBranch("HEAD")).toBe(false)
  })

  test("returns false for names starting with dash", () => {
    expect(isSafeInitialBranch("-branch")).toBe(false)
  })

  test("returns false for names with special characters", () => {
    expect(isSafeInitialBranch("bad~branch")).toBe(false)
    expect(isSafeInitialBranch("bad^branch")).toBe(false)
    expect(isSafeInitialBranch("bad:branch")).toBe(false)
    expect(isSafeInitialBranch("bad?branch")).toBe(false)
    expect(isSafeInitialBranch("bad*branch")).toBe(false)
    expect(isSafeInitialBranch("bad[branch]")).toBe(false)
    expect(isSafeInitialBranch("bad\\branch")).toBe(false)
    expect(isSafeInitialBranch("bad branch")).toBe(false)
  })

  test("returns false for names containing ..", () => {
    expect(isSafeInitialBranch("bad..branch")).toBe(false)
  })
})

describe("dirtyFilesPreview", () => {
  test("formats dirty files preview", () => {
    const result = dirtyFilesPreview(" M src/index.ts\n?? new.txt\n")
    expect(result).toContain("  M src/index.ts")
    expect(result).toContain("  ?? new.txt")
  })

  test("limits preview to maxDirtyPreview files", () => {
    const lines = Array.from({ length: 10 }, (_, i) => ` M file${i}.ts`).join("\n")
    const result = dirtyFilesPreview(lines)
    expect(result.split("\n").length).toBeLessThanOrEqual(7) // 5 files + "and X more" + empty
    expect(result).toContain("and 5 more")
  })

  test("handles empty porcelain", () => {
    expect(dirtyFilesPreview("")).toBe("")
  })
})

describe("dirtyTreeError", () => {
  test("creates error with resume hint when resuming", () => {
    const err = dirtyTreeError("/repo", " M src/index.ts", { resuming: true })
    expect(err.message).toContain("resume in an interactive terminal")
  })

  test("creates error with include-dirty hint when not resuming", () => {
    const err = dirtyTreeError("/repo", "?? new.txt", { resuming: false })
    expect(err.message).toContain("--include-dirty")
  })

  test("includes dirty files preview", () => {
    const err = dirtyTreeError("/repo", " M src/index.ts")
    expect(err.message).toContain("src/index.ts")
  })
})

describe("findSuspiciousStagedFiles", () => {
  test("returns empty array for clean porcelain", () => {
    expect(findSuspiciousStagedFiles("")).toEqual([])
  })

  test("finds files matching secret patterns", () => {
    const result = findSuspiciousStagedFiles("A  .env\nM  src/index.ts\n")
    expect(result).toContain(".env")
    expect(result).not.toContain("src/index.ts")
  })

  test("handles renamed files", () => {
    const result = findSuspiciousStagedFiles("R  oldname -> .env\n")
    expect(result).toContain(".env")
  })
})