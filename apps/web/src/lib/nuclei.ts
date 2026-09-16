/**
 * Nuclei Custom — bug-bounty power for Mia.
 * Runs nuclei with custom severity/tags/templates, scope-gated.
 * Own lab / RFC1918 / engagement scope only (via targetAllowed).
 * Uses spawn with ignore-stdin so nuclei never hangs on pipe.
 */
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { normalizeUrlTarget, targetAllowed } from "./security";
import { resolveInSandbox } from "./users";

const ALLOWED_SEV = new Set(["critical", "high", "medium", "low", "info", "unknown"]);

function runCapture(bin: string, args: string[], timeoutMs: number, maxBytes = 2 * 1024 * 1024): Promise<{ out: string; enoent: boolean; timedOut: boolean; err?: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ out: "", enoent: (e as NodeJS.ErrnoException).code === "ENOENT", timedOut: false, err: e instanceof Error ? e.message : String(e) });
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
      const code = (e as NodeJS.ErrnoException).code;
      resolve({ out, enoent: code === "ENOENT", timedOut, err: e instanceof Error ? e.message : String(e) });
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ out, enoent: false, timedOut });
    });
  });
}

export function normalizeSeverity(raw: string): string | null {
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((p) => !ALLOWED_SEV.has(p))) return null;
  // dedupe preserving order
  return [...new Set(parts)].join(",");
}

export function validateTags(raw: string): boolean {
  return normalizeTags(raw) !== null;
}

/**
 * Normalize a tag list: split on commas AND spaces, validate each token. Fixes
 * the old behaviour that silently glued space-separated tags into one wrong tag
 * ("xss sqli" → "xsssqli"). Returns the comma-joined value, or null if invalid.
 */
export function normalizeTags(raw: string): string | null {
  const tokens = (raw || "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!tokens.length || raw.length > 200) return null;
  if (tokens.some((t) => !/^[a-z0-9_-]+$/i.test(t))) return null;
  return [...new Set(tokens)].join(",");
}

export function parseNucleiSeverityCounts(output: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const line of output.split("\n")) {
    const m = /\[(\s*critical|\s*high|\s*medium|\s*low|\s*info|\s*unknown)\s*\]/i.exec(line);
    if (!m) continue;
    const sev = m[1].trim().toLowerCase();
    counts[sev] = (counts[sev] || 0) + 1;
  }
  return counts;
}

export function summarizeNucleiOutput(output: string, maxLines = 50): string {
  const lines = output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const counts = parseNucleiSeverityCounts(output);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return output.slice(0, 6000) || "(tanpa temuan)";
  const summary = Object.entries(counts)
    .sort((a, b) => {
      const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4, unknown: 5 };
      return (order[a[0]] ?? 9) - (order[b[0]] ?? 9);
    })
    .map(([k, v]) => `${k}:${v}`)
    .join(" ");
  const top = lines.slice(0, maxLines).join("\n");
  return `🔍 Nuclei — ${total} temuan (${summary})\n${top}${lines.length > maxLines ? `\n… +${lines.length - maxLines} baris lagi` : ""}`;
}

/** Pure: build nuclei argv for inspection/tests (no execution). */
export function nucleiArgv(opts: { target: string; severity?: string; tags?: string; templates?: string }): string[] | null {
  const target = (opts.target || "").trim();
  if (!target) return null;
  const url = normalizeUrlTarget(target);
  const sev = opts.severity ? normalizeSeverity(opts.severity) : "critical,high,medium";
  if (opts.severity && !sev) return null;
  const tags = opts.tags ? normalizeTags(opts.tags) : null;
  if (opts.tags && !tags) return null;
  let tpl: string | null = null;
  if (opts.templates) {
    const resolved = resolveInSandbox(opts.templates.trim());
    if (!resolved) return null;
    if (!existsSync(resolved)) return null;
    tpl = resolved;
  }

  const args: string[] = ["-u", url, "-silent", "-no-color", "-no-interactsh", "-duc", "-timeout", "5", "-rl", "150", "-nc"];
  if (tpl) {
    // custom templates take precedence over automatic scan
    args.push("-t", tpl);
  } else {
    args.push("-as");
  }
  if (sev) args.push("-severity", sev);
  if (tags) args.push("-tags", tags);
  return args;
}

export async function nucleiCustom(opts: { target: string; severity?: string; tags?: string; templates?: string }): Promise<string> {
  const target = (opts.target || "").trim();
  if (!target) return Promise.reject(new Error("target wajib diisi"));
  if (!targetAllowed(target)) {
    return Promise.reject(new Error("SCOPE: nuclei_custom hanya untuk localhost/lab, host di engagement aktif, atau PENTEST_LAB_TARGETS. Buat engagement dulu untuk host bounty in-scope."));
  }
  if (opts.severity) {
    const sev = normalizeSeverity(opts.severity);
    if (!sev) return Promise.reject(new Error("severity tidak valid — pakai kombinasi critical,high,medium,low,info,unknown (mis. \"critical,high\")"));
  }
  let tags: string | null = null;
  if (opts.tags) {
    tags = normalizeTags(opts.tags);
    if (!tags) return Promise.reject(new Error("tags tidak valid — hanya huruf/angka/,_- (mis. \"xss,sqli\")"));
  }
  let tplResolved: string | null = null;
  if (opts.templates) {
    const p = opts.templates.trim();
    if (!p) return Promise.reject(new Error("templates kosong"));
    const resolved = resolveInSandbox(p);
    if (!resolved) return Promise.reject(new Error("templates di luar sandbox"));
    if (!existsSync(resolved)) return Promise.reject(new Error(`templates tidak ditemukan: ${p}`));
    try {
      const st = statSync(resolved);
      if (!st.isFile() && !st.isDirectory()) return Promise.reject(new Error("templates harus file .yaml atau direktori"));
      if (st.isFile() && !/\.ya?ml$/i.test(resolved)) return Promise.reject(new Error("templates file harus .yaml/.yml"));
    } catch {
      return Promise.reject(new Error("templates tidak bisa dibaca"));
    }
    tplResolved = resolved;
  }

  const url = normalizeUrlTarget(target);
  const sev = opts.severity ? normalizeSeverity(opts.severity)! : "critical,high,medium";
  const args: string[] = ["-u", url, "-silent", "-no-color", "-no-interactsh", "-duc", "-timeout", "5", "-rl", "150", "-nc"];
  if (tplResolved) {
    args.push("-t", tplResolved);
  } else {
    args.push("-as");
  }
  args.push("-severity", sev);
  if (tags) args.push("-tags", tags);

  const { out, enoent, timedOut, err } = await runCapture("nuclei", args, 180_000);
  if (enoent) return "Error: nuclei belum terpasang — `brew install nuclei` lalu `nuclei -update-templates`";
  const o = out.trim();
  // A non-ENOENT spawn failure (EACCES, bad binary, missing lib) must NOT be
  // reported as "no findings" — that would claim a clean scan that never ran.
  if (!o && err) return `Error: gagal menjalankan nuclei — ${err}`;
  if (timedOut && !o) return `⏱️ nuclei timeout (180s) tanpa temuan — coba target lebih spesifik atau turunkan scope.`;
  if (!o) return `(nuclei selesai, tanpa temuan pada ${target} — severity ${sev}${tags ? ` tags ${tags}` : ""}${tplResolved ? ` templates ${opts.templates}` : " (auto-scan)"})`;
  const summary = summarizeNucleiOutput(o);
  const body = o.slice(0, 6000);
  // Keep summary + raw body (truncated) — model can call finding_add per line.
  return `🎯 nuclei_custom ${target} (severity ${sev}${tags ? ` tags ${tags}` : ""}${tplResolved ? ` templates ${opts.templates}` : " auto"}) \n${summary}\n\n${body}`;
}

export function nucleiUpdateHint(): string {
  return "Jalankan `nuclei -update-templates` untuk memperbarui template community (butuh internet).";
}
