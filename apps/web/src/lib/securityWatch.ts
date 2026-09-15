// Security watch — periodic (heartbeat) defensive checks for the owner's own
// machine: NEW listening TCP ports, and TLS certs nearing expiry for domains in
// SECURITY_CERT_DOMAINS. Alerts are pushed once (deduped via state). Silent when
// nothing changed. Best-effort; never throws.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot } from "./users";
import { pushToOwner } from "../channels/pushTarget";
import { logInfo, logError } from "./appLogger";
import { tlsExpiryDays } from "./security";

type State = { ports: string[]; certAlerted: Record<string, boolean>; engAlerted: Record<string, boolean>; scopeSeen: Record<string, string[]>; scopeWatchAt?: string; updatedAt: string };

function stateFile(): string {
  return join(appRoot(), ".data", "security-watch", "state.json");
}
function readState(): State {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8")) as State;
    return { ports: Array.isArray(s.ports) ? s.ports : [], certAlerted: s.certAlerted || {}, engAlerted: s.engAlerted || {}, scopeSeen: s.scopeSeen || {}, scopeWatchAt: s.scopeWatchAt || "", updatedAt: s.updatedAt || "" };
  } catch {
    return { ports: [], certAlerted: {}, engAlerted: {}, scopeSeen: {}, scopeWatchAt: "", updatedAt: "" };
  }
}
function writeState(s: State): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, file);
}

function listeningPorts(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"], { timeout: 8000, maxBuffer: 1024 * 1024 }, (_err, stdout) => {
      const set = new Set<string>();
      for (const line of (stdout || "").split("\n").slice(1)) {
        const name = line.trim().split(/\s+/).pop() || "";
        if (/:\d+$/.test(name)) set.add(name);
      }
      resolve([...set].sort());
    });
  });
}

export async function runSecurityWatchTick(): Promise<void> {
  try {
    const st = readState();
    const alerts: string[] = [];

    const ports = await listeningPorts();
    if (st.ports.length && ports.length) {
      const known = new Set(st.ports);
      const fresh = ports.filter((p) => !known.has(p));
      if (fresh.length) alerts.push(`Port listening BARU: ${fresh.join(", ")}`);
    }

    const domains = (process.env.SECURITY_CERT_DOMAINS || "").split(",").map((x) => x.trim()).filter(Boolean);
    const threshold = Math.max(1, Number(process.env.SECURITY_CERT_DAYS) || 14);
    const certAlerted = { ...st.certAlerted };
    for (const d of domains) {
      const days = await tlsExpiryDays(d);
      if (days === null) continue;
      if (days < threshold) {
        if (!certAlerted[d]) {
          alerts.push(`Sertifikat ${d} kedaluwarsa dalam ${days} hari`);
          certAlerted[d] = true;
        }
      } else {
        certAlerted[d] = false;
      }
    }

    const { listEngagements } = await import("./engagement");
    const engAlerted = { ...(st.engAlerted || {}) };
    for (const en of listEngagements()) {
      if (en.status !== "active" || !en.windowEnd) continue;
      const ms = Date.parse(en.windowEnd) - Date.now();
      if (ms > 0 && ms < 24 * 3600 * 1000 && !engAlerted[en.id]) {
        alerts.push(`Engagement ${en.id} (${en.client}) berakhir <24 jam — tutup bila selesai`);
        engAlerted[en.id] = true;
      }
    }

    // Scope-watch: alert on NEW subdomains for domains in SECURITY_SCOPE_WATCH.
    const watch = (process.env.SECURITY_SCOPE_WATCH || "").split(",").map((x) => x.trim()).filter(Boolean);
    const scopeSeen = { ...st.scopeSeen };
    if (watch.length) {
      const { passiveSubdomains } = await import("./recon");
      for (const d of watch) {
        const subs = await passiveSubdomains(d);
        if (!subs.length) continue;
        const had = Array.isArray(scopeSeen[d]);
        const known = new Set(scopeSeen[d] || []);
        if (had) {
          const fresh = subs.filter((h) => !known.has(h));
          if (fresh.length) alerts.push(`Aset BARU di ${d}: ${fresh.slice(0, 15).join(", ")}`);
        }
        scopeSeen[d] = subs.slice(0, 500);
      }
    }

    // Auto recon-watch: also cover the ACTIVE engagements' root domains (new
    // assets there are where fresh bugs appear) — bounded to 6 domains and at
    // most ~2×/day so the heartbeat stays cheap.
    const lastAuto = st.scopeWatchAt ? Date.parse(st.scopeWatchAt) : 0;
    if (Date.now() - lastAuto > 12 * 3600 * 1000) {
      const roots = new Set<string>();
      for (const en of listEngagements()) {
        if (en.status !== "active") continue;
        for (const s of en.scope) {
          const host = s.replace(/^https?:\/\//, "").replace(/^\*\./, "").split("/")[0].trim();
          if (!host) continue;
          const parts = host.split(".");
          roots.add(parts.length >= 2 ? parts.slice(-2).join(".") : host);
          if (roots.size >= 6) break;
        }
        if (roots.size >= 6) break;
      }
      if (roots.size) {
        const { passiveSubdomains } = await import("./recon");
        for (const d of roots) {
          const subs = await passiveSubdomains(d);
          if (!subs.length) continue;
          const had = Array.isArray(scopeSeen[d]);
          const known = new Set(scopeSeen[d] || []);
          if (had) {
            const fresh = subs.filter((h) => !known.has(h));
            if (fresh.length) alerts.push(`Aset BARU (engagement ${d}): ${fresh.slice(0, 12).join(", ")}`);
          }
          scopeSeen[d] = subs.slice(0, 500);
        }
      }
      st.scopeWatchAt = new Date().toISOString();
    }

    writeState({ ports, certAlerted, engAlerted, scopeSeen, scopeWatchAt: st.scopeWatchAt, updatedAt: new Date().toISOString() });
    if (alerts.length) {
      logInfo("security-watch", alerts.join("; "));
      await pushToOwner(`🔐 Security watch:\n- ${alerts.join("\n- ")}`).catch(() => {});
    }
  } catch (e) {
    logError("security-watch", e instanceof Error ? e.message : String(e));
  }
}
