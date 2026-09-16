// ROI / target scorer — help pick WHERE to hunt. Given a program's scope text
// (or an engagement), score the surface and rank hosts by likely return, so the
// human spends effort on the highest-value gaps instead of guessing.
//
// Heuristic and transparent (every point is explained); no network.

import { listEngagements, engagementTargetsText } from "./engagement";
import { parseScopeText } from "./scopeImport";

export type Scored = { host: string; score: number; why: string[] };

const HIGH_VALUE = /(^|\.)(api|auth|admin|account|accounts|login|sso|oauth|dashboard|portal|app|my|secure|internal|pay|payment|billing|wallet|graphql|swagger|dev|staging|test|uat)\./i;
const LOW_VALUE = /(^|\.)(www|blog|docs|help|support|status|cdn|static|assets|images|img|news|m|mobile-static)\.|\.(js|css)$/i;
const STATIC_HOST = /(static|assets|cdn|images|img)/i;

/** Score a single host by heuristics; each reason is named. Pure — unit-tested. */
export function scoreHost(host: string): { score: number; why: string[] } {
  const h = host.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const why: string[] = [];
  let score = 30;
  if (h.startsWith("*.")) {
    score += 20;
    why.push("wildcard → surface luas (+20)");
  }
  if (HIGH_VALUE.test(h)) {
    score += 25;
    why.push("kata kunci bernilai tinggi (auth/api/admin/pay/dashboard/dev) (+25)");
  }
  if (/(^|\.)(dev|staging|test|uat|qa)\./i.test(h)) {
    score += 15;
    why.push("environment non-prod — sering lebih longgar (+15)");
  }
  if (LOW_VALUE.test(h) || STATIC_HOST.test(h)) {
    score -= 20;
    why.push("statis/konten/dokumentasi — jarang ada bug (+/-20)");
  }
  if (h.split(".").length <= 2) {
    score += 5;
    why.push("root domain (endpoint bisa banyak) (+5)");
  }
  return { score: Math.max(0, Math.min(100, score)), why };
}

/** Rank a host list, highest value first. Pure — unit-tested. */
export function rankTargets(hosts: string[]): Scored[] {
  return hosts
    .map((h) => ({ host: h, ...scoreHost(h) }))
    .sort((a, b) => b.score - a.score || a.host.localeCompare(b.host));
}

/** Score a program from pasted scope text (in-scope/out-of-scope). */
export function programScore(text: string): { score: number; reasons: string[]; ranked: Scored[] } {
  const { inScope } = parseScopeText(text);
  const ranked = rankTargets(inScope);
  const reasons: string[] = [];
  let score = 40;
  if (!inScope.length) return { score: 0, reasons: ["tak ada host in-scope terbaca dari teks"], ranked: [] };
  if (inScope.some((h) => h.startsWith("*."))) {
    score += 15;
    reasons.push("ada wildcard scope — surface luas (+15)");
  }
  const hi = ranked.filter((r) => r.score >= 60).length;
  if (hi) {
    score += Math.min(20, hi * 5);
    reasons.push(`${hi} host bernilai tinggi (+${Math.min(20, hi * 5)})`);
  }
  if (inScope.length >= 10) {
    score += 10;
    reasons.push("scope lebar (≥10 host) — lebih banyak peluang (+10)");
  } else if (inScope.length <= 2) {
    score -= 10;
    reasons.push("scope sangat sempit (≤2 host) — ROI kecil (-10)");
  }
  return { score: Math.max(0, Math.min(100, score)), reasons, ranked };
}

/** Program score from pasted text, or an engagement's scope. */
export function roiText(opts: { scope?: string; engagement?: string }): string {
  let text = (opts.scope || "").trim();
  if (!text && opts.engagement) {
    const e = listEngagements().find((x) => x.id === opts.engagement);
    if (!e) return `Error: engagement "${opts.engagement}" tidak ditemukan.`;
    text = [`# ${e.name}`, ...e.scope].join("\n") + (e.outOfScope.length ? `\n\n# out of scope\n${e.outOfScope.join("\n")}` : "");
  }
  if (!text && opts.engagement === undefined) text = engagementTargetsText();
  const { score, reasons, ranked } = programScore(text);
  const top = ranked.slice(0, 15);
  return `📈 ROI SCORE: ${score}/100\n${reasons.map((r) => `• ${r}`).join("\n") || "• (tanpa catatan)"}\n\nPrioritas host (uji dari atas):\n${top.map((r, i) => `${i + 1}. ${r.host} [${r.score}]${r.why.length ? ` — ${r.why.join("; ")}` : ""}`).join("\n") || "(tak ada host)"}\n\n⚠️ Skor heuristik (bukan jaminan); tetap patuhi scope & RoE.`;
}
