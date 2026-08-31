// Standalone Kitty graphics check with streaming diagnostics: no TUI, no
// renderer. Every terminal reply prints the moment it lands; a watchdog ends
// the run no matter what. Run: bun scripts/kitty-test.ts [path-to-png]
import {
  cellAspectRatioFromResponse,
  coverSourceRect,
  displayKittyImage,
  kittyGraphicsSupported,
  pngDimensions,
  terminalCellAspectRatio,
} from "../src/kitty-graphics"
import { readFileSync } from "node:fs"

const path = process.argv[2] ?? new URL("../assets/home/pipelines.png", import.meta.url).pathname
const out = process.stdout
const stdin = process.stdin

console.log("env:")
console.log(`  TERM                  ${process.env.TERM ?? "(unset)"}`)
console.log(`  TERM_PROGRAM          ${process.env.TERM_PROGRAM ?? "(unset)"}`)
console.log(`  SSH_CONNECTION        ${process.env.SSH_CONNECTION ? "set (remote session)" : "(unset)"}`)
console.log(`  TMUX                  ${process.env.TMUX ? "SET — kitty graphics need allow-passthrough" : "(unset)"}`)
console.log(`env sniff: ${kittyGraphicsSupported()}`)
console.log("probing… (watchdog exits in 5s)")

// Anything the terminal says prints immediately, escaped and timestamped.
let data = ""
stdin.setRawMode(true)
stdin.resume()
stdin.on("data", (chunk: Buffer) => {
  const text = chunk.toString("latin1")
  data += text
  console.log(`  rx ${Date.now() % 100_000}: ${JSON.stringify(text)}`)
})

out.write("\x1b[>0q") // XTVERSION: what terminal is really out there?
out.write("\x1b[16t") // Exact cell height/width in pixels for cover cropping.
out.write("\x1b[c") // DA1: response barrier
out.write("\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\") // kitty graphics query
console.log("queries sent: XTVERSION, DA1, kitty graphics")

setTimeout(() => {
  const identity = data.match(/\x1bP\|([^\x1b]*)\x1b\\/)?.[1]
  const graphics = /_Gi=31;/.test(data)
  console.log("─".repeat(60))
  console.log(`terminal identity:        ${identity ? JSON.stringify(identity) : "(no reply)"}`)
  console.log(`graphics query answered:  ${graphics}`)
  if (!graphics) {
    console.log("no graphics reply — likely causes:")
    console.log("  - tmux/screen in between (set -g allow-passthrough on)")
    console.log("  - old Ghostty build without graphics support")
    console.log("  - escape sequences not reaching the client at all")
    console.log("force a drawing attempt: CONVOY_KITTY=1 bun scripts/kitty-test.ts")
  }
  // Try the photo regardless of the verdict when asked to.
  if (graphics || process.env.CONVOY_KITTY === "1") {
    const cols = out.columns ?? 80
    const rows = Math.max(4, (out.rows ?? 24) - 6)
    const cellAspectRatio = cellAspectRatioFromResponse(data) ?? terminalCellAspectRatio()
    const dimensions = pngDimensions(readFileSync(path))
    const source = dimensions
      ? coverSourceRect({
          sourceWidth: dimensions.width,
          sourceHeight: dimensions.height,
          targetWidth: cols * cellAspectRatio,
          targetHeight: rows,
        })
      : undefined
    out.write("\x1b[2J\x1b[H")
    const drawn = displayKittyImage({ id: 1, path, col: 0, row: 0, cols, rows, source })
    out.write(`\x1b[${rows + 1};1Hdrawn=${drawn} ${cols}x${rows} cells, cell aspect=${cellAspectRatio.toFixed(3)} — photo visible? Enter to exit.`)
    stdin.once("data", () => {
      out.write("\x1b[2J\x1b[H")
      process.exit(0)
    })
    return
  }
  process.exit(1)
}, 5_000)
