// Evidence capture for reports — save a raw HTTP request/response and/or a
// full-page screenshot to .data/users/<user>/reports/evidence/. Scope-gated:
// active contact with the target only (lab/engagement/PENTEST_LAB_TARGETS).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";
import { targetAllowed } from "./security";

export async function evidenceCapture(
  rawUser: unknown,
  opts: { url?: string; request?: { url: string; method?: string; headers?: Record<string, string>; body?: string } }
): Promise<string> {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  const dir = join(userDataRoot(), userKey, "reports", "evidence");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out: string[] = [];

  if (opts.request?.url) {
    const u = opts.request.url.trim();
    if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
    if (!targetAllowed(u)) return "Error: SCOPE — evidence request hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
    const method = (opts.request.method || "GET").toUpperCase();
    try {
      const res = await fetch(u, {
        method,
        headers: { "User-Agent": "mia-assistant/1.0", ...(opts.request.headers || {}) },
        body: method === "GET" || method === "HEAD" ? undefined : opts.request.body,
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.text()).slice(0, 200_000);
      const raw = `# REQUEST\n${method} ${u}\n${Object.entries(opts.request.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${opts.request.body || ""}\n\n# RESPONSE ${res.status} ${res.statusText}\n${[...res.headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n")}\n\n${body}`;
      const f = join(dir, `http-${stamp}.txt`);
      writeFileSync(f, raw);
      out.push(`• raw HTTP: ${f}`);
    } catch (e) {
      out.push(`• raw HTTP gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (opts.url?.trim()) {
    const u = opts.url.trim();
    if (!/^https?:\/\//i.test(u)) return "Error: URL harus http(s).";
    if (!targetAllowed(u)) return "Error: SCOPE — evidence screenshot hanya untuk lab / engagement aktif / PENTEST_LAB_TARGETS.";
    try {
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        await page.goto(u, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForTimeout(1000);
        const f = join(dir, `shot-${stamp}.png`);
        await page.screenshot({ path: f, fullPage: true });
        out.push(`• screenshot: ${f}`);
      } finally {
        await browser.close().catch(() => {});
      }
    } catch (e) {
      out.push(`• screenshot gagal: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (!out.length) return "Error: beri `url` (screenshot) dan/atau `request` (raw HTTP).";
  return `📎 Evidence tersimpan:\n${out.join("\n")}\n\nLampirkan path ini di finding evidence / laporan (report_generate).`;
}
