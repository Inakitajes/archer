export interface CoverageTotals {
  linePct: number
  funcPct: number
}

/** Parses Bun's aggregate row (`All files | % Funcs | % Lines |`). */
export function parseTextCoverage(output: string): CoverageTotals {
  const match = output.match(/All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/)
  if (!match) throw new Error("Could not parse coverage summary from test output")
  return {
    funcPct: Number.parseFloat(match[1]),
    linePct: Number.parseFloat(match[2]),
  }
}

export function badgeColor(percentage: number): string {
  if (percentage >= 95) return "#4c1"
  if (percentage >= 90) return "#97ca00"
  if (percentage >= 80) return "#a4a61d"
  if (percentage >= 70) return "#dfb317"
  if (percentage >= 60) return "#fe7d37"
  return "#e05d44"
}

export function generateBadgeSVG(label: string, value: string, color: string): string {
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
