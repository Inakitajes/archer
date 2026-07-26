import { mkdir, stat } from "node:fs/promises"
import { join } from "node:path"

import type { AgentConfig, Config, OpencodeClient } from "@opencode-ai/sdk/v2"

import { addWorktree, branchExists } from "./git"
import { log } from "./log"
import { startOpencode } from "./opencode"
import { splitModelVariant } from "./pipeline"
import { parseModel } from "./runner"
import { convoyHome } from "./workspace"

export type WorktreeResult = {
  /** Absolute path of the newly created worktree. */
  dir: string
  /** Name of the branch the worktree was created on. */
  branch: string
}

export type WorktreeInput = {
  targetDir: string
  /** The confirmed branch name; naming happens before the run is confirmed, never here. */
  branch: string
  /** Commit/ref to base the new branch on; defaults to HEAD. */
  baseRef?: string
}

export type BranchNameInput = {
  prompt: string
  targetDir: string
  /** Override the model used to name the branch (provider/model[#variant]). */
  model?: string
  /** Free-text steer from the user, e.g. "call it after the budget limits". Outranks the prompt. */
  guidance?: string
  signal?: AbortSignal
}

/** Where a proposed name came from, so the launcher can say who suggested it. */
export type BranchNameSource = "model" | "prompt" | "fallback"

export type BranchNameProposal = {
  branch: string
  source: BranchNameSource
  /** Set when the model call failed; shown in the launcher so the user knows why it's a guess. */
  error?: string
}

/** Cheap, fast model used to synthesize a branch name from the prompt. */
export const defaultBranchNameModel = "anthropic/claude-haiku-4-5"

/** Registered so the namer replaces opencode's default coding agent instead of merely appending to it. */
const namerAgentName = "convoy-branch-namer"

// Generous enough for the namer to look up a referenced issue before answering;
// the deterministic fallback still guards the whole thing.
const branchNameTimeoutMs = 60_000
const maxBranchNameLength = 48

/** Conventional-commit types; the branch prefix is always one of these. */
const branchTypes = ["feat", "fix", "refactor", "perf", "docs", "test", "chore", "build", "ci"] as const
type BranchType = (typeof branchTypes)[number]
const defaultBranchType: BranchType = "feat"

/**
 * The namer is a registered read-only agent, not a bare `system` string on the
 * default agent: an extra system message leaves opencode's conversational
 * coding persona in charge, which is how a reply ending in "¿Cuál es tu
 * siguiente paso?" once became a branch name. MCP tools from the user's
 * opencode setup are left untouched so issue trackers (Linear, GitHub) stay
 * reachable.
 */
function namerOpencodeConfig(): Config {
  const agent: AgentConfig = {
    description: "Names git branches for convoy worktrees",
    mode: "primary",
    temperature: 0,
    prompt: branchNameSystemPrompt,
    tools: {
      read: true,
      list: true,
      glob: true,
      grep: true,
      webfetch: true,
      write: false,
      edit: false,
      bash: false,
      task: false,
      todoread: false,
      todowrite: false,
      websearch: false,
    },
    permission: {
      read: "allow",
      list: "allow",
      glob: "allow",
      grep: "allow",
      webfetch: "allow",
      edit: "deny",
      bash: "deny",
      task: "deny",
      question: "deny",
      websearch: "deny",
    },
  }
  return {
    agent: { [namerAgentName]: agent },
    permission: { question: "deny" },
  }
}

/**
 * Creates a new git branch checked out in a dedicated worktree under
 * `~/.convoy/worktrees/<slug>`, so Convoy runs against an isolated checkout
 * instead of the user's current working tree. The branch name is decided (and
 * confirmed by the user) before this is called.
 */
export async function createIsolatedWorktree(input: WorktreeInput): Promise<WorktreeResult> {
  const base = input.baseRef ?? "HEAD"
  // Re-check right before creating: the name was validated in the launcher, and
  // anything could have claimed it since (a parallel convoy, a manual branch).
  const branch = await ensureFreeBranchName(input.branch, input.targetDir)
  const dir = worktreeDirFor(branch)
  await mkdir(join(convoyHome(), "worktrees"), { recursive: true })
  await addWorktree(dir, branch, base, input.targetDir)
  log.info(`created worktree at ${dir} on branch ${branch}`)
  return { dir, branch }
}

/** Where the worktree for `branch` lives; the directory slug flattens the `type/` prefix. */
export function worktreeDirFor(branch: string): string {
  return join(convoyHome(), "worktrees", slugifyBranch(branch))
}

/**
 * Asks a cheap, read-only model for a short kebab-case branch name derived
 * from the prompt — it may look up referenced issues/tickets first. Any
 * failure (no auth, timeout, unparseable reply) degrades to a name derived
 * from the prompt itself, so the proposal always says something about the work.
 */
export async function proposeBranchName(input: BranchNameInput): Promise<BranchNameProposal> {
  const trimmed = input.prompt.trim()
  if (!trimmed && !input.guidance?.trim()) return { branch: fallbackBranchName(), source: "fallback" }

  let error: string | undefined
  try {
    const handle = await startOpencode(namerOpencodeConfig(), AbortSignal.timeout(branchNameTimeoutMs))
    try {
      const reply = await askForBranchName(handle.client, {
        ...input,
        prompt: trimmed,
        model: input.model ?? defaultBranchNameModel,
      })
      const branch = readBranchName(reply)
      if (branch) return { branch, source: "model" }
      // Quote the reply like the safety judge does: an unusable answer is the
      // one failure mode that can't be diagnosed from the message alone.
      error = `the namer's reply had no usable branch name: ${truncate(reply, 160)}`
    } finally {
      handle.close()
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  }

  log.warn(`worktree: couldn't generate an AI branch name (${error}); deriving one from the prompt`)
  const heuristic = heuristicBranchName(input.guidance?.trim() || trimmed)
  if (heuristic) return { branch: heuristic, source: "prompt", error }
  return { branch: fallbackBranchName(), source: "fallback", error }
}

export async function askForBranchName(client: OpencodeClient, input: BranchNameInput & { model: string }): Promise<string> {
  const parsedModel = splitModelVariant(input.model)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new Error("branch namer timed out")), branchNameTimeoutMs)
  const onParentAbort = () => controller.abort(input.signal?.reason)
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason)
    else input.signal.addEventListener("abort", onParentAbort, { once: true })
  }

  let sessionID: string | undefined
  try {
    const session = await client.session.create(
      { directory: input.targetDir, title: "convoy branch namer" },
      { signal: controller.signal },
    )
    if (session.error || !session.data?.id) throw new Error("couldn't open a naming session")
    sessionID = session.data.id

    const response = await client.session.prompt(
      {
        sessionID,
        directory: input.targetDir,
        model: parseModel(parsedModel.model),
        ...(parsedModel.variant ? { variant: parsedModel.variant } : {}),
        agent: namerAgentName,
        // Sent as well as the agent prompt: if the agent name ever fails to
        // resolve, the reply must still follow the contract rather than be a
        // free-form answer from opencode's default persona.
        system: branchNameSystemPrompt,
        tools: { read: true, list: true, glob: true, grep: true, webfetch: true, write: false, edit: false, bash: false, todoread: false, todowrite: false },
        parts: [{ type: "text", text: namerMessage(input.prompt, input.guidance) }],
      },
      { signal: controller.signal },
    )
    if (response.error || !response.data) throw new Error("branch namer returned no answer")
    return collectText(response.data.parts)
  } finally {
    clearTimeout(timeout)
    input.signal?.removeEventListener("abort", onParentAbort)
    if (sessionID) {
      try {
        await client.session.delete({ sessionID, directory: input.targetDir })
      } catch {
        // best-effort
      }
    }
  }
}

/** The user's own steer outranks the prompt — it's the whole point of the guidance box. */
export function namerMessage(prompt: string, guidance?: string): string {
  const parts: string[] = []
  const steer = guidance?.trim()
  if (steer) parts.push(`How the user wants it named (this outranks everything below):\n${steer}`)
  if (prompt.trim()) parts.push(`Prompt:\n${excerpt(prompt.trim())}`)
  return parts.join("\n\n")
}

const branchNameSystemPrompt = [
  "You name git branches. Read the user's prompt and reply with ONE branch name for the work it",
  "describes. Reply with nothing but a single line of JSON:",
  '{"type": "feat", "name": "add-onboarding-flow"}',
  "",
  `"type" is one of: ${branchTypes.join(", ")}.`,
  '"name" is lowercase kebab-case, 2-5 words, ASCII letters/digits/hyphens only, no slashes.',
  "",
  "Rules:",
  "- When the message opens with a \"How the user wants it named\" block, that instruction wins over",
  "  everything else, including the prompt. Build the name around what it asks for.",
  "- Always name it in ENGLISH, even when the prompt is written in another language.",
  "- Name what the work DOES. Never transcribe a sentence, heading, or question from the prompt.",
  "- Never ask the user anything. There is no follow-up turn; a question is a failed answer.",
  "- Never refuse and never explain what you couldn't find. If something the user mentions can't be",
  "  verified from the repo or the tools, name the branch from what they told you anyway — the user",
  "  knows what they meant, and a name you can improve beats no name at all.",
  "- If the prompt references an issue, ticket, or PR (#123, ABC-123, a URL) instead of describing",
  "  the work, look it up first with the tools available to you (issue-tracker tools, webfetch,",
  "  repo files) and name the branch after what the issue is actually about. If the reference",
  "  can't be resolved, use the issue ID itself as the name (e.g. dev-1339).",
  "- You may investigate before answering, but the LAST line of your reply must be the JSON object",
  "  and nothing else.",
].join("\n")

/**
 * Pulls the branch name out of the namer's reply. The JSON object is the
 * contract; the loose fallbacks below exist because a model that investigated
 * first sometimes narrates, and a narration line is only accepted when it
 * actually looks like a branch name rather than prose.
 */
export function readBranchName(raw: string): string {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index--) {
    const parsed = parseNameObject(lines[index]!)
    if (parsed) return parsed
  }
  // A fenced or pretty-printed object spans several lines; try the whole reply.
  const whole = parseNameObject(raw)
  if (whole) return whole

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!.replace(/^[`'"]+|[`'"]+$/g, "")
    if (/^[a-z0-9][a-z0-9/_-]*$/i.test(line)) {
      const cleaned = cleanBranchName(line)
      if (cleaned) return cleaned
    }
  }
  return cleanBranchName(lines[lines.length - 1] ?? "")
}

function parseNameObject(text: string): string {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return ""
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return ""
  }
  if (!parsed || typeof parsed !== "object") return ""
  const name = (parsed as { name?: unknown }).name
  if (typeof name !== "string") return ""
  const type = (parsed as { type?: unknown }).type
  const prefix = typeof type === "string" && isBranchType(normalizeBranchType(type)) ? normalizeBranchType(type) : defaultBranchType
  // A namer that ignored "no slashes" and answered "feat/add-x" must not end up
  // as "feat/feat-add-x": the `type` field wins over an embedded prefix.
  const bare = splitBranchType(name.trim()).rest
  return cleanBranchName(`${prefix}/${bare}`)
}

/**
 * Coerces a candidate into a git-safe branch name, or returns "" when there is
 * nothing usable in it.
 *
 * `authored` marks a name a human typed: it keeps whatever prefix (or none)
 * they chose and is never second-guessed. Model output gets the opposite
 * treatment — a conventional `type/` prefix is enforced, and anything that
 * reads like prose is rejected so a conversational reply falls through to the
 * next fallback instead of turning a sentence into a branch.
 */
export function cleanBranchName(raw: string, options: { authored?: boolean } = {}): string {
  const candidate = raw.trim().replace(/^[`'"]+|[`'"]+$/g, "")
  if (!candidate) return ""
  if (!options.authored && looksLikeProse(candidate)) return ""

  const { type, rest } = splitBranchType(candidate)
  const body = kebab(rest)
  if (!body) return ""

  const prefix = type ?? (options.authored ? undefined : defaultBranchType)
  const name = prefix ? `${prefix}/${body}` : body
  const capped = capBranchName(name)
  if (!capped) return ""
  // A leading digit in the name confuses some tooling; the type prefix already
  // covers the prefixed form, so only bare names need the guard.
  return /^[0-9]/.test(capped) ? `task-${capped}` : capped
}

/** Splits an optional leading conventional-commit type off the candidate. */
function splitBranchType(candidate: string): { type?: BranchType; rest: string } {
  const match = /^([a-z]+)\s*[/:]\s*(.+)$/is.exec(candidate)
  if (!match) return { rest: candidate }
  const type = normalizeBranchType(match[1]!)
  if (!isBranchType(type)) return { rest: candidate }
  return { type, rest: match[2]! }
}

/** Common spellings people (and models) actually write, mapped onto the canonical types. */
const branchTypeAliases: Record<string, BranchType> = {
  feature: "feat",
  features: "feat",
  bug: "fix",
  bugfix: "fix",
  hotfix: "fix",
  ref: "refactor",
  doc: "docs",
  tests: "test",
  chores: "chore",
}

function normalizeBranchType(value: string): string {
  const lowered = value.trim().toLowerCase()
  return branchTypeAliases[lowered] ?? lowered
}

function isBranchType(value: string): value is BranchType {
  return (branchTypes as readonly string[]).includes(value)
}

/**
 * Prose is anything that reads like a sentence rather than a name: questions
 * are the giveaway (the namer must never ask), and so is a long word count.
 */
function looksLikeProse(candidate: string): boolean {
  if (/[?¿]/.test(candidate)) return true
  return candidate.split(/\s+/).filter(Boolean).length > 8
}

/** Accents survive as letters instead of collapsing into hyphens: "español" → "espanol". */
function kebab(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

/** Caps the length on a hyphen boundary so names never end mid-word. */
function capBranchName(name: string): string {
  if (name.length <= maxBranchNameLength) return name
  const slash = name.indexOf("/")
  const prefix = slash === -1 ? "" : name.slice(0, slash + 1)
  const body = slash === -1 ? name : name.slice(slash + 1)
  const room = maxBranchNameLength - prefix.length
  if (room <= 0) return prefix.slice(0, maxBranchNameLength).replace(/[-/]+$/, "")
  const clipped = body.slice(0, room)
  const lastHyphen = clipped.lastIndexOf("-")
  // Keep the partial word only when there is no earlier boundary to cut on.
  const trimmed = lastHyphen > 0 ? clipped.slice(0, lastHyphen) : clipped
  return `${prefix}${trimmed}`.replace(/[-/]+$/, "")
}

const stopWords = new Set([
  "the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "with", "we", "i", "it", "is", "are", "be",
  "that", "this", "should", "would", "must", "new", "add", "make",
  "el", "la", "los", "las", "un", "una", "unos", "unas", "de", "del", "que", "y", "o", "para", "por", "con",
  "en", "al", "se", "su", "sus", "lo", "es", "son", "ser", "como", "mas", "pero", "nos", "me", "te",
])

/**
 * Last resort before a timestamp: names the branch after the prompt's own
 * opening — its first heading or first line — so a failed model call still
 * produces something recognizable instead of `convoy-20260726-a4f2`.
 */
export function heuristicBranchName(prompt: string): string {
  const lines = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const heading = lines.find((line) => line.startsWith("#"))
  const source = (heading ?? lines[0] ?? "").replace(/^#+\s*/, "")
  const words = kebab(source)
    .split("-")
    .filter((word) => word && !stopWords.has(word))
    .slice(0, 4)
  if (words.length === 0) return ""
  return cleanBranchName(words.join("-"))
}

/** Deterministic fallback so worktree creation never depends on a model being available. */
export function fallbackBranchName(): string {
  const stamp = new Date()
  const pad = (value: number) => String(value).padStart(2, "0")
  return `convoy-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${randomSlug(4)}`
}

/**
 * Appends `-2`, `-3`… until neither the branch nor its worktree directory is
 * taken, so re-running a similar prompt doesn't fail `git worktree add` after
 * the run has already been confirmed.
 */
export async function ensureFreeBranchName(branch: string, targetDir: string, limit = 50): Promise<string> {
  for (let suffix = 1; suffix <= limit; suffix++) {
    const candidate = suffix === 1 ? branch : `${branch}-${suffix}`
    if (!(await branchNameTaken(candidate, targetDir))) return candidate
  }
  return `${branch}-${randomSlug(4)}`
}

/** True when the branch exists or its worktree directory is already on disk. */
export async function branchNameTaken(branch: string, targetDir: string): Promise<boolean> {
  if (await branchExists(branch, targetDir)) return true
  // `git worktree add` refuses a path that already exists, so an orphaned
  // directory from an earlier run counts as taken even without a branch.
  try {
    await stat(worktreeDirFor(branch))
    return true
  } catch {
    return false
  }
}

/** Filesystem-safe directory name for the worktree (flattens the `type/` prefix). */
export function slugifyBranch(branch: string): string {
  return kebab(branch) || `convoy-${randomSlug(6)}`
}

function collectText(parts: ReadonlyArray<{ type: string; text?: string }>): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

const excerptHead = 900
const excerptTail = 500

/**
 * Long PRDs bury the actual ask in their closing recommendation, so the namer
 * gets both ends of the document rather than only its opening context.
 */
export function excerpt(value: string): string {
  if (value.length <= excerptHead + excerptTail) return value
  return `${value.slice(0, excerptHead)}\n…\n${value.slice(-excerptTail)}`
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}

function randomSlug(size: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789"
  let out = ""
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  for (const byte of bytes) out += chars[byte % chars.length]
  return out
}
