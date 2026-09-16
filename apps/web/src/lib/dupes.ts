// Duplicate check — before you submit, see whether you (or a program corpus)
// already have something too similar. Duplicates are one of the top reasons a
// valid report earns nothing; a cheap local check avoids wasted effort.
//
// Local corpus: findings + tracked submissions for the user. (Public-disclosure
// scraping is intentionally out of scope — ToS/fragility.)

import { readFindings } from "./security";
import { readSubmissions } from "./submissions";

const STOP = new Set(["the", "a", "an", "in", "on", "of", "to", "and", "for", "via", "with", "di", "ke", "yang", "dan", "pada", "dengan"]);

/** Token-set Jaccard similarity over normalized words. Pure — unit-tested. */
export function similarity(a: string, b: string): number {
  const toks = (s: string) =>
    new Set(
      (s || "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 2 && !STOP.has(t))
    );
  const A = toks(a);
  const B = toks(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

export function dupCheck(rawUser: unknown, opts: { title: string; target?: string; cwe?: string }): string {
  const title = (opts.title || "").trim();
  if (!title) return "Error: title wajib.";
  const targetHost = (opts.target || "").replace(/^https?:\/\//, "").split("/")[0].toLowerCase();

  const corpus: { kind: string; title: string; target: string; status?: string }[] = [
    ...readFindings(rawUser).map((f) => ({ kind: "finding", title: f.title, target: f.target, status: f.status })),
    ...readSubmissions(rawUser).map((s) => ({ kind: "submission", title: s.title, target: s.url || "", status: s.status })),
  ];
  if (!corpus.length) return "Korpus kosong — belum ada finding/submission lokal untuk dibandingkan.";

  const scored = corpus
    .map((c) => {
      const sim = similarity(title, c.title);
      const sameHost = targetHost && c.target.toLowerCase().includes(targetHost) ? 1 : 0;
      const score = sim + sameHost * 0.25;
      return { ...c, sim, sameHost, score };
    })
    .filter((c) => c.score >= 0.34)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (!scored.length) {
    return `✅ Tak ada kemiripan signifikan di korpus lokal (${corpus.length} item) — kemungkinan bukan duplikat internal.\nTetap cek duplikat publik program (hacktivity/crowdstream) secara manual.`;
  }
  return `⚠️ Kemungkinan DUPLIKAT (skor kemiripan):\n${scored
    .map((c) => `• [${c.kind}] ${c.title.slice(0, 90)} — sim ${(c.sim * 100).toFixed(0)}%${c.sameHost ? " + host sama" : ""}${c.status ? ` (${c.status})` : ""}`)
    .join("\n")}\n\nSaran: bedakan judul/endpoint/impact, atau gabung sebagai satu laporan bila memang akar yang sama. Cek juga duplikat publik program.`;
}
