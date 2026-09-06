import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { execFile } from "./git"

/**
 * The deliberate `Create pull request` publication action (capability
 * run-finalization, design D5): the only publication surface left after the
 * manual finish was retired. On explicit selection it revalidates the current
 * branch state, performs one normal push to a disclosed destination with an
 * explicit refspec, then locates an existing open PR or creates one — never
 * force-pushing, deleting branches, or removing worktrees. A published
 * uncompacted branch is legitimate, so nothing here inspects compaction
 * success beyond refusing to publish while a transaction needs recovery.
 *
 * Unavailable states are disclosed with remediation, never guessed around:
 * a dirty/detached/base worktree, no remotes, ambiguous remotes without an
 * upstream, a missing `gh` binary, or missing authentication all stop before
 * the push. Push and PR creation are separate outcomes: a failed `gh pr
 * create` after a successful push is retryable without a duplicate PR, because
 * the retry locates the existing one first.
 */

export type RunResult = { stdout: string; stderr: string; exitCode: number }
export type PublishRunner = (command: string, args: string[], options?: { allowFailure?: boolean }) => Promise<RunResult>

/** The well-known trunk names a feature branch is never published from. */
const baseBranchNames = new Set(["main", "master", "develop", "trunk"])

export type CreatePublishSeamInput = {
  cwd: string
  /** The run workspace, when known; its summary seeds the PR body, its metadata gates publication during recovery. */
  runDir?: string
  /** Injectable subprocess runner for hermetic tests. */
  run?: PublishRunner
}

export function createPublishSeam(input: CreatePublishSeamInput) {
  const cwd = input.cwd
  const run: PublishRunner =
    input.run ??
    (async (command, args, options) => {
      try {
        return await execFile(command, args, { cwd, allowFailure: options?.allowFailure ?? false })
      } catch (error) {
        // execFile throws on failure without allowFailure; surface it through the
        // same shape a failure return would take.
        return { stdout: "", stderr: error instanceof Error ? error.message : String(error), exitCode: 1 }
      }
    })

  return {
    /**
     * Resolves and discloses repository, branch, destination remote, and PR
     * base, or explains exactly what is missing (D5: no guessed pushes).
     */
    async prepare(): Promise<{ ok: true; plan: { branch: string; remote: string; base: string } } | { ok: false; message: string }> {
      const branch = (await run("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFailure: true })).stdout.trim()
      if (!branch) {
        return { ok: false, message: "HEAD is detached; check out the run's branch before publishing" }
      }
      if (baseBranchNames.has(branch)) {
        return { ok: false, message: `"${branch}" is a base branch; publication is only offered for feature branches` }
      }
      if ((await run("git", ["status", "--porcelain"])).stdout.trim() !== "") {
        return { ok: false, message: "the working tree has uncommitted changes; commit or stash them before publishing" }
      }

      const remotes = (await run("git", ["remote"], { allowFailure: true })).stdout.split("\n").map((name) => name.trim()).filter(Boolean)
      if (remotes.length === 0) {
        return { ok: false, message: "the repository has no configured remote; add one (git remote add origin <url>) before publishing" }
      }

      // Destination: the branch's own upstream remote when it has one; otherwise
      // the unique repository remote; several remotes without an upstream stop
      // for an explicit choice instead of a guessed push.
      const upstream = (await run("git", ["rev-parse", "--quiet", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`], { allowFailure: true })).stdout.trim()
      let remote: string | undefined
      if (upstream && upstream !== `${branch}@{upstream}` && upstream.includes("/")) {
        remote = upstream.split("/")[0]
      } else if (remotes.length === 1) {
        remote = remotes[0]
      } else {
        return {
          ok: false,
          message: `several remotes are configured (${remotes.join(", ")}) and the branch has no upstream; set one (git push -u <remote> ${branch}) before publishing`,
        }
      }

      // The PR base is the destination's default branch.
      const remoteHead = (await run("git", ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], { allowFailure: true })).stdout.trim()
      const base = remoteHead.startsWith(`${remote}/`) ? remoteHead.slice(remote.length + 1) : "main"

      const gh = await ghGuidance(run)
      if (!gh.ok) return gh

      const recovery = await recoveryGate(input.runDir)
      if (!recovery.ok) return recovery

      // Feature-backed publication revalidates the reviewed feature link
      // immediately before the push (capability run-finalization, task 5.2):
      // the run's durable feature link must still verify — the same feature,
      // association revision, and branch. A historical run whose path was
      // reused by another feature never publishes the replacement branch.
      const featureGate = await featureLinkGate(input.runDir, cwd)
      if (!featureGate.ok) return featureGate

      return { ok: true, plan: { branch, remote, base } }
    },

    /**
     * One normal push, then PR location/creation. A non-fast-forward rejection
     * stops with the remote's message — never a force. A PR failure after a
     * landed push says exactly that, and the retry reuses the push because the
     * existing-PR check runs before creation.
     */
    async apply(plan: { branch: string; remote: string; base: string }): Promise<{ ok: true; outcome: { pushed: boolean; url?: string } } | { ok: false; message: string }> {
      const push = await run("git", ["push", plan.remote, `${plan.branch}:${plan.branch}`], { allowFailure: true })
      if (push.exitCode !== 0) {
        const detail = (push.stderr || push.stdout).trim()
        return { ok: false, message: `push to ${plan.remote}/${plan.branch} was rejected; nothing was published${detail ? `: ${detail}` : ""}` }
      }

      const existing = await run("gh", ["pr", "list", "--head", plan.branch, "--state", "open", "--json", "url", "--limit", "1"], { allowFailure: true })
      if (existing.exitCode === 0) {
        const url = parsePrListUrl(existing.stdout)
        if (url) return { ok: true, outcome: { pushed: true, url } }
      }

      const body = await prBody(input.runDir, plan)
      const created = await run(
        "gh",
        ["pr", "create", "--head", plan.branch, "--base", plan.base, "--title", body.title, "--body", body.text],
        { allowFailure: true },
      )
      if (created.exitCode !== 0) {
        const detail = (created.stderr || created.stdout).trim()
        return {
          ok: false,
          message: `the branch was pushed to ${plan.remote}/${plan.branch}, but creating the pull request failed${detail ? `: ${detail}` : ""}; retry to locate or create it without pushing again unnecessarily`,
        }
      }
      const url = parsePrUrl(created.stdout) ?? parsePrUrl(created.stderr)
      return { ok: true, outcome: { pushed: true, ...(url ? { url } : {}) } }
    },
  }
}

function parsePrUrl(stdout: string): string | undefined {
  return /https:\/\/\S+\/pull\/\S+/.exec(stdout)?.[0]?.replace(/[)\].,='"`]+$/, "")
}

/** The `gh pr list` JSON payload's first URL, or a URL quoted plainly in its output. */
function parsePrListUrl(stdout: string): string | undefined {
  try {
    const rows = JSON.parse(stdout) as Array<{ url?: string }>
    const url = rows.find((row) => typeof row.url === "string" && row.url)?.url
    if (url) return url
  } catch {
    // fall through to the plain-text scan
  }
  return parsePrUrl(stdout)
}

/** A run whose compaction transaction needs recovery must not publish (design D4). */
async function recoveryGate(runDir: string | undefined): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!runDir || runDir === "/") return { ok: true }
  let metadata: { finalization?: { recoveryRequired?: boolean; reason?: string } }
  try {
    metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8"))
  } catch {
    return { ok: true }
  }
  if (metadata.finalization?.recoveryRequired === true) {
    return {
      ok: false,
      message: `this run's compaction transaction needs recovery before publication${metadata.finalization.reason ? `: ${metadata.finalization.reason}` : ""}`,
    }
  }
  return { ok: true }
}

/**
 * The feature-link gate (task 5.2): a feature-backed run's durable link is
 * revalidated against the live repository right before publication. The
 * resolution is lazy so no-spec runs never touch the lifecycle module.
 */
async function featureLinkGate(runDir: string | undefined, cwd: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!runDir || runDir === "/") return { ok: true }
  let metadata: { feature?: { featureId: string; associationRevision: number; branch: string; baseRef: string; contracts: readonly string[]; repositoryId: string; worktreeDir?: string } }
  try {
    metadata = JSON.parse(await readFile(join(runDir, "metadata.json"), "utf8"))
  } catch {
    return { ok: true }
  }
  const link = metadata.feature
  if (!link) return { ok: true }
  const { revalidateFeatureLink } = await import("./feature-lifecycle/launch")
  try {
    await revalidateFeatureLink({ cwd, link })
    return { ok: true }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `publication refuses: the run's reviewed feature context no longer verifies — ${detail}. Publication never pushes the branch now occupying the historical path.`,
    }
  }
}

/** `gh` availability and authentication, each with concrete remediation (D5). */
async function ghGuidance(run: PublishRunner): Promise<{ ok: true } | { ok: false; message: string }> {
  const version = await run("gh", ["--version"], { allowFailure: true })
  if (version.exitCode !== 0) {
    return {
      ok: false,
      message: "the GitHub CLI (gh) is not installed; install it from https://cli.github.com, or publish manually with: git push <remote> <branch> && gh pr create",
    }
  }
  const auth = await run("gh", ["auth", "status"], { allowFailure: true })
  if (auth.exitCode !== 0) {
    return { ok: false, message: "the GitHub CLI is not authenticated; run `gh auth login` before publishing" }
  }
  return { ok: true }
}

/** The PR title/body: the run's own summary when it is still applicable, else the branch. */
async function prBody(runDir: string | undefined, plan: { branch: string; base: string }): Promise<{ title: string; text: string }> {
  const title = await firstHeading(runDir, "prd.md")
  const slug = plan.branch.replace(/^.*?\//, "").replace(/[-_]+/g, " ").trim()
  const summary = await readOptional(runDir, "SUMMARY.md")
  const bodyLines = summary ? summary.trim().split("\n").slice(0, 40).join("\n") : ""
  const text = [
    ...(title ? [`Run: ${title}`] : []),
    ...(bodyLines ? ["", bodyLines] : []),
  ].join("\n")
  return { title: title ?? `feat: ${slug || plan.branch}`, text }
}

async function firstHeading(runDir: string | undefined, file: string): Promise<string | undefined> {
  const content = await readOptional(runDir, file)
  if (!content) return undefined
  const line = content.split("\n").map((raw) => raw.replace(/^#+\s*/, "").trim()).find(Boolean)
  return line || undefined
}

async function readOptional(runDir: string | undefined, file: string): Promise<string | undefined> {
  if (!runDir || runDir === "/") return undefined
  try {
    return await readFile(join(runDir, file), "utf8")
  } catch {
    return undefined
  }
}
