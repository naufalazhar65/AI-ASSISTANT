/**
 * Discord button approval — server-side state + message builders.
 *
 * Replaces the "balas ya/tidak" round-trip with native Discord buttons while
 * reusing the EXACT same execution path (`runAssistantTurn` + `confirm_calls`
 * in discord.ts). Text approval keeps working; whichever path decides first
 * wins and the other sees a decided request (no double execution, either way).
 *
 * Security shape (mirrors the repo's strict-gateway lessons):
 * - `customId` carries only an opaque request id (`mia-ap:<id>` /
 *   `mia-rj:<id>`), never tool args, targets, or secrets.
 * - The approved action is resolved from THIS store, never from client input.
 * - One approval = the listed calls, once. No blanket permission is granted;
 *   the next risky tool pauses again with a fresh request.
 * - State lives on `globalThis` (HMR re-evaluation must not fork the registry
 *   into two maps that disagree — same reason as pushTarget.ts). Restart
 *   drops pending requests by design: a click after restart finds nothing and
 *   is told to re-ask (fail-closed, never a phantom approval).
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, type APIEmbed } from "discord.js";
import { getTool, type ToolCall } from "../lib/tools";
import { redactArgsForDisplay } from "../lib/args";
import { clockLabel } from "../lib/time";
import type { ChatMessage } from "../lib/agent";

export type ApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXECUTING"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED";

export interface ApprovalRequest {
  id: string;
  /** Owning bot label (`mia`/`agnes`/`michelle`) — only this bot may execute. */
  agentLabel: string;
  agentDisplay: string;
  userKey: string;
  provider: string;
  model?: string;
  agent?: string;
  peerAgent?: string | null;
  messages: ChatMessage[];
  /** The exact calls this approval covers (array identity shared with the turn). */
  calls: ToolCall[];
  createdAt: number;
  expiresAt: number;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: number;
  messageId?: string;
  /** Original user message (what the reaction attaches to) + its channel. */
  channelId?: string;
  userMessageId?: string;
}

/** Approvals live 10 minutes; expiry is validated on every click (no timers). */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export type ApprovalStore = Map<string, ApprovalRequest>;

function globalStore(): ApprovalStore {
  const g = globalThis as unknown as { __discordApprovals?: ApprovalStore };
  if (!g.__discordApprovals) g.__discordApprovals = new Map();
  return g.__discordApprovals;
}

function newId(): string {
  return `ap_${Date.now().toString(36)}${Math.floor(Math.random() * 0xffffff).toString(36)}`;
}

export interface CreateApprovalInput {
  agentLabel: string;
  agentDisplay: string;
  userKey: string;
  provider: string;
  model?: string;
  agent?: string;
  peerAgent?: string | null;
  messages: ChatMessage[];
  calls: ToolCall[];
  channelId?: string;
  userMessageId?: string;
  store?: ApprovalStore;
  ttlMs?: number;
}

export function createApprovalRequest(input: CreateApprovalInput): ApprovalRequest {
  const now = Date.now();
  const req: ApprovalRequest = {
    id: newId(),
    agentLabel: input.agentLabel,
    agentDisplay: input.agentDisplay,
    userKey: input.userKey,
    provider: input.provider,
    model: input.model,
    agent: input.agent,
    peerAgent: input.peerAgent ?? null,
    messages: input.messages,
    calls: input.calls,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? APPROVAL_TTL_MS),
    status: "PENDING",
    channelId: input.channelId,
    userMessageId: input.userMessageId,
  };
  (input.store ?? globalStore()).set(req.id, req);
  return req;
}

/** Fetch + lazily expire. An expired request can never execute again. */
export function getApproval(id: string, store?: ApprovalStore): ApprovalRequest | undefined {
  const s = store ?? globalStore();
  const req = s.get(id);
  if (!req) return undefined;
  if (req.status === "PENDING" && Date.now() > req.expiresAt) {
    req.status = "EXPIRED";
  }
  return req;
}

/**
 * Atomic PENDING -> decision. Node runs one callback at a time, so the
 * check-and-set below cannot interleave: the first click wins, every later
 * click (double-click, second user, or a stale "ya" text) sees decided.
 */
export function decideApproval(
  id: string,
  by: string,
  allow: boolean,
  store?: ApprovalStore
): { ok: true; request: ApprovalRequest } | { ok: false; reason: "missing" | "decided" | "expired"; request?: ApprovalRequest } {
  const s = store ?? globalStore();
  const req = s.get(id);
  if (!req) return { ok: false, reason: "missing" };
  if (req.status === "PENDING" && Date.now() > req.expiresAt) req.status = "EXPIRED";
  if (req.status === "EXPIRED") return { ok: false, reason: "expired", request: req };
  if (req.status !== "PENDING") return { ok: false, reason: "decided", request: req };
  req.status = allow ? "APPROVED" : "REJECTED";
  req.decidedBy = by;
  req.decidedAt = Date.now();
  return { ok: true, request: req };
}

/** PENDING/APPROVED -> EXECUTING (approve path only), terminal states stick. */
export function markApproval(id: string, status: ApprovalStatus, store?: ApprovalStore): ApprovalRequest | undefined {
  const s = store ?? globalStore();
  const req = s.get(id);
  if (!req) return undefined;
  if (req.status === "PENDING" || req.status === "APPROVED" || req.status === "EXECUTING") {
    req.status = status;
  }
  return req;
}

/** Same allow-list rule as the slash-command path: empty = open, else member. */
export function isApprovalAuthorized(allowedUsers: string[], userId: string): boolean {
  return !allowedUsers.length || allowedUsers.includes(userId);
}

export function approvalCustomId(action: "ap" | "rj", id: string): string {
  return `mia-${action}:${id}`;
}

export function parseApprovalCustomId(customId: string): { action: "ap" | "rj"; id: string } | null {
  const m = /^mia-(ap|rj):([A-Za-z0-9_]+)$/.exec(customId || "");
  if (!m) return null;
  return { action: m[1] as "ap" | "rj", id: m[2] };
}

/** Target from by-design fields only — never mined from free text (targetDriftNote lesson). */
export function approvalTargetOf(call: ToolCall): string {
  try {
    const args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
    for (const f of ["target", "url", "endpoint", "base_url", "host"]) {
      const v = args[f];
      if (typeof v === "string" && v.trim()) return v.trim().slice(0, 120);
    }
  } catch { /* malformed args — no target shown */ }
  return "";
}

const RISK_LABEL: Record<string, string> = {
  read: "Rendah (baca saja)",
  write: "Sedang (mengubah)",
  delete: "Tinggi (menghapus)",
  transaction: "Tinggi (transaksi)",
  external: "Tinggi (keluar)",
};

export function approvalRiskOf(toolName: string): string {
  const risk = getTool(toolName)?.definition.risk;
  if (!risk) return "Tidak diketahui";
  return RISK_LABEL[risk] ?? risk;
}

function approvalActionLines(calls: ToolCall[]): string {
  return calls
    .map((c, i) => {
      const prefix = calls.length > 1 ? `${i + 1}. ` : "";
      const target = approvalTargetOf(c);
      // The target line already shows url/target/endpoint args — reprinting
      // the same JSON next to it is noise (live 2026-10-15: full args blob
      // duplicating the target line). Only show args carrying MORE than that.
      let args = "";
      try {
        const parsed = JSON.parse(c.arguments || "{}") as Record<string, unknown>;
        const extra = Object.entries(parsed).filter(([k]) => !["target", "url", "endpoint", "base_url", "host"].includes(k));
        if (extra.length) args = redactArgsForDisplay(JSON.stringify(Object.fromEntries(extra)));
      } catch {
        try {
          args = redactArgsForDisplay(c.arguments || "{}");
        } catch { /* keep empty */ }
      }
      const argBit = args && args !== "{}" ? ` — \`${args.slice(0, 160)}\`` : "";
      return `${prefix}\`${c.name}\`${target ? ` → ${target}` : ""}${argBit}`;
    })
    .join("\n");
}

/** Expiry clock (WIB, same clock the owner reads everywhere else). */

/** The approval prompt: embed + action row. Callers send both together. */
export function approvalMessage(req: ApprovalRequest): {
  embeds: APIEmbed[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const embed = new EmbedBuilder()
    .setTitle("🔐 Persetujuan Diperlukan")
    .setDescription(
      `${req.agentDisplay} meminta persetujuan untuk menjalankan aksi berikut.\n\n` +
        `**Agent:** ${req.agentDisplay}\n${approvalActionLines(req.calls)}\n\n` +
        `**Risiko:** ${req.calls.map((c) => approvalRiskOf(c.name)).join(", ")}\n` +
        `**ID:** \`${req.id}\` · berlaku sampai ${clockLabel(req.expiresAt)} WIB\n\n` +
        `**Status:** Menunggu persetujuan.`
    )
    .setColor(0xf59e0b);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(approvalCustomId("ap", req.id))
      .setLabel("Setujui & Jalankan")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
    new ButtonBuilder()
      .setCustomId(approvalCustomId("rj", req.id))
      .setLabel("Tolak")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌")
  );
  return { embeds: [embed.toJSON()], components: [row] };
}

/** Rebuild the button row in a disabled state (works from customIds alone). */
export function disabledApprovalRow(ids: { approve: string; reject: string }): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(ids.approve)
      .setLabel("Setujui & Jalankan")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅")
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(ids.reject)
      .setLabel("Tolak")
      .setStyle(ButtonStyle.Danger)
      .setEmoji("❌")
      .setDisabled(true)
  );
}

function decidedDescription(req: ApprovalRequest): string {
  return (
    `**Agent:** ${req.agentDisplay}\n${approvalActionLines(req.calls)}\n\n` +
    `**ID:** \`${req.id}\`${req.decidedBy ? ` · oleh <@${req.decidedBy}>` : ""}`
  );
}

/** Status edit applied to the original message after a decision/expiry. */
export function approvalStatusEmbed(
  req: ApprovalRequest,
  kind: "approved" | "rejected" | "expired" | "completed" | "failed"
): EmbedBuilder {
  const base = decidedDescription(req);
  switch (kind) {
    case "approved":
      return new EmbedBuilder().setTitle("✅ Approval Diberikan — menjalankan…").setDescription(base).setColor(0x22c55e);
    case "rejected":
      return new EmbedBuilder()
        .setTitle("❌ Permintaan Ditolak")
        .setDescription(`${base}\n\nAksi di atas TIDAK dijalankan.`)
        .setColor(0xef4444);
    case "expired":
      return new EmbedBuilder()
        .setTitle("⌛ Persetujuan Kedaluwarsa")
        .setDescription(`${base}\n\nMinta lagi bila masih perlu — approval lama tidak bisa dipakai ulang.`)
        .setColor(0x6b7280);
    case "completed":
      return new EmbedBuilder().setTitle("✅ Selesai").setDescription(base).setColor(0x22c55e);
    case "failed":
      return new EmbedBuilder().setTitle("⚠️ Gagal Saat Eksekusi").setDescription(base).setColor(0xef4444);
  }
}
