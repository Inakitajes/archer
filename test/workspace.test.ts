import { describe, expect, test } from "bun:test"

import { isValidRunID, convoyRoot, convoyHome, globalConfigPath, globalAgentsDir, runsRoot, opencodeConfigDir } from "../src/workspace"

describe("isValidRunID", () => {
  test("accepts a valid run ID", () => {
    expect(isValidRunID("20240101-120000-abcd")).toBe(true)
  })

  test("rejects invalid run IDs", () => {
    expect(isValidRunID("")).toBe(false)
    expect(isValidRunID("abc")).toBe(false)
    expect(isValidRunID("20240101-120000-ABCD")).toBe(false) // uppercase
    expect(isValidRunID("20240101-120000-abcde")).toBe(false) // 5 chars
    expect(isValidRunID("2024-120000-abcd")).toBe(false) // wrong format
  })
})

describe("convoyRoot", () => {
  test("returns CONVOY_HOME when set, else homedir", () => {
    const original = process.env.CONVOY_HOME
    delete process.env.CONVOY_HOME
    try {
      const root = convoyRoot()
      expect(root.length).toBeGreaterThan(0)
      expect(root).not.toContain(".convoy")
    } finally {
      if (original) process.env.CONVOY_HOME = original
    }
  })

  test("uses CONVOY_HOME when set", () => {
    const original = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = "/custom/convoy"
    try {
      expect(convoyRoot()).toBe("/custom/convoy")
    } finally {
      if (original) process.env.CONVOY_HOME = original
      else delete process.env.CONVOY_HOME
    }
  })
})

describe("convoyHome", () => {
  test("returns the .convoy subdirectory of convoyRoot", () => {
    const original = process.env.CONVOY_HOME
    process.env.CONVOY_HOME = "/tmp"
    try {
      expect(convoyHome()).toBe("/tmp/.convoy")
    } finally {
      if (original) process.env.CONVOY_HOME = original
      else delete process.env.CONVOY_HOME
    }
  })
})

describe("globalConfigPath", () => {
  test("returns the config.yaml path under convoyHome", () => {
    const home = globalConfigPath()
    expect(home.endsWith("config.yaml")).toBe(true)
    expect(home).toContain(".convoy")
  })
})

describe("globalAgentsDir", () => {
  test("returns the agents directory under convoyHome", () => {
    const dir = globalAgentsDir()
    expect(dir.endsWith("agents")).toBe(true)
    expect(dir).toContain(".convoy")
  })
})

describe("runsRoot", () => {
  test("returns the runs directory under convoyHome", () => {
    const root = runsRoot()
    expect(root.endsWith("runs")).toBe(true)
    expect(root).toContain(".convoy")
  })
})

describe("opencodeConfigDir", () => {
  test("returns the opencode directory under convoyHome", () => {
    const dir = opencodeConfigDir()
    expect(dir.endsWith("opencode")).toBe(true)
    expect(dir).toContain(".convoy")
  })
})

describe("runDir", () => {
  test("throws for an invalid run ID", () => {
    const { runDir } = require("../src/workspace") as { runDir: (id: string) => string }
    expect(() => runDir("invalid")).toThrow("invalid run id")
  })
})