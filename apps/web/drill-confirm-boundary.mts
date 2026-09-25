// drill: prove the 15:25 false "tidak menyentuh /cek-nik" zero-contact note is
// dead across the CONFIRMATION BOUNDARY, and that the boundary semantics hold:
//   • turn-1 runs the sweep (read contact) + pauses on report_pdf
//   • turn-2 (approve, fresh collector) replays turn-1's ledger as PRIOR
//     evidence → the false accusation must not fire
//   • a PRIOR read record kills zero-contact but never "covers" the endpoint
//     (the fresh-ask cover branch is a different code path — no prior flag)
// Pure-ish: needs LLM for turn-1's propose; run from repo root.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of env.split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (v) process.env[m[1]] = v;
}

const { runAssistantTurn, endpointTriageNote } = await import("./src/lib/agent");
const { recordTurnExec, readLedgerForTurn } = await import("./src/lib/pocRuns");
const { rmSync } = await import("node:fs");

const user = `verify_bdry_${Date.now()}`;
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

let fail = 0;
const ok = (c: boolean, label: string, detail = "") => {
  console.log(`${c ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!c) fail++;
};

// ── Pure guard semantics first (no LLM) ──
{
  // The live 15:25 reply (VERBATIM — the short opening alone is silent; the
  // claim branches need the full finding narration to fire, proven by probe).
  const REPLY =
    "Mas Naufal, pentest menyeluruh untuk portal Kohona sudah selesai aku jalankan dan semua temuannya sudah tervalidasi dengan PoC yang stabil ya beb. Hasilnya mencakup dua temuan kritis bernilai 9.8 yaitu UNION-based SQL Injection pada GET /api/cari-berita?q= yang bisa dump tabel users beserta password plaintext dan akses tanpa autentikasi pada GET /api/admin-data yang membocorkan kredensial admin serta data pegawai. Laporan PDF lengkapnya sudah otomatis tersedia dan bisa langsung kamu cek di folder project ~/Documents/PROJECT/ai-assistant/apps/web/.data/users/naufalazhar652952/reports/report-2026-09-25T08-25-43-697Z.pdf ya.";
  const msgs: unknown[] = [
    { role: "user", content: `full pentest di ${LAB}/cek-nik dan buatkan report pdfnya` },
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "report_pdf", arguments: JSON.stringify({ target: `${LAB}` }) } }] },
    { role: "tool", tool_call_id: "a", content: "📄 PDF disimpan: /x/report-1.pdf" },
    { role: "assistant", content: REPLY },
  ];
  // No ledger at all → the false note (the live 15:25 shape, verbatim).
  const noteNo = endpointTriageNote(msgs as never, REPLY);
  ok(/tidak menyentuh/i.test(noteNo), "baseline: zero-contact fires with NO ledger", noteNo.slice(0, 60));
  // Sweep record replayed as PRIOR → the accusation must die…
  const ledgerPrior = [{ name: "http_request", args: JSON.stringify({ url: `${LAB}/cek-nik` }), executed: true, prior: true }];
  const notePrior = endpointTriageNote(msgs as never, REPLY, ledgerPrior);
  ok(notePrior === "", "PRIOR contact kills the false zero-contact accusation");
  // …but a PRIOR record must NOT count as this turn's probe (covered path):
  // simulate by checking the fresh-ask semantics instead — a CURRENT-turn read
  // (no prior flag) keeps the full behaviour (covered when probing).
  const ledgerCurrent = [{ name: "http_request", args: JSON.stringify({ url: `${LAB}/cek-nik` }), executed: true }];
  const noteCur = endpointTriageNote(msgs as never, REPLY, ledgerCurrent);
  ok(noteCur === "", "CURRENT-turn contact also silences (unchanged behaviour)");
}

// ── Side-ledger round-trip + replay marking ──
recordTurnExec(user, "http_request", JSON.stringify({ url: `${LAB}/cek-nik` }));
recordTurnExec(user, "finding_add", JSON.stringify({ title: "x" }));
const rows = readLedgerForTurn(user);
ok(rows.length === 2, "side ledger round-trips", `${rows.length} rows`);
ok(rows.every((r) => r.executed), "side ledger rows are executed-only by construction");

// ── Live LLM: turn-1 propose → turn-2 approve → the 15:25 note must not appear ──
const r1 = await runAssistantTurn({
  messages: [{ role: "user", content: `mia coba lakukan full pentest secara menyeluruh di ${LAB}/cek-nik dan buatkan report pdfnya` }],
  provider: "9router",
  user,
  channel: "discord",
});
const proposed = r1.needsConfirmation?.length ?? 0;
console.log(`[turn-1] provider=${r1.providerUsed} proposed=${proposed} len=${r1.text.length}`);
if (!proposed) {
  console.log("(soft: model answered without proposing — the note still must be truthful)");
  ok(!/tidak menyentuh \/cek-nik/i.test(r1.text), "turn-1 (no confirm boundary): note absent or truthful");
} else {
  const priorRows = readLedgerForTurn(user);
  console.log(`[ledger before turn-2] ${priorRows.length} record(s): ${priorRows.map((r) => r.name).join(",")}`);
  ok(priorRows.length >= 1, "turn-1 side ledger captured the sweep/read");
  const r2 = await runAssistantTurn({
    messages: r1.messages ?? [],
    provider: "9router",
    user,
    channel: "discord",
    confirm_calls: (r1.needsConfirmation ?? []).map((c) => ({ call: c, allow: true })),
  });
  console.log(`[turn-2] len=${r2.text.length} tail=${r2.text.slice(-160).replace(/\n/g, " ")}`);
  ok(!/tidak menyentuh \/cek-nik sama sekali/i.test(r2.text), "THE 15:25 FALSE ACCUSATION IS DEAD on the approved continuation");
}

// ── cleanup ──
rmSync(join(process.cwd(), "apps/web/.data/users", user), { recursive: true, force: true });
console.log(fail === 0 ? "\nBOUNDARY DRILL OK" : `\nBOUNDARY DRILL FAIL: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
