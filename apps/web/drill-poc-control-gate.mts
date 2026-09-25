// drill-poc-control-gate.mts — the CALLER-side proof of the 2026-09-25 fix.
//
// The bug: the live Discord turn probed the owner's lab with `?id=1;-- -`, got the
// SAME 292 bytes as the clean `?id=1`, and poc_verify still said
// "✅ PoC STABIL & terkonfirmasi — layak dilaporkan" → a HIGH CWE-89 finding was
// filed for what is actually an IDOR. The tool judged only STATUS against the
// control, and never let the control gate the verdict.
//
// This drill measures the ground truth ITSELF (two raw fetches) and then asserts
// the tool's verdict matches that observed relationship — so it proves the gate
// WITHOUT hardcoding the lab's current bytes (the lab may legitimately change).
// Run from the repo root:  npx tsx apps/web/drill-poc-control-gate.mts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of env.split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (v) process.env[m[1]] = v;
}

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const PAYLOAD = `${LAB}/api/cek-nik?id=1;-- -`;
const CONTROL = `${LAB}/api/cek-nik?id=1`;
const user = `verify_pocgate_${Date.now()}`;

let fail = 0;
const ok = (c: boolean, label: string, detail = "") => {
  console.log(`${c ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

// ---- ground truth, measured independently of the tool ----
const raw = async (url: string) => {
  const res = await fetch(url, { headers: { "User-Agent": "mia-assistant/1.0" }, redirect: "manual" });
  const body = await res.text();
  return { status: res.status, body };
};
const payload = await raw(PAYLOAD);
const control = await raw(CONTROL);
const identical = payload.status === control.status && payload.body === control.body;
console.log(`ground truth: payload ${payload.status}/${payload.body.length}b vs control ${control.status}/${control.body.length}b → ${identical ? "IDENTIK" : "BERBEDA"}`);

const { pocVerify } = await import("./src/lib/poc");
const { isPocStable } = await import("./src/lib/vulnCompose");

// ---- the gate must follow the OBSERVED relationship ----
const report = await pocVerify(user, {
  url: PAYLOAD,
  times: 3,
  expect_status: 200,
  baseline_url: CONTROL,
});
const confirmed = report.includes("PoC STABIL");
const noSignal = report.includes("TIDAK ADA SINYAL");
console.log("--- verdict ---");
console.log(report.split("\n").filter((l) => /baseline|delta|SINYAL|STABIL/.test(l)).join("\n"));

ok(confirmed === !identical, identical ? "identical payload is NOT confirmed" : "a real differential is confirmed");
if (identical) {
  ok(noSignal, "verdict says TIDAK ADA SINYAL");
  ok(!isPocStable(report), "an unchanged payload is not a 'proven' compose hop");
} else {
  ok(!noSignal, "verdict does not cry 'no signal' at a real differential");
  ok(isPocStable(report), "a real differential is a 'proven' compose hop");
}

// ---- the other half: a control that FAILS must never confirm either ----
const broken = await pocVerify(user, {
  url: PAYLOAD,
  times: 2,
  baseline_url: "http://127.0.0.1:1/nope",
});
ok(!broken.includes("PoC STABIL"), "a failed control never confirms", broken.includes("baseline gagal") ? "reported as 'baseline gagal'" : "(message varies)");

// ---- and repetition alone is still not proof ----
const bare = await pocVerify(user, { url: PAYLOAD, times: 2 });
ok(!bare.includes("PoC STABIL"), "determinism without assertion/control is not proof");

// ---- the WRITE PATH: poc_verify's own ledger row must block the false finding ----
// This is the part a verdict cannot do on its own: the model is free to ignore a
// verdict, so the ledger is what finding_add reads. Uses the REAL row the tool just
// wrote for the REAL lab, not a synthetic fixture.
const { readPocRuns } = await import("./src/lib/pocRuns");
const { findingAddGate } = await import("./src/lib/findingGate");
const { toolResultExecuted } = await import("./src/lib/agent");

const ledger = readPocRuns(user);
const payloadRow = ledger.find((r) => r.url === PAYLOAD);
ok(!!payloadRow, "poc_verify wrote its run to the ledger", payloadRow ? `${payloadRow.verdict}${payloadRow.differs ? " · differential" : ""}` : "no row");

// the finding EXACTLY as the live turn filed it
const falseFinding = {
  title: "SQL Injection pada parameter id endpoint /api/cek-nik",
  severity: "high",
  cwe: "CWE-89",
  owasp: "A03:2025 Injection",
  target: `${LAB}/cek-nik`,
  text: [
    "SQL Injection pada parameter id endpoint /api/cek-nik",
    "Payload 'id=1;-- -' menghasilkan data sensitif.",
    `2. Kirim request GET ke ${PAYLOAD} melalui browser atau alat bantu.`,
  ].join("\n"),
};
const decision = findingAddGate(falseFinding, ledger);
ok(decision.allow === !identical, identical ? "the live false finding is now REFUSED by the gate" : "a real differential is allowed through");
if (identical) {
  ok(decision.block === "no-signal", "refused as REFUTED (not merely unproven)", decision.block ?? "");
  ok(/refused to execute/i.test(decision.reason), "refusal reads as a non-execution to the honesty guards");
  ok(toolResultExecuted(decision.reason) === false, "a 'sudah kucatat' claim after this will be corrected");
}

// ---- a different endpoint on the same host must not be licensed by this row ----
const otherEndpoint = findingAddGate(
  { ...falseFinding, target: `${LAB}/api/lain`, text: `${LAB}/api/lain` },
  ledger
);
ok(otherEndpoint.allow === false, "a DIFFERENT endpoint never inherits the payload endpoint's proof");

// ---- cleanup: the drill must not leave a user behind ----
const { rmSync } = await import("node:fs");
const { userDataRoot } = await import("./src/lib/users");
rmSync(join(userDataRoot(), user), { recursive: true, force: true });

console.log(fail === 0 ? "\nCONTROL GATES VERDICT — drill OK" : `\nDRILL FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
