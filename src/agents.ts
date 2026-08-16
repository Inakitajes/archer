import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

import type { AgentConfig, Config } from "@opencode-ai/sdk/v2"
import { advisorFeedbackToolName, advisorProviderOverride, advisorToolName, type ModelSelection } from "./advisor"
import { bashPolicy, noAdditions } from "./bash-policy"
import { builtInPrompts } from "./built-in-prompts"
import { resolveLoopGuard, softAgentSteps, type LoopGuardSettings } from "./loop-guard"
import { builtInAgents, readOnlyAgentSuffix, verifyAgentSuffix } from "./pipeline"
import type { AgentSpec, PermissionAdditions } from "./types"
import { globalAgentsDir } from "./workspace"

const runtimeSafetyPrompt = "runtime-safety"
const advisorTimingPrompt = "advisor-timing"

export type OpencodeConfigOptions = {
  /**
   * Agents that at least one step consults an advisor from. They get the
   * advisor tool plus the timing block in their prompt, and their `edit`
   * permission becomes "ask" so the gate can enforce the first-write checkpoint.
   *
   * Agent-level rather than step-level on purpose: OpenCode's agent registry is
   * built once per run, while the advisor is per step. Which advising model gets
   * consulted is resolved at call time from the session's phase, so the only
   * thing this set decides is whether the machinery is present at all.
   */
  advisorAgents?: ReadonlySet<string>
  /** Advising models used anywhere in the run; declared as output-capped aliases. */
  advisorModels?: readonly ModelSelection[]
  /** Output cap for those aliases. */
  advisorMaxTokens?: number
  /**
   * Circuit-breaker settings for this run. Drives the soft OpenCode `steps`
   * budget; the hard abort lives in the session watcher.
   */
  loopGuard?: LoopGuardSettings
}

export function opencodeConfig(
  runDir: string,
  targetDir = process.cwd(),
  agents: readonly AgentSpec[] = builtInAgents,
  permissions: PermissionAdditions = noAdditions,
  options: OpencodeConfigOptions = {},
): Config {
  const advisorAgents = options.advisorAgents ?? new Set<string>()
  const loopGuard = resolveLoopGuard(options.loopGuard)
  // Soft prompt only: current OpenCode still advertises tools after this. The
  // watcher is what actually stops a model that ignores it.
  const steps = loopGuard.enabled ? softAgentSteps(loopGuard.maxSteps) : undefined
  const agent: Record<string, AgentConfig> = {}
  for (const spec of agents) {
    // Synthesized variants (name suffixed "__ro" or "__verify") have no prompt
    // file of their own; they share the base agent's prompt under its real name.
    const promptName = baseAgentPromptName(spec.name)
    const advised = advisorAgents.has(spec.name)
    agent[spec.name] = agentConfig(
      spec.description,
      spec.temperature,
      spec.readOnly,
      Boolean(spec.readOnly && spec.verify),
      loadAgentPrompt(promptName, targetDir, { advisor: advised }),
      runDir,
      targetDir,
      false,
      permissions,
      advised,
      steps,
    )
  }

  return {
    agent,
    provider: mergeProviders(providerTimeouts(), advisorProviderOverride(options.advisorModels ?? [], options.advisorMaxTokens)),
    permission: {
      question: "deny",
      // OpenCode's detector only sees repeats inside one assistant message, so
      // this almost never fires for the real loop. Deny anyway: if it does
      // fire, stop. YOLO cannot override a deny.
      doom_loop: "deny",
    },
  }
}

/** Advisor aliases carry no options of their own; the timeout entries own the provider-level settings. */
function mergeProviders(timeouts: Config["provider"], advisors: Config["provider"]): Config["provider"] {
  const merged: NonNullable<Config["provider"]> = { ...timeouts }
  for (const [providerID, entry] of Object.entries(advisors ?? {})) {
    merged[providerID] = { ...merged[providerID], ...entry, models: { ...merged[providerID]?.models, ...entry.models } }
  }
  return merged
}

export type LoadAgentPromptOptions = {
  /** Prepend the advisor timing block, which the reference pattern places before anything else that mentions the advisor. */
  advisor?: boolean
}

export function loadAgentPrompt(agentName: string, targetDir = process.cwd(), options: LoadAgentPromptOptions = {}) {
  // Precedence mirrors config merge: project override > global override > built-in.
  const agentPrompt = readProjectAgentPrompt(agentName, targetDir) ?? readGlobalAgentPrompt(agentName) ?? readBuiltInPrompt(agentName)
  const safetyPrompt = readBuiltInPrompt(runtimeSafetyPrompt)
  // Timing first, then the agent's own instructions, then the non-replaceable
  // guard rails: the advisor block is about *when* to stop and ask, which has to
  // land before the phase instructions it interrupts.
  const advisorPrompt = options.advisor ? [readBuiltInPrompt(advisorTimingPrompt).trim(), "", "---", ""] : []
  return [...advisorPrompt, agentPrompt.trimEnd(), "", "---", "", safetyPrompt.trim()].join("\n")
}

export function projectAgentPromptPath(agentName: string, targetDir: string) {
  return join(targetDir, ".convoy", "agents", `${agentName}.md`)
}

function readProjectAgentPrompt(agentName: string, targetDir: string) {
  const path = projectAgentPromptPath(agentName, targetDir)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readGlobalAgentPrompt(agentName: string) {
  const path = join(globalAgentsDir(), `${agentName}.md`)
  if (!isFile(path)) return undefined
  return readFileSync(path, "utf8")
}

function readBuiltInPrompt(promptName: string) {
  const prompt = builtInPrompts[promptName]
  if (prompt !== undefined) return prompt
  if (builtInAgents.some((agent) => agent.name === promptName) || promptName === runtimeSafetyPrompt) {
    throw new Error(`missing built-in prompt: add prompts/${promptName}.md to src/built-in-prompts.ts`)
  }
  throw new Error(`agent "${promptName}" has no prompt; create .convoy/agents/${promptName}.md in the target repo`)
}

function isFile(path: string) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function baseAgentPromptName(name: string) {
  if (name.endsWith(readOnlyAgentSuffix)) return name.slice(0, -readOnlyAgentSuffix.length)
  if (name.endsWith(verifyAgentSuffix)) return name.slice(0, -verifyAgentSuffix.length)
  return name
}

const providerIdleTimeoutMs = 10 * 60 * 1000

function providerTimeouts(): Config["provider"] {
  const options = {
    timeout: false as const,
    chunkTimeout: providerIdleTimeoutMs,
  }

  return {
    anthropic: { options },
    openai: { options },
    openrouter: { options },
    vercel: { options },
    zai: { options },
  }
}

function agentConfig(
  description: string,
  temperature: number | undefined,
  readOnly: boolean | undefined,
  // Only meaningful alongside readOnly: bash comes back, write/edit stay gone.
  // The repository boundary in runner.ts is what still holds the step to its
  // promise, since bash can write through shell redirection (see bash-policy).
  verify: boolean,
  prompt: string,
  runDir: string,
  targetDir: string,
  webfetch: boolean,
  permissions: PermissionAdditions,
  advisor = false,
  steps?: number,
): AgentConfig {
  if (readOnly) {
    return {
      description,
      mode: "primary",
      ...(temperature === undefined ? {} : { temperature }),
      ...(steps === undefined ? {} : { steps }),
      tools: {
        read: true,
        list: true,
        glob: true,
        grep: true,
        write: false,
        edit: false,
        bash: verify,
        task: false,
        webfetch,
        websearch: false,
        [advisorToolName]: advisor,
        [advisorFeedbackToolName]: advisor,
      },
      permission: {
        read: "allow",
        list: "allow",
        glob: "allow",
        grep: "allow",
        edit: "deny",
        // A verifying step gets the same bash policy writable agents get:
        // allowlisted checks run silently, the hard denylist stays deny.
        bash: verify ? bashPolicy(targetDir, permissions) : "deny",
        task: "deny",
        question: "deny",
        webfetch: webfetch ? "allow" : "deny",
        websearch: "deny",
        doom_loop: "deny",
        external_directory: {
          "*": "deny",
          [join(runDir, "**")]: "allow",
        },
      },
      prompt,
    }
  }

  return {
    description,
    mode: "primary",
    ...(temperature === undefined ? {} : { temperature }),
    ...(steps === undefined ? {} : { steps }),
    tools: {
      read: true,
      write: true,
      edit: true,
      bash: true,
      webfetch,
      [advisorToolName]: advisor,
      [advisorFeedbackToolName]: advisor,
    },
    permission: {
      // Advised steps route edits through the gate so it can enforce the
      // first-write checkpoint: the first edit of a phase that hasn't consulted
      // yet is answered with the advice itself. Every other edit is allowed
      // immediately, so no new human prompt appears.
      edit: advisor ? "ask" : "allow",
      question: "deny",
      doom_loop: "deny",
      bash: bashPolicy(targetDir, permissions),
      external_directory: {
        "*": "deny",
        [join(runDir, "**")]: "allow",
      },
    },
    prompt,
  }
}
