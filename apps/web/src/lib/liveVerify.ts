import {
  REFUSAL_CAPABILITY_VERB_RE,
  REFUSAL_REASON_RE,
  REFUSAL_SECURITY_NOUN_RE,
  SCOPE_CHECK_TOOLS,
  TOOL_CLAIM_ADMISSION_RE,
  TOOL_CLAIM_AKU_RE,
  TOOL_CLAIM_FUTURE_RE,
  TOOL_CLAIM_KU_RE,
  TOOL_CLAIM_PAST_MARK_RE,
  TOOL_CLAIM_PAST_VERB_RE,
  TOOL_CLAIM_RESULT_AFTER_RE,
  isBlanketRefusalClause,
  toolResultExecuted,
} from "./agent";
import { getTOOLS } from "./tools";

/**
 * Live-voice post-turn verifier (Phase 1: server-side, annotate-only).
 *
 * The text path guards (`toolRunClaimSuffix` family in agent.ts) consume a
 * `ChatMessage[]` turn window that does not exist on Live: the model talks
 * to Google directly, and the server only sees isolated tool executions
 * (this ledger, fed by `/api/gemini-live/tool`) plus transcript strings
 * (`/api/gemini-live/memory`). This module joins the two at save time.
 *
 * Two claim classes, both pure and unit-tested:
 *  (a) TOOL-NAME claims — "kuuji pakai http_request", "hasil dari
 *      poc_verify": same window/verb/admission/future logic as
 *      toolRunClaimSuffix (vocabulary imported, not copied — the regexes
 *      are the single owner in agent.ts). Deliberately WITHOUT the
 *      TOOL_CLAIM_EXEMPT class: on Live nothing runs outside the tool
 *      loop, so no claim is exempt.
 *  (b) BARE ACTION claims — "Udah kubuka di browser ya" names no tool
 *      (the Cozy 2026-10-02 shape that toolRunClaimSuffix structurally
 *      cannot see). Fires only when ZERO tools executed in the window —
 *      if anything ran, the claim might refer to it and we stay silent
 *      rather than accuse wrongly. A lone refused tool is attributed by
 *      name; several refused tools fall back to the generic note.
 *
 * Cross-turn lookback (2026-10-03 false-positive fix): Live turns split
 * seconds apart, so a tool executed at the end of turn N-1 and narrated
 * at the start of turn N falls outside the new turn's `sinceMs` window.
 * When nothing executed IN the window, both classes additionally consult
 * the last LOOKBACK_MS of the same user's ledger: a claim about a tool
 * that ran there (or any tool at all, for bare claims) stays silent.
 * True fabrications (Cozy: no tool anywhere near) still flag. Refusals
 * never silence — a refused tool did not run. Tradeoff is deliberate:
 * recall-friendly over accusation-happy; the note questions, it does
 * not convict, and a same-turn execution is still the only thing that
 * lands in `executed`.
 *
 * (c) BLANKET REFUSALS without a scope check - the Live path never runs
 * refusalWithoutScopeCheckNote, and neither scope tool
 * (engagement_list/pentest_resources) exists in the Live toolset, so a
 * reason-free capability refusal here can never have checked scope. Same
 * clause vocabulary (imported, not copied) + reason carve-out; the note
 * asks for target/continue instead of demanding uncallable tools. The
 * ledger check is kept for structural symmetry (and forward-compat).
 *
 * Annotate-only by design (owner scope): returns a verdict + note, never
 * rewrites memory. Clients render the note; the memory write is untouched.
 */

export interface LiveToolRun {
  user: string;
  name: string;
  ok: boolean;
  at: number;
}

const MAX_RUNS = 300;
const RUN_TTL_MS = 30 * 60 * 1000;
const DEFAULT_WINDOW_MS = 5 * 60 * 1000;
/** Cross-turn attribution horizon: tools executed this recently may still
 *  be what a turn-opening claim narrates. Far below RUN_TTL_MS. */
export const LOOKBACK_MS = 10 * 60 * 1000;

const runs: LiveToolRun[] = [];

/** Append one Live tool outcome. Best-effort: never throws. Pure shape, tested.
 *  `atMs` is a test seam (backdating); production callers omit it. */
export function recordLiveToolRun(user: unknown, name: unknown, ok: boolean, atMs?: unknown): void {
  try {
    const u = typeof user === "string" && user ? user : "shared";
    const n = typeof name === "string" && name ? name : "(missing)";
    const now = Date.now();
    const at = typeof atMs === "number" && Number.isFinite(atMs) && atMs > 0 && atMs <= now ? atMs : now;
    runs.push({ user: u, name: n, ok: !!ok, at });
    if (runs.length > MAX_RUNS) runs.splice(0, runs.length - MAX_RUNS);
    const cutoff = now - RUN_TTL_MS;
    let i = 0;
    while (i < runs.length && runs[i].at < cutoff) i++;
    if (i > 0) runs.splice(0, i);
  } catch {
    /* ledger is best-effort */
  }
}

/** Bare past-action verbs ("udah kubuka", "sudah kujalankan", "udah aku setting") with no tool name. Setup verbs need adjacent aku ("kerjaanku udah beres" stays silent). Noun-anchored completion/discovery arms live below (COMPLETION_STATE_RE/DISCOVERY_RE). */
const BARE_ACTION_RE =
  /(?:\b(?:aku\s+)?(?:sudah|telah|udah|barusan|tadi)\b[\s\S]{0,24}\b(?:buka|dibuka|membuka|jalankan|dijalankan|menjalankan|eksekusi|dieksekusi|cek|dicek|lihat|dilihat|simpan|disimpan|catat|dicatat|buat|dibuat|ambil|diambil|kirim|dikirim|hapus|dihapus)\b|\bku(?:buka|jalankan|jalanin|eksekusi|tes|test|uji|scan|simpan|catat|cek|lihat|ambil|buat|kirim|hapus)\b|(?:\baku\s+(?:sudah|telah|udah|barusan|tadi)\b|\b(?:sudah|telah|udah|barusan|tadi)\s+aku\b)[\s\S]{0,24}\b(?:setting|seting|siapin|siapkan|beres|beresin)\b)/i;

/**
 * Noun-anchored completion/discovery arms (anti-treadmill: verbs rotate,
 * the WORK nouns don't — "udah jalan", "udah selesai", "nemu celah" all
 * name the work, so anchor on that). Both require a security noun in the
 * same ±70 window, so "udah selesai makan" / "nemu artikel" stay silent.
 * - arm 4 COMPLETION_STATE_RE: past-marker + (jalan|selesai|kelar|tuntas);
 *   "jalan" excludes the street sense ("di jalan") via lookbehind.
 * - arm 5 DISCOVERY_RE: (nemu|nemuin|nemukan|menemukan|ditemukan) + a
 *   FINDING noun (celah|temuan|kerentanan|vuln) — pentest/pemindaian name
 *   the TOPIC, not the find, so "nemu artikel soal pentest" stays silent.
 * Noun base = REFUSAL_SECURITY_NOUN_RE (shared, single owner); the four
 * discovery/completion nouns are composed from its source so the two
 * can't drift (parity locked by unit test; the strip is shape-tolerant —
 * worst case it nests redundantly and still compiles).
 */
const LIVE_NOUN_INNER = REFUSAL_SECURITY_NOUN_RE.source
  .replace(/^\\b\(\?:/, "")
  .replace(/\)\\b$/, "");
export const LIVE_SECURITY_NOUN_RE = new RegExp(
  `\\b(?:${LIVE_NOUN_INNER}|celah\\w*|temuan\\w*|pemindaian\\w*|pengetesan\\w*)\\b`,
  "i",
);
export const LIVE_FINDING_NOUN_RE = /\b(?:celah\w*|temuan\w*|kerentanan\w*|vuln\w*)\b/i;
export const COMPLETION_STATE_RE =
  /\b(?:sudah|telah|udah|barusan|tadi)\b[\s\S]{0,24}\b(?:(?<!\bdi\s)jalan|selesai|kelar|tuntas)\b/i;
export const DISCOVERY_RE = /\b(?:nemu|nemuin|nemukan|menemukan|ditemukan)\b/i;

export interface LiveVerification {
  verdict: "clean" | "flagged";
  note: string;
  executed: string[];
}

/**
 * Verify one Live turn's narration against the tool ledger. Pure — tested.
 * `sinceMs` is the turn start (clients send it); falls back to a 5-minute
 * window. Returns "" note on clean.
 */
export function verifyLiveTurn(
  userKey: string,
  said: unknown,
  sinceMs?: unknown,
): LiveVerification {
  const now = Date.now();
  const since =
    typeof sinceMs === "number" && Number.isFinite(sinceMs) && sinceMs > 0
      ? sinceMs
      : now - DEFAULT_WINDOW_MS;
  const inWin = runs.filter((r) => r.user === userKey && r.at >= since && r.at <= now);
  const executed = new Set<string>();
  const refusedOnly = new Set<string>();
  for (const r of inWin) {
    if (r.ok) {
      executed.add(r.name);
      refusedOnly.delete(r.name);
    } else if (!executed.has(r.name)) {
      refusedOnly.add(r.name);
    }
  }
  // Cross-turn lookback: successful runs just before the window that the
  // claim may still narrate (turn split seconds apart). Refusals never
  // silence — a refused tool did not run.
  const recentOk = new Set<string>();
  const lookCut = now - LOOKBACK_MS;
  for (const r of runs) {
    if (r.user === userKey && r.ok && r.at >= lookCut && r.at <= now) recentOk.add(r.name);
  }
  const execList = [...executed];
  const t = typeof said === "string" ? said.trim() : "";
  if (!t) return { verdict: "clean", note: "", executed: execList };

  // --- (a) tool-name claims: same framing logic as toolRunClaimSuffix ---
  const names = getTOOLS()
    .map((x) => x.function.name)
    .sort((a, b) => b.length - a.length);
  const lowerOf: Record<string, string> = {};
  for (const n of names) lowerOf[n.toLowerCase()] = n;
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const alt = new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
  const flagged: string[] = [];
  const refused: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = alt.exec(t)) !== null) {
    const name = lowerOf[match[1].toLowerCase()] ?? match[1];
    if (executed.has(name) || recentOk.has(name)) continue;
    const start = match.index;
    const before = t.slice(Math.max(0, start - 70), start);
    const after = t.slice(start + match[1].length, start + match[1].length + 70);
    const window = `${before} ${after}`;
    if (TOOL_CLAIM_ADMISSION_RE.test(window)) continue;
    const claimed =
      TOOL_CLAIM_KU_RE.test(before) ||
      TOOL_CLAIM_AKU_RE.test(before) ||
      TOOL_CLAIM_PAST_VERB_RE.test(window) ||
      /\bhasil\s*(?:dari)?\s*$/i.test(before) ||
      TOOL_CLAIM_RESULT_AFTER_RE.test(after);
    if (!claimed) continue;
    if (TOOL_CLAIM_FUTURE_RE.test(window) && !TOOL_CLAIM_PAST_MARK_RE.test(window)) continue;
    if (refusedOnly.has(name)) {
      if (!refused.includes(name)) refused.push(name);
      continue;
    }
    if (!flagged.includes(name)) flagged.push(name);
  }

  // --- (b) bare action claims: only when nothing executed at all,
  //     in-window or in the cross-turn lookback ---
  let bareHit = false;
  if (executed.size === 0 && recentOk.size === 0) {
    const m = BARE_ACTION_RE.exec(t);
    if (m) {
      const start = m.index;
      const window = t.slice(Math.max(0, start - 70), start + m[0].length + 70);
      if (
        !TOOL_CLAIM_ADMISSION_RE.test(window) &&
        !(TOOL_CLAIM_FUTURE_RE.test(window) && !TOOL_CLAIM_PAST_MARK_RE.test(window))
      ) {
        bareHit = true;
      }
    }
    if (!bareHit) {
      // Arms 4/5: noun-anchored completion/discovery (anti-treadmill).
      // Noun must sit in the same window; carve-outs mirror the bare arm.
      const mc = COMPLETION_STATE_RE.exec(t);
      const md = !mc ? DISCOVERY_RE.exec(t) : null;
      const m2 = mc ?? md;
      if (m2) {
        const start = m2.index;
        const window = t.slice(Math.max(0, start - 70), start + m2[0].length + 70);
        const nounRe = md ? LIVE_FINDING_NOUN_RE : LIVE_SECURITY_NOUN_RE;
        if (
          nounRe.test(window) &&
          !TOOL_CLAIM_ADMISSION_RE.test(window) &&
          !(TOOL_CLAIM_FUTURE_RE.test(window) && !TOOL_CLAIM_PAST_MARK_RE.test(window))
        ) {
          bareHit = true;
        }
      }
    }
  }

  // --- (c) blanket capability refusals: the Live path never runs the
  //     text guard, and neither scope tool exists in the Live toolset, so
  //     a refusal here can never have checked scope — the ledger check is
  //     kept for structural symmetry (and forward-compat).
  let refusalHit = false;
  for (const clause of t.split(/[.!?\n]+/)) {
    if (!isBlanketRefusalClause(clause)) continue;
    // A refusal that GIVES a reason is legitimate — same carve-out as text.
    if (REFUSAL_REASON_RE.test(clause)) continue;
    // Epistemic hedging is not a capability refusal.
    if (!REFUSAL_CAPABILITY_VERB_RE.test(clause)) continue;
    refusalHit = true;
    break;
  }
  let scopeChecked = false;
  if (refusalHit) {
    for (const r of runs) {
      if (r.user !== userKey || r.at < lookCut || r.at > now) continue;
      if (SCOPE_CHECK_TOOLS.has(r.name)) {
        scopeChecked = true;
        break;
      }
    }
  }

  const parts: string[] = [];
  if (flagged.length) {
    parts.push(
      `hasil eksekusi ${flagged.slice(0, 3).join(", ")} tidak tercatat di giliran ini — tool itu belum benar-benar kujalankan.`,
    );
  }
  if (refused.length) {
    parts.push(
      `${refused.slice(0, 3).join(", ")} ditolak/belum dikonfirmasi di giliran ini, bukan dijalankan.`,
    );
  }
  if (bareHit) {
    if (refusedOnly.size === 1) {
      const only = [...refusedOnly][0];
      parts.push(
        `${only} ditolak/belum dikonfirmasi di giliran ini, bukan dijalankan.`,
      );
    } else {
      parts.push(
        `tidak ada tool yang tercatat jalan di giliran ini — klaim aksi di atas belum terverifikasi.`,
      );
    }
  }
  if (refusalHit && !scopeChecked) {
    parts.push(
      `penolakan di atas keluar tanpa memeriksa scope — jangan menolak kapabilitas; tanyakan targetnya, atau lanjutkan di lab yang sedang dibahas dan sebutkan eksplisit ya.`,
    );
  }
  if (!parts.length) return { verdict: "clean", note: "", executed: execList };
  return {
    verdict: "flagged",
    note: ` (Catatan jujur: ${parts.join(" ")} Bilang "jalankan" kalau mau aku kerjakan sekarang ya.)`,
    executed: execList,
  };
}

/** Re-exported for the tool route: an "Error:" result is not an execution. */
export { toolResultExecuted };
