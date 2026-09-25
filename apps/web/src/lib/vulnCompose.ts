// vulnCompose.ts — cross-class chain composer (vuln_compose).
//
// Takes >=2 PROVEN (open + evidenced) findings on ONE host and tries to link
// them into a single end-to-end chain: output-A → input-B. A hop is real only
// when both findings share the host AND share a concrete artifact (endpoint
// path, query param, token/session value, object id) found deterministically
// in their evidence/steps — never a narrated "could be combined". Each hop
// with a replayable URL is re-verified with pocVerify; the composite critical
// finding is created ONLY when every hop proves. Honest verdicts:
//
//   ✅ CHAIN TERBUKTI PENUH — every hop replayed STABIL, composite finding filed.
//   ⚠️ PUTUS DI HOP n     — hop n failed replay, no composite finding.
//   ⛔ TAK TERSAMBUNG      — no shared artifact between findings.
//
// Scope-gated (targetAllowed) on every replay URL. Bounded (<=6 findings,
// <=5 hops, pocVerify times=2). Write — confirm.

import { addFinding, readFindings, targetAllowed, type Finding } from "./security";
import { pocVerify } from "./poc";

export type ComposeHop = {
  fromId: string;
  toId: string;
  kind: "endpoint" | "param" | "token" | "object-id" | "host-only";
  shared: string[];
  replayUrl?: string;
  proven?: boolean;
  note?: string;
};

const MAX_FINDINGS = 6;
const MAX_SHARED = 5;

function firstHttpUrl(text: string): string {
  const m = /https?:\/\/[^\s"'`<>\]]+/i.exec(text || "");
  return m ? m[0].replace(/[).,;]+$/, "") : "";
}

function hostOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Hostname of a finding: first http(s) URL in target → evidence → steps. Pure. */
export function findingHost(f: Finding): string {
  for (const field of [f.target, f.evidence, f.steps]) {
    const u = firstHttpUrl(field || "");
    if (u) {
      const h = hostOfUrl(u);
      if (h) return h;
    }
  }
  return "";
}

export type FindingSignals = { urls: string[]; paths: string[]; params: string[]; tokens: string[]; ids: string[] };

/** Deterministic artifact signals scraped from a finding's text. Pure. */
export function extractSignals(f: Finding): FindingSignals {
  const text = [f.target, f.evidence, f.steps, f.title].filter(Boolean).join("\n");
  const urls = [...new Set([...(text.match(/https?:\/\/[^\s"'`<>\]]+/gi) || [])].map((u) => u.replace(/[).,;]+$/, "").slice(0, 200)))].slice(0, 12);
  const paths = [...new Set(urls.map((u) => { try { return new URL(u).pathname; } catch { return ""; } }).filter((p) => p && p !== "/"))].slice(0, 12);
  const params = [...new Set([...(text.match(/[?&]([A-Za-z_][A-Za-z0-9_]{0,30})=/g) || [])].map((m) => m.slice(1, -1).toLowerCase()))].slice(0, 12);
  const tokens = [...new Set([...(text.match(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) || []),
    ...(text.match(/(?:session|sid|token|auth)[=:]["']?([A-Za-z0-9_-]{10,80})/gi) || []).map((m) => m.slice(-24))])].slice(0, 6);
  const ids = [...new Set([...(text.match(/\b(?:id|user_id|doc|order|invoice)[=:\"'\s]+([A-Za-z0-9_-]{1,40})/gi) || [])].map((m) => m.toLowerCase().slice(0, 48)))].slice(0, 8);
  return { urls, paths, params, tokens, ids };
}

function intersect(a: string[], b: string[]): string[] {
  const setB = new Set(b.map((s) => s.toLowerCase()));
  return [...new Set(a)].filter((s) => setB.has(s.toLowerCase())).slice(0, MAX_SHARED);
}

/**
 * Link finding A → finding B. Returns a hop only when both share the host AND
 * share >=1 concrete artifact. Pure.
 */
export function composeHop(a: Finding, b: Finding): ComposeHop | null {
  const ha = findingHost(a);
  const hb = findingHost(b);
  if (!ha || ha !== hb) return null;
  const sa = extractSignals(a);
  const sb = extractSignals(b);
  const sharedPaths = intersect(sa.paths, sb.paths);
  const sharedParams = intersect(sa.params, sb.params);
  const sharedTokens = intersect(sa.tokens, sb.tokens);
  const sharedIds = intersect(sa.ids, sb.ids);
  let kind: ComposeHop["kind"] = "host-only";
  let shared: string[] = [];
  if (sharedTokens.length) { kind = "token"; shared = sharedTokens; }
  else if (sharedIds.length) { kind = "object-id"; shared = sharedIds; }
  else if (sharedParams.length) { kind = "param"; shared = sharedParams; }
  else if (sharedPaths.length) { kind = "endpoint"; shared = sharedPaths; }
  if (kind === "host-only") return null;
  const replayUrl = firstHttpUrl(b.evidence || "") || firstHttpUrl(b.steps || "") || firstHttpUrl(b.target || "") || undefined;
  return { fromId: a.id, toId: b.id, kind, shared, replayUrl };
}

/** Chain consecutive same-host findings (oldest first) into hop candidates. Pure. */
export function composeHops(findings: Finding[]): ComposeHop[] {
  const sorted = [...findings].sort((x, y) => (x.createdAt < y.createdAt ? -1 : 1));
  const hops: ComposeHop[] = [];
  for (let i = 0; i + 1 < sorted.length && hops.length < MAX_SHARED; i++) {
    const hop = composeHop(sorted[i], sorted[i + 1]);
    if (hop) hops.push(hop);
  }
  return hops;
}

export type ComposeVerdict = "TERBUKTI PENUH" | "PUTUS" | "TAK TERSAMBUNG";

/** Honest verdict from hop replay results. Pure. */
export function composeVerdict(hops: ComposeHop[]): { verdict: ComposeVerdict; brokenAt: number } {
  if (!hops.length) return { verdict: "TAK TERSAMBUNG", brokenAt: -1 };
  const brokenAt = hops.findIndex((h) => h.proven !== true);
  if (brokenAt === -1) return { verdict: "TERBUKTI PENUH", brokenAt: -1 };
  return { verdict: "PUTUS", brokenAt };
}

export function isPocStable(report: string): boolean {
  // Accepts the vuln verdict ("✅ PoC STABIL …") and the reproducibility verdict
  // ("🔄 PoC ULANG STABIL …") — but NEVER the ⛔ identical-to-baseline line, so a
  // payload that changed nothing can never make a compose hop "proven".
  return /PoC (?:ULANG )?STABIL/.test(report || "");
}

/**
 * Compose proven findings on one host into a single E2E chain.
 * Scope-gated, bounded. Creates the composite critical finding ONLY on
 * TERBUKTI PENUH — otherwise answers honestly with the break point.
 */
export async function vulnCompose(
  rawUser: unknown,
  opts: { target?: string; finding_ids?: string[] } = {}
): Promise<string> {
  const all = readFindings(rawUser).filter((f) => f.status === "open" && (f.evidence || "").trim());
  if (!all.length) return "⛔ vuln_compose: belum ada temuan PROVEN (open + evidence) — buktikan dulu via poc_verify → finding_add.";
  let pool = all;
  const wantIds = (opts.finding_ids || []).map((s) => String(s).trim()).filter(Boolean);
  if (wantIds.length) {
    pool = all.filter((f) => wantIds.includes(f.id));
    if (pool.length < wantIds.length) {
      const missing = wantIds.filter((id) => !pool.some((f) => f.id === id));
      return `⛔ vuln_compose: finding tidak dikenal/belum proven: ${missing.join(", ")}.`;
    }
  } else if (opts.target) {
    const wantHost = hostOfUrl(opts.target) || opts.target.toLowerCase();
    pool = all.filter((f) => findingHost(f) === wantHost);
    if (!pool.length) return `⛔ vuln_compose: tidak ada temuan proven untuk host "${opts.target}".`;
  } else {
    // Group by host, take the largest group.
    const byHost = new Map<string, Finding[]>();
    for (const f of all) {
      const h = findingHost(f);
      if (!h) continue;
      if (!byHost.has(h)) byHost.set(h, []);
      byHost.get(h)!.push(f);
    }
    let best: Finding[] = [];
    for (const g of byHost.values()) if (g.length > best.length) best = g;
    pool = best;
  }
  pool = pool.slice(0, MAX_FINDINGS);
  if (pool.length < 2) return `⛔ vuln_compose: butuh ≥2 temuan proven pada satu host (ketemu ${pool.length}) — chain butuh minimal 2 hop.`;
  const host = findingHost(pool[0]);
  const hops = composeHops(pool);
  if (!hops.length) {
    return `⛔ vuln_compose TAK TERSAMBUNG — ${pool.length} temuan di ${host} tidak berbagi artefak konkret (endpoint/param/token/object-id). Chain lintas-kelas butuh output-A → input-B yang nyata, bukan narasi.`;
  }
  const lines: string[] = [`⛓️ VULN COMPOSE — ${host} (${pool.length} temuan, ${hops.length} hop kandidat)`];
  for (let i = 0; i < hops.length; i++) {
    const h = hops[i];
    const from = pool.find((f) => f.id === h.fromId);
    const to = pool.find((f) => f.id === h.toId);
    lines.push(`\n[hop ${i + 1}] "${(from?.title || h.fromId).slice(0, 80)}" → "${(to?.title || h.toId).slice(0, 80)}"`);
    lines.push(`   relasi: ${h.kind} — berbagi: ${h.shared.join(", ")}`);
    if (!h.replayUrl) {
      h.proven = false;
      h.note = "tak ada URL replay di evidence";
      lines.push(`   ⛔ hop tidak bisa di-replay (tak ada URL di evidence) — dianggap PUTUS.`);
      continue;
    }
    if (!targetAllowed(h.replayUrl)) {
      h.proven = false;
      h.note = "replay URL di luar scope";
      lines.push(`   ⛔ SCOPE — replay URL di luar lab/engagement — dianggap PUTUS.`);
      continue;
    }
    try {
      // reproducible_only: this hop asks whether the chain step reproduces, not
      // whether a new vulnerability exists (that was proven when it was recorded).
      const rep = await pocVerify(rawUser, { url: h.replayUrl, times: 2, reproducible_only: true });
      h.proven = isPocStable(rep);
      h.note = h.proven ? "replay STABIL" : "replay tidak stabil";
      lines.push(h.proven ? `   ✅ hop TERBUKTI (replay STABIL ×2)` : `   ❌ hop GAGAL replay — dianggap PUTUS.`);
    } catch (e) {
      h.proven = false;
      h.note = e instanceof Error ? e.message : String(e);
      lines.push(`   ❌ hop error (${h.note}) — dianggap PUTUS.`);
    }
  }
  const { verdict, brokenAt } = composeVerdict(hops);
  if (verdict !== "TERBUKTI PENUH") {
    lines.push(`\n⚠️ VULN COMPOSE PUTUS DI HOP ${brokenAt + 1} — tidak ada temuan komposit yang dibuat. Perbaiki hop itu (poc_verify manual) lalu ulangi.`);
    return lines.join("\n");
  }
  const chainTitles = pool.map((f) => f.title);
  const comp = addFinding(rawUser, {
    title: `CHAIN E2E: ${chainTitles.map((t) => t.slice(0, 48)).join(" → ")}`.slice(0, 200),
    severity: "critical",
    cvss: 9.8,
    owasp: pool.map((f) => f.owasp).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" + ").slice(0, 120) || "multi",
    cwe: pool.map((f) => f.cwe).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(",").slice(0, 60),
    target: host,
    evidence: hops.map((h, i) => `hop${i + 1} [${h.kind}] ${h.fromId}→${h.toId} berbagi ${h.shared.join(",")} — replay STABIL`).join(" | ").slice(0, 2000),
    steps: pool.map((f, i) => `${i + 1}. [${f.id}] ${f.title}\n   ${f.steps || "(langkah tercatat di finding)"}`.slice(0, 400)).join("\n").slice(0, 1500),
    impact: `Rantai end-to-end lintas-kelas: ${chainTitles.join(" → ")}. Tiap hop ter-replay STABIL.`.slice(0, 1000),
    rootCause: "Rantai kelemahan yang saling menguatkan pada satu host.",
    remediation: "Perbaiki tiap hop dari yang paling hulu; verifikasi ulang dengan retest_run per finding asal.",
    references: `vuln_compose:${pool.map((f) => f.id).join(",")}`.slice(0, 600),
  });
  lines.push(`\n✅ CHAIN TERBUKTI PENUH — temuan komposit critical dicatat: [CRITICAL CVSS 9.8] ${comp.title} (${comp.id})`);
  return lines.join("\n");
}
