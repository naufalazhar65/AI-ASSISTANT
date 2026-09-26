/**
 * Concrete readers for `claimAudit`, backed by the stores the agent already
 * maintains.
 *
 * Deliberately NOT the audit log. Its own header says it is "an append-only
 * trail for the owner's personal review — NOT a queryable service", and mining
 * it for verdicts would contradict that. Everything here comes from a store
 * built for the job:
 *
 *   target_brain  per-host endpoints (with the statuses actually observed),
 *                 safeTested requests, and recorded PROOFS
 *   poc-runs      the only artifact a finding can cite that a payload actually
 *                 changed something (verdict + differs)
 *   coverage      the per-surface ledger, which is where "did we exercise this
 *                 risk area" is actually recorded
 *
 * Every reader fails closed: a missing store, a thrown read, or an unrecognised
 * shape yields `null`/0, which claimAudit treats as UNKNOWN, never as false.
 * Inventing a fact here would be worse than having none.
 */
import { brainGet } from "./targetBrain";
import { readPocRuns } from "./pocRuns";
import { listCoverage } from "./coverage";
import { readFindings } from "./security";
import type { AuditReaders } from "./claimAudit";

const hostOf = (raw: string): string =>
  String(raw || "")
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .split(/[/?#]/)[0]
    .replace(/\.$/, "");

/**
 * Which host is this reply talking about?
 *
 * Learned the hard way from `targetDriftNote` (2026-09-25): mining free-text
 * args for URLs pulls in citation and remediation links, and a guard that reads
 * those thinks the model tested owasp.org. So the host comes ONLY from
 * by-design target fields, parsed as JSON, plus — as a last resort — the user's
 * own question. Malformed args are skipped, never mined.
 */
export function claimAuditHost(
  // Structural, not ChatMessage: importing that from agent.ts would be circular.
  // `content` is `unknown` because ChatMessage allows string | ContentPart[] |
  // null — the string case is narrowed below.
  messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> }>,
  replyText: string
): string {
  const TARGET_FIELDS = ["target", "url", "endpoint", "base_url", "host"];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant" || !m.tool_calls) continue;
    for (const tc of m.tool_calls) {
      const raw = tc.function?.arguments;
      if (!raw || typeof raw !== "string" || !raw.includes("http")) continue;
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      for (const f of TARGET_FIELDS) {
        const v = args[f];
        if (typeof v === "string" && /^https?:\/\//i.test(v)) return hostOf(v);
      }
    }
  }
  // Fall back to the user's own words: a user naming their own lab is not a
  // fabricated citation.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || typeof m.content !== "string") continue;
    const hit = /https?:\/\/([^\s/?#]+)/i.exec(m.content);
    if (hit) return hostOf(hit[1]);
  }
  // Last resort: a bare host in the reply (the user pasted it, not the model
  // inventing it). Stripped of path/punctuation.
  const inReply = /https?:\/\/([^\s/?#]+)/i.exec(replyText || "");
  return inReply ? hostOf(inReply[1]) : "";
}

/**
 * Was proving work done for this host, and how much?
 *
 * Two independent sources, either of which settles it:
 *  - a recorded brain proof (finding_add wrote "what/how" for this host), and
 *  - a PoC ledger entry whose verdict is `confirmed`/`reproducible` AND whose
 *    control really differed. `differs` is the load-bearing field: a run whose
 *    payload was byte-identical to its baseline is a REFUTED claim, and counting
 *    it would let a no-signal run vouch for "already verified".
 */
export function liveReaders(rawUser: unknown, host: string): AuditReaders {
  const h = hostOf(host);
  if (!h) return {};

  return {
    provingRunsForHost(target: string) {
      const th = hostOf(target);
      if (!th) return null;
      let count = 0;
      try {
        const brain = brainGet(rawUser, th);
        if (brain?.proofs?.length) count += brain.proofs.length;
      } catch { /* unknown */ }
      try {
        for (const r of readPocRuns(rawUser)) {
          if (hostOf(r.url) !== th) continue;
          if (r.verdict === "confirmed" || r.verdict === "reproducible") {
            if (r.differs !== false) count += 1;
          }
        }
      } catch { /* unknown */ }
      return { count };
    },

    /**
     * Endpoints known for the host vs endpoints that actually took a request.
     *
     * `status.length > 0` is the discriminator: an endpoint discovered by
     * recon (content_discover / js_mine) is recorded with no observed status,
     * while one that received a real request has at least one. An endpoint that
     * proved something, or was tested and found safe, counts as touched too.
     */
    endpointCoverageForHost(target: string) {
      const th = hostOf(target);
      if (!th) return null;
      let seen = 0;
      let probed = 0;
      try {
        const brain = brainGet(rawUser, th);
        if (brain?.endpoints?.length) {
          const safe = new Set((brain.safeTested || []).map((s) => String(s)));
          const proven = new Set((brain.proofs || []).map((p) => String(p.what || "")));
          seen += brain.endpoints.length;
          for (const e of brain.endpoints) {
            const touched =
              (Array.isArray(e.status) && e.status.length > 0) ||
              safe.has(e.path) ||
              [...proven].some((p) => p && p.includes(e.path));
            if (touched) probed += 1;
          }
        }
      } catch { /* unknown */ }
      try {
        // A coverage row is only filed with evidence, so each one is a surface
        // that was actually exercised rather than merely listed.
        for (const c of listCoverage(rawUser, { target: th })) {
          seen += 1;
          if (c.outcome !== "not_applicable") probed += 1;
        }
      } catch { /* unknown */ }
      if (!seen) return null;
      return { seen, probed };
    },

    /** Findings that carry their own proof, scoped to this host. */
    verifiedFindingIds(target: string) {
      const th = hostOf(target);
      if (!th) return null;
      try {
        return withProof(
          readFindings(rawUser)
            .filter((f) => f.status !== "resolved")
            .filter((f) => hostOf(String(f.target || "")) === th)
        );
      } catch {
        return [];
      }
    },

    /** Open findings for this host, so a "verified" claim can be counted. */
    openFindingIds(target: string) {
      const th = hostOf(target);
      if (!th) return null;
      try {
        return readFindings(rawUser)
          .filter((f) => f.status !== "resolved")
          .filter((f) => hostOf(String(f.target || "")) === th)
          .map((f) => f.id);
      } catch {
        return [];
      }
    },
  };
}

/**
 * Does this finding carry its own proof?
 *
 * Mirrors the gate `findingAdd` already enforces for injection-class findings —
 * see pocRuns.ts for why a PoC verdict is the only acceptable evidence.
 *
 * `expected`/`actual` is deliberately NOT accepted as proof on its own. It was in
 * an earlier draft, and an audit of the owner's real store on 2026-09-27 showed
 * why that was wrong: 7 findings carried expected+actual while only 5 carried a
 * real PoC marker, so the reader would have reported "7 of 7 proven" and Mia
 * would have said it with confidence. Expected/Actual records what the model
 * *says* happened; a PoC record is what actually ran. A criterion that is often
 * true without a PoC proves nothing, and a confident wrong number is worse than
 * no number.
 */
function withProof<T extends { id: string; evidence?: string }>(fs: T[]): string[] {
  return fs
    .filter((f) => {
      const ev = String(f.evidence || "");
      return /poc_verify/i.test(ev) || /\b\d+\/\d+\s*PASS\b/i.test(ev) || /TERBUKTI|PROVEN|CONFIRMED/i.test(ev);
    })
    .map((f) => f.id);
}
