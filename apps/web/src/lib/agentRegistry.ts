/**
 * Single source of truth for agent identity + capabilities.
 *
 * Before this module the labels lived in three places (agentRouting for names,
 * discord.ts / slack.ts for tokens) and the orchestrator could only guess what
 * an agent may do. Every claim here is derived from the real implementation:
 * - domains come from roleGate.agentDomains(), the gate that actually refuses
 *   tools at dispatch time (tools.ts roleGateRefusal),
 * - availability comes from the same env vars the channel adapters boot from,
 *   so an agent with no token is never treated as operational.
 *
 * Env var names are duplicated from the channel specs on purpose: importing
 * discord.ts/slack.ts here would create a cycle and pull the whole bot runtime
 * into the engine. verify.ts asserts the names still match.
 */

import { agentDomains } from "./roleGate";
import type { AgentLabel } from "./agentRouting";
import { isAgentLabel } from "./agentRole";

/** What a subtask can be about. Maps to an agent's real domains. */
export type TaskCategory = "coordinate" | "research" | "code" | "security" | "assistant";

export interface AgentProfile {
  label: AgentLabel;
  displayName: string;
  role: string;
  /** Tool domains this agent may actually run (empty = not gated = everything). */
  domains: readonly string[];
  /** Task categories this agent is registered for. */
  categories: readonly TaskCategory[];
  /** Output kinds this agent can deliver. */
  outputTypes: readonly string[];
  /** Env vars whose presence makes the agent operational on some channel. */
  tokenEnv: readonly string[];
  /** Operational limits. */
  maxConcurrent: number;
  /** Honest description of what this agent must not be used for. */
  restrictions: readonly string[];
}

export const AGENT_REGISTRY: Record<AgentLabel, AgentProfile> = {
  mia: {
    label: "mia",
    displayName: "Mia",
    role: "coordinator",
    domains: agentDomains("mia") ?? [],
    categories: ["coordinate", "research", "code", "security", "assistant"],
    outputTypes: ["final_report", "plan", "progress_update"],
    tokenEnv: [],
    maxConcurrent: 4,
    restrictions: [
      "Does not need a channel token: she runs in-process",
      "Delegation is per subtask — never hand her the whole request",
    ],
  },
  agnes: {
    label: "agnes",
    displayName: "Agnes",
    role: "researcher",
    domains: agentDomains("agnes") ?? [],
    categories: ["research"],
    outputTypes: ["research_notes", "source_list", "synthesis"],
    tokenEnv: ["DISCORD_BOT_TOKEN_AGNES", "SLACK_BOT_TOKEN_AGNES"],
    maxConcurrent: 2,
    restrictions: [
      "Only the research domain is hers: tools outside it are refused at dispatch",
      "Never assign implementation, code changes or security testing",
    ],
  },
  michelle: {
    label: "michelle",
    displayName: "Michelle",
    role: "coder",
    domains: agentDomains("michelle") ?? [],
    categories: ["code", "security"],
    outputTypes: ["code_change", "analysis", "test_result"],
    tokenEnv: ["DISCORD_BOT_TOKEN_MICHELLE", "SLACK_BOT_TOKEN_MICHELLE"],
    maxConcurrent: 2,
    restrictions: [
      "Code and authorised-security domains only",
      "Security work still needs the existing scope + approval workflow",
    ],
  },
};

export function agentProfile(label: unknown): AgentProfile | undefined {
  return isAgentLabel(label) ? AGENT_REGISTRY[label] : undefined;
}

/** Registered agents that can perform a category (registry order: mia first). */
export function agentsForCategory(category: TaskCategory): AgentProfile[] {
  return (Object.keys(AGENT_REGISTRY) as AgentLabel[])
    .map((l) => AGENT_REGISTRY[l])
    .filter((p) => p.categories.includes(category));
}

/**
 * Agents that are really runnable right now. Mia always is (in-process); the
 * specialists need a channel token, otherwise a plan could dispatch work to a
 * bot nobody can reach.
 */
export function availableAgents(): AgentProfile[] {
  return (Object.keys(AGENT_REGISTRY) as AgentLabel[])
    .map((l) => AGENT_REGISTRY[l])
    .filter((p) => p.tokenEnv.length === 0 || p.tokenEnv.some((e) => (process.env[e] ?? "").trim().length > 0));
}

/** True when the label is registered AND runnable — the only delegation source. */
export function isAvailableAgent(label: unknown): boolean {
  const p = agentProfile(label);
  return !!p && availableAgents().includes(p);
}

export function unavailableReason(label: unknown): string {
  const p = agentProfile(label);
  if (!p) return `agent "${String(label)}" tidak terdaftar`;
  if (p.tokenEnv.length === 0 || isAvailableAgent(label)) return "";
  return `${p.displayName} tidak punya token kanal aktif (butuh salah satu dari ${p.tokenEnv.join(", ")})`;
}