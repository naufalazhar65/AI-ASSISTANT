// SafeExec — safe command execution for OpenClaw/Mia agents
// Risk levels CRITICAL/HIGH/MEDIUM/LOW, pending store, audit log, agent auto-bypass
// No network, no monitoring, local only. Env: SAFE_EXEC_DISABLE, OPENCLAW_AGENT_CALL, SAFE_EXEC_AUTO_CONFIRM

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type Risk = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

const SAFE_DIR = join(homedir(), ".openclaw", "safe-exec");
const PENDING_DIR = join(SAFE_DIR, "pending");
const AUDIT_LOG = join(homedir(), ".openclaw", "safe-exec-audit.log");
const RULES_FILE = join(SAFE_DIR, "..", "safe-exec-rules.json");

function ensureDirs(): void {
  mkdirSync(PENDING_DIR, { recursive: true });
}

export function isDisabled(): boolean { return process.env.SAFE_EXEC_DISABLE === "1"; }
export function isAgentCall(): boolean { return !!process.env.OPENCLAW_AGENT_CALL; }
export function isAutoConfirm(): boolean { return process.env.SAFE_EXEC_AUTO_CONFIRM === "1"; }

type Rule = { pattern: string; risk: Risk; reason: string };
// Built-in danger patterns (subset of OTTTTTO/safe-exec)
const BUILTIN: Rule[] = [
  { pattern: "rm\\s+.*-rf\\s+/", risk: "CRITICAL", reason: "Recursive deletion of root" },
  { pattern: "rm\\s+.*-rf\\s+\\*", risk: "CRITICAL", reason: "Recursive deletion with wildcard" },
  { pattern: ":\\(\\)\\{.*\\}:", risk: "CRITICAL", reason: "Fork bomb" },
  { pattern: "\\bdd\\b.*if=", risk: "CRITICAL", reason: "Raw disk write (dd)" },
  { pattern: "\\bmkfs", risk: "CRITICAL", reason: "Filesystem format" },
  { pattern: "chmod\\s+777", risk: "HIGH", reason: "Overly permissive chmod 777" },
  { pattern: "curl\\s+.*\\|\\s*(bash|sh)", risk: "HIGH", reason: "curl piped to shell" },
  { pattern: "wget\\s+.*\\|\\s*(bash|sh)", risk: "HIGH", reason: "wget piped to shell" },
  { pattern: "rm\\s+.*-rf", risk: "HIGH", reason: "Recursive force deletion" },
  { pattern: "rm\\s+.*-r", risk: "HIGH", reason: "Recursive deletion" },
  { pattern: "\\bsudo\\b", risk: "MEDIUM", reason: "Privileged sudo" },
  { pattern: "systemctl|service\\s+|ufw\\s+|iptables", risk: "MEDIUM", reason: "Service/firewall change" },
  { pattern: "mv\\s+.*\\s+/", risk: "MEDIUM", reason: "Move to system dir" },
  { pattern: "chmod\\s+|chown\\s+", risk: "MEDIUM", reason: "Permission change" },
];

function loadRules(): Rule[] {
  try {
    if (existsSync(RULES_FILE)) {
      const raw = JSON.parse(readFileSync(RULES_FILE, "utf8")) as Rule[];
      if (Array.isArray(raw)) return [...BUILTIN, ...raw];
    }
  } catch {}
  return BUILTIN;
}

export function assessRisk(cmd: string): { risk: Risk; reason: string; matched?: string } {
  const rules = loadRules();
  let worst: Risk = "LOW";
  let reason = "Read/safe operation";
  let matched: string | undefined;
  const order: Record<Risk, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  for (const r of rules) {
    try {
      const re = new RegExp(r.pattern, "i");
      if (re.test(cmd)) {
        if (order[r.risk] > order[worst]) {
          worst = r.risk;
          reason = r.reason;
          matched = r.pattern;
        }
      }
    } catch {}
  }
  return { risk: worst, reason, matched };
}

export function shouldIntercept(risk: Risk): boolean {
  if (isDisabled()) return false;
  if (risk === "LOW") return false;
  if (isAgentCall() || isAutoConfirm()) {
    // Agent mode: auto-bypass LOW/MEDIUM, still intercept CRITICAL/HIGH (but audit only, don't block hang)
    if (risk === "MEDIUM") return false;
    if (risk === "CRITICAL" || risk === "HIGH") return true;
    return false;
  }
  return true;
}

export function audit(entry: { command: string; risk: Risk; mode: string; status: string; requestId?: string; result?: string }): void {
  try {
    ensureDirs();
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(AUDIT_LOG, line + "\n");
  } catch {}
}

export function createPending(command: string, risk: Risk, reason: string): string {
  ensureDirs();
  const id = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const data = { id, command, risk, reason, createdAt: new Date().toISOString() };
  writeFileSync(join(PENDING_DIR, `${id}.json`), JSON.stringify(data, null, 2));
  // In-session notification (stdout, no external)
  console.log(`\n🚨 Dangerous Operation Detected — Command Intercepted\nRisk: ${risk}\nCommand: \`${command}\`\nReason: ${reason}\nRequest ID: ${id}\nApprove: safe-exec-approve ${id} | Reject: safe-exec-reject ${id} | List: safe-exec-list\n`);
  return id;
}

export function listPending(): Array<{ id: string; command: string; risk: Risk; reason: string; createdAt: string }> {
  try {
    ensureDirs();
    return readdirSync(PENDING_DIR).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(PENDING_DIR, f), "utf8"))).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch { return []; }
}

export function approve(id: string): boolean {
  try {
    const p = join(PENDING_DIR, `${id}.json`);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    audit({ command: id, risk: "LOW", mode: "user_approved", status: "approved", requestId: id });
    return true;
  } catch { return false; }
}

export function reject(id: string): boolean {
  try {
    const p = join(PENDING_DIR, `${id}.json`);
    if (!existsSync(p)) return false;
    unlinkSync(p);
    audit({ command: id, risk: "LOW", mode: "user_rejected", status: "rejected", requestId: id });
    return true;
  } catch { return false; }
}

// Main guard: returns { allow: true } or { allow: false, requestId, risk, reason }
export function guard(command: string): { allow: boolean; risk: Risk; reason: string; requestId?: string } {
  const { risk, reason } = assessRisk(command);
  if (!shouldIntercept(risk)) {
    audit({ command, risk, mode: isAgentCall() ? "agent_auto" : "user_auto", status: "allowed" });
    return { allow: true, risk, reason };
  }
  const id = createPending(command, risk, reason);
  audit({ command, risk, mode: isAgentCall() ? "agent_auto" : "pending", status: "intercepted", requestId: id });
  return { allow: false, risk, reason, requestId: id };
}
