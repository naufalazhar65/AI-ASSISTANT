// CVE / exploit intel — keyless. NVD keyword search (public API) + optional
// searchsploit (Exploit-DB) if the binary is installed. Passive lookup only.
import { execFile } from "node:child_process";

function run(bin: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as NodeJS.ErrnoException | null;
      if (e && e.code === "ENOENT") return resolve({ ok: false, out: "" });
      resolve({ ok: !e || !!stdout, out: `${stdout || ""}${stderr || ""}`.trim() });
    });
  });
}

type NvdCve = { id?: string; descriptions?: { lang?: string; value?: string }[]; metrics?: Record<string, { cvssData?: { baseScore?: number } }[]> };

export async function cveIntel(query: string): Promise<string> {
  const q = (query || "").trim();
  if (!q) return "Error: beri `query` (nama produk/versi/keyword, mis. 'apache 2.4.7').";
  const parts: string[] = [];

  try {
    const res = await fetch(`https://services.nvd.nist.gov/rest/json/cves/2.0?keywordSearch=${encodeURIComponent(q)}&resultsPerPage=10`, {
      headers: { "User-Agent": "mia-assistant/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) {
      const j = (await res.json()) as { vulnerabilities?: { cve?: NvdCve }[] };
      const rows = (j.vulnerabilities || []).map((v) => v.cve).filter((c): c is NvdCve => !!c);
      if (rows.length) {
        const lines = rows.slice(0, 10).map((c) => {
          const score = c.metrics?.cvssMetricV31?.[0]?.cvssData?.baseScore ?? c.metrics?.cvssMetricV30?.[0]?.cvssData?.baseScore ?? c.metrics?.cvssMetricV2?.[0]?.cvssData?.baseScore;
          const desc = (c.descriptions || []).find((d) => d.lang === "en")?.value || "";
          return `• ${c.id}${score != null ? ` (CVSS ${score})` : ""} — ${desc.replace(/\s+/g, " ").slice(0, 170)}`;
        });
        parts.push(`📚 NVD (${rows.length}):\n${lines.join("\n")}`);
      } else {
        parts.push("📚 NVD: tidak ada CVE cocok.");
      }
    } else {
      parts.push(`📚 NVD: HTTP ${res.status} (rate-limit? coba lagi sebentar).`);
    }
  } catch (e) {
    parts.push(`📚 NVD: gagal (${e instanceof Error ? e.message : String(e)}).`);
  }

  const ss = await run("searchsploit", ["--json", q]);
  if (!ss.ok && !ss.out) {
    parts.push("💥 searchsploit belum terpasang (`brew install exploitdb`) — opsional untuk PoC lokal.");
  } else if (ss.out) {
    try {
      const j = JSON.parse(ss.out) as { RESULTS_EXPLOIT?: { Title?: string; Path?: string }[] };
      const rows = j.RESULTS_EXPLOIT || [];
      parts.push(`💥 searchsploit (${rows.length}):\n${rows.slice(0, 10).map((x) => `• ${x.Title} — ${x.Path}`).join("\n") || "(kosong)"}`);
    } catch {
      parts.push("💥 searchsploit: output tak terbaca.");
    }
  }

  return `🔎 CVE intel: ${q}\n\n${parts.join("\n\n")}\n\n⚠️ Cocokkan versi persis sebelum menyimpulkan rentan (fingerprint dulu).`;
}
