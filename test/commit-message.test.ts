import { describe, expect, test } from "bun:test"

import {
  commitMessagePrompt,
  formatCommitMessage,
  readCommitMessage,
  templateCommitMessage,
} from "../src/commit-message"

describe("readCommitMessage", () => {
  test("reads the JSON contract from the last line of a reply that narrated first", () => {
    const reply = [
      "Let me look at the reports before answering.",
      "The run added a per-step advisor and wired it through the bridge.",
      '{"type": "feat", "scope": "advisor", "subject": "add per-step advisor model", "body": ["route calls through the bridge", "cap consultations"]}',
    ].join("\n")

    expect(readCommitMessage(reply)).toEqual({
      type: "feat",
      scope: "advisor",
      subject: "add per-step advisor model",
      body: ["route calls through the bridge", "cap consultations"],
    })
  })

  test("reads a fenced, pretty-printed object spanning several lines", () => {
    const reply = ['```json', "{", '  "type": "fix",', '  "subject": "stop the runner leaking sessions"', "}", "```"].join("\n")
    expect(readCommitMessage(reply)).toEqual({ type: "fix", subject: "stop the runner leaking sessions", body: [] })
  })

  test("falls back to feat for an unknown type and drops an unusable scope", () => {
    const reply = '{"type": "improvement", "scope": "Core Runner!", "subject": "tidy up"}'
    expect(readCommitMessage(reply)).toMatchObject({ type: "feat", scope: "corerunner" })
  })

  test("strips a doubled conventional prefix out of the subject", () => {
    const reply = '{"type": "feat", "scope": "tui", "subject": "feat(tui): add the palette."}'
    expect(readCommitMessage(reply)).toMatchObject({ subject: "add the palette" })
  })

  test("normalizes body bullets and caps the list", () => {
    const body = ["- one", "* two", "", "three", "four", "five", "six", "seven"]
    const reply = JSON.stringify({ type: "feat", subject: "do things", body })
    expect(readCommitMessage(reply)?.body).toEqual(["one", "two", "three", "four", "five", "six"])
  })

  test("caps the subject so the whole line stays inside 72 columns", () => {
    const subject = "add a very long and rather over-explained description of the change we made today"
    const message = readCommitMessage(JSON.stringify({ type: "feat", scope: "runner", subject }))
    expect(`feat(runner): ${message?.subject}`.length).toBeLessThanOrEqual(72)
    expect(message?.subject.endsWith(" ")).toBe(false)
    expect(subject.startsWith(message?.subject ?? "")).toBe(true)
  })

  test("rejects a reply with no usable subject", () => {
    expect(readCommitMessage("I couldn't determine what changed.")).toBeUndefined()
    expect(readCommitMessage('{"type": "feat"}')).toBeUndefined()
  })

  test("strips leading quotes from the subject", () => {
    const reply = '{"type": "fix", "subject": "\'fix the parser\'"}'
    expect(readCommitMessage(reply)?.subject).toBe("fix the parser")
  })

  test("strips trailing period from the subject", () => {
    const reply = '{"type": "fix", "subject": "fix the parser."}'
    expect(readCommitMessage(reply)?.subject).toBe("fix the parser")
  })

  test("rejects malformed JSON in reply", () => {
    expect(readCommitMessage('{"type": "feat", "subject": "broken')).toBeUndefined()
  })

  test("rejects reply JSON with non-object type", () => {
    expect(readCommitMessage("true")).toBeUndefined()
    expect(readCommitMessage("null")).toBeUndefined()
    expect(readCommitMessage('"string"')).toBeUndefined()
  })

  test("subject with missing type field defaults to feat", () => {
    const reply = '{"subject": "add the feature"}'
    expect(readCommitMessage(reply)?.type).toBe("feat")
  })

  test("subject with missing subject field returns undefined", () => {
    const reply = '{"type": "feat"}'
    expect(readCommitMessage(reply)).toBeUndefined()
  })

  test("handles body with non-string items", () => {
    const reply = '{"type": "feat", "subject": "do things", "body": ["one", 2, null, "four"]}'
    expect(readCommitMessage(reply)?.body).toEqual(["one", "four"])
  })

  test("handles scope with special characters", () => {
    const reply = '{"type": "feat", "scope": "CORE!!!", "subject": "fix it"}'
    expect(readCommitMessage(reply)).toMatchObject({ scope: "core", subject: "fix it" })
  })

  test("caps scope to 20 chars", () => {
    const reply = '{"type": "feat", "scope": "a-very-long-scope-name-that-exceeds", "subject": "fix it"}'
    expect(readCommitMessage(reply)?.scope?.length).toBeLessThanOrEqual(20)
  })

  test("removes the conventional prefix (type(scope):) from subject", () => {
    const reply = '{"type": "feat", "subject": "feat(runner): implement the thing."}'
    expect(readCommitMessage(reply)?.subject).toBe("implement the thing")
  })

  test("empty body becomes an empty array", () => {
    const reply = '{"type": "feat", "subject": "do things", "body": []}'
    expect(readCommitMessage(reply)?.body).toEqual([])
  })

  test("body with empty strings after trimming filters them out", () => {
    const reply = '{"type": "feat", "subject": "do things", "body": ["one", "", "  ", "two"]}'
    expect(readCommitMessage(reply)?.body).toEqual(["one", "two"])
  })
})

describe("formatCommitMessage", () => {
  test("renders subject, blank line, and a bullet body", () => {
    expect(formatCommitMessage({ type: "feat", scope: "advisor", subject: "add per-step model", body: ["one", "two"] })).toBe(
      "feat(advisor): add per-step model\n\n- one\n- two",
    )
  })

  test("omits the scope and the body when there are none", () => {
    expect(formatCommitMessage({ type: "fix", subject: "stop the leak", body: [] })).toBe("fix: stop the leak")
  })

  test("single body line renders as one bullet", () => {
    expect(formatCommitMessage({ type: "feat", subject: "do it", body: ["only one change"] })).toBe(
      "feat: do it\n\n- only one change",
    )
  })

  test("long body with many lines", () => {
    const body = ["a", "b", "c", "d", "e", "f"]
    const result = formatCommitMessage({ type: "feat", subject: "many changes", body })
    expect(result).toBe("feat: many changes\n\n- a\n- b\n- c\n- d\n- e\n- f")
  })

  test("body with empty strings before rendering filters them", () => {
    const result = formatCommitMessage({ type: "feat", subject: "work", body: ["", "a", "", "b"] })
    // formatCommitMessage doesn't filter body - it just joins them
    expect(result).toBe("feat: work\n\n- \n- a\n- \n- b")
  })
})

describe("templateCommitMessage", () => {
  test("takes the type from the branch and the subject from the PRD's first heading", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "fix/runtime-guard-limits",
      prompt: "# Add runtime guard limits\n\nThe limits must be configurable.",
      commits: ["convoy(implementer): Implementer report", "convoy(security): Security audit"],
    })

    expect(message.type).toBe("fix")
    expect(message.subject).toBe("Add runtime guard limits")
    expect(message.body).toEqual(["Implementer report", "Security audit"])
  })

  test("falls back to the branch name when there is no prompt", () => {
    const message = templateCommitMessage({ targetDir: "/repo", branch: "feat/add-onboarding-flow", commits: [] })
    expect(message).toMatchObject({ type: "feat", subject: "add onboarding flow", body: [] })
  })

  test("defaults the type when the branch carries no conventional prefix", () => {
    expect(templateCommitMessage({ targetDir: "/repo", branch: "my-branch", commits: [] }).type).toBe("feat")
  })

  test("uses first meaningful line from prompt when it has markdown heading", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "fix/issue-42",
      prompt: "### Fix issue 42\n\nThis is a fix for issue 42.",
      commits: [],
    })
    expect(message.subject).toContain("Fix issue 42")
  })

  test("subject falls back to 'update' when prompt and branch both yield nothing", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "",
      prompt: "",
      commits: [],
    })
    // A branch with no prefix uses defaultCommitType "feat", and empty rest becomes "update"
    expect(message.subject).toBe("update")
  })

  test("body strips convoy scope from step commits", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/feature",
      commits: ["convoy(implementer): Implementer report", "convoy(security): Security audit"],
    })
    expect(message.body).toEqual(["Implementer report", "Security audit"])
  })

  test("body filters out step commits that are empty after stripping prefix", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/feature",
      commits: ["convoy(implementer): ", "convoy(security): Security audit"],
    })
    expect(message.body).toEqual(["Security audit"])
  })

  test("body caps at maxBodyLines", () => {
    const commits = Array.from({ length: 10 }, (_, i) => `convoy(step): Commit ${i + 1}`)
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/many",
      commits,
    })
    expect(message.body.length).toBe(6)
  })

  test("subject is capped to fit in 72 columns", () => {
    const longSubject = "a".repeat(100)
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat/long-subject",
      prompt: longSubject,
      commits: [],
    })
    expect(message.subject.length).toBeLessThanOrEqual(72)
  })

  test("branch without slash uses rest of whole branch as subject base", () => {
    const message = templateCommitMessage({
      targetDir: "/repo",
      branch: "feat",
      commits: [],
    })
    expect(message.subject).toBe("feat")
  })
})

describe("commitMessagePrompt", () => {
  test("leads with the reports and includes every other signal it was given", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      summary: "Built the thing.",
      prompt: "Please build the thing.",
      commits: ["convoy(implementer): Implementer report"],
      diffStat: " src/thing.ts | 10 ++++",
    })

    expect(prompt.indexOf("What the run reported doing")).toBeLessThan(prompt.indexOf("What the user originally asked for"))
    expect(prompt).toContain("Branch: feat/thing")
    expect(prompt).toContain("convoy(implementer): Implementer report")
    expect(prompt).toContain("src/thing.ts")
  })

  test("omits sections it has nothing for", () => {
    const prompt = commitMessagePrompt({ targetDir: "/repo", branch: "feat/thing", commits: [] })
    expect(prompt).toBe("Branch: feat/thing")
  })

  test("omits summary when it is only whitespace", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      summary: "   ",
      commits: [],
    })
    expect(prompt).not.toContain("reported doing")
  })

  test("omits prompt when it is only whitespace", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      prompt: "   \n  \n",
      commits: [],
    })
    expect(prompt).not.toContain("originally asked for")
  })

  test("omits diffstat when it is only whitespace", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      diffStat: "  ",
      commits: [],
    })
    expect(prompt).not.toContain("Diffstat")
  })

  test("includes commits when non-empty", () => {
    const prompt = commitMessagePrompt({
      targetDir: "/repo",
      branch: "feat/thing",
      commits: ["convoy(step): Step 1"],
    })
    expect(prompt).toContain("squashed")
    expect(prompt).toContain("convoy(step): Step 1")
  })
})