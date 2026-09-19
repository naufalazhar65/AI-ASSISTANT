// Learning from disclosed reports — Mia gets smarter from real-world
// writeups. `learning_ingest` takes a disclosed report (pasted text or a
// public URL), extracts structured patterns (vuln class, target tech,
// endpoint style, the bypass trick, root cause), and stores them per user.
// `learning_query` matches the current target's tech/endpoint style against
// stored patterns so the agent gets "target seperti ini biasanya kena X via Y"
// hints BEFORE hunting.
//
// Boundary: stores PATTERNS (no credentials, no victim data, capped text).
// Store: .data/users/<user>/learnings-security.json (atomic, capped).
// Pure helpers exported for unit tests.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

export type LearnPattern = {
  id: string;
  title: string;
  /** vuln class, e.g. "idor", "ssrf", "auth-bypass", "race" */
  vulnClass: string;
  /** target tech when mentioned (e.g. "laravel", "nextjs", "aws s3") */
  tech: string;
  /** endpoint style hint (e.g. "/api/v1/orders/{id}") */
  endpointStyle: string;
  /** the actual trick that made it work */
  trick: string;
  /** detection idea — how Mia could have found it */
  detection: string;
  source: string;
  at: string;
};

const MAX_PATTERNS = 200;
const MAX_FIELD = 400;
const UA = "mia-assistant/1.0";

function storePath(rawUser: unknown): string {
  const user = sanitizeUser(rawUser) ?? "shared";
  return join(userDataRoot(), user, "learnings-security.json");
}

function read(rawUser: unknown): LearnPattern[] {
  try {
    const p = storePath(rawUser);
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, "utf8")) as unknown;
    return Array.isArray(j) ? (j as LearnPattern[]).filter((p) => p && typeof p.title === "string") : [];
  } catch {
    return [];
  }
}

function write(rawUser: unknown, rows: LearnPattern[]): void {
  const p = storePath(rawUser);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify(rows.slice(0, MAX_PATTERNS), null, 2));
  renameSync(tmp, p);
}

const KNOWN_CLASSES = ["idor", "bola", "ssrf", "xss", "sqli", "auth-bypass", "jwt", "race", "xxe", "ssti", "rce", "lfi", "open-redirect", "csrf", "prototype-pollution", "web-cache", "upload", "graphql", "oauth", "mass-assignment", "subdomain-takeover", "info-disclosure"];

/** Vuln class from free text (title + body). Pure — tested. */
export function learnClassify(text: string): string {
  const t = (text || "").toLowerCase();
  const pairs: [string, RegExp][] = [
    ["idor", /\bido?r\b|insecure direct object/],
    ["bola", /\bbola\b|broken object level/],
    ["ssrf", /\bssrf\b|server[- ]side request forgery/],
    ["xss", /\bxss\b|cross[- ]site scripting/],
    ["sqli", /\bsql[ -]?i\b|sql injection/],
    // jwt BEFORE generic auth-bypass so "JWT authentication bypass" classifies
    // as jwt (the token class is the actionable detail).
    ["jwt", /\bjwt\b|json web token|alg\s*[:=]?\s*none/],
    ["auth-bypass", /auth(?:orization|entication)? bypass|access control/],
    ["race", /race condition|toctou/],
    ["ssti", /\bssti\b|template injection/],
    ["rce", /\brce\b|remote code execution/],
    ["open-redirect", /open redirect/],
    ["prototype-pollution", /prototype pollution/],
    ["web-cache", /web cache (?:poison|decept)/],
    ["graphql", /graphql/],
    ["oauth", /\boauth\b|openid connect/],
    ["mass-assignment", /mass assignment/],
    ["subdomain-takeover", /subdomain takeover|dangling (?:cname|dns)/],
    ["info-disclosure", /information disclosure|info disclosure|exposed (?:env|credentials|debug)/],
  ];
  for (const [cls, re] of pairs) if (re.test(t)) return cls;
  return "info-disclosure";
}

/** Best-effort tech mention. Pure — tested. */
export function learnTech(text: string): string {
  const t = (text || "").toLowerCase();
  const techs = ["laravel", "django", "nextjs", "next.js", "react", "vue", "express", "spring", "rails", "flask", "fastapi", "wordpress", "aws", "gcp", "azure", "cloudflare", "kubernetes", "nginx", "apache", "graphql", "supabase", "firebase", "auth0"];
  const hits = techs.filter((x) => t.includes(x));
  return hits.slice(0, 3).join(", ");
}

/** First endpoint-like token in the text. Pure — tested. */
export function learnEndpointStyle(text: string): string {
  const m = (text || "").match(/(?:https?:\/\/[^\s"'()]+|(?:\/[A-Za-z0-9_\-./]{2,}))/);
  return (m?.[0] || "").slice(0, MAX_FIELD);
}

/** Extract one pattern from a report text. Pure — tested. */
export function learnExtract(text: string, source: string): LearnPattern | null {
  const clean = (text || "").replace(/\r/g, "").trim();
  if (clean.length < 40) return null;
  const title = clean.split("\n").find((l) => l.trim().length > 8)?.trim().slice(0, 160) || "Disclosed report";
  const trickM = clean.match(/(?:bypass|trick|payload|impact|how it works?|root cause)[:\s]\s*([^\n]{20,})/i);
  const detM = clean.match(/(?:detection|how (?:to|could) (?:find|detect)|remediat\w+)[:\s]\s*([^\n]{20,})/i);
  return {
    id: `L-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    title,
    vulnClass: learnClassify(`${title}\n${clean.slice(0, 2000)}`),
    tech: learnTech(clean),
    endpointStyle: learnEndpointStyle(clean),
    trick: (trickM?.[1] || clean.slice(0, MAX_FIELD)).slice(0, MAX_FIELD),
    detection: (detM?.[1] || "").slice(0, MAX_FIELD),
    source: source.slice(0, 200),
    at: new Date().toISOString(),
  };
}

/** Ingest from pasted text or a public URL. */
export async function learningIngest(rawUser: unknown, opts: { text?: string; url?: string; title?: string }): Promise<string> {
  let text = (opts.text || "").trim();
  let source = "paste";
  if (!text && opts.url) {
    const url = opts.url.trim();
    if (!/^https?:\/\//i.test(url)) return "Error: url harus http(s).";
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) return `Error: fetch → ${res.status}`;
      const html = await res.text();
      // Strip tags crudely; cap to keep the store small.
      text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 8000);
      source = url;
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : "fetch failed"}`;
    }
  }
  if (!text) return "Error: butuh `text` (isi report) atau `url` (artikel publik).";
  const pat = learnExtract(opts.title ? `${opts.title}\n${text}` : text, source);
  if (!pat) return "Error: teks terlalu pendek untuk diekstrak jadi pattern (min ~40 char).";
  const rows = read(rawUser);
  // Dedup: same vulnClass + very similar title.
  const dup = rows.find((r) => r.vulnClass === pat.vulnClass && r.title.toLowerCase().slice(0, 80) === pat.title.toLowerCase().slice(0, 80));
  if (dup) return `Sudah ada pattern serupa: ${dup.id} (${dup.title.slice(0, 80)}) — skip.`;
  rows.unshift(pat);
  write(rawUser, rows);
  return `📚 Pattern tersimpan ${pat.id} [${pat.vulnClass}]${pat.tech ? ` tech: ${pat.tech}` : ""}\nTitle: ${pat.title}\nTrick: ${pat.trick.slice(0, 160)}${pat.detection ? `\nDetection: ${pat.detection.slice(0, 160)}` : ""}\n\nTotal pattern: ${rows.length}. Gunakan learning_query tech=<tech> saat mulai hunt target serupa.`;
}

/** Query stored patterns against the current target. */
export function learningQuery(rawUser: unknown, opts: { query?: string; vuln_class?: string } = {}): string {
  const rows = read(rawUser);
  if (!rows.length) return "Belum ada pattern tersimpan. Ingest dari writeup: learning_ingest url=<artikel disclosed> atau text=<isi report>.";
  const q = (opts.query || "").toLowerCase();
  const qTokens = q.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
  const scored = rows
    .map((r) => {
      let s = 0;
      const hay = `${r.tech} ${r.endpointStyle} ${r.title}`.toLowerCase();
      for (const t of qTokens) if (hay.includes(t)) s += 2;
      if (opts.vuln_class && r.vulnClass === opts.vuln_class) s += 3;
      return { r, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, 8);
  if (!scored.length) {
    const top = rows.slice(0, 6);
    return `📚 Tidak ada pattern yang cocok dengan "${opts.query || opts.vuln_class || ""}". Pattern terbaru:\n${top.map((r) => `• [${r.vulnClass}] ${r.title.slice(0, 90)}${r.tech ? ` — ${r.tech}` : ""}`).join("\n")}`;
  }
  return `📚 Pattern cocok (${scored.length}):\n${scored.map(({ r }) => `• [${r.vulnClass}] ${r.title.slice(0, 100)}\n   tech: ${r.tech || "—"} | endpoint: ${r.endpointStyle.slice(0, 80) || "—"}\n   trick: ${r.trick.slice(0, 140)}${r.detection ? `\n   detection: ${r.detection.slice(0, 140)}` : ""}`).join("\n")}`;
}

export function learningStatsText(rawUser: unknown): string {
  const rows = read(rawUser);
  if (!rows.length) return "Belum ada pattern security learning.";
  const byClass = new Map<string, number>();
  for (const r of rows) byClass.set(r.vulnClass, (byClass.get(r.vulnClass) || 0) + 1);
  const classes = KNOWN_CLASSES.filter((c) => byClass.has(c));
  return `📚 Security learnings: ${rows.length} pattern\n${classes.map((c) => `• ${c}: ${byClass.get(c)}`).join("\n")}\n\nQuery: learning_query query=<tech/host style> vuln_class=<kelas>.`;
}
