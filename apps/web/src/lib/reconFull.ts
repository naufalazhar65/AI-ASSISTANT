// reconFull.ts — one-shot attack-surface pipeline (recon_full).
//
// Runs the recon stages in ONE confirmation instead of 3–5 LLM rounds:
//  1. recon_subdomains(domain) — passive CT (skip untuk IP literal);
//  2. recon_httpx(domain) — host hidup;
//  3. recon_params(domain) — param arsip publik;
//  4. tech_watch(url) — fingerprint (tanpa CVE agar cepat; CVE via tech_watch manual);
//  5. exposure_hunt(url) — predictable resources;
//  6. content_discover(url) — endpoint + JS.
// Tiap tahap bounded + try/catch (satu tahap gagal tak menggugurkan lainnya),
// output dipotong jujur (cap per seksi + catatan truncate). Diakhiri peta
// prioritas host + langkah berikut (tool yang ter-delivery).
// Scope-gated via setiap primitif. Write — confirm (memicu probing aktif).

import { targetAllowed, politeDelay } from "./security";

const CAP = 12;

function capLines(text: string, max: number, label: string): string[] {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean).slice(0, max + 1);
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `… (+${lines.length - max} baris dipotong — lihat tool tahap itu langsung)`];
}

function isIpLiteral(host: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");
}

export async function reconFull(rawUser: unknown, opts: { target?: string } = {}): Promise<string> {
  const raw = String(opts.target || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: target harus URL http(s) (halaman/origin lab).";
  if (!targetAllowed(raw)) return "Error: SCOPE — recon_full hanya untuk lab / engagement aktif.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "Error: URL tidak valid.";
  }
  const origin = url.origin;
  const domain = url.hostname;
  const lines: string[] = [`🗺️ RECON FULL ${origin} — pipeline 1-konfirmasi (subdomain→httpx→params→tech→exposure→content).`];
  const call = async (label: string, fn: () => Promise<string>, max: number) => {
    try {
      await politeDelay();
      const out = await fn();
      if (/^Error:/.test(out.trim())) {
        lines.push(`\n━━ ${label} ━━\n⛔ ${out.split("\n")[0].slice(0, 160)}`);
        return;
      }
      lines.push(`\n━━ ${label} ━━`);
      lines.push(...capLines(out, max, label));
    } catch (e) {
      lines.push(`\n━━ ${label} ━━\n⛔ gagal: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  };

  if (isIpLiteral(domain)) {
    lines.push("\n━━ subdomains ━━\n⏭️ dilewati (IP literal — CT/hackertarget butuh nama domain).");
  } else {
    const { reconSubdomains } = await import("./recon");
    await call("subdomains (pasif)", () => reconSubdomains(rawUser, domain), CAP);
  }
  {
    const { reconHttpx } = await import("./recon");
    await call("httpx (host hidup)", () => reconHttpx(rawUser, domain), CAP);
  }
  if (!isIpLiteral(domain)) {
    const { reconParams } = await import("./recon");
    await call("params arsip", () => reconParams(rawUser, domain), 10);
  }
  {
    const { techWatch } = await import("./techWatch");
    await call("tech fingerprint", () => techWatch(rawUser, origin, { cve: false }), 8);
  }
  {
    const { exposureHunt } = await import("./exposureHunt");
    await call("exposure", () => exposureHunt(rawUser, { url: origin }), 12);
  }
  {
    const { contentDiscover } = await import("./recon");
    await call("content", () => contentDiscover(rawUser, raw), 15);
  }
  lines.push("");
  lines.push("Prioritas lanjut: endpoint ber-param → http_request satu per satu → poc_verify yang mencurigakan → finding_add; cek gap via target_brain action=coverage (bila ter-delivery) atau finding_list + hunt_log.");
  return lines.join("\n");
}
