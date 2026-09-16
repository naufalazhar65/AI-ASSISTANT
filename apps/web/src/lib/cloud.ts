// Cloud storage misconfiguration checks (unauthenticated) — one of the most
// consistent bug-bounty payouts: an org's S3/GCS/Azure bucket, Firebase DB, or
// Supabase project left publicly readable.
//
// Authorization anchor: the checks run only when the caller gives a `base_domain`
// that an ACTIVE engagement covers (or a lab). Each candidate is derived from
// that org's name, so we only ever poke the target's OWN storage endpoints.
// Bounded (few candidates × few providers), read-only (GET/HEAD), low-rate.

import { engagementAllows } from "./engagement";
import { isLabTarget } from "./security";

const SALT = "abcdefghijklmnopqrstuvwxyz0123456789";
const TIMEOUT = 8000;
const MAX_BODY = 2500;

export type CloudProvider = "s3" | "gcs" | "azure" | "firebase" | "supabase";
const PROVIDERS: CloudProvider[] = ["s3", "gcs", "azure", "firebase", "supabase"];

/** Candidate bucket/project names derived from an org domain. Pure — unit-tested. */
export function cloudCandidates(baseDomain: string): string[] {
  const d = (baseDomain || "").trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");
  if (!d) return [];
  const labels = d.split(".");
  const first = labels[0] || "";
  const set = new Set<string>();
  if (first.length >= 3) set.add(first);
  if (first.length >= 3) set.add(first + "-assets");
  set.add(d.replace(/\./g, "-"));
  if (d.includes(".")) set.add(d); // S3 allows dotted names
  return [...set].filter((s) => /^[a-z0-9][a-z0-9.-]{1,60}$/.test(s)).slice(0, 4);
}

function endpoints(name: string, provider: CloudProvider): { label: string; url: string; kind: "s3" | "gcs" | "azure" | "firebase" | "supabase" }[] {
  switch (provider) {
    case "s3":
      return [
        { label: `${name}.s3.amazonaws.com`, url: `https://${name}.s3.amazonaws.com/`, kind: "s3" },
        { label: `s3.amazonaws.com/${name}`, url: `https://s3.amazonaws.com/${name}/`, kind: "s3" },
      ];
    case "gcs":
      return [
        { label: `storage.googleapis.com/${name}`, url: `https://storage.googleapis.com/${name}/`, kind: "gcs" },
        { label: `${name}.storage.googleapis.com`, url: `https://${name}.storage.googleapis.com/`, kind: "gcs" },
      ];
    case "azure":
      return [{ label: `${name}.blob.core.windows.net`, url: `https://${name}.blob.core.windows.net/?comp=list`, kind: "azure" }];
    case "firebase":
      return [
        { label: `${name}.firebaseio.com`, url: `https://${name}.firebaseio.com/.json?shallow=true`, kind: "firebase" },
        { label: `${name}-default-rtdb.firebaseio.com`, url: `https://${name}-default-rtdb.firebaseio.com/.json?shallow=true`, kind: "firebase" },
      ];
    case "supabase":
      return [{ label: `${name}.supabase.co`, url: `https://${name}.supabase.co/auth/v1/settings`, kind: "supabase" }];
  }
}

type Probe = { status: number; body: string; error?: string };

async function probe(url: string): Promise<Probe> {
  try {
    const res = await fetch(url, { method: "GET", headers: { "User-Agent": "mia-assistant/1.0" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    const body = (await res.text()).slice(0, MAX_BODY);
    return { status: res.status, body };
  } catch (e) {
    return { status: 0, body: "", error: e instanceof Error ? e.message : String(e) };
  }
}

/** Classify a probe into a verdict + lead text. Pure — unit-tested. */
export function classifyCloud(kind: "s3" | "gcs" | "azure" | "firebase" | "supabase", p: Probe): { verdict: string; lead: boolean } {
  const b = p.body || "";
  if (p.status === 0) return { verdict: `tak terjangkau (${p.error || "?"})`, lead: false };
  if (p.status === 404) return { verdict: "tidak ada", lead: false };
  if (p.status === 401 || p.status === 403) return { verdict: "privat/terkunci (401/403)", lead: false };
  if (kind === "firebase") {
    if (p.status === 200 && b.trim() !== "null" && !/Permission denied/i.test(b)) return { verdict: "🔥 REALTIME DB TERBUKA (baca publik)", lead: true };
    if (p.status === 200) return { verdict: "DB ada (null / aturan menolak)", lead: false };
    return { verdict: `status ${p.status}`, lead: false };
  }
  if (kind === "supabase") {
    if (p.status === 200) return { verdict: "endpoint auth publik (info; butuh anon key untuk data)", lead: false };
    return { verdict: `status ${p.status}`, lead: false };
  }
  // s3 / gcs / azure
  if (p.status === 200 && /(<ListBucketResult|<EnumerationResults|<Contents>|<Key>)/i.test(b)) {
    return { verdict: "📂 BUCKET TERBUKA — listing publik", lead: true };
  }
  if (p.status === 200) return { verdict: "200 (perlu cek manual: mungkin objek publik)", lead: false };
  return { verdict: `status ${p.status}`, lead: false };
}

export async function cloudMisconfig(
  rawUser: unknown,
  opts: { base_domain?: string; target?: string; provider?: string }
): Promise<string> {
  const base = (opts.base_domain || "").trim();
  if (!base) return "Error: base_domain wajib (domain organisasi yang tercakup engagement) — dipakai sebagai dasar otorisasi.";
  const baseHost = base.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
  if (!isLabTarget(baseHost) && !engagementAllows(baseHost)) {
    return `Error: SCOPE — ${baseHost} bukan lab / tidak dicakup engagement aktif. Tambahkan ke scope engagement dulu (engagement_create).`;
  }
  const providers = (opts.provider && opts.provider !== "auto" ? [opts.provider as CloudProvider] : PROVIDERS).filter((p) => PROVIDERS.includes(p));
  const names = opts.target ? [opts.target.trim().toLowerCase()] : cloudCandidates(baseHost);
  if (!names.length) return "Error: tak bisa menurunkan nama bucket dari base_domain — berikan `target` eksplisit.";

  const rows: string[] = [];
  const leads: string[] = [];
  let count = 0;
  for (const name of names) {
    for (const prov of providers) {
      for (const ep of endpoints(name, prov)) {
        if (count++ > 24) break;
        const p = await probe(ep.url);
        const c = classifyCloud(ep.kind, p);
        rows.push(`• [${prov}] ${ep.label} → ${p.status || "x"} — ${c.verdict}`);
        if (c.lead) leads.push(`[${prov}] ${ep.url} → ${c.verdict}`);
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }
  const leadBlock = leads.length
    ? `\n\n🎯 LEADS (verifikasi manual + poc_verify sebelum finding_add):\n${leads.map((l) => `• ${l}`).join("\n")}`
    : "\n\n🎯 tidak ada penyimpanan publik terdeteksi dari kandidat ini (bisa jadi namanya beda — coba `target` eksplisit).";
  return `☁️ CLOUD MISCONFIG — dasar: ${baseHost}\n${rows.join("\n")}${leadBlock}\n\n⚠️ Hanya storage MILIK organisasi dalam scope. Listing publik = akses tak sah ke data org — buktikan dengan poc_verify.`;
}
