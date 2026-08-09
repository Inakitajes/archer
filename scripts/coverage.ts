#!/usr/bin/env bun
/**
 * Coverage runner and badge generator.
 *
 * Usage:
 *   bun run scripts/coverage.ts              # run tests, check threshold, generate badge
 *   bun run scripts/coverage.ts --check      # check threshold against existing coverage
 *   bun run scripts/coverage.ts --badge      # generate badge from existing coverage
 *
 * Environment variables:
 *   COVERAGE_THRESHOLD_LINES     minimum line coverage % (default 90)
 *   COVERAGE_THRESHOLD_FUNCS     minimum function coverage % (default 90)
 */

import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const ROOT = resolve(import.meta.dirname, "..")
const COVERAGE_DIR = join(ROOT, "coverage")
const BADGE_PATH = join(ROOT, "assets", "coverage.svg")
const CACHED_SUMMARY = join(COVERAGE_DIR, "summary.txt")
const THRESHOLD_LINES = Number(process.env.COVERAGE_THRESHOLD_LINES ?? 95)
const THRESHOLD_FUNCS = Number(process.env.COVERAGE_THRESHOLD_FUNCS ?? 95)

interface CoverageTotals {
  linePct: number
  funcPct: number
}

/**
 * Parses the "All files" line from bun's text coverage output.
 * The line looks like:
 *   All files | 87.37 | 85.38 |
 */
function parseTextCoverage(output: string): CoverageTotals {
  const match = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/)
  if (!match) {
    throw new Error("Could not parse coverage summary from test output")
  }
  return {
    linePct: Number.parseFloat(match[1]),
    funcPct: Number.parseFloat(match[2]),
  }
}

function badgeColor(p: number): string {
  if (p >= 95) return "#4c1"       // brightgreen
  if (p >= 90) return "#97ca00"    // green
  if (p >= 80) return "#a4a61d"    // yellowgreen
  if (p >= 70) return "#dfb317"    // yellow
  if (p >= 60) return "#fe7d37"    // orange
  return "#e05d44"                  // red
}

/**
 * Generates a shields.io-style SVG badge.
 */
function generateBadgeSVG(
  label: string,
  value: string,
  color: string,
): string {
  const labelWidth = Math.max(label.length * 7 + 20, 60)
  const valueWidth = Math.max(value.length * 7 + 20, 40)
  const totalWidth = labelWidth + valueWidth

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${totalWidth}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#fff" stop-opacity=".7"/>
    <stop offset=".1" stop-color="#aaa" stop-opacity=".1"/>
    <stop offset=".9" stop-opacity=".3"/>
    <stop offset="1" stop-opacity=".5"/>
  </linearGradient>
  <clipPath id="r">
    <rect width="${totalWidth}" height="20" rx="3" fill="#fff"/>
  </clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelWidth}" height="20" fill="#555"/>
    <rect x="${labelWidth}" width="${valueWidth}" height="20" fill="${color}"/>
    <rect width="${totalWidth}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${Math.floor(labelWidth / 2)}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${Math.floor(labelWidth / 2)}" y="14">${label}</text>
    <text x="${labelWidth + Math.floor(valueWidth / 2)}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelWidth + Math.floor(valueWidth / 2)}" y="14">${value}</text>
  </g>
</svg>`
}

function runTestsWithCoverage(): CoverageTotals {
  console.log("🧪 Running tests with coverage...")
  // bun outputs the coverage table on stderr, so merge both streams
  const output = execSync(
    "bun test --coverage-reporter=text --coverage --coverage-dir=" + COVERAGE_DIR + " 2>&1",
    { cwd: ROOT, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  )

  // Cache the summary for --check / --badge modes
  if (!existsSync(COVERAGE_DIR)) mkdirSync(COVERAGE_DIR, { recursive: true })
  writeFileSync(CACHED_SUMMARY, output, "utf-8")

  return parseTextCoverage(output)
}

function readCachedSummary(): CoverageTotals {
  if (!existsSync(CACHED_SUMMARY)) {
    console.error("❌ No cached coverage found. Run tests with coverage first.")
    process.exit(1)
  }
  return parseTextCoverage(readFileSync(CACHED_SUMMARY, "utf-8"))
}

function checkThreshold(totals: CoverageTotals): boolean {
  console.log(`\n📊 Coverage Summary (from bun text reporter):`)
  console.log(`   Lines:      ${totals.linePct}%`)
  console.log(`   Functions:  ${totals.funcPct}%`)
  console.log(`   Threshold:  ${THRESHOLD_LINES}% lines, ${THRESHOLD_FUNCS}% functions`)

  let ok = true
  if (totals.linePct < THRESHOLD_LINES) {
    console.error(`❌ Line coverage ${totals.linePct}% is below threshold of ${THRESHOLD_LINES}%`)
    ok = false
  } else {
    console.log(`✅ Line coverage ${totals.linePct}% meets threshold of ${THRESHOLD_LINES}%`)
  }

  if (totals.funcPct < THRESHOLD_FUNCS) {
    console.error(`❌ Function coverage ${totals.funcPct}% is below threshold of ${THRESHOLD_FUNCS}%`)
    ok = false
  } else {
    console.log(`✅ Function coverage ${totals.funcPct}% meets threshold of ${THRESHOLD_FUNCS}%`)
  }

  return ok
}

function generateBadge(totals: CoverageTotals): void {
  const color = badgeColor(totals.linePct)
  const value = `${totals.linePct}%`
  const svg = generateBadgeSVG("coverage", value, color)

  const dir = join(BADGE_PATH, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(BADGE_PATH, svg, "utf-8")
  console.log(`\n🏷️  Coverage badge written to ${BADGE_PATH}`)
}

// --- Main ---

const args = process.argv.slice(2)
const mode = args.includes("--check") ? "check" : args.includes("--badge") ? "badge" : "full"

let totals: CoverageTotals

if (mode === "check") {
  totals = readCachedSummary()
  const ok = checkThreshold(totals)
  if (!ok) process.exit(1)
  console.log("\n✅ All coverage checks passed!")
} else if (mode === "badge") {
  totals = readCachedSummary()
  generateBadge(totals)
} else {
  totals = runTestsWithCoverage()
  const ok = checkThreshold(totals)
  generateBadge(totals)
  if (!ok) {
    console.error("\n❌ Coverage check failed!")
    process.exit(1)
  }
  console.log("\n✅ All coverage checks passed!")
}