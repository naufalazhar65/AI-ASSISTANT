// DOM XSS Taint Analysis — the automated gap no commercial scanner here
// covers: trace `location.*` / `postMessage` / `document.referrer` SOURCES to
// `innerHTML` / `document.write` / `eval` / `Function` / `outerHTML` /
// `insertAdjacentHTML` / `$()` SINKS inside the target's JS bundles, and
// flag those NOT sanitized (no encodeURI/encodeURIComponent/DOMPurify/escape
// between source and sink).
//
// Input: JS bundle text(s) already fetched (js_mine pattern) OR a URL to fetch
// (scope-gated). Output: per-flow evidence `file:line — source → sink` ready
// for manual verification + finding_add. STATIC = belum terkonfirmasi (the
// methodology gate still applies).
//
// Pure helpers (SOURCES/SINKS/analyzeTaint) exported for unit tests.

import { targetAllowed } from "./security";

/** Escape a string for literal use inside new RegExp (audit 2026-09-23: `$`
 *  is legal in JS identifiers, so an unescaped `$x` became an end-anchor and
 *  its flows never matched). Pure — tested. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export type TaintFlow = {
  source: string;
  sourceLine: number;
  sink: string;
  sinkLine: number;
  /** variable that carries taint from source to sink (best-effort) */
  variable: string;
  sanitized: boolean;
  /** the offending line, trimmed */
  snippet: string;
};

/** DOM sources that inject attacker-controlled data. Pure data — tested. */
export const TAINT_SOURCES: { name: string; re: RegExp }[] = [
  { name: "location.search", re: /location\.search\b/ },
  { name: "location.hash", re: /location\.hash\b/ },
  { name: "location.href", re: /location\.href\b/ },
  { name: "location.pathname", re: /location\.pathname\b/ },
  { name: "document.referrer", re: /document\.referrer\b/ },
  { name: "postMessage event.data", re: /\b(?:event|e|msg|data)\.data\b/ },
  { name: "window.name", re: /\bwindow\.name\b/ },
];

/** DOM sinks that execute/insert HTML or code. Pure data — tested. */
export const TAINT_SINKS: { name: string; re: RegExp }[] = [
  { name: "innerHTML", re: /\.innerHTML\s*=/ },
  { name: "outerHTML", re: /\.outerHTML\s*=/ },
  { name: "document.write", re: /document\.write(?:ln)?\s*\(/ },
  { name: "eval", re: /\beval\s*\(/ },
  { name: "Function constructor", re: /\bnew\s+Function\s*\(/ },
  { name: "insertAdjacentHTML", re: /\.insertAdjacentHTML\s*\(/ },
  { name: "jQuery html()", re: /\$\([^)]*\)\.html\s*\(/ },
  { name: "setAttribute handler", re: /\.setAttribute\s*\(\s*["'](on[a-z]+)["']\s*,/i },
];

/** Sanitizer calls that (probably) neutralize the flow. Pure data — tested. */
export const TAINT_SANITIZERS = /encodeURI(?:Component)?\(|DOMPurify\.sanitize|sanitizeHtml|\bescape(?:Html|HTML)\(|textContent\s*=/;

/**
 * Analyze one JS text for unsanitized source→sink flows in the SAME function
 * scope heuristic (per-line variable tracking, bounded). Pure — unit-tested.
 */
export function analyzeTaint(text: string, fileLabel = "bundle.js"): TaintFlow[] {
  void fileLabel; // kept for API symmetry with domTaint(); flows are file-labeled at the caller
  const flows: TaintFlow[] = [];
  const lines = text.split("\n");
  // Track the most recent source assignment per variable name.
  const tainted = new Map<string, { source: string; line: number }>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 1) sources: `const x = location.hash` / `x = location.search`
    for (const src of TAINT_SOURCES) {
      const m = line.match(new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*[^;\\n]*${src.re.source}`));
      if (m) tainted.set(m[1], { source: src.name, line: i + 1 });
    }
    // 2) sinks: does the sink call reference a tainted variable?
    // (No \b: `$` is non-word, so \b never matches before `$x` — use explicit
    // identifier-boundary lookarounds. Audit 2026-09-23.)
    for (const sink of TAINT_SINKS) {
      if (!sink.re.test(line)) continue;
      for (const [v, t] of tainted) {
        const vRe = new RegExp(`(?<![\\w$])${escapeRegExp(v)}(?![\\w$])`);
        if (!vRe.test(line)) continue;
        // Walk back ≤15 lines for a sanitizer touching the same variable.
        let sanitized = false;
        for (let j = i - 1; j >= Math.max(0, i - 15); j--) {
          if (vRe.test(lines[j]) && TAINT_SANITIZERS.test(lines[j])) {
            sanitized = true;
            break;
          }
        }
        if (TAINT_SANITIZERS.test(line)) sanitized = true;
        flows.push({ source: t.source, sourceLine: t.line, sink: sink.name, sinkLine: i + 1, variable: v, sanitized, snippet: line.trim().slice(0, 200) });
        break; // one sink hit per line is enough
      }
    }
  }
  const flagged = flows.filter((f) => !f.sanitized);
  // Keep the report bounded and stable.
  return flagged.slice(0, 20).map((f) => ({ ...f, snippet: f.snippet }));
}

function trimLabel(label: string): string {
  return label.split("/").pop() || label;
}

/** Fetch a URL (scope-gated) and analyze; or analyze the given bundle text. */
export async function domTaint(rawUser: unknown, opts: { url?: string; text?: string; file_label?: string }): Promise<string> {
  const items: { label: string; text: string }[] = [];
  if (opts.text && opts.text.trim()) {
    items.push({ label: opts.file_label?.trim() || "inline.js", text: opts.text.slice(0, 400_000) });
  } else if (opts.url) {
    const url = opts.url.trim();
    if (!/^https?:\/\//i.test(url)) return "Error: URL harus http(s).";
    if (!targetAllowed(url)) return "Error: SCOPE — dom_taint hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
    try {
      const res = await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(12_000) });
      if (!res.ok) return `Error: fetch ${url} → ${res.status}`;
      const ct = res.headers.get("content-type") || "";
      const body = (await res.text()).slice(0, 400_000);
      if (/\.jsx?(\?|$)/i.test(url) || /javascript/i.test(ct)) {
        items.push({ label: url, text: body });
      } else {
        // HTML: pull same-origin script srcs (bounded 8), analyze each.
        const base = new URL(url);
        const srcs = new Set<string>();
        for (const m of body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
          try {
            const u = new URL(m[1], url);
            if (u.origin === base.origin) srcs.add(u.toString());
          } catch { /* skip */ }
        }
        if (!srcs.size) items.push({ label: url, text: body });
        const list = [...srcs].slice(0, 8);
        for (const s of list) {
          try {
            const r2 = await fetch(s, { headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(12_000) });
            if (r2.ok) items.push({ label: s, text: (await r2.text()).slice(0, 400_000) });
          } catch { /* skip */ }
        }
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : "fetch failed"}`;
    }
  } else {
    return "Error: butuh `url` (halaman/JS target, scope-gated) atau `text` (isi bundle dari js_mine).";
  }
  if (!items.length) return "Tidak ada JS yang bisa dianalisis.";

  const flows: (TaintFlow & { file: string })[] = [];
  for (const it of items) {
    for (const f of analyzeTaint(it.text, it.label)) flows.push({ ...f, file: trimLabel(it.label) });
  }
  const head = `🕸️ DOM TAINT — ${items.length} file, ${flows.length} aliran source→sink TANPA sanitizer (statik — verifikasi manual dulu).`;
  if (!flows.length) return `${head}\nTidak ada aliran berbahaya terdeteksi pada file yang dianalisis.`;
  const lines = flows.map((f) => `• [${f.sink}] ${f.file}:${f.sinkLine} ← ${f.source} (${f.file}:${f.sourceLine}) via \`${f.variable}\`\n   ${f.snippet}`);
  return `${head}\n${lines.join("\n")}\n\nLanjut: verifikasi di browser (payload di location.hash lalu cek eksekusi) → poc_verify → finding_add (CWE-79, PLAYBOOK dom-xss bila ada).`;
}
