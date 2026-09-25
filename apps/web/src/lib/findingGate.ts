// findingGate.ts — the write-path gate that stops a REFUTED injection claim from
// entering the findings store.
//
// Why (live 2026-09-25): a turn tested `?id=1;-- -` on the owner's lab; the clean
// `?id=1` returned byte-identical output, the real SQLi payload was 404 — and a
// HIGH CWE-89 finding was filed anyway. `poc_verify` had already (correctly) said
// ⛔, but a verdict only ever reached the MODEL's context, and a model is free to
// ignore it. Prompt rules cannot fix that; the write path can.
//
// Two ways a finding is refused, both requiring it to be an injection-class claim
// at high/critical:
//   1. REFUTED — a PoC run on that endpoint came back `no-signal` (the control ran
//      and the payload changed nothing). This is positive evidence, so no honest
//      finding can be blocked by it.
//   2. UNBACKED — no PoC run on that endpoint is `confirmed`, and the evidence does
//      not cite a proof that `poc_verify` cannot produce (OOB/OAST, browser DOM
//      execution, raw-socket desync, a passwd/win.ini read). Those classes are
//      proven by their own prover, so they stay reportable — otherwise this gate
//      would block genuinely proven work and teach the model nothing.
//
// Pure — the caller supplies the effective severity and the ledger rows.
import type { PocRun } from "./pocRuns";

/**
 * Injection-family classes whose claim IS a payload/response differential. Kept
 * deliberately narrow: OOB-only classes (XXE, blind SSRF), browser-execution
 * proofs (DOM XSS) and structural proofs (request smuggling) are NOT listed here
 * because `poc_verify` cannot reproduce them — gating them would block real work.
 */
const INJECTION_CWE_RE =
  /\bCWE-(?:89|564|943|78|77|88|1336|1337|90|643|91|917|94|95|74|1236|113|22|23|36|98|434)\b/i;

const INJECTION_TITLE_RE =
  /\b(sql[\s-]?injection|sqli|nosql|command[\s-]?injection|os[\s-]?command|shell[\s-]?injection|rce|remote code execution|ssti|server[\s-]?side template|template injection|ldap injection|xpath injection|xslt injection|xml injection|csv injection|formula injection|path traversal|directory traversal|lfi|local file inclusion|header injection|crlf injection|code injection|injeksi|sql injeksi)\b/i;

const INJECTION_OWASP_RE = /injection/i;

/** A proof that `poc_verify` fundamentally cannot produce (OOB / browser / socket). */
const NON_POC_PROOF_RE =
  /oast_poll|oast_dns|interactsh|callback\s*(?:OOB|ter-atribusi|hit)|dom_xss_prove|PROVEN[^\n]{0,40}handler|smuggle_probe|desync|CL\.TE|TE\.CL|\/etc\/passwd|win\.ini|php:\/\/filter|blind_cmdi|time-based/i;

export function hostOfUrl(raw: string): string {
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return String(raw || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  }
}

export function pathOfUrl(raw: string): string {
  try {
    return new URL(raw).pathname;
  } catch {
    const m = String(raw || "").match(/^https?:\/\/[^/]+(\/[^?#]*)/i);
    return m ? m[1] : "";
  }
}

/** Is this finding a differential-dependent injection claim? Pure. */
export function findingIsInjectionClass(input: { title?: string; cwe?: string; owasp?: string }): boolean {
  const title = String(input.title || "");
  const cwe = String(input.cwe || "");
  const owasp = String(input.owasp || "");
  if (INJECTION_CWE_RE.test(cwe)) return true;
  if (INJECTION_TITLE_RE.test(title)) return true;
  // "Injection" in the OWASP label is only trusted when the title is also specific
  // — a bare A03 label on a non-injection bug must not trip the gate.
  return INJECTION_OWASP_RE.test(owasp) && INJECTION_TITLE_RE.test(title);
}

/**
 * Does this run speak for the endpoint named in the finding? A host-level run
 * (path "/") witnesses its whole host; a path-level run must be referenced by the
 * finding itself (the model puts the tested URL in steps/evidence — verified on
 * the live 2026-09-25 turn).
 */
export function pocRunWitnesses(runUrl: string, findingTarget: string, findingText: string): boolean {
  const runHost = hostOfUrl(runUrl);
  const targetHost = hostOfUrl(findingTarget) || hostOfUrl(findingText);
  if (!runHost || !targetHost || runHost !== targetHost) return false;
  const p = pathOfUrl(runUrl);
  if (!p || p === "/") return true;
  const text = `${findingTarget}\n${findingText}`;
  return text.includes(p) || text.includes(runUrl);
}

/**
 * Marks the result as a refusal for the honesty guards: `toolResultExecuted`
 * already treats "refused to execute" as NOT an execution, so a reply that goes
 * on to claim the finding was recorded gets a correction instead of silence.
 * Without this, a refused write would look like a successful one.
 */
const REFUSAL_FOOTER =
  "\n\n(refused to execute — gerbang bukti: pencatatan DIBATALKAN, tidak ada temuan tersimpan. Jangan klaim temuan ini tercatat.)";

export type FindingGateDecision = {
  allow: boolean;
  block: "no-signal" | "no-proof" | null;
  reason: string;
  matched: PocRun[];
};

/**
 * Decide whether `finding_add` may store this finding.
 *
 * Only high/critical injection-class claims are gated; everything else is allowed
 * untouched (medium/low stays a warning, as before).
 */
export function findingAddGate(
  input: {
    title?: string;
    severity?: string;
    cwe?: string;
    owasp?: string;
    target?: string;
    /** target + evidence + steps + impact + root cause — what the finding claims. */
    text?: string;
  },
  runs: readonly PocRun[]
): FindingGateDecision {
  const allow = (): FindingGateDecision => ({ allow: true, block: null, reason: "", matched: [] });

  const severity = String(input.severity || "").toLowerCase();
  if (severity !== "high" && severity !== "critical") return allow();
  if (!findingIsInjectionClass(input)) return allow();
  // A cited OOB / browser / socket proof is honoured: those provers are the evidence.
  const text = String(input.text || "");
  if (NON_POC_PROOF_RE.test(text)) return allow();

  const target = String(input.target || "");
  const matched = (runs || []).filter((r) => r && typeof r.url === "string" && pocRunWitnesses(r.url, target, text));

  const refuted = matched.filter((r) => r.verdict === "no-signal");
  if (refuted.length) {
    const where = [...new Set(refuted.map((r) => `${r.method} ${r.url}`))].slice(0, 3).join(", ");
    return {
      allow: false,
      block: "no-signal",
      matched,
      reason:
        `⛔ finding_add DITOLAK (gerbang bukti): klaim ${severity.toUpperCase()} injection TAPI buktinya MENYANGKAL klaimnya. ` +
        `poc_verify pada ${where} memberi "⛔ TIDAK ADA SINYAL" — respons payload IDENTIK dengan baseline, artinya payload tidak mengubah apa pun. ` +
        `JANGAN mengulang finding_add dengan argumen yang sama, dan JANGAN menghapus baseline demi meloloskannya. ` +
        `Yang benar: cari payload/differential lain lalu poc_verify sampai ✅ (assertion + kontrol BERBEDA); ` +
        `kalau buktinya memang blind/OOB, sebutkan bukti itu (oast_poll/blind_cmdi/dom_xss_prove) di evidence.` +
        REFUSAL_FOOTER,
    };
  }

  if (matched.some((r) => r.verdict === "confirmed")) return allow();

  return {
    allow: false,
    block: "no-proof",
    matched,
    reason:
      `⛔ finding_add DITOLAK (gerbang bukti): temuan ${severity.toUpperCase()} kelas injection belum punya bukti diferensial. ` +
      `Tidak ada satu pun run poc_verify yang berstatus ✅ untuk endpoint ini` +
      (matched.length ? ` (yang tercatat: ${[...new Set(matched.map((r) => `${r.method} ${r.url} → ${r.verdict}`))].slice(0, 3).join(", ")})` : "") +
      `. Klaim "payload mengubah perilaku server" WAJIB dibuktikan: jalankan poc_verify pada endpoint di atas dengan expect_status/expect_contains ` +
      `DAN baseline_url (kontrol yang seharusnya BEDA), baru catat temuan. Jangan mengarang atau mengulang finding_add yang sama.` +
      REFUSAL_FOOTER,
  };
}
