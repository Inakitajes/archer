/**
 * Dependency-neutral commit-text primitives shared by the final squash composer
 * (`commit-message.ts`) and the intermediate step-commit composer
 * (`step-commit.ts`). This module deliberately imports nothing from the runner,
 * git, or opencode layers so both composers can reuse it without re-creating
 * the historical `commit-message.ts` → `runner.ts` import cycle.
 */

/** Conventional commits recommend keeping the whole subject line inside ~72 columns. */
export const maxCommitSubjectLength = 72

/**
 * Strips terminal-injection bytes from model- and git-derived text at the
 * render and commit-composition boundaries (SC-4). Removes full ANSI CSI
 * sequences (`\x1b[…m` and friends, so git-stderr color codes don't leave
 * `[31m` garbage) plus the remaining C0 bytes except tab/newline/CR and DEL —
 * escape bytes that could otherwise paint arbitrary terminal sequences.
 * Newlines survive so multi-line bodies and error blocks stay readable.
 */
export function stripControlBytes(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
}

/** The first line of a document that says anything after dropping heading markers and blanks. */
export function firstMeaningfulLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim().replace(/^#+\s*/, "")
    if (trimmed) return trimmed
  }
  return ""
}

/**
 * Fits `subject` under `maxLength` including the already-built `prefix`
 * (e.g. `feat(cli): ` or `convoy(implementer): `). Shortens at the last word
 * boundary so a cut never splits through a word, unless the only boundary
 * available leaves less than half the budget — then the hard cut wins over a
 * uselessly tiny subject. Returns a non-empty trimmed subject for non-empty
 * input; the caller owns the fallback when `subject` is empty.
 */
export function capSubjectWithin(prefix: string, subject: string, maxLength: number = maxCommitSubjectLength): string {
  const room = maxLength - prefix.length
  if (room <= 0 || subject.length <= room) return subject
  const cut = subject.slice(0, room)
  const boundary = cut.lastIndexOf(" ")
  return (boundary > room / 2 ? cut.slice(0, boundary) : cut).trim()
}
