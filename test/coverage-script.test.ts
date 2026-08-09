import { describe, expect, test } from "bun:test"

import { badgeColor, generateBadgeSVG, parseTextCoverage } from "../scripts/coverage"

describe("parseTextCoverage", () => {
  test("maps Bun's function and line columns in the documented order", () => {
    const output = `
----------------|---------|---------|-------------------
File            | % Funcs | % Lines | Uncovered Line #s
----------------|---------|---------|-------------------
All files       |   91.84 |   90.12 |
`

    expect(parseTextCoverage(output)).toEqual({ funcPct: 91.84, linePct: 90.12 })
  })

  test("rejects output without Bun's aggregate row", () => {
    expect(() => parseTextCoverage("1836 pass\n0 fail")).toThrow("Could not parse coverage summary")
  })
})

describe("coverage badge", () => {
  test("uses the expected color bands", () => {
    expect(badgeColor(95)).toBe("#4c1")
    expect(badgeColor(90)).toBe("#97ca00")
    expect(badgeColor(80)).toBe("#a4a61d")
    expect(badgeColor(70)).toBe("#dfb317")
    expect(badgeColor(60)).toBe("#fe7d37")
    expect(badgeColor(59.99)).toBe("#e05d44")
  })

  test("renders an accessible badge with calculated dimensions", () => {
    const svg = generateBadgeSVG("coverage", "90.2%", "#97ca00")

    expect(svg).toContain('width="131" height="20"')
    expect(svg).toContain('aria-label="coverage: 90.2%"')
    expect(svg).toContain("<title>coverage: 90.2%</title>")
    expect(svg).toContain('<rect width="76" height="20" fill="#555"/>')
    expect(svg).toContain('<rect x="76" width="55" height="20" fill="#97ca00"/>')
  })
})
