/**
 * Ethical-Hacker toolkit for the OWNER's own systems / explicitly authorized
 * targets — defensive posture, secret hygiene, TLS hygiene, breach check.
 * Keyless by default. Never used to attack third parties.
 *
 * Safety: all shell calls use fixed, hardcoded commands via execFile (no shell,
 * no interpolation of user input). secret_scan walks a sandbox root only and
 * redacts any secret value it finds.
 */
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { connect as tlsConnect } from "node:tls";
import { dirname, extname, join, relative } from "node:path";
import { appRoot, resolveInSandbox, repoRoot, sanitizeUser, userDataRoot } from "./users";
import { engagementAllows, listEngagements } from "./engagement";

function run(cmd: string, args: string[], timeoutMs = 12_000): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve((stdout || stderr || (err ? String((err as NodeJS.ErrnoException).code ?? err.message) : "")).trim());
    });
  });
}

/**
 * Capture a CLI's output with stdin IGNORED (/dev/null). Some scanners (nuclei)
 * block forever waiting for stdin when it is an open pipe (execFile's default) —
 * giving /dev/null makes them exit normally.
 */
function runCapture(bin: string, args: string[], timeoutMs: number, maxBytes = 2 * 1024 * 1024): Promise<{ out: string; enoent: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ out: "", enoent: (e as NodeJS.ErrnoException).code === "ENOENT", timedOut: false });
      return;
    }
    let out = "";
    let bytes = 0;
    let timedOut = false;
    const onData = (d: Buffer) => {
      if (bytes < maxBytes) {
        out += d.toString();
        bytes += d.length;
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ out, enoent: (e as NodeJS.ErrnoException).code === "ENOENT", timedOut });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ out, enoent: false, timedOut });
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
    "• bWAPP (lokal)     http://localhost:8083  — jalankan image Docker bWAPP sendiri (sama dgn demo publik, tapi MILIKMU)",
    "(Butuh Docker; belum terpasang — lihat labs/pentest/README.md)",
    "• [TANPA Docker] vuln-node  http://127.0.0.1:4010  — `node labs/pentest/vuln-node/server.js` (SQLi/Reflected+Stored XSS/IDOR/Open-redirect/Path-traversal; cmd-injection opsional VULN_ALLOW_CMDI=1)",
    "",
    "SCOPE: hanya target sendiri / berizin tertulis. Active scan hanya ke localhost/lab ini.",
    "⛔ Demo publik pihak ketiga (mis. itsecgames.com / bWAPP online) BUKAN target — jangan discan; jalankan bWAPP lokal sebagai gantinya.",
    "",
    "Target PUBLIK yang eksplisit MENGIZINKAN diuji (ikuti aturan + rate-limit):",
    "• scanme.nmap.org — resmi boleh di-nmap (Nmap Project)",
    "• testphp.vulnweb.com — demo Acunetix untuk uji scanner",
    "Selain itu: hanya host milikmu (set PENTEST_LAB_TARGETS=host setelah kamu punya izin).",
  ].join("\n");
}

// ── Guarded pentest scanning (OWN lab / authorized targets only) ─────────────

const PENTEST_TOOLS: Record<string, { bin: string; formula: string; timeoutMs?: number; args: (t: string, wordlist: string) => string[] }> = {
  nmap: { bin: "nmap", formula: "nmap", timeoutMs: 120_000, args: (t) => ["-sV", "-T4", "-Pn", t] },
  // nuclei default scans EVERY template (very slow, hangs 100s+). `-as`
  // (automatic/tech-aware scan) is bounded (~10s here) and still useful.
  nuclei: { bin: "nuclei", formula: "nuclei", timeoutMs: 180_000, args: (t) => ["-u", t, "-as", "-silent", "-no-color", "-no-interactsh", "-duc", "-severity", "critical,high,medium", "-timeout", "5", "-rl", "150"] },
  nikto: { bin: "nikto", formula: "nikto", timeoutMs: 180_000, args: (t) => ["-h", t] },
  ffuf: { bin: "ffuf", formula: "ffuf", timeoutMs: 120_000, args: (t, w) => ["-u", t.includes("FUZZ") ? t : `${t.replace(/\/$/, "")}/FUZZ`, "-w", w, "-s", "-mc", "all"] },
};

/**
 * Public hosts that EXPLICITLY permit security testing (follow their rules +
 * rate-limit). Kept deliberately tiny & well-known; everything else public is
 * refused.
 */
const SCAN_PERMITTED_HOSTS = new Set<string>([
  "scanme.nmap.org", // Nmap Project — explicitly authorizes Nmap scans
  "testphp.vulnweb.com", // Acunetix demo — intended for scanner testing
]);

/**
 * True only for localhost / RFC1918 private / link-local, an explicitly
 * scan-permitted public host, or an exact host in the PENTEST_LAB_TARGETS env.
 * Everything else public is refused.
 */
export function isLabTarget(raw: string): boolean {
  const t = (raw || "").trim().replace(/^[a-z]+:\/\//i, "");
  if (!t) return false;
  const hostport = t.split("/")[0].toLowerCase();
  const host = hostport.replace(/^\[/, "").replace(/\].*$/, "").split(":")[0];
  const envTargets = (process.env.PENTEST_LAB_TARGETS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (envTargets.includes(host) || envTargets.includes(hostport)) return true;
  if (SCAN_PERMITTED_HOSTS.has(host)) return true;
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host)) return true;
  if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  return false;
}

/** Lab/permitted host OR a host inside an ACTIVE engagement scope. */
export function targetAllowed(raw: string): boolean {
  return isLabTarget(raw) || engagementAllows(raw);
}

export function pentestToolsList(): string {
  return Object.keys(PENTEST_TOOLS).join(", ");
}

/** Run one allowlisted pentest tool against a validated local/lab target. */
export async function pentestScan(opts: { tool: string; target: string; wordlist?: string }): Promise<string> {
  const spec = PENTEST_TOOLS[opts.tool];
  if (!spec) return Promise.reject(new Error(`tool "${opts.tool}" tidak didukung (pilih: ${pentestToolsList()})`));
  const target = (opts.target || "").trim();
  if (!target) return Promise.reject(new Error("target wajib diisi"));
  if (!targetAllowed(target)) {
    return Promise.reject(new Error("SCOPE: hanya localhost/lab, host di engagement aktif, atau PENTEST_LAB_TARGETS. Untuk klien, buat engagement dulu."));
  }
  let wordlist = "";
  if (opts.tool === "ffuf") {
    if (opts.wordlist) {
      const wl = resolveInSandbox(opts.wordlist);
      if (!wl) return Promise.reject(new Error("wordlist di luar sandbox"));
      wordlist = wl;
    } else {
      const def = join(repoRoot(), "labs", "pentest", "wordlists", "common.txt");
      if (!existsSync(def)) return Promise.reject(new Error("wordlist default tidak ada — beri arg `wordlist`"));
      wordlist = def;
    }
  }
  const args = spec.args(target, wordlist);
  const { out, enoent, timedOut } = await runCapture(spec.bin, args, spec.timeoutMs ?? 120_000);
  if (enoent) return `Error: ${spec.bin} belum terpasang — \`brew install ${spec.formula}\``;
  const o = out.trim();
  if (timedOut && !o) return `⏱️ ${spec.bin} timeout (${Math.round((spec.timeoutMs ?? 120_000) / 1000)}s) tanpa temuan — coba target lebih spesifik.`;
  if (!o) return `(${spec.bin} selesai, tanpa output)`;
  return `🎯 ${spec.bin} ${target}\n${o.slice(0, 6000)}`;
}

// ── Findings store + report (per-user) ───────────────────────────────────────

export type Finding = { id: string; title: string; severity: string; cvss: number | null; owasp: string; cwe: string; target: string; evidence: string; impact: string; remediation: string; status: "open" | "resolved"; createdAt: string; resolvedAt?: string };

const SEVERITIES = ["critical", "high", "medium", "low", "info"];

function findingsPath(userKey: string): string {
  return join(userDataRoot(), userKey, "findings.json");
}

export function readFindings(rawUser: unknown): Finding[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  try {
    const parsed = JSON.parse(readFileSync(findingsPath(userKey), "utf8"));
    return Array.isArray(parsed) ? (parsed as Finding[]).map((r) => ({ ...r, status: r.status === "resolved" ? "resolved" : "open" })) : [];
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

const DEFAULT_CVSS: Record<string, number> = { critical: 9.8, high: 8.1, medium: 5.5, low: 3.1, info: 0 };

export function addFinding(rawUser: unknown, f: { title: string; severity?: string; cvss?: number; owasp?: string; cwe?: string; target?: string; evidence?: string; impact?: string; remediation?: string }): Finding {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const title = (f.title || "").trim().slice(0, 200);
  if (!title) throw new Error("judul temuan wajib");
  const sev = SEVERITIES.includes((f.severity || "").toLowerCase()) ? (f.severity as string).toLowerCase() : "medium";
  const cvss = typeof f.cvss === "number" && f.cvss >= 0 && f.cvss <= 10 ? Math.round(f.cvss * 10) / 10 : DEFAULT_CVSS[sev] ?? null;
  const row: Finding = {
    id: `F-${Date.now().toString(36)}`,
    title,
    severity: sev,
    cvss,
    owasp: (f.owasp || "").slice(0, 120),
    cwe: (f.cwe || "").slice(0, 60),
    target: (f.target || "").slice(0, 200),
    evidence: (f.evidence || "").slice(0, 2000),
    impact: (f.impact || "").slice(0, 1000),
    remediation: (f.remediation || "").slice(0, 1000),
    status: "open",
    createdAt: new Date().toISOString(),
  };
  const rows = readFindings(rawUser);
  rows.push(row);
  while (rows.length > 500) rows.shift();
  writeFindings(userKey, rows);
  return row;
}

export function listFindingsText(rawUser: unknown): string {
  const all = readFindings(rawUser);
  const rows = all.filter((r) => r.status !== "resolved");
  if (!all.length) return "Belum ada temuan tercatat.";
  if (!rows.length) return `Semua ${all.length} temuan sudah resolved ✅`;
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...rows].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0) || (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  return `${rows.length} temuan:\n${sorted.map((f) => `• [${f.severity.toUpperCase()}${f.cvss != null ? ` CVSS ${f.cvss}` : ""}] ${f.title}${f.owasp ? ` (${f.owasp})` : ""}${f.target ? ` — ${f.target}` : ""}${f.evidence ? `\n   Evidence: ${f.evidence.slice(0, 160)}` : ""}${f.remediation ? `\n   Fix: ${f.remediation.slice(0, 160)}` : ""}`).join("\n")}`;
}

export function generateReport(rawUser: unknown): string {
  const rows = readFindings(rawUser).filter((r) => r.status !== "resolved");
  if (!rows.length) return "Belum ada temuan terbuka — belum ada yang bisa dilaporkan.";
  const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const sorted = [...rows].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0) || (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
  const counts = SEVERITIES.map((s) => `${s}:${rows.filter((r) => r.severity === s).length}`).join("  ");
  const avg = rows.length ? Math.round((rows.reduce((a, r) => a + (r.cvss ?? 0), 0) / rows.length) * 10) / 10 : 0;
  const body = sorted
    .map(
      (f, i) =>
        `## ${i + 1}. [${f.severity.toUpperCase()}${f.cvss != null ? ` · CVSS ${f.cvss}` : ""}] ${f.title}\n\n- **Kategori**: ${[f.owasp, f.cwe].filter(Boolean).join(" / ") || "-"}\n- **Target**: ${f.target || "-"}\n- **Evidence**: ${f.evidence || "-"}\n- **Impact**: ${f.impact || "-"}\n- **Remediation**: ${f.remediation || "-"}\n- **Found**: ${f.createdAt}`
    )
    .join("\n\n");
  return `# Laporan Pentest\n\nDibuat: ${new Date().toISOString()}\nTotal temuan: ${rows.length} (${counts}) — rata-rata CVSS ${avg}\n\n${(() => { const a = listEngagements().find((e) => e.status === "active"); return a ? `> Engagement: ${a.id} — ${a.name} (${a.client})\n> Izin: ${a.authorization}\n> Scope: ${a.scope.join(", ")}${a.windowEnd ? ` (s/d ${a.windowEnd})` : ""}` : "> Scope: aset milik sendiri / berizin tertulis. Laporan ini untuk perbaikan defensif."; })()}\n\n${body}`;
}

/** OWASP ZAP baseline scan via Docker (web app in the owner's own lab only). */
export function zapScan(target: string, minutes = 5): Promise<string> {
  const t = (target || "").trim();
  if (!t) return Promise.reject(new Error("target wajib"));
  if (!targetAllowed(t)) {
    return Promise.reject(new Error("SCOPE: ZAP baseline hanya untuk localhost/lab atau host di engagement aktif."));
  }
  const m = Math.min(30, Math.max(1, Number(minutes) || 5));
  return new Promise((resolve) => {
    execFile(
      "docker",
      ["run", "--rm", "-t", "ghcr.io/zaproxy/zaproxy:stable", "zap-baseline.py", "-t", t, "-m", String(m)],
      { timeout: (m + 3) * 60_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        if (e && e.code === "ENOENT") {
          resolve("Error: Docker belum terpasang — `brew install --cask docker` (atau colima) lalu start.");
          return;
        }
        const out = `${stdout || ""}${stderr || ""}`.trim();
        if (!out) {
          resolve(`(ZAP selesai, tanpa output${e ? ` — ${e.message.split("\n")[0]}` : ""})`);
          return;
        }
        resolve(`🛡️ ZAP baseline ${t}\n${out.slice(0, 7000)}`);
      }
    );
  });
}

// ── Passive web audit (headers/cookies/TLS) ─────────────────────────────────
export async function webAudit(url: string): Promise<string> {
  const raw = (url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: URL harus http(s), mis. https://example.com";
  const res = await fetch(raw, { redirect: "follow", headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(12_000) });
  const SEC = ["strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-embedder-policy", "x-xss-protection"];
  const present = SEC.filter((h) => res.headers.get(h));
  const missing = SEC.filter((h) => !res.headers.has(h));
  const cookies = (res.headers.get("set-cookie") || "").split(/, (?=[^;]+=)/);
  const cookieIssues: string[] = [];
  for (const c of cookies) {
    if (!c || !c.includes("=")) continue;
    const name = c.split("=")[0].trim();
    if (!/;\s*secure/i.test(c)) cookieIssues.push(`${name}: tanpa Secure`);
    if (!/httponly/i.test(c)) cookieIssues.push(`${name}: tanpa HttpOnly`);
    if (!/samesite/i.test(c)) cookieIssues.push(`${name}: tanpa SameSite`);
  }
  const score = Math.round((present.length / SEC.length) * 100);
  const lines = [
    `🛡️ WEB AUDIT (pasif) ${raw}`,
    `• Status: ${res.status} ${res.statusText}`,
    `• Server: ${res.headers.get("server") || "-"}  |  X-Powered-By: ${res.headers.get("x-powered-by") || "-"}`,
    `• Header keamanan ada (${present.length}/${SEC.length}, skor ${score}%): ${present.join(", ") || "-"}`,
    `• Header HILANG: ${missing.join(", ") || "-"}`,
    cookieIssues.length ? `• Cookie: ${cookieIssues.join("; ")}` : `• Cookie: (tidak ada / aman)`,
    /^https:/i.test(raw) ? "" : "⚠️ Bukan HTTPS — data bisa disadap.",
    "",
    "Catatan: audit pasif (1x GET). Jadikan temuan via finding_add bila perlu.",
  ].filter(Boolean);
  return lines.join("\n");
}

// ── Email/DNS domain audit (SPF/DMARC/DKIM/CAA/MX) ──────────────────────────
export async function domainAudit(domain: string): Promise<string> {
  const d = (domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d)) return "Error: domain tidak valid, mis. example.com";
  const dns = await import("node:dns");
  const q = (fn: () => Promise<unknown>) => fn().then((v) => v).catch(() => null);
  const txt = (await q(() => dns.promises.resolveTxt(d))) as string[][] | null;
  const flat = (txt || []).map((r) => r.join(""));
  const spf = flat.find((t) => /^v=spf1/i.test(t)) || null;
  const dmarcTxt = (await q(() => dns.promises.resolveTxt(`_dmarc.${d}`))) as string[][] | null;
  const dmarc = (dmarcTxt || []).map((r) => r.join("")).find((t) => /^v=DMARC1/i.test(t)) || null;
  const caa = (await q(() => dns.promises.resolveCaa(d))) as unknown[] | null;
  const mx = (await q(() => dns.promises.resolveMx(d))) as unknown[] | null;
  const ns = (await q(() => dns.promises.resolveNs(d))) as string[] | null;
  const dkimSel = ["default", "google", "selector1", "selector2", "k1", "mail"];
  const dkim: string[] = [];
  for (const s of dkimSel) {
    const t = (await q(() => dns.promises.resolveTxt(`${s}._domainkey.${d}`))) as string[][] | null;
    if (t && t.map((r) => r.join("")).some((x) => /v=DKIM1/i.test(x))) dkim.push(s);
  }
  const dmarcPolicy = dmarc ? (dmarc.match(/p=(\w+)/i)?.[1] ?? "none").toLowerCase() : null;
  const lines = [
    `🌐 DOMAIN AUDIT ${d}`,
    `• SPF: ${spf ? `✅ ${spf}` : "❌ tidak ada (email bisa dipalsukan)"}`,
    `• DMARC: ${dmarc ? `✅ policy=${dmarcPolicy}${dmarcPolicy === "none" ? " (⚠️ monitoring saja)" : ""}` : "❌ tidak ada"}`,
    `• DKIM: ${dkim.length ? `✅ selector: ${dkim.join(", ")}` : "❓ tidak terdeteksi pada selector umum (default/google/selector1/selector2/k1/mail)"}`,
    `• CAA: ${caa && caa.length ? "✅ ada" : "⚠️ tidak ada (siapa pun bisa terbitkan sertifikat)"}`,
    `• MX (${mx ? mx.length : 0}): ${mx ? mx.map((m) => (m as { exchange: string }).exchange).slice(0, 5).join(", ") : "-"}`,
    `• NS: ${ns ? ns.slice(0, 4).join(", ") : "-"}`,
    "",
    "Saran: pasang SPF ketat (-all) + DMARC p=reject/quarantine + DKIM + CAA.",
  ];
  return lines.join("\n");
}

// ── Password strength (local, no network) ───────────────────────────────────
export function passwordStrength(pw: string): string {
  const s = pw || "";
  if (!s) return "Error: password kosong";
  let cs = 0;
  if (/[a-z]/.test(s)) cs += 26;
  if (/[A-Z]/.test(s)) cs += 26;
  if (/[0-9]/.test(s)) cs += 10;
  if (/[^A-Za-z0-9]/.test(s)) cs += 33;
  const entropy = Math.round(s.length * Math.log2(cs || 1));
  const common = /^(password|123456|qwerty|admin|iloveyou|welcome|letmein|monkey|dragon|abc123|password1)/i.test(s);
  const seq = /(0123|1234|2345|3456|4567|5678|6789|abcd|qwer|asdf)/i.test(s);
  const rep = /(.)\1{2,}/.test(s);
  const verdict = common || seq || s.length < 8 ? "LEMAH" : entropy < 50 ? "SEDANG" : entropy < 70 ? "KUAT" : "SANGAT KUAT";
  const notes = [common && "pola umum", seq && "urutan keyboard/angka", rep && "karakter berulang", s.length < 12 && "panjang <12"].filter(Boolean);
  return `🔑 Password strength: ${verdict} (~${entropy} bit)\nPanjang: ${s.length}\n${notes.length ? `Catatan: ${notes.join(", ")}` : "Bagus."}\nSaran: ≥14 karakter, frasa unik, jangan pakai ulang; simpan di password manager.`;
}

// ── Hash identify + compute (defensive) ─────────────────────────────────────
export function hashIdentify(input: string): string {
  const s = (input || "").trim();
  const h = createHash("sha256").update(s).digest("hex");
  const sha1 = createHash("sha1").update(s).digest("hex");
  const md5 = createHash("md5").update(s).digest("hex");
  let type = "teks biasa";
  if (/^[a-f0-9]{32}$/i.test(s)) type = "MD5";
  else if (/^[a-f0-9]{40}$/i.test(s)) type = "SHA-1";
  else if (/^[a-f0-9]{64}$/i.test(s)) type = "SHA-256";
  else if (/^[a-f0-9]{128}$/i.test(s)) type = "SHA-512";
  else if (/^\$2[aby]\$/.test(s)) type = "bcrypt";
  else if (/^\$argon2/.test(s)) type = "argon2";
  return `#️⃣ Hash\n• Terdeteksi: ${type}\n• SHA-256("${s.slice(0, 40)}"): ${h}\n• SHA-1: ${sha1}\n• MD5: ${md5}`;
}

// ── JWT inspect (no verify) ─────────────────────────────────────────────────
export function jwtInspect(token: string): string {
  const t = (token || "").trim();
  const parts = t.split(".");
  if (parts.length !== 3) return "Error: bukan JWT (butuh 3 bagian dipisah titik)";
  const dec = (p: string) => {
    try {
      return JSON.parse(Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    } catch {
      return null;
    }
  };
  const header = dec(parts[0]);
  const payload = dec(parts[1]);
  if (!header || !payload) return "Error: JWT tidak bisa didecode";
  const flags: string[] = [];
  if (String(header.alg || "").toLowerCase() === "none") flags.push("⚠️ alg=none (JWT tanpa tanda tangan — berbahaya)");
  if (payload.exp && Number(payload.exp) * 1000 < Date.now()) flags.push("⚠️ token sudah kedaluwarsa (exp)");
  return `🎫 JWT\nHeader: ${JSON.stringify(header)}\nPayload: ${JSON.stringify(payload)}\n${flags.length ? flags.join("\n") : "Tidak ada flag mencurigakan dasar."}\n(Ikatan: token ini TIDAK diverifikasi — hanya decode.)`;
}

// ── IOC extraction (IR/forensics) ───────────────────────────────────────────
export function iocExtract(text: string): string {
  const s = (text || "").replace(/hxxp/gi, "http").replace(/\[\.\]/g, ".").replace(/\(\.\)/g, ".");
  const uniq = (arr: RegExpMatchArray | null) => [...new Set(arr || [])].slice(0, 30);
  const ips = uniq(s.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)).filter((i) => !/^(?:0\.|127\.|255\.)/.test(i));
  const urls = uniq(s.match(/https?:\/\/[^\s"'<>)]+/gi));
  const emails = uniq(s.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g));
  const domains = uniq(s.match(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|id|co|xyz|ru|cn|top|info|biz|dev|app)\b/gi)).filter((d) => !emails.some((e) => e.endsWith(d)));
  const hashes = uniq(s.match(/\b[a-f0-9]{32,64}\b/gi));
  return ["🧲 IOC", `IP (${ips.length}): ${ips.join(", ") || "-"}`, `Domain (${domains.length}): ${domains.join(", ") || "-"}`, `URL (${urls.length}): ${urls.slice(0, 10).join(", ") || "-"}`, `Email (${emails.length}): ${emails.join(", ") || "-"}`, `Hash (${hashes.length}): ${hashes.slice(0, 10).join(", ") || "-"}`].join("\n");
}

/** Save the current pentest report to .data/users/<user>/reports/<ts>.md. */
export function reportSave(rawUser: unknown): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const md = generateReport(rawUser);
  const dir = join(userDataRoot(), userKey, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `report-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
  writeFileSync(file, md);
  return `📄 Laporan disimpan: ${file}\n\n${md.slice(0, 800)}`;
}

// ── SQLi testing with sqlmap (authorized lab only) ──────────────────────────
export function sqlmapScan(url: string, opts?: { level?: number; risk?: number }): Promise<string> {
  const u = (url || "").trim();
  if (!/^https?:\/\//i.test(u)) return Promise.reject(new Error("url http(s) wajib, mis. http://localhost:8081/vulnerabilities/sqli/?id=1&Submit=Submit"));
  if (!targetAllowed(u)) return Promise.reject(new Error("SCOPE: sqlmap hanya untuk localhost/lab atau host di engagement aktif (authorization)."));
  const level = Math.min(5, Math.max(1, Number(opts?.level) || 1));
  const risk = Math.min(3, Math.max(1, Number(opts?.risk) || 1));
  const outDir = mkdtempSync(join(tmpdir(), "mia-sqlmap-"));
  return new Promise((resolve) => {
    execFile(
      "sqlmap",
      ["-u", u, "--batch", "--smart", "--level", String(level), "--risk", String(risk), "--output-dir", outDir, "--disable-coloring"],
      { timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as NodeJS.ErrnoException | null;
        if (e && e.code === "ENOENT") {
          resolve("Error: sqlmap belum terpasang — `brew install sqlmap`");
          return;
        }
        const out = `${stdout || ""}${stderr || ""}`.trim();
        resolve(`💉 sqlmap ${u}\n${out.slice(0, 6000) || "(tanpa output)"}`);
      }
    );
  });
}

// ── PDF report (markdown -> HTML -> PDF via Playwright, no new deps) ─────────
async function renderMarkdownPdf(userKey: string, md: string, prefix: string): Promise<string> {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = esc(md)
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;max-width:820px;margin:32px auto;padding:0 20px;color:#111}h1{font-size:24px}h2{font-size:18px;border-bottom:1px solid #ddd;padding-bottom:4px}h3{font-size:15px}strong{color:#000}</style></head><body>${body}</body></html>`;
  const dir = join(userDataRoot(), userKey, "reports");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: file, format: "A4", margin: { top: "18mm", bottom: "18mm", left: "16mm", right: "16mm" } });
  } finally {
    await browser.close().catch(() => {});
  }
  return `📄 PDF disimpan: ${file}`;
}

export async function reportPdf(rawUser: unknown): Promise<string> {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  return renderMarkdownPdf(userKey, generateReport(rawUser), "report");
}

export async function hardeningPdf(rawUser: unknown): Promise<string> {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  return renderMarkdownPdf(userKey, hardeningPlan(rawUser), "hardening");
}

/** Days until a host's TLS cert expires (null on failure). For security watch. */
export function tlsExpiryDays(host: string, port = 443): Promise<number | null> {
  const h = (host || "").trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const socket = tlsConnect({ host: h, port, servername: h, rejectUnauthorized: false, timeout: 8000 }, () => {
      const c = socket.getPeerCertificate();
      const to = c.valid_to ? new Date(c.valid_to).getTime() : NaN;
      resolve(Number.isNaN(to) ? null : Math.round((to - Date.now()) / 86_400_000));
      socket.end();
    });
    socket.on("timeout", () => { socket.destroy(); resolve(null); });
    socket.on("error", () => resolve(null));
  });
}

// ── Local lab lifecycle (so Mia can start its own practice target) ──────────
const LABS: Record<string, { port: number; cmd: string; args: string[] }> = {
  "vuln-node": { port: 4010, cmd: "node", args: [join(repoRoot(), "labs", "pentest", "vuln-node", "server.js")] },
};

function portListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-P", "-n"], { timeout: 5000 }, (_e, stdout) => resolve(!!stdout && stdout.includes("LISTEN")));
  });
}

export async function labStatus(): Promise<string> {
  const rows: string[] = [];
  for (const [name, spec] of Object.entries(LABS)) {
    rows.push(`• ${name} (:${spec.port}) — ${(await portListening(spec.port)) ? "UP ✅" : "down"}`);
  }
  // Docker lab (optional) ports
  for (const [n, p] of [["juice-shop", 3001], ["dvwa", 8081], ["webgoat", 8082]] as [string, number][]) {
    if (await portListening(p)) rows.push(`• ${n} (:${p}) — UP (docker)`);
  }
  return `🧪 LAB STATUS\n${rows.join("\n")}\n\nNyalakan: lab_start name="vuln-node" (tanpa Docker).`;
}

export async function labStart(name = "vuln-node"): Promise<string> {
  const spec = LABS[name];
  if (!spec) return `Error: lab "${name}" tak dikenal (pilih: ${Object.keys(LABS).join(", ")})`;
  if (await portListening(spec.port)) return `✅ Lab ${name} sudah jalan di http://127.0.0.1:${spec.port}`;
  const { spawn } = await import("node:child_process");
  const dir = join(appRoot(), ".data", "labs");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, `${name}.log`);
  const out = (await import("node:fs")).openSync(logPath, "a");
  const child = spawn(spec.cmd, spec.args, { detached: true, stdio: ["ignore", out, out] });
  child.unref();
  writeFileSync(join(dir, `${name}.pid`), String(child.pid ?? ""));
  await new Promise((r) => setTimeout(r, 1200));
  const up = await portListening(spec.port);
  return up
    ? `✅ Lab ${name} jalan di http://127.0.0.1:${spec.port} (pid ${child.pid}, log ${logPath})`
    : `⚠️ Lab ${name} dijalankan (pid ${child.pid}) tapi port ${spec.port} belum listen — cek ${logPath}`;
}

export async function labStop(name = "vuln-node"): Promise<string> {
  const spec = LABS[name];
  if (!spec) return `Error: lab "${name}" tak dikenal`;
  const pidFile = join(appRoot(), ".data", "labs", `${name}.pid`);
  try {
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    if (pid > 1) process.kill(pid, "SIGKILL");
    return `🛑 Lab ${name} dihentikan (pid ${pid})`;
  } catch {
    return `ℹ️ Tak ada pid tercatat untuk ${name} (mungkin sudah mati).`;
  }
}

/**
 * Fetch a LAB/authorized URL (localhost/private/permitted) — bypasses the
 * public-only SSRF guard of `fetch_url`/`browser_*` so Mia can see a local
 * target's response (e.g. verify a reflected payload). Refuses public hosts.
 */
export async function labFetch(url: string): Promise<string> {
  const raw = (url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: URL harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — lab_fetch hanya untuk localhost/lab atau host di engagement aktif.";
  const res = await fetch(raw, { redirect: "manual", headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(10_000) });
  const ct = res.headers.get("content-type") || "";
  const body = (await res.text()).slice(0, 2000);
  const flag = /<script\b|onerror\s*=|onload\s*=|javascript:/i.test(body) ? "\n⚠️ Body mengandung markup/JS — indikasi XSS bila input user ter-reflect mentah." : "";
  return `🌐 LAB FETCH ${res.status} ${res.statusText} (${ct})\nLocation: ${res.headers.get("location") || "-"}${flag}\n\n${body}`;
}

// ── Dependency CVE audit (OSV, keyless) ─────────────────────────────────────
export type Dep = { name: string; version: string; ecosystem: string };

/** Parse an npm package-lock.json (v1 nested deps or v2/v3 packages map). */
export function parseNpmLock(text: string): Dep[] {
  const out: Dep[] = [];
  try {
    const j = JSON.parse(text) as { packages?: Record<string, { name?: string; version?: string }>; dependencies?: Record<string, { version?: string; dependencies?: unknown }> };
    if (j.packages && typeof j.packages === "object") {
      for (const [k, v] of Object.entries(j.packages)) {
        if (!k) continue;
        if (v && typeof v.version === "string") {
          const name = v.name || k.replace(/^.*node_modules\//, "");
          if (name) out.push({ name, version: v.version, ecosystem: "npm" });
        }
      }
    } else if (j.dependencies) {
      const walk = (deps: Record<string, { version?: string; dependencies?: unknown }>) => {
        for (const [n, v] of Object.entries(deps)) {
          if (v && v.version) out.push({ name: n, version: String(v.version), ecosystem: "npm" });
          if (v && v.dependencies && typeof v.dependencies === "object") walk(v.dependencies as Record<string, { version?: string; dependencies?: unknown }>);
        }
      };
      walk(j.dependencies);
    }
  } catch {
    /* ignore */
  }
  return out;
}

/** Parse a Python requirements.txt (pkg==version lines). */
export function parseRequirements(text: string): Dep[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const m = l.match(/^([A-Za-z0-9_.-]+)\s*==\s*([0-9][\w.\-]*)/);
      return m ? { name: m[1], version: m[2], ecosystem: "PyPI" } : null;
    })
    .filter((d): d is Dep => !!d);
}

function cmpVer(a: string, b: string): number {
  const norm = (v: string) => v.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const A = norm(a), B = norm(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? 0, y = B[i] ?? 0;
    if (x === y) continue;
    if (typeof x === "number" && typeof y === "number") return x - y;
    return String(x) > String(y) ? 1 : -1;
  }
  return 0;
}
function nearestFixed(fixed: string[] | undefined, current: string): string | null {
  if (!fixed?.length) return null;
  const above = fixed.filter((f) => cmpVer(f, current) > 0).sort(cmpVer);
  return above[0] ?? null;
}

export async function depAudit(dirRel = "", toFindingsUser?: unknown): Promise<string> {
  const root = dirRel.trim() ? resolveInSandbox(dirRel.trim()) : repoRoot();
  if (!root) throw new Error("path di luar sandbox / tidak valid");
  const deps: Dep[] = [];
  const sources: string[] = [];
  const lock = join(root, "package-lock.json");
  if (existsSync(lock)) {
    deps.push(...parseNpmLock(readFileSync(lock, "utf8")));
    sources.push("package-lock.json");
  }
  const req = join(root, "requirements.txt");
  if (existsSync(req)) {
    deps.push(...parseRequirements(readFileSync(req, "utf8")));
    sources.push("requirements.txt");
  }
  if (!deps.length) return `Tidak menemukan package-lock.json / requirements.txt di ${dirRel || "repo root"} — tak ada yang bisa diaudit.`;
  // dedup by ecosystem:name@version
  const seen = new Set<string>();
  const uniq = deps.filter((d) => {
    const k = `${d.ecosystem}:${d.name}@${d.version}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const batch = uniq.slice(0, 500).map((d) => ({ version: d.version, package: { name: d.name, ecosystem: d.ecosystem } }));
  const res = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "mia-assistant/1.0" },
    body: JSON.stringify({ queries: batch }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return `Error: OSV tidak bisa diakses (HTTP ${res.status})`;
  const data = (await res.json()) as { results?: { vulns?: { id: string }[] }[] };
  const results = data.results ?? [];
  const found: { dep: Dep; ids: string[] }[] = [];
  results.forEach((r, i) => {
    if (r.vulns?.length) found.push({ dep: uniq[i], ids: r.vulns.map((v) => v.id) });
  });
  if (!found.length) return `✅ Dependency audit (${sources.join(", ")}, ${uniq.length} paket): tidak ada CVE dikenal (OSV).`;
  // fetch details for up to 30 unique vuln ids
  const ids = [...new Set(found.flatMap((f) => f.ids))].slice(0, 30);
  const detail = new Map<string, { summary: string; severity: string; fixed: string[] }>();
  await Promise.all(
    ids.map(async (vid) => {
      try {
        const r = await fetch(`https://api.osv.dev/v1/vulns/${encodeURIComponent(vid)}`, { headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(12_000) });
        if (!r.ok) return;
        const j = (await r.json()) as { summary?: string; database_specific?: { severity?: string }; affected?: { ranges?: { events?: { fixed?: string }[] }[] }[] };
        const fixed: string[] = [];
        for (const a of j.affected || []) for (const rg of a.ranges || []) for (const ev of rg.events || []) if (ev.fixed) fixed.push(ev.fixed);
        detail.set(vid, { summary: j.summary || "", severity: (j.database_specific?.severity || "").toLowerCase(), fixed });
      } catch {
        /* best-effort */
      }
    })
  );
  if (toFindingsUser) {
    // Dedup: don't re-add a finding that already exists (same dep target + advisory).
    const seenKeys = new Set(readFindings(toFindingsUser).map((e) => `${e.target}|${e.evidence}`));
    for (const f of found) {
      for (const vid of f.ids.slice(0, 3)) {
        const key = `${f.dep.ecosystem}:${f.dep.name}@${f.dep.version}|${vid}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const d = detail.get(vid);
        const fix = nearestFixed(d?.fixed, f.dep.version);
        addFinding(toFindingsUser, {
          title: `${f.dep.name}@${f.dep.version} — ${vid}`,
          severity: d?.severity && ["critical", "high", "medium", "low"].includes(d.severity) ? d.severity : "medium",
          owasp: "A06:2021 Vulnerable and Outdated Components",
          target: `${f.dep.ecosystem}:${f.dep.name}@${f.dep.version}`,
          evidence: vid,
          impact: d?.summary || "komponen rentan",
          remediation: fix ? `Upgrade ${f.dep.name} ke >= ${fix} (versi aman terdekat).` : `Upgrade ${f.dep.name} ke versi tanpa ${vid} (cek OSV).`,
        });
      }
    }
  }
  const lines = found.slice(0, 40).map((f) => {
    const fix = nearestFixed(f.ids.flatMap((id) => detail.get(id)?.fixed || []), f.dep.version);
    return `• ${f.dep.name}@${f.dep.version}${fix ? ` → upgrade >= ${fix}` : ""} — ${f.ids.map((id) => `${id}${detail.get(id)?.severity ? ` (${detail.get(id)!.severity})` : ""}`).join(", ")}`;
  });
  return `🔎 DEP AUDIT (${sources.join(", ")}, ${uniq.length} paket) — ${found.length} paket rentan:\n${lines.join("\n")}${toFindingsUser ? "\n\n(Temuan ditambahkan ke board.)" : ""}`;
}

/** Prioritized remediation plan derived from the recorded findings (by CVSS). */
export function hardeningPlan(rawUser: unknown): string {
  const rows = readFindings(rawUser);
  if (!rows.length) return "Belum ada temuan — tidak ada rencana perbaikan.";
  const sorted = [...rows].sort((a, b) => (b.cvss ?? 0) - (a.cvss ?? 0));
  const summary = SEVERITIES.map((s) => `${s} ${rows.filter((r) => r.severity === s).length}`).join(" | ");
  const lines = sorted.slice(0, 30).map(
    (f, i) => `${i + 1}. [${f.severity.toUpperCase()}${f.cvss != null ? ` · CVSS ${f.cvss}` : ""}] ${f.title}${f.target ? ` — ${f.target}` : ""}\n   → ${f.remediation || "perbaiki sesuai kategori " + (f.owasp || "-")}`
  );
  const rest = rows.length > 30 ? `\n… dan ${rows.length - 30} temuan lain.` : "";
  return `🛠️ HARDENING PLAN (prioritas CVSS)\nRingkasan: ${summary} | total ${rows.length}\n\n${lines.join("\n")}${rest}`;
}

/** Mark a finding resolved (drops from open lists + the report). */
export function resolveFinding(rawUser: unknown, id: string): boolean {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const rows = readFindings(rawUser);
  const f = rows.find((r) => r.id === id);
  if (!f) return false;
  f.status = "resolved";
  f.resolvedAt = new Date().toISOString();
  writeFindings(userKey, rows);
  return true;
}

/** Export open findings as CSV / JSON / SARIF to .data/users/<user>/reports/. */
export function exportFindings(rawUser: unknown, format = "csv"): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const rows = readFindings(rawUser).filter((r) => r.status !== "resolved");
  if (!rows.length) return "Tidak ada temuan terbuka untuk diexport.";
  const dir = join(userDataRoot(), userKey, "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fmt = format.toLowerCase();
  let content: string;
  let ext: string;
  if (fmt === "json") {
    content = JSON.stringify(rows, null, 2);
    ext = "json";
  } else if (fmt === "sarif") {
    const rules = [...new Set(rows.map((r) => r.owasp || r.cwe || "generic"))].map((id) => ({ id, name: id }));
    const level = (sv: string) => (sv === "critical" || sv === "high" ? "error" : sv === "medium" ? "warning" : "note");
    content = JSON.stringify(
      {
        version: "2.1.0",
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        runs: [
          {
            tool: { driver: { name: "Mia Pentest", informationUri: "https://opencode.ai", rules } },
            results: rows.map((r) => ({
              ruleId: r.owasp || r.cwe || "generic",
              level: level(r.severity),
              message: { text: `[${r.severity.toUpperCase()}${r.cvss != null ? ` CVSS ${r.cvss}` : ""}] ${r.title}${r.evidence ? ` — ${r.evidence.slice(0, 200)}` : ""}` },
              locations: [{ physicalLocation: { artifactLocation: { uri: r.target || "unknown" } } }],
            })),
          },
        ],
      },
      null,
      2
    );
    ext = "sarif";
  } else {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const cols = ["id", "severity", "cvss", "title", "owasp", "cwe", "target", "status", "evidence", "impact", "remediation"];
    content = [cols.join(","), ...rows.map((r) => cols.map((c) => esc((r as unknown as Record<string, unknown>)[c])).join(","))].join("\n");
    ext = "csv";
  }
  const file = join(dir, `findings-${stamp}.${ext}`);
  writeFileSync(file, content);
  return `📤 Export (${fmt}) ${rows.length} temuan → ${file}`;
}

/** CVSS v3.1 base score from a vector string. */
export function cvssScore(vector: string): string {
  const v = (vector || "").trim().toUpperCase();
  const get = (m: string) => new RegExp(`(?:^|/)${m}:([A-Z])`).exec(v)?.[1];
  const AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }[get("AV") ?? ""] ?? NaN;
  const AC = { L: 0.77, H: 0.44 }[get("AC") ?? ""] ?? NaN;
  const UI = { N: 0.85, R: 0.62 }[get("UI") ?? ""] ?? NaN;
  const S = get("S");
  const PRU = { N: 0.85, L: 0.62, H: 0.27 }[get("PR") ?? ""] ?? NaN;
  const PRC = { N: 0.85, L: 0.68, H: 0.5 }[get("PR") ?? ""] ?? NaN;
  const C = { N: 0, L: 0.22, H: 0.56 }[get("C") ?? ""] ?? NaN;
  const I = { N: 0, L: 0.22, H: 0.56 }[get("I") ?? ""] ?? NaN;
  const A = { N: 0, L: 0.22, H: 0.56 }[get("A") ?? ""] ?? NaN;
  if ([AV, AC, UI, C, I, A].some((n) => Number.isNaN(n)) || (S !== "U" && S !== "C")) {
    return "Error: vektor CVSS v3.1 tak valid. Contoh: CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H";
  }
  const PR = S === "C" ? PRC : PRU;
  if (Number.isNaN(PR)) return "Error: metric PR tak valid (N/L/H).";
  const iss = 1 - (1 - C) * (1 - I) * (1 - A);
  const impact = S === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);
  const expl = 8.22 * AV * AC * PR * UI;
  const roundup = (x: number) => Math.ceil(x * 10) / 10;
  const score = impact <= 0 ? 0 : roundup(Math.min((S === "U" ? 1 : 1.08) * (impact + expl), 10));
  const sev = score === 0 ? "none" : score < 4 ? "low" : score < 7 ? "medium" : score < 9 ? "high" : "critical";
  return `📊 CVSS v3.1 base score: ${score.toFixed(1)} (${sev})\nVector: ${v}`;
}

/** Parse a dependency finding's target/remediation (name, installed ver, fixed ver). */
export function parseDepFinding(f: Finding): { name: string; fixed: string | null } | null {
  const m = /^([a-z]+):(.+)@([^@]+)$/i.exec(f.target || "");
  if (!m) return null;
  const fixed = (/>=?\s*([0-9][\w.-]*)/.exec(f.remediation || "") || [])[1] ?? null;
  return { name: m[2].toLowerCase(), fixed };
}

/** Check installed dependency versions vs each dep finding's fixed version. */
export function verifyPatch(rawUser: unknown, dirRel = "", apply = false): string {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const root = dirRel.trim() ? resolveInSandbox(dirRel.trim()) : repoRoot();
  if (!root) throw new Error("path di luar sandbox");
  const lock = join(root, "package-lock.json");
  if (!existsSync(lock)) return `Tidak ada package-lock.json di ${dirRel || "repo root"}.`;
  const installed = parseNpmLock(readFileSync(lock, "utf8"));
  const rows = readFindings(rawUser).filter((r) => r.status !== "resolved" && (r.owasp || "").includes("A06"));
  if (!rows.length) return "Tidak ada temuan dependency (A06) terbuka.";
  const patched: string[] = [];
  const still: string[] = [];
  const unknown: string[] = [];
  for (const f of rows) {
    const d = parseDepFinding(f);
    if (!d || !d.fixed) {
      unknown.push(`${f.id} ${f.target}`);
      continue;
    }
    const vers = installed.filter((x) => x.name.toLowerCase() === d.name).map((x) => x.version);
    if (!vers.length) {
      unknown.push(`${f.id} ${d.name} (tak ada di lock)`);
      continue;
    }
    const ok = vers.every((v) => cmpVer(v, d.fixed!) >= 0);
    if (ok) {
      patched.push(`${f.id} ${d.name}@${vers.join(",")} >= ${d.fixed}`);
      if (apply) resolveFinding(rawUser, f.id);
    } else {
      still.push(`${f.id} ${d.name}@${vers.join(",")} < ${d.fixed}`);
    }
  }
  const head = `🧩 VERIFY PATCH${apply ? " (apply)" : ""}: ${patched.length} sudah patched, ${still.length} masih rentan, ${unknown.length} tak bisa diverifikasi.`;
  const parts = [head];
  if (patched.length) parts.push(`✅ Sudah >= fixed${apply ? " → resolved" : ""}:\n${patched.map((x) => "• " + x).join("\n")}`);
  if (still.length) parts.push(`⚠️ Masih rentan (upgrade belum jalan):\n${still.map((x) => "• " + x).join("\n")}`);
  if (unknown.length) parts.push(`❓ Tak terverifikasi:\n${unknown.map((x) => "• " + x).join("\n")}`);
  return parts.join("\n\n");
}
