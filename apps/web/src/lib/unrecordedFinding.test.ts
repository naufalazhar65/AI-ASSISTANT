// unrecordedFinding.test.ts — a proven bug that was never recorded.
//
// Live 2026-09-25: the 11:02 turn proved IDOR on /api/cek-nik (200 + NIK +
// address) and ran two poc_verify probes on the SQLi angle, narrated it as
// confirmed — and never called `finding_add`. The 11:13 report then could not
// show it: a bug absent from the store is invisible to report_generate,
// finding_list, dup_check and retest. The user lost the finding silently.
import { describe, expect, it } from "vitest";
import { unrecordedFindingNote } from "./agent";

const call = (id: string, name: string, args: Record<string, unknown>) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

function liveTurn(proofBody: string) {
  return [
    { role: "user", content: `uji ${LAB}/cek-nik` },
    { role: "assistant", content: null, tool_calls: [call("a", "http_request", { url: `${LAB}/api/cek-nik?id=1` })] },
    { role: "tool", tool_call_id: "a", content: '{"nik":"3571010101010001","nama":"Suharto Wijaya"}' },
    { role: "assistant", content: null, tool_calls: [call("b", "poc_verify", { url: `${LAB}/api/cek-nik?id=1%27`, times: 3 })] },
    { role: "tool", tool_call_id: "b", content: proofBody },
    {
      role: "assistant",
      content:
        "Endpoint /cek-nik terbukti rentan IDOR karena menampilkan data pribadi terbuka tanpa autentikasi, dan sudah dipastikan aman dari SQL injection. Pengujian menyeluruh selesai.",
    },
  ] as never;
}

const STABLE_PASS = "✅ PoC STABIL & terkonfirmasi 3/3\n  GET /api/cek-nik?id=1 → 200";
const UNSTABLE = "⚠️ TIDAK STABIL — signature berubah antar run (assertion-belum)";

describe("unrecordedFindingNote — fires on a real gap", () => {
  // Deterministic: without injected recordedTargets the guard reads the REAL
  // owner store (live 14:09 lesson — the lab findings ARE recorded there), so
  // these pure cases must inject an empty store.
  const EMPTY = { recordedTargets: [] as string[] };
  it("flags the live case: stable proof, no finding_add, presented as result", () => {
    const note = unrecordedFindingNote(liveTurn(STABLE_PASS), "Endpoint terbukti rentan IDOR, pengujian selesai.", EMPTY);
    expect(note).toMatch(/BELUM masuk daftar/i);
    expect(note).toContain("finding_add");
  });

  it("accepts a confirmed-strength prover (dom_xss_prove PROVEN)", () => {
    const msgs = [
      { role: "user", content: "buktikan DOM XSS" },
      { role: "assistant", content: null, tool_calls: [call("a", "dom_xss_prove", { url: `${LAB}/x` })] },
      { role: "tool", tool_call_id: "a", content: "VERDICT: PROVEN — handler onerror dieksekusi" },
      { role: "assistant", content: "XSS terkonfirmasi dan pengujian selesai." },
    ] as never;
    expect(unrecordedFindingNote(msgs, "XSS terkonfirmasi dan pengujian selesai.", EMPTY)).toMatch(/BELUM masuk daftar/i);
  });
});

describe("unrecordedFindingNote — must stay silent (no nagging)", () => {
  it("silent when finding_add DID run", () => {
    const msgs = [
      ...(liveTurn(STABLE_PASS) as unknown as Array<Record<string, unknown>>),
    ];
    msgs.splice(4, 0, {
      role: "assistant",
      content: null,
      tool_calls: [call("c", "finding_add", { title: "IDOR /cek-nik" })],
    });
    msgs.push({ role: "tool", tool_call_id: "c", content: "F-mu5c2qwm tercatat" });
    expect(
      unrecordedFindingNote(msgs as never, "Endpoint terbukti rentan IDOR, pengujian selesai.")
    ).toBe("");
  });

  it("silent when the PoC was NOT stable (no earned proof)", () => {
    expect(
      unrecordedFindingNote(liveTurn(UNSTABLE), "Endpoint terbukti rentan IDOR, pengujian selesai.")
    ).toBe("");
  });

  it("silent on an honest admission ('belum saya catat')", () => {
    const note = unrecordedFindingNote(
      liveTurn(STABLE_PASS),
      "Endpoint terbukti rentan IDOR. Temuannya belum saya catat ya — bilang 'catat' kalau mau disimpan."
    );
    expect(note).toBe("");
  });

  it("silent when only a LEAD exists (house rule: a lead still owes poc_verify)", () => {
    const msgs = [
      { role: "user", content: "cari celah" },
      { role: "assistant", content: null, tool_calls: [call("a", "bypass403", { url: `${LAB}/admin` })] },
      { role: "tool", tool_call_id: "a", content: "LEADS: 403 bypass candidate — verifikasi manual + poc_verify" },
      { role: "assistant", content: "Ada lead bypass 403, pengujian selesai." },
    ] as never;
    expect(unrecordedFindingNote(msgs, "Ada lead bypass 403, pengujian selesai.")).toBe("");
  });

  it("silent when the proof was REFUSED (not delivered / not selected)", () => {
    const msgs = [
      { role: "user", content: "uji" },
      { role: "assistant", content: null, tool_calls: [call("a", "poc_verify", { url: `${LAB}/x` })] },
      { role: "tool", tool_call_id: "a", content: 'Not executed: "poc_verify" is not available on this provider (tool budget).' },
      { role: "assistant", content: "Poc_verify tidak tersedia, pengujian selesai." },
    ] as never;
    expect(unrecordedFindingNote(msgs, "Poc_verify tidak tersedia, pengujian selesai.")).toBe("");
  });

  it("silent on ordinary prose with no finding claim", () => {
    expect(unrecordedFindingNote(liveTurn(STABLE_PASS), "Halo Mas Naufal, apa kabar?")).toBe("");
  });
});
