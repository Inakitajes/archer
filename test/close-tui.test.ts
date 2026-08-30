import { describe, expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { EventEmitter } from "node:events"

import { CloseTui, type CloseFollowUpItem } from "../src/close-tui"

function keyEvent(name: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
  return {
    name,
    ctrl: options.ctrl ?? false,
    meta: false,
    shift: options.shift ?? false,
    option: false,
    sequence: name,
    number: false,
    raw: options.ctrl && name === "c" ? "\u0003" : name,
    eventType: "keypress" as const,
    source: "raw" as const,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as any
}

async function openClose(width = 100, height = 30, input = new EventEmitter()) {
  const testRenderer = await createTestRenderer({ width, height })
  const instance = new CloseTui(testRenderer.renderer, "/workspace/convoy", undefined, input)
  await testRenderer.renderOnce()
  return {
    ...testRenderer,
    instance,
    input,
    press(name: string, options: { ctrl?: boolean; shift?: boolean } = {}) {
      testRenderer.renderer.keyInput.emit("keypress", keyEvent(name, options))
    },
  }
}

describe("close TUI progress", () => {
  test("renders the event stream as a real full-screen checklist", async () => {
    const session = await openClose()
    try {
      session.instance.onEvent({ type: "preflight", summary: "clean tree · 4/4 tasks · no live runs" })
      session.instance.onEvent({ type: "step-skipped", step: "sync", reason: "main is already an ancestor" })
      session.instance.onEvent({ type: "step-started", step: "archive" })
      await session.renderOnce()

      const frame = session.captureCharFrame()
      expect(frame).toContain("convoy close")
      expect(frame).toContain("/workspace/convoy")
      expect(frame).toContain("clean tree · 4/4 tasks · no live runs")
      expect(frame).toContain("sync — skipped: main is already an ancestor")
      expect(frame).toContain("archive…")
      // The previous pseudo-TUI leaked cursor-up ANSI bytes to stdout. The
      // OpenTUI frame contains only the rendered interface.
      expect(frame).not.toContain("\x1b[")
    } finally {
      session.instance.destroy()
    }
  })

  test("keeps a failed step and remediation visible until dismissed", async () => {
    const session = await openClose()
    try {
      session.instance.onEvent({ type: "step-failed", step: "archive", message: "archive: openspec archive failed" })
      const dismissed = session.instance.showFailure("archive: openspec archive failed\nrun convoy close --resume")
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("close stopped")
      expect(frame).toContain("openspec archive failed")
      expect(frame).toContain("run convoy close --resume")
      session.press("q")
      await expect(dismissed).resolves.toBeUndefined()
    } finally {
      session.instance.destroy()
    }
  })
})

describe("close TUI commit gate", () => {
  test("offers accept, editor, and cancel inside the TUI", async () => {
    const session = await openClose()
    try {
      const decision = session.instance.confirmMessage({
        message: "feat(cli): improve close\n\n- change close-ui",
        source: "model",
      })
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("commit message")
      expect(frame).toContain("feat(cli): improve close")
      expect(frame).toContain("Accept")
      expect(frame).toContain("Edit in $EDITOR")
      expect(frame).toContain("Cancel")

      session.press("e")
      await expect(decision).resolves.toBe("edit")
    } finally {
      session.instance.destroy()
    }
  })

  test("Ctrl-C cancels before the squash lands", async () => {
    const session = await openClose()
    try {
      const decision = session.instance.confirmMessage({ message: "feat: close", source: "fallback" })
      session.press("c", { ctrl: true })
      await expect(decision).resolves.toBe("cancel")
    } finally {
      session.instance.destroy()
    }
  })

  test("terminal EOF cancels the gate instead of hanging", async () => {
    const input = new EventEmitter()
    const session = await openClose(100, 30, input)
    try {
      const decision = session.instance.confirmMessage({ message: "feat: close", source: "fallback" })
      input.emit("end")
      await expect(decision).resolves.toBe("cancel")
      // Any later blocking surface resolves immediately after the input died.
      await expect(session.instance.showFailure("terminal closed")).resolves.toBeUndefined()
    } finally {
      session.instance.destroy()
    }
  })

  test("releases and restores the renderer around terminal-owned commands", async () => {
    const session = await openClose()
    let suspended = 0
    let resumed = 0
    session.renderer.suspend = () => {
      suspended += 1
    }
    session.renderer.resume = () => {
      resumed += 1
    }
    try {
      await expect(session.instance.withTerminal(async () => "done")).resolves.toBe("done")
      expect(suspended).toBe(1)
      expect(resumed).toBe(1)
    } finally {
      session.instance.destroy()
    }
  })
})

describe("close TUI follow-ups", () => {
  const initial: CloseFollowUpItem[] = [
    { id: "push", label: "Push main", detail: "No upstream configured.", status: "unavailable" },
    { id: "worktree", label: "Remove worktree", detail: "/workspace/wt", status: "available" },
    { id: "branch", label: "Delete feat/close-ui", detail: "Remove the worktree first.", status: "unavailable" },
  ]

  test("shows disabled dependencies and resolves only an available action", async () => {
    const session = await openClose()
    try {
      const selection = session.instance.selectFollowUp(initial)
      await session.renderOnce()
      const frame = session.captureCharFrame()
      expect(frame).toContain("optional follow-ups")
      expect(frame).toContain("Nothing below runs automatically")
      expect(frame).toContain("Push main  unavailable")
      expect(frame).toContain("Remove worktree  available")
      expect(frame).toContain("Delete feat/close-ui  unavailable")

      // Push is selected but unavailable, so Enter is inert. Move to removal.
      session.press("return")
      session.press("down")
      session.press("return")
      await expect(selection).resolves.toEqual({ type: "run", id: "worktree" })
    } finally {
      session.instance.destroy()
    }
  })

  test("q leaves every remaining cleanup action optional", async () => {
    const session = await openClose()
    try {
      const selection = session.instance.selectFollowUp(initial)
      session.press("q")
      await expect(selection).resolves.toEqual({ type: "done" })
    } finally {
      session.instance.destroy()
    }
  })
})
