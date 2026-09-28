// urlMatch.ts — the ONE owner of "does this recorded request speak for the
// endpoint this finding is about?". Pure — unit-tested.
//
// Why it exists (bounty-audit §4.1, "the evidence must match the endpoint"):
// `addFinding` auto-attached the newest http_history record whose URL merely
// CONTAINED the host, so a finding about `/api/login` could ship
// `[auto from http_history] GET /api/dokumen?id=4 → 200` as its evidence. The
// evidence gate is only as good as the evidence: a wrong-endpoint citation is
// how a reviewer concludes the reporter did not test what they claim.
//
// The matching rule mirrors the PoC ledger's witness rule so the two cannot
// disagree: a HOST-level record (path "/") speaks for the whole host, while a
// path-level record speaks only for that path — and a path-level record can
// still be claimed when the finding itself references that path (the model puts
// the tested URL in steps/evidence), which is how the live turns actually look.

/** Host of an absolute URL, or the leading host-ish token of a bare target. Pure. */
export function hostOfUrl(raw: string): string {
  try {
    return new URL(raw).host.toLowerCase();
  } catch {
    return String(raw || "").replace(/^https?:\/\//i, "").split("/")[0].toLowerCase();
  }
}

/** Path of an absolute URL, or of a bare `/a/b` target. Pure. */
export function pathOfUrl(raw: string): string {
  const s = String(raw || "");
  try {
    return new URL(s).pathname;
  } catch {
    // Absolute URL whose host is not parseable (rare), or a bare path target.
    const abs = s.match(/^https?:\/\/[^/]+(\/[^?#]*)/i);
    if (abs) return abs[1] || "/";
    const rel = s.match(/^(\/[^?#]*)/);
    return rel ? rel[1] : "";
  }
}

/** `/a/b` path tokens inside a string, normalised (lower, no query, no `//`, no trailing `/`). */
function pathTokens(s: string): string[] {
  const out: string[] = [];
  try {
    const str = String(s || "");
    // The leading `/` must NOT be glued to a preceding word character, so
    // "prefix/login" does not read as the endpoint `/login`. That boundary check
    // is what keeps free prose from covering endpoints nobody touched.
    for (const m of str.matchAll(/(^|[\s"'`(=,;:])\/(?:[A-Za-z0-9._~%-]+\/)*[A-Za-z0-9._~%:-]*/g)) {
      const t = normalisePath(m[0].slice(1));
      if (t && t !== "/") out.push(t);
    }
  } catch {
    /* not a string — no tokens */
  }
  return out;
}

/**
 * Every endpoint path a single string could be speaking about: absolute URLs
 * contribute their pathname, bare `/a/b` mentions contribute themselves, and a
 * scheme-less `host/a/b` contributes `/a/b`. Pure.
 */
function candidatePaths(leaf: string): string[] {
  const out: string[] = [];
  const s = String(leaf || "");
  for (const m of s.matchAll(/https?:\/\/[^\s"'`<>()[\]]+/gi)) {
    const p = pathOfUrl(m[0]);
    if (p) out.push(normalisePath(p));
  }
  const rest = s.replace(/https?:\/\/[^\s"'`<>()[\]]+/gi, " ");
  for (const tok of pathTokens(rest)) out.push(tok);
  const schemeless = rest.match(/^[A-Za-z0-9._-]+\.[A-Za-z]{2,}(\/.*)$/);
  if (schemeless) out.push(normalisePath(schemeless[1]));
  return out;
}

/** Normalise one path for EXACT comparison. Pure. */
export function normalisePath(p: string): string {
  let t = String(p || "").split(/[?#]/)[0].toLowerCase().replace(/\/{2,}/g, "/");
  if (t.length > 1) t = t.replace(/\/+$/, "");
  return t || "/";
}

/** Recursively collect every string leaf of a tool-args value. Pure, depth-bounded. */
function stringLeaves(v: unknown, out: string[], depth = 0): void {
  if (depth > 6 || v == null) return;
  if (typeof v === "string") {
    out.push(v);
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) stringLeaves(x, out, depth + 1);
    return;
  }
  if (typeof v === "object") {
    for (const x of Object.values(v as Record<string, unknown>)) stringLeaves(x, out, depth + 1);
  }
}

/**
 * Does a tool's arguments speak for EXACTLY this path?
 *
 * Live origin (turn 17:12): the ask named `/login`, the model probed
 * `/api/login`, and the old membership test was a raw `.includes()` on the whole
 * serialised args — so `/login` was found INSIDE `/api/login`, the path was
 * marked "covered", and the completion-claim correction silently never fired in
 * production. The same substring confusion had already hit `isEnumerationProbe`
 * and the auto-evidence host match, so the rule now lives here, once, EXACT:
 * a path token counts only when it EQUALS the path.
 *
 * There is deliberately NO substring fallback. A `reason`/`notes` field that
 * merely mentions a path must not mark an endpoint as tested, and a path with no
 * token in the args simply is not covered — which makes the honesty guard speak
 * rather than stay silent. The one deliberate looseness is the host-level path
 * `/`, where any absolute URL in the args counts: a site-level claim is
 * legitimately witnessed by a request to a host.
 */
export function argsMentionPath(args: unknown, path: string): boolean {
  // The caller sometimes hands us the whole URL the user typed rather than a
  // pathname (the triage guard's path extraction can yield `https://host`).
  // Reduce it first, or `normalisePath` would collapse the `//` and look for a
  // path that no argument can ever contain.
  const raw = /^https?:\/\//i.test(String(path || "")) ? pathOfUrl(path) : path;
  const want = normalisePath(raw);
  if (!want || want === "?") return false;
  const leaves: string[] = [];
  try {
    stringLeaves(args, leaves);
  } catch {
    return false;
  }
  if (!leaves.length) return false;
  for (const leaf of leaves) {
    if (want === "/") {
      // NOT anchored to the start: the guard hands us `arguments` as a raw JSON
      // string, so the URL sits inside '{"url":"https://host/…"}'. An earlier
      // `^https?://` anchor only matched when the leaf WAS the URL, i.e. only
      // when a test passed an object — the object/string asymmetry hid a real
      // regression in the honest TeamCity turn.
      if (/https?:\/\/\S+/i.test(leaf)) return true;
      continue;
    }
    for (const cand of candidatePaths(leaf)) if (cand === want) return true;
  }
  return false;
}

/**
 * Every endpoint path a tool's args mention, regardless of which path the
 * caller is asking about. Used where a note makes a TURN-LEVEL claim ("no
 * testing ran this turn") and must therefore see the whole turn's activity, not
 * only the asked path — the honest 01:45 turn probed `/api/login` while the ask
 * named `/login`. Pure.
 */
export function pathsInArgs(args: unknown): string[] {
  const leaves: string[] = [];
  try {
    stringLeaves(args, leaves);
  } catch {
    return [];
  }
  const out = new Set<string>();
  for (const leaf of leaves) for (const c of candidatePaths(leaf)) out.add(c);
  return [...out];
}

/**
 * Does a record URL witness the finding's target? `findingText` is everything
 * the finding claims (steps/evidence/impact) — a path-level record counts when
 * the finding references that path or the full URL.
 */
export function urlWitnessesUrl(recordUrl: string, findingTarget: string, findingText = ""): boolean {
  const runHost = hostOfUrl(recordUrl);
  const targetHost = hostOfUrl(findingTarget) || hostOfUrl(findingText);
  if (!runHost || !targetHost || runHost !== targetHost) return false;
  const p = pathOfUrl(recordUrl);
  if (!p || p === "/") return true;
  // A finding whose target is the bare HOST (no path anywhere) is a site-level
  // claim, so any request on that host is legitimate evidence for it. Tightening
  // the path rule without this branch broke the real "add a finding, let it pull
  // the last request" flow that verify.ts exercises.
  const text = `${findingTarget}\n${findingText}`;
  const targetPath = pathOfUrl(findingTarget);
  if (!targetPath || targetPath === "/") return true;
  return text.includes(p) || text.includes(recordUrl);
}

export type AutoEvidenceRecord = { url: string; method?: string; status?: number; at?: string };

/**
 * Pick the record to cite as auto-attached evidence, newest first.
 *
 * Preference order is deliberate: an EXACT path match beats a host-level one, so
 * a finding that names its endpoint gets that endpoint's response rather than
 * whatever the last request to the host happened to be. Returns null when
 * nothing on the host matches — an unproven finding is better than a
 * wrong-endpoint citation.
 */
export function pickAutoEvidence<T extends AutoEvidenceRecord>(
  records: readonly T[],
  findingTarget: string,
  findingText = ""
): T | null {
  if (!findingTarget) return null;
  const targetPath = pathOfUrl(findingTarget);
  let hostLevel: T | null = null;
  for (let i = (records?.length || 0) - 1; i >= 0; i--) {
    const rec = records[i];
    if (!rec || typeof rec.url !== "string") continue;
    if (!urlWitnessesUrl(rec.url, findingTarget, findingText)) continue;
    const p = pathOfUrl(rec.url);
    if (p && p !== "/" && p === targetPath) return rec;
    if (!hostLevel) hostLevel = rec;
  }
  return hostLevel;
}
