/**
 * LIVE liveness probe — which store-backed honesty guards are DEAD right now?
 *
 * The corpus can only prove a DETECTOR works. It cannot tell you whether the
 * fact the guard depends on is actually being written in production. On
 * 2026-09-27 surface-coverage scored as covered while the owner's
 * target-brain.json held endpoints: [] — 29 js_mine + 17 content_discover in
 * the audit log and the store never moved, because the auto-write hook existed
 * only in AGENTS.md.
 *
 * This probe reads the REAL per-user stores and reports DEAD/ALIVE per guard.
 * Run it after touching any brain/record hook, not just the corpus.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { userDataRoot } from "./src/lib/users";
import { FACT_FED_SOURCES, livenessLine, type AuditFacts } from "./src/lib/honestyStability";

// The owner key is correct HERE and is NOT a hygiene violation: this probe is
// strictly READ-ONLY (readFileSync over the stores below — it never writes, never
// calls runAssistantTurn/executeTool, and never touches the owner-lab registry).
// Its whole job is to report whether the fact source behind each guard is
// actually populated in PRODUCTION, so a run-unique throwaway user would make
// every guard read DEAD and the probe worthless. Probes that WRITE (turns,
// findings, memory, registry) must use a run-unique throwaway — see
// `verify_<name>_${Date.now()}` in the sibling probes.
const USER = process.argv[2] || "naufalazhar652952";
const dir = join(userDataRoot(), USER);

function readJson<T>(name: string, fallback: T): T {
  const p = join(dir, name);
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as T) : fallback;
  } catch {
    return fallback;
  }
}

// --- read the three fact sources, exactly as the guard's readers do ---
// Shapes verified against the real store (2026-09-27) — two earlier versions of
// THIS probe guessed wrong and reported findingsTotal: 0 for a user with 21
// findings, i.e. it would have cried "DEAD" on a perfectly healthy guard:
//   target-brain.json → { "<host>": { endpoints: [...] } }
//   findings.json     → [ Finding, … ]            (bare LIST, not { findings })
//   poc-runs.json     → [ { url, verdict, at, … } ] (bare LIST, not { runs })
const brain = readJson<Record<string, { endpoints?: unknown[] }>>("target-brain.json", {});
const endpointsSeen = Object.values(brain).reduce((n, t) => n + (t?.endpoints?.length ?? 0), 0);

const allFindings = readJson<Array<{ status?: string; evidence?: string }>>("findings.json", []);
const open = allFindings.filter((f) => (f?.status ?? "open") !== "resolved");
const withProof = open.filter((f) => /poc_verify|PASS|\b3\/3\b|STABIL/i.test(f?.evidence ?? ""));

const pocRuns = readJson<Array<{ at?: string; url?: string; verdict?: string }>>("poc-runs.json", []);
const provingRuns = pocRuns.filter((r) => r?.verdict === "confirmed").length;

const facts = {
  host: "",
  pastWorkProven: provingRuns > 0 ? true : null,
  provingRuns,
  endpointsSeen,
  endpointsProbed: 0,
  verifiedFindingIds: [],
  findingsTotal: open.length,
  findingsWithProof: withProof.length,
  referencedFindingIds: [],
} as AuditFacts;

console.log(`user  : ${USER}`);
console.log(`store : ${dir}`);
console.log(
  `\nfakta: endpoints=${endpointsSeen} · temuan terbuka=${open.length} (punya bukti PoC=${withProof.length}) · poc-runs=${provingRuns}\n`
);

let fail = 0;
const rows: string[] = [];
for (const src of Object.keys(FACT_FED_SOURCES)) {
  const line = livenessLine(src, facts);
  rows.push(`  ${line}`);
  if (line.startsWith("DEAD")) fail++;
}

console.log("liveness guard fact-fed (DEAD = fact source kosong = guard buta di produksi):");
console.log(rows.join("\n"));

// The real regression from 2026-09-27: surface-coverage was DEAD because
// content_discover/js_mine never wrote the brain. If that regresses, this goes
// red instead of quietly scoring 23/23 in the corpus.
console.log(`\nEXIT=${fail ? 1 : 0}`);
process.exit(fail ? 1 : 0);
