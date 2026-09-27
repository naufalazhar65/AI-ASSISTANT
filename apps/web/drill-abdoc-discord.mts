// LIVE drill — A/B probe dokumen internal Kohona via jalur Discord sungguhan
// (runAssistantTurn, provider 9router = DISCORD_PROVIDER, approve = confirm_calls
// persis kontrak handleConfirmation di channels/discord.ts). Berjalan sebagai
// key OWNER karena sesi admin/staff (x-user-role) tersimpan di key itu — ini
// memang turn nyata, bukan simulasi user lain.
// Bukti keberhasilan = AUDIT LOG (tool:http_request / poc_verify / finding_add),
// bukan prosa balasan (pelajaran house: bukti = audit log).
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !m[1].startsWith("NEXT_PUBLIC")) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { runAssistantTurn } = await import("./src/lib/agent");
// Type-only: `import type { … }` — a destructuring pattern cannot carry a
// `type` modifier, so `const { type X } = await import(…)` does not parse.
import type { ToolCall } from "./src/lib/tools";
import type { ChatMessage } from "./src/lib/agent";
// The real types, not a hand-rolled copy: the local `Call` had no top-level
// `name` (so three read sites did not compile) and its `messages?: unknown[]`
// did not satisfy `ChatMessage[]`. A drill that declares its own approximation
// of a product type stops checking the moment the product type changes.
type Turn = Awaited<ReturnType<typeof runAssistantTurn>>;

const USER = "naufalazhar652952";
const BASE = "https://cozy-kangaroo-42f2e0.netlify.app";
const DOC = `${BASE}/api/dokumen?id=4`;

function auditCounts(user: string, names: string[]): Record<string, number> {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  const counts: Record<string, number> = {};
  try {
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".log")).sort().slice(-2);
    for (const f of files) {
      for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!l.includes(`"user":"${user}"`)) continue;
        for (const n of names) if (l.includes(`"action":"tool:${n}"`)) counts[n] = (counts[n] || 0) + 1;
      }
    }
  } catch { /* dir belum ada */ }
  return counts;
}

async function approveAll(prev: Turn, pendingMsgs: ChatMessage[], provider: string): Promise<Turn> {
  const pending = prev.needsConfirmation || [];
  const decisions = pending.map((call: ToolCall) => ({ call, allow: true })); // owner reply "ya" = semua
  return runAssistantTurn({
    // prev.messages is already ChatMessage[]; the old `as unknown[]` cast was
    // what hid the mismatch from the compiler.
    messages: (prev.messages as ChatMessage[] | undefined) ?? pendingMsgs,
    provider,
    user: USER,
    channel: "discord",
    confirm_calls: decisions,
  });
}

(async () => {
  console.log("── T1: ask A/B probe (9router, jalur Discord) ──");
  const ask = `uji akses dokumen internal ${DOC} pakai dua sesi yang sudah kusiapkan: http_request session=admin lalu http_request session=staff ke URL yang sama — bandingkan apakah staff (bukan admin) juga dapat 200 untuk dokumen rahasia`;
  const t1 = (await runAssistantTurn({ messages: [{ role: "user", content: ask }], provider: "9router", user: USER, channel: "discord" }));
  console.log("T1 text:", (t1.text || "").slice(0, 300));
  console.log("T1 pending:", (t1.needsConfirmation || []).map((c) => c.name).join(",") || "(none)");

  // Declared OUTSIDE the branch on purpose. This used to be `var t2 =` inside
  // the `if`, relying on function-scope hoisting so line 84 could read it when
  // the branch never ran — which is why the definite-assignment error (TS2454)
  // appeared the moment these files were typechecked. An explicit `let` above
  // with an `undefined` initialiser states the same intent and is checkable.
  let t2: Turn | undefined;
  if (t1.needsConfirmation?.length) {
    console.log("\n── T2: owner approve semua (reply 'ya') ──");
    t2 = await approveAll(t1, [{ role: "user", content: ask }], "9router");
    console.log("T2 text:", (t2.text || "").slice(0, 400));
    console.log("T2 pending baru:", (t2.needsConfirmation || []).map((c) => c.name).join(",") || "(none)");
  } else {
    console.log("T1 tidak mengusulkan tool write — audit akan menentukan apakah http_request jalan.");
  }

  console.log("\n── T3: minta poc_verify + finding_add ──");
  // t2 is genuinely undefined when T1 proposed nothing — fall back to T1's own
  // text so the follow-up context still carries what the model actually said.
  const t2text = t2?.text || t1.text || "";
  const followMsgs = [
    { role: "user", content: ask },
    { role: "assistant", content: t2text },
    { role: "user", content: `kalau staff ikut dapat 200, buktikan deterministik dengan poc_verify (3x, expect_status 200) di ${DOC} pakai session staff, lalu catat temuan BOLA/IDOR-nya dengan finding_add (CVSS, evidence, target=${BASE})` },
  ];
  const t3 = (await runAssistantTurn({ messages: followMsgs, provider: "9router", user: USER, channel: "discord" }));
  console.log("T3 text:", (t3.text || "").slice(0, 300));
  console.log("T3 pending:", (t3.needsConfirmation || []).map((c) => c.name).join(",") || "(none)");

  if (t3.needsConfirmation?.length) {
    console.log("\n── T4: owner approve poc_verify/finding_add ──");
    const t4 = await approveAll(t3, followMsgs, "9router");
    console.log("T4 text:", (t4.text || "").slice(0, 400));
  }

  console.log("\n── FORENSIK AUDIT (bukti, bukan prosa) ──");
  const counts = auditCounts(USER, ["http_request", "poc_verify", "finding_add"]);
  console.log("audit counts (owner key):", JSON.stringify(counts));
  if (!counts.http_request) { console.log("⛔ http_request tidak pernah dieksekusi"); process.exit(1); }
  if (!counts.finding_add) { console.log("⛔ finding_add tidak pernah dieksekusi"); process.exit(1); }
  console.log("\nDONE — http_request & finding_add terbukti jalan di jalur Discord.");
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
