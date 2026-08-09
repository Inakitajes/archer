import { describe, expect, test } from "bun:test"

import { parseTextCoverage } from "../scripts/coverage"

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
