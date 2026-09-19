// Live drill: superpowers (target_brain + auth_matrix) through runAssistantTurn
// — the SAME path a Discord adapter takes. Tests with the owner's Netlify lab.
// Provider: 9router (env LLM_*). tsx does NOT load .env.local — parse it first.
//
// Flow (mirrors a real Discord conversation):
//   T1 "petakan lab + baca target_brain"  → recon (write, auto-denied headless?
//        no: normal turn → needsConfirmation for write tools → we approve)
//   T2 approve the batch                   → tools run, brain fills
//   T3 "set 2 sessions + auth_matrix"      → http_session (write→approve) then matrix
//   T4 approve                             → matrix runs against the lab
//   T5 "apa yang kamu ingat soal lab?"     → target_brain brief (read/auto)
//
// Gitignored by pattern *_probe.ts? No — this file is drill-*.ts; delete after.

import fs from "node:fs";
const home = process.env.HOME || "";
for (const line of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}

const { runAssistantTurn } = (await import("./src/lib/agent")) as typeof import("./src/lib/agent");
const { brainBrief, brainGet } = (await import("./src/lib/targetBrain")) as typeof import("./src/lib/targetBrain");
const { readSessions } = (await import("./src/lib/httpSession")) as typeof import("./src/lib/httpSession");
void home;

const USER = "naufalazhar652952";
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const PROVIDER = "9router";

type Pending = { call: { id: string; name: string; arguments: string }; allow: boolean }[];

function toolList(msg: string): string {
  try {
    const j = JSON.parse(msg);
    if (Array.isArray(j)) return j.map((c: { name?: string }) => c.name || "?").join(", ");
  } catch { /* not json */ }
  return "(none)";
}

async function turn(text: string, history: { role: "user" | "assistant"; content: string }[], approve: Pending | null): Promise<{ reply: string; pending: Pending }> {
  const res = await runAssistantTurn({
    messages: [...history, { role: "user", content: text }],
    provider: PROVIDER,
    user: USER,
    channel: "discord",
    confirm_calls: approve ?? undefined,
  });
  return { reply: res.text, pending: (res.needsConfirmation || []).map((call) => ({ call, allow: true })) };
}

async function main() {
  const history: { role: "user" | "assistant"; content: string }[] = [];

  // T1 — ask for mapping (will propose write tools)
  console.log("== T1: petakan lab ==");
  const t1 = await turn(`petakan dulu lab-ku ${LAB}/index.html — pakai target_brain dulu lalu content_discover`, history, null);
  console.log("pending:", toolList(JSON.stringify(t1.pending.map((p) => p.call))));
  console.log("reply:", t1.reply.slice(0, 220).replace(/\n/g, " | "));
  history.push({ role: "user", content: `petakan dulu lab-ku ${LAB}/index.html — pakai target_brain dulu lalu content_discover` }, { role: "assistant", content: t1.reply });

  // T2 — approve everything proposed
  if (t1.pending.length) {
    console.log(`\n== T2: approve ${t1.pending.length} call ==`);
    const t2 = await turn("ya", history, t1.pending);
    console.log("reply:", t2.reply.slice(0, 300).replace(/\n/g, " | "));
    history.push({ role: "user", content: "ya" }, { role: "assistant", content: t2.reply });
  }

  const brain1 = brainGet(USER, LAB);
  console.log("\nbrain endpoints after mapping:", brain1?.endpoints.length ?? 0);

  // T3 — sessions + matrix ask
  console.log("\n== T3: auth_matrix ==");
  const t3 = await turn(
    `bikin 2 session uji: admin_test cookie "role=admin" dan guest_test cookie "role=guest", lalu jalankan auth_matrix ke ${LAB}/api/dokumen?id=1 dan /api/admin dengan sessions admin_test,guest_test`,
    history,
    null
  );
  console.log("pending:", toolList(JSON.stringify(t3.pending.map((p) => p.call))));
  console.log("reply:", t3.reply.slice(0, 220).replace(/\n/g, " | "));
  history.push({ role: "user", content: "set sessions + matrix" }, { role: "assistant", content: t3.reply });

  // T4 — approve
  if (t3.pending.length) {
    console.log(`\n== T4: approve ${t3.pending.length} call ==`);
    const t4 = await turn("ya", history, t3.pending);
    console.log("reply:", t4.reply.slice(0, 400).replace(/\n/g, " | "));
    history.push({ role: "user", content: "ya" }, { role: "assistant", content: t4.reply });
  }

  // Sanity: sessions exist? matrix verdict?
  const sessions = readSessions(USER);
  console.log("\nsessions:", Object.keys(sessions).filter((k) => k.includes("_test")).join(", ") || "(none)");
  const brief = brainBrief(USER, LAB);
  console.log("\n== T5: brain brief ==");
  console.log(brief.slice(0, 800));
  console.log("\nDRILL DONE");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("DRILL FAIL:", e instanceof Error ? e.message : e);
    process.exit(1);
  }
);
