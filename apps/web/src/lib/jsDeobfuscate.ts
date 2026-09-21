// js_deobfuscate — decode/minify-aware extraction that upgrades js_mine for
// modern bundles. js_mine greps RAW source, so it misses everything in a
// webpack-style string array ("var a=['/api/x'];") or split across lines
// ("fetch(\n 'https://api.x/v2'\n + '/users')"). This module:
//   1. sourcemap   — fetch adjacent "<bundle>.map" (the classic "forgot to
//                    disable source maps" finding); restores ORIGINAL sources
//                    (file/line for every endpoint/secret, not mangled vars).
//   2. deobfuscate — eval-free, bounded passes:
//                    • string-array: pull literal elements and replace VAR(i)
//                      / VAR.i references (comma-separated arrays too).
//                    • string concat folding ('a'+'b', nested/many terms,
//                      unquoted + parts) so split literals rejoin.
//   3. mine        — same extraction as js_mine, but on the deobfuscated text:
//                    string-literal endpoints + relative-path endpoints +
//                    scanTextSecrets (types+lines only, values REDACTED).
// Pure helpers exported for tests: deobfuscate, foldConcats, foldConcatsText,
// unwrapChunk, decodeCommonEscapes, firstStringElement, splitTopLevel,
// isPathLike, findSourceMapUrl, SOURCEMAP_HINT, looksMinified, hasDeobfSignal,
// dedupe.
// Bounded: bundle ≤900KB, ≤8 passes, array ≤2000 elements, element ≤2000 chars,
// map sources ≤120, source file ≤900KB each, output cap ~1.2MB. Eval-free.
import { targetAllowed, scanTextSecrets, politeDelay } from "./security";

const FETCH_TIMEOUT_MS = 15_000;

async function getText(url: string, maxBytes: number): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "mia-assistant/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    return buf.byteLength > maxBytes ? null : new TextDecoder().decode(buf);
  } catch {
    return null;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

/** Hex/decimal numeric literal (0x1f, 15). */
function parseNum(s: string): number {
  return /^0x/i.test(s) ? parseInt(s, 16) : Number(s);
}

/** Collapse runs of whitespace (incl. newlines) that surround a `+` operator.
 *  Folded separately so "split across lines" cases match the same regexes as
 *  single-line ones. Repeated — foldConcats runs up to 8 passes. */
function squeezePlus(text: string): string {
  return text
    .replace(/[ \t\r\n]*\+[ \t\r\n]*/g, "+")
    .replace(/\){2,}/g, (m) => (m.length > 6 ? ")".repeat(6) : m))
    .replace(/\({2,}/g, (m) => (m.length > 6 ? "(".repeat(6) : m));
}

/** Decode the escape sequences that appear inside evaluated string literals
 *  (JS via String eval, and JSON.parse strings). `\xNN`, `\uNNNN`,
 *  `\\`/`\"`/`\'`/`\n`/`\r`/`\t`/`\/`. Unknown escapes preserved verbatim. */
export function decodeCommonEscapes(s: string): string {
  if (!s.includes("\\")) return s;
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|[\\"'nrt/])/g, (all, g1: string) => {
    if (g1[0] === "x") return String.fromCharCode(parseInt(g1.slice(1), 16));
    if (g1[0] === "u") return String.fromCharCode(parseInt(g1.slice(1), 16));
    switch (g1) {
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      case "/": return "/";
      case "\\": return "\\";
      case "'": return "'";
      case '"': return '"';
      default: return all;
    }
  });
}

/** Strip ONE layer of JS string/comment wrapping: JSON.parse('{"a":1}') →
 *  {"a":1}; eval("alert(1)") → alert(1); new Function("return 1") → return 1;
 *  atob indirectly via decodeCommonEscapes on the literal. Also unwrap one
 *  layer of /*…*​/ comments. Exported for tests (used by unwrapChunk). */
export function unwrapOneLayer(chunk: string): string {
  const t = chunk.trim();
  if (t.length >= 2) {
    const q = t[0];
    if ((q === '"' || q === "'" || q === "`") && t.endsWith(q)) {
      const inner = t.slice(1, -1);
      if (inner.length > 1 && /\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4})/.test(inner)) {
        return decodeCommonEscapes(inner);
      }
    }
  }
  const f = t.match(/^(?:JSON\.parse|eval|Function)\s*\(\s*([\s\S]*)\)\s*;?\s*$/);
  if (f) return f[1];
  const c = t.match(/^\/\*[\s\S]*\*\/([\s\S]*)$/);
  if (c) return c[1];
  return t;
}

/** Unwrap nested string/eval/JSON.parse layers (≤3). Exported + tested. */
export function unwrapChunk(chunk: string): string {
  let out = chunk;
  for (let i = 0; i < 3; i++) {
    const next = unwrapOneLayer(out);
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Split on `+` at depth 0 (not inside quotes/parens/brackets/braces). */
export function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      cur += c;
      if (c === "\\") {
        cur += s[i + 1] ?? "";
        i++;
      } else if (c === q) {
        q = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "+" && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/** First string literal of a chunk (trimmed of template/newlines). */
export function firstStringElement(chunk: string): string {
  const t = chunk.trim();
  if (!t) return "";
  if (t[0] === '"' || t[0] === "'" || t[0] === "`") {
    const q = t[0];
    let out = q === "`" ? "" : "";
    for (let i = 1; i < t.length; i++) {
      const c = t[i];
      if (c === "\\") {
        out += c + (t[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === q) return out;
      if (q !== "`" && c === "\n") return out;
      out += c;
    }
    return out;
  }
  const m = t.match(/"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1];
  return "";
}

/** Split the INSIDE of an array literal on top-level commas. */
function splitTopLevelCommas(inside: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < inside.length; i++) {
    const c = inside[i];
    if (q) {
      cur += c;
      if (c === "\\") {
        cur += inside[i + 1] ?? "";
        i++;
      } else if (c === q) {
        q = null;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      cur += c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

/**
 * Webpack/browserify string-array deobfuscation. Bounded passes (≤8):
 *  1. collect literal arrays of ≥3 string elements ("var _0x1a2b=['a','b',…]"
 *     and the comma-separated variant "var a='x',b=['a','b'];").
 *  2. replace NUMERIC member access a[0], a["0"], and a.at(0) with the literal.
 *  3. replace INDEX-FUNCTION calls _0xabcd(0) where the function's body is a
 *     pure lookup (alias chains resolved iteratively, loop-free).
 *  4. rename remaining bare identifier references of array names (var-shadow
 *     safe: skips lookahead '(' and skip-names like `window`, `document`).
 * Eval-free; numbers/indices are validated. Returns { text, arrays }.
 */
export function deobfuscate(src: string): { text: string; arrays: number } {
  let text = src;
  const arrays = new Map<string, string[]>();
  const MAX_ARRAY = 2000;
  const MAX_ELEM = 2000;

  // Pass A — collect string-array declarations (≥2 elements — bundles often
  // ship small arrays; still require ALL elements to be plain literals so
  // normal code with mixed arrays is never rewritten).
  const collect = (name: string, inside: string): number => {
    if (arrays.has(name) || !inside || inside.length > 200_000) return 0;
    const parts = splitTopLevelCommas(inside).map((p) => firstStringElement(p));
    const strs = parts.filter((p) => p !== "");
    if (parts.length && strs.length === parts.length && parts.length >= 2 && parts.length <= MAX_ARRAY) {
      const elems = parts.map((p) => (p.length > MAX_ELEM ? "" : p));
      arrays.set(name, elems);
      return 1;
    }
    return 0;
  };

  const reBracket = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*[;,]/g;
  text = text.replace(reBracket, (full, name: string, inside: string) => (collect(name, inside) ? "" : full));
  // Comma-separated declaration lists: var base='x',rt=['a','b']; — the array
  // var has NO keyword before it, so anchor on the preceding `,`/`;`/start.
  const reCommaList = /(?:^|[;,])\s*([A-Za-z_$][\w$]*)\s*=\s*\[([\s\S]*?)\]\s*[;,]/g;
  text = text.replace(reCommaList, (full, name: string, inside: string) => (collect(name, inside) ? ";" : full));

  if (!arrays.size) return { text, arrays: 0 };

  // Pass B — accessor functions: function _0x4(a){return _0x2[a-1];} (the
  // classic obfuscator.io shape — a SEPARATE lookup fn, sometimes aliased
  // through chains) plus the rare direct array-as-function. Resolved iteratively
  // (alias → alias → array), loop-free via a seen-set. Eval-free.
  const bodies: { name: string; p: string; body: string }[] = [];
  const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\s*(?:,\s*[A-Za-z_$][\w$]*)?\s*\)\s*\{([\s\S]{0,600}?)\}/g;
  let fm: RegExpExecArray | null;
  while ((fm = fnRe.exec(text))) bodies.push({ name: fm[1], p: fm[2], body: fm[3] });
  const accessors = new Map<string, { arr: string; off: number }>();
  const resolveAccessor = (name: string, seen = new Set<string>()): { arr: string; off: number } | null => {
    if (accessors.has(name)) return accessors.get(name) as { arr: string; off: number };
    if (seen.has(name)) return null;
    seen.add(name);
    const b = bodies.find((x) => x.name === name);
    if (!b) return null;
    const escP = b.p.replace(/\$/g, "\\$");
    // Self-reassignment `e = e - 0x1;` inside the body shifts every later use
    // of the parameter by that offset (obfuscator.io emits this constantly).
    let selfShift = 0;
    const self = b.body.match(new RegExp(`${escP}\\s*=\\s*${escP}\\s*([-+])\\s*(0x[0-9a-fA-F]+|\\d+)`));
    if (self) selfShift = self[1] === "-" ? -parseNum(self[2]) : parseNum(self[2]);
    for (const arr of arrays.keys()) {
      const escA = arr.replace(/\$/g, "\\$");
      const m =
        b.body.match(new RegExp(`return\\s+${escA}\\s*\\[\\s*(?:parseInt\\s*\\(\\s*)?${escP}\\s*(?:([-+])\\s*(0x[0-9a-fA-F]+|\\d+))?`)) ||
        b.body.match(new RegExp(`return\\s+${escA}\\s*\\[\\s*${escP}\\s*([-+])\\s*(0x[0-9a-fA-F]+|\\d+)`));
      if (m) {
        const off = m[2] ? (m[1] === "-" ? -parseNum(m[2]) : parseNum(m[2])) : 0;
        const info = { arr, off: off + selfShift };
        accessors.set(name, info);
        return info;
      }
    }
    const am = b.body.match(new RegExp(`return\\s+([A-Za-z_$][\\w$]*)\\s*\\(\\s*${escP}\\s*(?:([-+])\\s*(0x[0-9a-fA-F]+|\\d+))?`));
    if (am && am[1] !== name) {
      const inner = resolveAccessor(am[1], seen);
      if (inner) {
        const extra = am[2] ? (am[2] === "-" ? -parseNum(am[3]) : parseNum(am[3])) : 0;
        const info = { arr: inner.arr, off: inner.off + extra + selfShift };
        accessors.set(name, info);
        return info;
      }
    }
    return null;
  };
  for (const b of bodies) resolveAccessor(b.name);
  for (const [name, info] of accessors) {
    const elems = arrays.get(info.arr);
    if (!elems) continue;
    const pat = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\s*\\(\\s*(\\d{1,7})\\s*\\)`, "g");
    text = text.replace(pat, (_full, num: string) => {
      const idx = Number(num) + info.off;
      return idx >= 0 && idx < elems.length ? JSON.stringify(elems[idx]) : "undefined";
    });
  }

  // Pass C — member/index access: arr[0], arr["0"], arr.at(0).
  for (const [name, elems] of arrays) {
    const esc = name.replace(/\$/g, "\\$");
    const resolve = (num: string): string | null => {
      const i = Number(num);
      return Number.isInteger(i) && i >= 0 && i < elems.length ? JSON.stringify(elems[i]) : null;
    };
    text = text.replace(new RegExp(`(?<![\\w$])${esc}\\s*\\[\\s*["']?(\\d{1,7})["']?\\s*\\]`, "g"), (_f, num: string) => resolve(num) ?? _f);
    text = text.replace(new RegExp(`(?<![\\w$.])${esc}\\s*\\.\\s*at\\s*\\(\\s*(\\d{1,7})\\s*\\)`, "g"), (_f, num: string) => resolve(num) ?? _f);
  }

  // Pass D — remaining bare identifier references (alias chains resolved
  // iteratively, loop-free).
  for (let round = 0; round < 4 && arrays.size; round++) {
    let changed = false;
    for (const [name, elems] of arrays) {
      const esc = name.replace(/\$/g, "\\$");
      const pat = new RegExp(`(?<![\\w$.])${esc}(?!\\s*\\()`, "g");
      text = text.replace(pat, () => {
        changed = true;
        return JSON.stringify(elems);
      });
    }
    // An array assigned wholesale to another var: var b = a; → b becomes an
    // array too (bounded — only first 4 alias rounds).
    const reAlias = /(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:"(?:[^"\\]|\\.)*"(?:\s*,\s*)?)+);?/g;
    if (changed) {
      let m: RegExpExecArray | null;
      while ((m = reAlias.exec(text))) {
        if (arrays.has(m[1])) continue;
        const strs = m[2].split(",").map((s) => s.trim()).filter((s) => /^".*"$/.test(s) || /^'.*'$/.test(s)).map((s) => s.slice(1, -1));
        if (strs.length >= 2 && strs.length <= MAX_ARRAY) {
          arrays.set(m[1], strs);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  return { text, arrays: arrays.size };
}

/** Fold string concat: 'a'+'b' → "ab", nested/many terms, unquoted `+` parts
 *  (numbers/identifiers are preserved, not joined). Exported + tested. */
export function foldConcats(text: string): string {
  let out = text;
  for (let pass = 0; pass < 8; pass++) {
    const squeezed = squeezePlus(out);
    let changed = false;

    // Three-term fold first ("a"+id+"c"), so head/tail literals anchor the
    // join — the WS sentinel keeps the identifier visible after folding.
    out = squeezed.replace(/"((?:[^"\\\n]|\\.)*)"\+([A-Za-z_$][\w$]*)\+"((?:[^"\\\n]|\\.)*)"/g, (_f, a: string, id: string, c: string) => {
      changed = true;
      return `"${a}§WS§${id}§WS§${c}"`;
    });
    out = out.replace(/'((?:[^'\\\n]|\\.)*)'\+([A-Za-z_$][\w$]*)\+'((?:[^'\\\n]|\\.)*)'/g, (_f, a: string, id: string, c: string) => {
      changed = true;
      return `'${a}§WS§${id}§WS§${c}'`;
    });

    // Two-term folds. The "many terms" case folds pairwise per pass.
    out = out.replace(/"((?:[^"\\\n]|\\.)*)"\s*\+\s*"((?:[^"\\\n]|\\.)*)"/g, (_f, a: string, b: string) => {
      changed = true;
      return `"${a}${b}"`;
    });
    out = out.replace(/'((?:[^'\\\n]|\\.)*)'\s*\+\s*'((?:[^'\\\n]|\\.)*)'/g, (_f, a: string, b: string) => {
      changed = true;
      return `'${a}${b}'`;
    });

    if (!changed) {
      out = squeezed;
      break;
    }
  }
  return out.replaceAll("§WS§", " + ");
}

/** foldConcats over the WHOLE text (identifiers unquoted + parts). */
export function foldConcatsText(text: string): string {
  return foldConcats(text);
}

/** Endpoint-shaped string: path, query, or full URL. No binary/img/fonts. */
export function isPathLike(s: string): boolean {
  if (!s || s.length < 2 || s.length > 400) return false;
  if (!/^[/?#]|^https?:\/\//i.test(s)) return false;
  if (/\.(png|jpe?g|gif|svg|css|woff2?|ttf|ico|map|webp|mp4|webm|mp3|wasm|onnx)$/i.test(s)) return false;
  if (/[\s<>"'`{}]/.test(s)) return false;
  return true;
}

/** URL of an adjacent source map for a bundle URL (pure). */
export function findSourceMapUrl(bundleUrl: string, body: string): string | null {
  const inline = body.match(/\/\*[#@]\s*sourceMappingURL=(\S+?)\s*\*\/\s*$/);
  if (inline) {
    try {
      return new URL(inline[1], bundleUrl).toString();
    } catch {
      return null;
    }
  }
  if (/\.m?js(\?|$)/i.test(bundleUrl)) {
    return bundleUrl.replace(/\.m?js(\?|$)/i, ".js.map$1");
  }
  return null;
}

/** Honest minification hint: a bundle is "minified" when it has few newlines
 *  relative to its size (single-line bundles: >300 chars/line) OR very long
 *  average lines. */
export function looksMinified(s: string): boolean {
  const lines = s.split("\n").length;
  const avg = s.length / Math.max(1, lines);
  return avg > 300;
}

/** Detect leftover obfuscation signals after deobfuscation. */
export function hasDeobfSignal(s: string): boolean {
  if (/_0x[0-9a-f]{4,}/i.test(s)) return true;
  if (/\\x[0-9a-fA-F]{2}/.test(s)) return true;
  return false;
}

/** De-dup preserving order. */
export function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

const SOURCEMAP_HINT =
  "\n💡 Cek manual: file .map yang ter-publish memulihkan source asli (temuan klasik Information Disclosure, CWE-540) — sarankan hapus *.map dari deploy.";

// ── Orchestrator (network, scope-gated) ─────────────────────────────────────

export async function deobfuscateAndMine(rawUser: unknown, urlRaw: string): Promise<string> {
  const raw = (urlRaw || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: URL harus http(s).";
  if (!targetAllowed(raw)) return "Error: SCOPE — js_deobfuscate hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return "Error: URL tidak valid.";
  }
  const origin = base.origin;

  // Collect JS urls — same rule as js_mine: direct .js is ALWAYS a bundle.
  const jsUrls = new Set<string>();
  const html = await getText(raw, 900_000);
  if (/\.m?jsx?(\?|$)/i.test(base.pathname)) {
    jsUrls.add(raw);
  } else if (html && /<script|<!doctype|<html/i.test(html)) {
    for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
      try {
        const u = new URL(m[1], raw);
        if (u.origin === origin) jsUrls.add(u.toString());
      } catch {
        /* skip */
      }
    }
  }
  if (!jsUrls.size) {
    return `Tidak menemukan file JS di ${raw}. (Arahkan langsung ke file .js, atau ke halaman HTML yang memuat script.)`;
  }

  const endpoints = new Set<string>();
  const secrets: string[] = [];
  const mapHits: string[] = [];
  let minified = 0;

  const jobs = [...jsUrls].slice(0, 8);
  for (const js of jobs) {
    const body = await getText(js, 900_000);
    if (!body) continue;
    const name = new URL(js).pathname.split("/").pop() || js;
    if (looksMinified(body)) minified++;
    await politeDelay();

    // 1) Adjacent source map — restore ORIGINAL sources when published.
    const mapUrl = findSourceMapUrl(js, body);
    let mapRestored = false;
    if (mapUrl) {
      const mapText = await getText(mapUrl, 4_000_000);
      if (mapText) {
        try {
          const map = JSON.parse(mapText) as { sources?: unknown; sourcesContent?: unknown };
          const sources = Array.isArray(map.sources) ? (map.sources as unknown[]).filter((s): s is string => typeof s === "string") : [];
          const contents = Array.isArray(map.sourcesContent) ? (map.sourcesContent as unknown[]) : [];
          if (sources.length) {
            mapHits.push(name);
            mapRestored = true;
            const n = Math.min(sources.length, 120);
            for (let i = 0; i < n; i++) {
              const src = typeof contents[i] === "string" ? (contents[i] as string) : null;
              if (!src || src.length > 900_000) continue;
              const file = (sources[i] || `src-${i}`).split("/").pop() || `src-${i}`;
              for (const m of src.matchAll(/["'`](\/[A-Za-z0-9_\-./]{2,}(?:\?[^"'`\s]*)?)["'`]/g)) {
                if (isPathLike(m[1])) endpoints.add(`${m[1]}  ← ${file}`);
              }
              for (const h of scanTextSecrets(src, 40)) secrets.push(`${file}:${h.line} — ${h.type}`);
            }
          }
        } catch {
          /* not JSON — ignore */
        }
      }
    }

    // 2) Eval-free deobfuscation of the bundle text itself.
    let work = body;
    let deobfNote = "";
    if (!mapRestored) {
      const d = deobfuscate(work);
      work = d.text;
      const folded = foldConcatsText(work);
      if (folded.length <= 1_200_000) work = folded;
      deobfNote = d.arrays > 0 ? ` (deobf: ${d.arrays} string-array)` : "";
    }

    // 3) Mine the (possibly restored/deobfuscated) text.
    for (const m of work.matchAll(/["'`](\/[A-Za-z0-9_\-./]{2,}(?:\?[^"'`\s]*)?)["'`]/g)) {
      if (isPathLike(m[1])) endpoints.add(m[1]);
    }
    for (const m of work.matchAll(/(?:https?:)?\/\/[A-Za-z0-9._-]+\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/g)) {
      try {
        const u = new URL(m[0], js);
        if (u.origin === origin) endpoints.add(u.pathname + u.search);
      } catch {
        /* skip */
      }
    }
    for (const h of scanTextSecrets(work, 40)) secrets.push(`${name}:${h.line} — ${h.type}${deobfNote}`);
  }

  const eps = [...endpoints].slice(0, 80);
  const parts = [
    `🧩 JS DEOBFUSCATE ${origin} — ${jsUrls.size} JS, ${eps.length} endpoint, ${secrets.length} indikasi secret.`,
  ];
  if (mapHits.length) parts.push(`\n🗺️ Source map terbuka (RESTORED source asli): ${dedupe(mapHits).join(", ")}`);
  if (minified) parts.push(`\n📦 ${minified} bundle minified terdeteksi.`);
  if (eps.length) parts.push(`\n🔗 Endpoint:\n${eps.map((e) => `• ${e}`).join("\n")}`);
  if (secrets.length) parts.push(`\n🔐 Secret terdeteksi (nilai di-redact):\n${dedupe(secrets).slice(0, 40).map((s) => `• ${s}`).join("\n")}`);
  if (!mapHits.length) parts.push(SOURCEMAP_HINT);
  parts.push("\nLanjut: uji endpoint ber-parameter (param_fuzz/workflow_fuzz). Secret → WAJIB rotate + finding_add.");
  return parts.join("\n");
}
