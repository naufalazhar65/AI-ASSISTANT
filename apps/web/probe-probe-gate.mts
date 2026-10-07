/**
 * probe-probe-gate.mts — proves the probe gate fires in the REAL agent loop.
 *
 * Why this probe exists (live 2026-10-07 17:29, cozy-kangaroo-42f2e0.netlify.app):
 * the turn ran finding_list + http_request + web_audit + js_mine, then wrote a
 * full eight-finding pentest report as PROSE and ended. It used ONE round of a
 * TEN-round budget. sweepReportGate could not catch it (no report tool was
 * called) and the honesty guards only annotated the prose afterwards. So the
 * turn was honest AND useless: the owner asked for testing, got a
 * re-transcription of the store.
 *
 * `probeGateNudge` in sweepGate.ts is the mechanism. Unit tests prove the pure
 * function; THIS probe proves the WIRING — that runAgent's final-answer branch
 * actually calls it, that the recursive round runs, and that the audit log
 * shows real probes where previously there were none.
 *
 * What it asserts (evidence is the AUDIT LOG and the model's own text, never
 * the prose alone):
 *   1. the gate's console line `[agent] round N: pentest turn with zero probes`
 *      appears for the ask;
 *   2. at least one PROBE tool (poc_verify / param_fuzz / http_request with a
 *      payload) executed this turn — the thing that did NOT happen live;
 *   3. the turn terminated (no infinite loop) — the probe gate is bounded to
 *      ONE nudge per turn, and this is what proves the bound holds in the real
 *      loop, not just in a unit test.
 *
 * Run from the repo root:
 *   npx tsx apps/web/probe-probe-gate.mts
 * Env:
 *   PROBE_BASE   default http://localhost:3000
 *   PROBE_ASK    default the owner's exact ask (17:29)
 *   PROBE_USER   default a throwaway key so the owner's store is untouched
 *   PROBE_HEAD=1 print the reply in full
 */

import { execFileSync } from "node:child_process";

const BASE = process.env.PROBE_BASE || "http://localhost:3000";
const ASK =
  process.env.PROBE_ASK ||
  "coba lakukan full pentest secara menyeluruh di https://cozy-kangaroo-42f2e0.netlify.app/ dan buatkan report pdf nya";
const USER = process.env.PROBE_USER || "probe_gate";

// The probe tools whose execution means "real testing happened". Kept to the
// names that send a payload or read a payload's answer — a plain GET is not
// testing, which is the whole point of the gate.
const PROBE_NAMES = new Set([
  "poc_verify", "param_fuzz", "idor_enum", "bola_diff", "auth_matrix",
  "ssti_enum", "bypass403", "path_traversal", "otp_hunt", "race_attack",
  "workflow_fuzz", "retest_run", "exploit_chain", "vuln_compose",
]);

/** Payload marker — an http_request only counts as testing if it carries one. */
const PAYLOAD = /'|union\s+select|\.\.\/|;--|\{\{|onerror|%27|<script|\bor\s+1\s*=|sleep\(|etc\/passwd/i;

/** An honest "I did not test this turn" — the gate's designed exit. */
const HONEST_NO_TEST =
  /belum (aku )?(sempat )?(menguji|uji|diuji|tes)|tidak (bisa|sempat) (menguji|uji|tes)|gagal (menguji|uji)/i;

function readAudit(): Array<{ ts: string; action: string; user?: string; detail?: string }> {
  try {
    const dir = "apps/web/.data/audit";
    const file = execFileSync("/bin/ls", ["-t", dir], { encoding: "utf8" })
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (!file) return [];
    const raw = execFileSync("/bin/cat", [`${dir}/${file}`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        try {
          const j = JSON.parse(l) as { ts?: string; action?: string; user?: string; detail?: string };
          return { ts: j.ts ?? "", action: j.action ?? "", user: j.user, detail: j.detail };
        } catch {
          return { ts: "", action: "", user: undefined, detail: undefined };
        }
      });
  } catch {
    return [];
  }
}

/**
 * How many times the gate has fired, read from the dev log. Without this the
 * probe cannot tell the two cases apart: "the gate made it probe" versus "the
 * model probed on its own and the gate never fired". Run 3 of 2026-10-07 was
 * exactly that false positive — probe said OK, the gate log was empty.
 */
function gateFires(): number {
  try {
    return execFileSync("/usr/bin/grep", ["-c", "pentest turn with zero probes", "/tmp/mia-dev.log"], {
      encoding: "utf8",
    }).trim() === "0"
      ? 0
      : Number(execFileSync("/usr/bin/grep", ["-c", "pentest turn with zero probes", "/tmp/mia-dev.log"], { encoding: "utf8" }).trim());
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  const before = readAudit();
  const firesBefore = gateFires();
  console.log(`ask      : ${ASK.slice(0, 90)}…`);
  console.log(`user     : ${USER}`);

  const res = await fetch(`${BASE}/api/llm`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ user: USER, channel: "discord", messages: [{ role: "user", content: ASK }] }),
  });
  const body = await res.text();
  const text = body.slice(0, 4000);

  // The confirm path can pause the turn; follow it so the drill exercises the
  // same shape a real channel does, otherwise a pause looks like "no probes".
  let finalText = text;
  for (let i = 0; i < 3 && /@@CONFIRM/.test(finalText); i++) {
    console.log(`\n(confirm pause #${i + 1} — approving)`);
    const r2 = await fetch(`${BASE}/api/llm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user: USER,
        channel: "discord",
        messages: [{ role: "user", content: ASK }],
        confirm_calls: [{ call: { id: "x", name: "noop", arguments: "{}" }, allow: true }],
      }),
    });
    finalText = (await r2.text()).slice(0, 4000);
  }

  const after = readAudit();
  const fresh = after.slice(before.length).filter((r) => r.user === USER || r.user === undefined);
  const rows = fresh.filter((r) => r.action.startsWith("tool:"));
  const tools = rows.map((r) => ({ name: r.action.slice(5), detail: r.detail ?? "" }));

  console.log(`\n--- audit rows this turn (${tools.length}) ---`);
  for (const t of tools) console.log(`  ${t.name}${t.detail ? `  ${t.detail.slice(0, 110)}` : ""}`);
  if (process.env.PROBE_HEAD === "1") console.log(`\n--- reply ---\n${finalText}`);

  // A plain GET is not testing. http_request counts ONLY when its args carry a
  // payload marker — the same rule agent.ts's PROBE_TOOLS gate uses
  // (PAYLOAD_MARK_RE). `finding_add` is a RECORD, never a probe: counting it
  // here would let a turn that fabricated three findings look like a tester,
  // which is exactly the bug this whole exercise exists to catch.
  const probes = tools.filter(
    (t) =>
      PROBE_NAMES.has(t.name) ||
      (t.name === "http_request" && PAYLOAD.test(t.detail)),
  );
  const records = tools.filter((t) => t.name === "finding_add");
  console.log(`\nprobes (payload sent) : ${probes.length} ${probes.map((p) => p.name).join(", ")}`);
  console.log(`finding_add recorded  : ${records.length}`);
  const fired = gateFires() - firesBefore;
  console.log(`GATE FIRED this turn : ${fired}`);

  let fail = 0;
  const honest = HONEST_NO_TEST.test(finalText);
  if (probes.length === 0 && !honest) {
    console.log("FAIL: no payload-bearing probe ran AND the reply does not admit it");
    fail++;
  }
  if (/@@CONFIRM/.test(finalText)) {
    console.log("FAIL: turn ended still paused on a confirmation");
    fail++;
  }
  if (fired === 0) {
    // Not a failure — but the result says NOTHING about the gate. The model
    // probed on its own. Recording it as a pass would be the false positive
    // that run 3 of 2026-10-07 already produced once.
    console.log(
      "INCONCLUSIVE: the gate never fired, so this run proves nothing about it. The model chose to probe by itself.",
    );
    process.exit(2);
  }
  if (probes.length === 0) {
    console.log(
      honest
        ? "GATE WORKED: fired, the model could not probe, and the reply SAYS SO — that is the designed exit."
        : "GATE FAILED: it fired and the model ignored it.",
    );
  } else {
    console.log("GATE WORKED: it fired and the turn went on to run a real payload-bearing probe.");
  }
  console.log(`\nVERDICT: ${fail === 0 ? "OK — turn terminated correctly" : `NOT PROVEN (${fail} failed)`}`);
  console.log("Reminder: proof is the AUDIT LOG above, not the reply prose.");
  process.exit(fail === 0 ? 0 : 1);
}

void main();
