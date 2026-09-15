// Scope import — parse a bug-bounty program's in-scope / out-of-scope targets
// from pasted text (or a fetched policy page) into a ready engagement_create.
// Parsing is heuristic; the output always says to verify manually.
import { assertPublicUrl } from "./netGuard";

const HOST_RE = /(?<![a-z0-9])((?:\*\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,})\b/gi;
const OUT_HDR = /out[\s_-]?of[\s_-]?scope|excluded|not in scope|non-?scope|tidak termasuk/i;
const IN_HDR = /in[\s_-]?scope|targets?|assets?|allowed|scope:/i;

/** Pure parser: split hosts into in/out buckets by section headers. */
export function parseScopeText(text: string): { inScope: string[]; outOfScope: string[] } {
  const inSet = new Set<string>();
  const outSet = new Set<string>();
  let mode: "in" | "out" = "in";
  for (const line of (text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    // A short header line flips the mode — but still extract any host on it
    // (e.g. "targets: app.acme.com" is both a header and a target).
    if (t.length < 90 && OUT_HDR.test(t)) mode = "out";
    else if (t.length < 90 && IN_HDR.test(t)) mode = "in";
    for (const m of t.matchAll(HOST_RE)) {
      const h = m[1].toLowerCase().replace(/\.$/, "");
      if (/\.(png|jpe?g|gif|css|js|json|xml)$/.test(h)) continue; // filenames
      (mode === "out" ? outSet : inSet).add(h);
    }
  }
  for (const h of outSet) inSet.delete(h);
  return { inScope: [...inSet].sort(), outOfScope: [...outSet].sort() };
}

export async function scopeImport(opts: { text?: string; url?: string }): Promise<string> {
  let raw = (opts.text || "").trim();
  let source = "teks";
  if (!raw && opts.url) {
    const target = opts.url.trim();
    try {
      const u = assertPublicUrl(target);
      const res = await fetch(u.toString(), { redirect: "follow", headers: { "User-Agent": "mia-assistant/1.0" }, signal: AbortSignal.timeout(15_000) });
      raw = (await res.text()).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ");
      source = target;
    } catch (e) {
      return `Error: gagal ambil scope dari URL (${e instanceof Error ? e.message : String(e)}). Tempel teks scope-nya langsung (bagian Targets / In scope).`;
    }
  }
  if (!raw) return "Error: beri `text` (tempel daftar scope) atau `url` (halaman policy/targets publik).";
  const { inScope, outOfScope } = parseScopeText(raw);
  if (!inScope.length) return `Tidak menemukan host in-scope dari ${source}. Tempel bagian "Targets / In scope" apa adanya (satu target per baris).`;
  const scopeArr = inScope.map((h) => `"${h}"`).join(", ");
  const outArr = outOfScope.map((h) => `"${h}"`).join(", ");
  const eng = `engagement_create name="<nama program>" client="<klien/owner>" authorization="${source.startsWith("http") ? source : "<URL policy program>"}" scope=[${scopeArr}]${outOfScope.length ? ` out_of_scope=[${outArr}]` : ""}`;
  return [
    `📋 SCOPE (dari ${source})`,
    `In-scope (${inScope.length}):\n${inScope.map((h) => `• ${h}`).join("\n")}`,
    outOfScope.length ? `\nOut-of-scope (${outOfScope.length}):\n${outOfScope.map((h) => `• ${h}`).join("\n")}` : "",
    `\nDaftarkan (konfirmasi dulu): \`${eng}\``,
    "",
    "⚠️ Parsing heuristik — VERIFIKASI manual ke halaman Targets sebelum menguji (hindari salah scope/DQ).",
  ]
    .filter(Boolean)
    .join("\n");
}
