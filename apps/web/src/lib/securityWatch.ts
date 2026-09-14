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

type State = { ports: string[]; certAlerted: Record<string, boolean>; engAlerted: Record<string, boolean>; updatedAt: string };

function stateFile(): string {
  return join(appRoot(), ".data", "security-watch", "state.json");
}
function readState(): State {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8")) as State;
    return { ports: Array.isArray(s.ports) ? s.ports : [], certAlerted: s.certAlerted || {}, engAlerted: s.engAlerted || {}, updatedAt: s.updatedAt || "" };
  } catch {
    return { ports: [], certAlerted: {}, engAlerted: {}, updatedAt: "" };
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

    writeState({ ports, certAlerted, engAlerted, updatedAt: new Date().toISOString() });
    if (alerts.length) {
      logInfo("security-watch", alerts.join("; "));
      await pushToOwner(`🔐 Security watch:\n- ${alerts.join("\n- ")}`).catch(() => {});
    }
  } catch (e) {
    logError("security-watch", e instanceof Error ? e.message : String(e));
  }
}
