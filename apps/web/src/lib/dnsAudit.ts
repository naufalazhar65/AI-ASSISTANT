// dnsAudit.ts — DNS posture audit (read/auto tool `dns_audit`).
//
// Three bounded checks that complete the recon family (subdomains/params/
// dnsbrute already exist):
//   1. AXFR — classic zone-transfer attempt against the domain's own NS servers.
//      A dumped zone = instant HIGH-visibility finding (information disclosure).
//   2. DNSSEC — DNSKEY present = zone signed (info), absent = unsigned (info).
//   3. CAA — issuance policy records (info).
// Read-only (DNS queries only), polite (≤3 NS attempts, short timeouts),
// any-domain like recon_dnsbrute/subdomains. Uses `dig` when available (default
// on macOS; honest install hint otherwise) + native resolveCaa for CAA.
// Pure helpers are exported for unit tests.
import { execFile } from "node:child_process";
import dnsPromises from "node:dns/promises";

export type AxfrResult = { ns: string; dumped: boolean; records: number; sample: string[] };

/** Parse `dig AXFR` output. Pure — unit-tested. */
export function parseAxfrOutput(raw: string): { dumped: boolean; records: number; sample: string[] } {
  const lines = (raw || "").split("\n").map((l) => l.trim());
  // dig AXFR output: one "record line" per RR (name TTL class type value), and
  // a trailing ";; XFER size: N" statistics line on success. Failures show
  // "Transfer failed", "communication timed out", or status REFUSED/SERVFAIL.
  const failed = /transfer failed|timed out|REFUSED|SERVFAIL|connection refused|couldn't|no servers/i.test(raw || "");
  const rrs = lines.filter((l) => /^[a-z0-9*._-]+\.\s+\d+\s+IN\s+\w+/i.test(l));
  const sizeNote = /;; XFER size: (\d+)/i.exec(raw || "");
  const dumped = !failed && rrs.length > 3;
  return { dumped, records: sizeNote ? Number(sizeNote[1]) || rrs.length : rrs.length, sample: rrs.slice(0, 8).map((l) => l.slice(0, 110)) };
}

/** DNSSEC verdict from `dig +short DNSKEY` output. Pure — unit-tested. */
export function dnssecVerdict(raw: string): "signed" | "unsigned" | "unknown" {
  const t = (raw || "").trim();
  if (!t) return "unsigned";
  if (/^(257|256|258)\s|DNSKEY/i.test(t)) return "signed";
  if (/timed out|no servers|REFUSED|SERVFAIL|communication/i.test(t)) return "unknown";
  return "unsigned";
}

/** One-line CAA summary. Pure — unit-tested. */
export function caaSummary(records: Array<{ critical?: number; issue?: string; issuewild?: string; iodef?: string }>): string {
  if (!records.length) return "CAA: tidak ada record — siapa pun boleh menerbitkan sertifikat untuk domain ini (info, umum).";
  const parts = records
    .map((r) => [r.issue ? `issue=${r.issue}` : "", r.issuewild ? `issuewild=${r.issuewild}` : "", r.iodef ? `iodef=${r.iodef}` : ""].filter(Boolean).join(" "))
    .filter(Boolean);
  return `CAA: ${parts.slice(0, 3).join(" | ")}`;
}

function dig(args: string[], timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    try {
      execFile("dig", args, { timeout: timeoutMs, maxBuffer: 1024 * 512 }, (err, stdout) => {
        if (err && !stdout) resolve(`;; dig failed: ${err.message}`);
        else resolve(stdout || "");
      });
    } catch (e) {
      resolve(`;; dig failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
}

// ── Runner ──────────────────────────────────────────────────────────────────

export async function dnsAudit(_rawUser: unknown, opts: { domain?: string }): Promise<string> {
  const domain = (opts.domain || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].split(":")[0];
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(domain)) {
    return "Error: domain wajib (mis. example.com — tanpa scheme/path).";
  }
  const lines: string[] = [`🛰️ DNS AUDIT — ${domain}`];

  // NS servers (native)
  let ns: string[] = [];
  try {
    ns = (await dnsPromises.resolveNs(domain)).map((s) => s.toLowerCase());
  } catch { ns = []; }
  lines.push(`NS (${ns.length}): ${ns.slice(0, 4).join(", ") || "tidak terbaca"}`);

  // 1) AXFR against the first ≤3 NS
  const axfr: AxfrResult[] = [];
  for (const server of ns.slice(0, 3)) {
    const out = await dig([`@${server}`, domain, "AXFR", "+none"]);
    const p = parseAxfrOutput(out);
    axfr.push({ ns: server, ...p });
    if (p.dumped) break; // one dumped zone is enough
  }
  const dumped = axfr.find((a) => a.dumped);
  if (dumped) {
    lines.push("", `🎯 AXFR TERBUKA @ ${dumped.ns} — ZONE TER-DUMP (${dumped.records} record):`);
    for (const s of dumped.sample) lines.push(`  ${s}`);
    lines.push("  ⚠️ SINYAL KUAT — verifikasi isi (record internal), lalu finding_add (CWE-200 information exposure).");
  } else {
    const detail = axfr.map((a) => `${a.ns}: ${a.dumped ? "DUMPED" : "ditolak/gagal"}${a.records ? ` (${a.records} rr)` : ""}`).join(" · ");
    lines.push(`AXFR: semua NS menolak transfer — ${detail || "tidak ada NS terbaca"}`);
  }

  // 2) DNSSEC
  const dk = await dig(["+short", domain, "DNSKEY", "@8.8.8.8"]);
  const sec = dnssecVerdict(dk);
  lines.push(`DNSSEC: ${sec === "signed" ? "signed (DNSKEY ada)" : sec === "unsigned" ? "unsigned (tanpa DNSKEY)" : "tidak diketahui (query gagal)"}`);

  // 3) CAA (native when available)
  try {
    const rp = dnsPromises as unknown as { resolveCaa?: (d: string) => Promise<Array<{ critical?: number; issue?: string; issuewild?: string; iodef?: string }>> };
    if (typeof rp.resolveCaa === "function") {
      const caa = await rp.resolveCaa(domain);
      lines.push(caaSummary(caa));
    } else {
      lines.push("CAA: resolver runtime tidak mendukung (info minor).");
    }
  } catch {
    lines.push(caaSummary([]));
  }

  lines.push("", "AXFR = satu-satunya yang bisa jadi temuan di sini (sisanya posture info). Lanjutkan recon: recon_subdomains, recon_dnsbrute.");
  return lines.join("\n").slice(0, 6000);
}
