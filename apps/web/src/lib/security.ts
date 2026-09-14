/**
 * Ethical-Hacker toolkit for the OWNER's own systems / explicitly authorized
 * targets — defensive posture, secret hygiene, TLS hygiene, breach check.
 * Keyless by default. Never used to attack third parties.
 *
 * Safety: all shell calls use fixed, hardcoded commands via execFile (no shell,
 * no interpolation of user input). secret_scan walks a sandbox root only and
 * redacts any secret value it finds.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { connect as tlsConnect } from "node:tls";
import { dirname, extname, join, relative } from "node:path";
import { resolveInSandbox, repoRoot, sanitizeUser, userDataRoot } from "./users";

function run(cmd: string, args: string[], timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve((stdout || stderr || (err ? String((err as NodeJS.ErrnoException).code ?? err.message) : "")).trim());
    });
  });
}

/** macOS security posture — read-only, keyless. */
export async function securityPosture(): Promise<string> {
  const out: string[] = [];
  let score = 0;
  let total = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    total++;
    if (ok) score++;
    out.push(`${ok ? "✅" : "⚠️"} ${label}: ${detail}`);
  };

  const fv = await run("fdesetup", ["status"]);
  check("FileVault (enkripsi disk)", /On/i.test(fv), fv || "tidak diketahui");

  const fw = await run("/usr/libexec/ApplicationFirewall/socketfilterfw", ["--getglobalstate"]);
  check("Firewall", /enabled/i.test(fw), fw || "tidak diketahui");

  const gk = await run("spctl", ["--status"]);
  check("Gatekeeper", /enabled/i.test(gk), gk || "tidak diketahui");

  const sip = await run("csrutil", ["status"]);
  check("System Integrity Protection", /enabled/i.test(sip), sip || "tidak diketahui");

  const listen = await run("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"]);
  const listenLines = listen.split("\n").filter((l) => /\bLISTEN\b/.test(l) || /\(LISTEN\)/.test(l));
  out.push(`ℹ️ Port TCP listening: ${listenLines.length} entri (pakai exec \`lsof -iTCP -sTCP:LISTEN -P -n\` untuk detail)`);

  const users = await run("w", []);
  out.push(`ℹ️ ${users.split("\n")[0] || "sesi login"} — ${(users.split("\n").length - 2) || 0} sesi aktif`);

  const pct = total ? Math.round((score / total) * 100) : 0;
  return `🔐 SECURITY POSTURE (Mac, read-only)\n${out.join("\n")}\n\nSkor dasar: ${score}/${total} (${pct}%). Catatan: ini cek cepat — bukan audit menyeluruh; update OS & password manager tetap penting.`;
}

export type SecretHit = { file: string; line: number; type: string };

const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "AWS access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "Slack token", re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  { name: "OpenAI key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { name: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: "Private key", re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: "Generic secret assignment", re: /(?:api[_-]?key|apikey|secret|token|passwd|password|client[_-]?secret)\s*[:=]\s*['"][^'"]{8,}['"]/gi },
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".data", "dist", "build", "coverage", ".brv", ".learnings", ".self-improving", ".memory"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".ico", ".woff", ".woff2", ".ttf", ".mp3", ".mp4", ".wav", ".mov", ".pt", ".onnx", ".lock"]);

/** Scan a sandbox directory for exposed secrets. Returns hits WITHOUT the value. */
export function scanForSecrets(dirRel = "", maxFiles = 500): { hits: SecretHit[]; scanned: number } {
  const root = dirRel.trim() ? resolveInSandbox(dirRel.trim()) : repoRoot();
  if (!root) throw new Error("path di luar sandbox / tidak valid");
  const hits: SecretHit[] = [];
  let scanned = 0;
  const walk = (dir: string) => {
    if (scanned >= maxFiles || hits.length >= 50) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (scanned >= maxFiles || hits.length >= 50) return;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(full);
        continue;
      }
      if (SKIP_EXT.has(extname(name).toLowerCase()) || st.size > 300_000) continue;
      scanned++;
      let text: string;
      try {
        text = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      const rel = relative(root, full);
      const lines = text.split("\n");
      for (const p of SECRET_PATTERNS) {
        p.re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = p.re.exec(text))) {
          const line = text.slice(0, m.index).split("\n").length;
          hits.push({ file: rel, line, type: p.name });
          if (hits.length >= 50) break;
        }
        void lines;
      }
    }
  };
  walk(root);
  return { hits, scanned };
}

/** TLS certificate hygiene for a host (yours / authorized). Keyless via node:tls. */
export function tlsCheck(host: string, port = 443): Promise<string> {
  const h = host.trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)) return Promise.reject(new Error("host tidak valid (mis. example.com)"));
  const p = Number(port) || 443;
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: h, port: p, servername: h, rejectUnauthorized: false, timeout: 10_000 }, () => {
      const c = socket.getPeerCertificate();
      const auth = socket.authorized;
      const validTo = c.valid_to ? new Date(c.valid_to) : null;
      const days = validTo ? Math.round((validTo.getTime() - Date.now()) / 86_400_000) : null;
      const issuer = c.issuer && (c.issuer.O || c.issuer.CN) ? c.issuer.O || c.issuer.CN : "?";
      const subject = c.subject && (c.subject.CN || c.subject.O) ? c.subject.CN || c.subject.O : "?";
      resolve(`🔐 TLS ${h}:${p}\n• Subject: ${subject}\n• Issuer: ${issuer}\n• Berlaku s/d: ${c.valid_to || "?"}${days !== null ? ` (${days} hari lagi)` : ""}\n• Verifikasi chain: ${auth ? "valid ✅" : "TIDAK valid (self-signed/expired) ⚠️"}\n• Protocol: ${socket.getProtocol?.() ?? "?"}`);
      socket.end();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("koneksi timeout"));
    });
    socket.on("error", (e) => reject(e));
  });
}

/** HaveIBeenPwned Pwned Passwords (k-anonymity, keyless — full password never leaves). */
export async function breachCheck(password: string): Promise<{ count: number }> {
  if (!password) throw new Error("password kosong");
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
    headers: { "Add-Padding": "true", "User-Agent": "mia-assistant/1.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HIBP tidak bisa diakses (HTTP ${res.status})`);
  const body = await res.text();
  for (const line of body.split("\n")) {
    const [s, n] = line.trim().split(":");
    if (s === suffix) return { count: Number(n) || 0 };
  }
  return { count: 0 };
}

/** Practice platforms + the local lab, for when the owner asks where to train. */
export function pentestResources(): string {
  return [
    "🎯 LATIHAN ETHICAL HACKING (legal)",
    "",
    "Platform (belajar/CTF — JANGAN diautomasi, ToS melarang bot):",
    "• PortSwigger Web Security Academy — gratis, lab web terbaik",
    "• TryHackMe — pemula→menengah, guided",
    "• Hack The Box (+ Academy) — mesin nyata",
    "• PentesterLab, OverTheWire, Root-Me, picoCTF",
    "• CyberDefenders / LetsDefend / Blue Team Labs — blue team & DFIR",
    "",
    "Lab LOKAL (aman untuk Mia praktik langsung) — `docker compose -f labs/pentest/docker-compose.yml up -d`:",
    "• OWASP Juice Shop  http://localhost:3001",
    "• DVWA              http://localhost:8081  (admin / password)",
    "• WebGoat           http://localhost:8082/WebGoat",
    "(Butuh Docker; belum terpasang — lihat labs/pentest/README.md)",
    "",
    "SCOPE: hanya target sendiri / berizin tertulis. Active scan hanya ke localhost/lab ini.",
  ].join("\n");
}

// ── Guarded pentest scanning (OWN lab / authorized targets only) ─────────────

const PENTEST_TOOLS: Record<string, { bin: string; formula: string; args: (t: string, wordlist: string) => string[] }> = {
  nmap: { bin: "nmap", formula: "nmap", args: (t) => ["-sV", "-T4", "-Pn", t] },
  nuclei: { bin: "nuclei", formula: "nuclei", args: (t) => ["-u", t, "-silent", "-no-color"] },
  whatweb: { bin: "whatweb", formula: "whatweb", args: (t) => [t] },
  nikto: { bin: "nikto", formula: "nikto", args: (t) => ["-h", t] },
  ffuf: { bin: "ffuf", formula: "ffuf", args: (t, w) => ["-u", t.includes("FUZZ") ? t : `${t.replace(/\/$/, "")}/FUZZ`, "-w", w, "-s"] },
};

/**
 * True only for localhost / RFC1918 private / link-local, or an exact host in
 * the PENTEST_LAB_TARGETS env (comma-separated). Everything public is refused —
 * active scans are for the owner's own lab/authorized assets only.
 */
export function isLabTarget(raw: string): boolean {
  const t = (raw || "").trim().replace(/^[a-z]+:\/\//i, "");
  if (!t) return false;
  const hostport = t.split("/")[0].toLowerCase();
  const host = hostport.replace(/^\[/, "").replace(/\].*$/, "").split(":")[0];
  const envTargets = (process.env.PENTEST_LAB_TARGETS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (envTargets.includes(host) || envTargets.includes(hostport)) return true;
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

export function pentestToolsList(): string {
  return Object.keys(PENTEST_TOOLS).join(", ");
}

/** Run one allowlisted pentest tool against a validated local/lab target. */
export function pentestScan(opts: { tool: string; target: string; wordlist?: string }): Promise<string> {
  const spec = PENTEST_TOOLS[opts.tool];
  if (!spec) return Promise.reject(new Error(`tool "${opts.tool}" tidak didukung (pilih: ${pentestToolsList()})`));
  const target = (opts.target || "").trim();
  if (!target) return Promise.reject(new Error("target wajib diisi"));
  if (!isLabTarget(target)) {
    return Promise.reject(new Error("SCOPE: hanya localhost/lab/aset berizin. Untuk host lain, set PENTEST_LAB_TARGETS setelah kamu punya izin tertulis."));
  }
  let wordlist = "";
  if (opts.tool === "ffuf") {
    if (!opts.wordlist) return Promise.reject(new Error("ffuf butuh `wordlist` (path di sandbox)"));
    const wl = resolveInSandbox(opts.wordlist);
    if (!wl) return Promise.reject(new Error("wordlist di luar sandbox"));
    wordlist = wl;
  }
  const args = spec.args(target, wordlist);
  return new Promise((resolve) => {
    execFile(spec.bin, args, { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as NodeJS.ErrnoException | null;
      if (e && e.code === "ENOENT") {
        resolve(`Error: ${spec.bin} belum terpasang — \`brew install ${spec.formula}\``);
        return;
      }
      const out = `${stdout || ""}${stderr || ""}`.trim();
      if (!out) {
        resolve(`(${spec.bin} selesai, tanpa output${e ? ` — ${e.message.split("\n")[0]}` : ""})`);
        return;
      }
      resolve(`🎯 ${spec.bin} ${target}\n${out.slice(0, 6000)}`);
    });
  });
}

// ── Findings store + report (per-user) ───────────────────────────────────────

export type Finding = { id: string; title: string; severity: string; target: string; evidence: string; impact: string; remediation: string; createdAt: string };

const SEVERITIES = ["critical", "high", "medium", "low", "info"];

function findingsPath(userKey: string): string {
  return join(userDataRoot(), userKey, "findings.json");
}

export function readFindings(rawUser: unknown): Finding[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const parsed = JSON.parse(readFileSync(findingsPath(userKey), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeFindings(userKey: string, rows: Finding[]): void {
  const file = findingsPath(userKey);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows, null, 2));
  renameSync(tmp, file);
}

export function addFinding(rawUser: unknown, f: { title: string; severity?: string; target?: string; evidence?: string; impact?: string; remediation?: string }): Finding {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const title = (f.title || "").trim().slice(0, 200);
  if (!title) throw new Error("judul temuan wajib");
  const sev = SEVERITIES.includes((f.severity || "").toLowerCase()) ? (f.severity as string).toLowerCase() : "medium";
  const row: Finding = {
    id: `F-${Date.now().toString(36)}`,
    title,
    severity: sev,
    target: (f.target || "").slice(0, 200),
    evidence: (f.evidence || "").slice(0, 2000),
    impact: (f.impact || "").slice(0, 1000),
    remediation: (f.remediation || "").slice(0, 1000),
    createdAt: new Date().toISOString(),
  };
  const rows = readFindings(rawUser);
  rows.push(row);
  while (rows.length > 500) rows.shift();
  writeFindings(userKey, rows);
  return row;
}

export function listFindingsText(rawUser: unknown): string {
  const rows = readFindings(rawUser);
  if (!rows.length) return "Belum ada temuan tercatat.";
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...rows].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  return `${rows.length} temuan:\n${sorted.map((f) => `• [${f.severity.toUpperCase()}] ${f.title}${f.target ? ` — ${f.target}` : ""}${f.evidence ? `\n   Evidence: ${f.evidence.slice(0, 160)}` : ""}${f.remediation ? `\n   Fix: ${f.remediation.slice(0, 160)}` : ""}`).join("\n")}`;
}

export function generateReport(rawUser: unknown): string {
  const rows = readFindings(rawUser);
  if (!rows.length) return "Belum ada temuan — belum ada yang bisa dilaporkan.";
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...rows].sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const counts = SEVERITIES.map((s) => `${s}:${rows.filter((r) => r.severity === s).length}`).join("  ");
  const body = sorted
    .map(
      (f, i) =>
        `## ${i + 1}. [${f.severity.toUpperCase()}] ${f.title}\n\n- **Target**: ${f.target || "-"}\n- **Evidence**: ${f.evidence || "-"}\n- **Impact**: ${f.impact || "-"}\n- **Remediation**: ${f.remediation || "-"}\n- **Found**: ${f.createdAt}`
    )
    .join("\n\n");
  return `# Laporan Pentest\n\nDibuat: ${new Date().toISOString()}\nTotal temuan: ${rows.length} (${counts})\n\n> Scope: aset milik sendiri / berizin tertulis. Laporan ini untuk perbaikan defensif.\n\n${body}`;
}
