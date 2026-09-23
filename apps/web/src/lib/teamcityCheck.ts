// teamcityCheck.ts — safe version-fingerprint detector for CVE-2026-63077.
//
// JetBrains TeamCity On-Premises < 2026.1.3 / < 2025.11.7: unauthenticated RCE
// (CVSS 9.8, CWE-502, CISA KEV — actively exploited) via the agent polling
// protocol (/app/agents/v1/register → /app/agents/v1/commands/error,
// XStream deserialization → HSQLDB SCRIPT writes a .jspws → RCE).
//
// This tool NEVER sends exploit traffic: it fetches the login page (and root
// fallback), confirms TeamCity markers, extracts the advertised version, and
// compares it against the two published fixed lines. Version-match against an
// unpatched line IS the evidence (patch-management finding) — there is
// nothing safe left to "prove" by replay, and replaying would BE the exploit,
// so this tool stops at detection by design. Finding → finding_add (CWE-502)
// + remediation (upgrade); never poc_verify with payloads here.
// Scope-gated, bounded (<=2 page fetches). Risk read (same invasiveness as
// tls_check: plain GETs, no state change) → auto, no confirmation.

import { targetAllowed, politeDelay } from "./security";

export interface TeamCityVersion {
  year: number;
  minor: number;
  patch: number;
  raw: string;
  build?: string;
}

export type TeamCityVerdict = "VULNERABLE" | "PATCHED" | "UNKNOWN" | "NOT_TEAMCity";

const KNOWN_CVE = "CVE-2026-63077";

/**
 * Extract an advertised TeamCity version from page HTML. TeamCity's login
 * page carries strings like "TeamCity 2026.1.2 (build 166000)" or
 * "Version 2025.11.7". Pure — unit-tested.
 */
export function parseTeamCityVersion(html: string): TeamCityVersion | null {
  const text = String(html || "");
  const patterns = [
    /TeamCity\s+(?:Professional\s+|Enterprise\s+)?(\d{4})\.(\d{1,2})(?:\.(\d{1,3}))?/i,
    /[Vv]ersion\s*[:\s]+(\d{4})\.(\d{1,2})(?:\.(\d{1,3}))?/,
    /teamcity-(\d{4})\.(\d{1,2})(?:\.(\d{1,3}))?/i,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (m) {
      const build = /[Bb]uild\s+(\d{5,7})/.exec(text);
      return {
        year: Number(m[1]),
        minor: Number(m[2]),
        patch: m[3] !== undefined ? Number(m[3]) : 0,
        raw: m[0].slice(0, 80),
        ...(build ? { build: build[1] } : {}),
      };
    }
  }
  return null;
}

/** Numeric triple compare. Pure — unit-tested. */
export function cmpTeamCityVersion(
  a: Pick<TeamCityVersion, "year" | "minor" | "patch">,
  b: Pick<TeamCityVersion, "year" | "minor" | "patch">
): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

const FIX_2026_1 = { year: 2026, minor: 1, patch: 3 };
const FIX_2025_11 = { year: 2025, minor: 11, patch: 7 };

/**
 * Assess a parsed version against the two published fixed lines. Pure —
 * unit-tested. Lines older than 2025.11 have no published patch → treated as
 * VULNERABLE (unpatched), said honestly in the reason.
 */
export function assessTeamCityVersion(v: TeamCityVersion): {
  verdict: Exclude<TeamCityVerdict, "NOT_TEAMCity">;
  reason: string;
} {
  const ym = { year: v.year, minor: v.minor, patch: 0 };
  if (v.year === 2026 && v.minor === 1) {
    return v.patch >= 3
      ? { verdict: "PATCHED", reason: `${v.year}.${v.minor}.${v.patch} >= garis patch 2026.1.3 — aman untuk ${KNOWN_CVE}.` }
      : { verdict: "VULNERABLE", reason: `${v.year}.${v.minor}.${v.patch} < 2026.1.3 — RENTAN ${KNOWN_CVE} (RCE unauth, CVSS 9.8).` };
  }
  if (v.year === 2025 && v.minor === 11) {
    return v.patch >= 7
      ? { verdict: "PATCHED", reason: `${v.year}.${v.minor}.${v.patch} >= garis patch 2025.11.7 — aman untuk ${KNOWN_CVE}.` }
      : { verdict: "VULNERABLE", reason: `${v.year}.${v.minor}.${v.patch} < 2025.11.7 — RENTAN ${KNOWN_CVE} (RCE unauth, CVSS 9.8).` };
  }
  if (cmpTeamCityVersion(ym, { year: 2026, minor: 1, patch: 0 }) > 0) {
    return {
      verdict: "PATCHED",
      reason: `jalur ${v.year}.${v.minor} lebih baru dari semua garis patch terbit — diasumsikan membawa patch ${KNOWN_CVE}.`,
    };
  }
  return {
    verdict: "VULNERABLE",
    reason: `jalur ${v.year}.${v.minor}.${v.patch} di bawah semua garis patch terbit (2025.11.7 / 2026.1.3) — tidak ada patch untuk jalur ini, anggap RENTAN ${KNOWN_CVE} sampai advisory berkata lain.`,
  };
}

/** TeamCity page markers (login page carries these). Pure — unit-tested. */
export function isTeamCityPage(html: string): boolean {
  const text = String(html || "");
  if (!/teamcity/i.test(text)) return false;
  return (
    /\/app\/agents/i.test(text) ||
    /buildServer/i.test(text) ||
    /jetbrains/i.test(text) ||
    /login\.html/i.test(text) ||
    /TeamCity\s+(Professional|Enterprise|\d{4})/i.test(text)
  );
}

async function fetchPage(url: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "mia-assistant/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await res.text()).slice(0, 60_000);
    return { status: res.status, body };
  } catch {
    return { status: 0, body: "" };
  }
}

/**
 * Fingerprint a target for CVE-2026-63077 exposure. Detection only — no
 * exploit traffic is ever sent (no /app/agents/v1/* POSTs). Scope-gated.
 */
export async function teamcityCheck(
  rawUser: unknown,
  opts: { url?: string } = {}
): Promise<string> {
  void rawUser;
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw))
    return `Error: SCOPE — teamcity_check hanya untuk lab / engagement aktif.`;
  let origin = "";
  try {
    origin = new URL(raw).origin;
  } catch {
    return "Error: URL tidak valid.";
  }
  await politeDelay();
  let page = await fetchPage(`${origin}/login.html`);
  if (page.status === 0 || page.status >= 400 || !page.body) {
    await politeDelay();
    page = await fetchPage(`${origin}/`);
  }
  const lines: string[] = [`🎯 TEAMCITY CHECK ${origin} — deteksi ${KNOWN_CVE} (tanpa exploit, hanya fingerprint versi).`];
  if (page.status === 0) {
    lines.push("Target tak terjangkau — bukan temuan.");
    return lines.join("\n");
  }
  if (!isTeamCityPage(page.body)) {
    lines.push(`Bukan TeamCity (HTTP ${page.status}, tanpa marker TeamCity) — bukan temuan untuk CVE ini.`);
    return lines.join("\n");
  }
  const ver = parseTeamCityVersion(page.body);
  if (!ver) {
    lines.push(
      `TeamCity TERDETEKSI tapi versi tak terbaca (HTTP ${page.status}) — TAK DIKETAHUI. ` +
        `Cek manual: baca versi di halaman login, bandingkan dengan garis patch 2025.11.7 / 2026.1.3.`
    );
    return lines.join("\n");
  }
  const a = assessTeamCityVersion(ver);
  lines.push(`• versi: ${ver.year}.${ver.minor}.${ver.patch}${ver.build ? ` (build ${ver.build})` : ""} — "${ver.raw}"`);
  if (a.verdict === "VULNERABLE") {
    lines.push(
      `• ⛔ RENTAN ${KNOWN_CVE} — ${a.reason}`,
      `• finding_add: CWE-502, CVSS 9.8, vector CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H — version-match = bukti (tak perlu replay; replay = exploit).`,
      `• remediasi: upgrade TeamCity ke ≥2026.1.3 (jalur 2026.1) atau ≥2025.11.7 (jalur 2025.11); CISA KEV — patch segera, CVE ini dieksploitasi aktif.`,
      `• referensi: NVD ${KNOWN_CVE} · JetBrains advisory 2026-07 · Rapid7 analysis 2026-08-07.`
    );
  } else {
    lines.push(`• ✅ AMAN untuk ${KNOWN_CVE} — ${a.reason}`);
  }
  return lines.join("\n");
}
