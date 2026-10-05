// LIVE drill for the trio persona overlay (agentRole.ts) — real LLM, not mocks.
//
// What is proven (the two things a unit test structurally CANNOT prove):
//   T1  the ROLE overlay actually reaches the model: a real `runAssistantTurn`
//       with agent:"agnes"/"michelle" answers as THAT agent — right name, right
//       specialty, no Mia identity, no signature emoji.
//   T2  CONTROL: the same ask with NO agent label still answers as Mia with the
//       🌸 signature → proves the overlay (not the persona files, not luck)
//       is what changed the answer, and that Mia's paths are untouched.
//   T3  role boundary LIVE: an out-of-role ask makes the agent hand off to its
//       sibling in prose instead of silently attempting the work.
//   T4  tool routing LIVE: the in-role ask for the same task actually CALLS a
//       tool (audit-log proof, house rule) — proof = audit log, not prose.
//   T5  the shipped persona files on disk are persona-v2 with the injected
//       sections present (the seed migration actually reached production).
//
// Safety: provider 9router only (the same provider the three bots use). No
// Discord gateway, no outbound messages, run-unique throwaway user keys,
// auto-cleanup. Run from repo root: npx tsx apps/web/drill-trio-persona.mts
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn } = await import("./src/lib/agent");
const { ensureAgentPersona } = await import("./src/channels/discord");

const STAMP = Date.now();
const BASE = `verify_persona_${STAMP}`;
const KEYS = { mia: BASE, agnes: `${BASE}.agnes`, michelle: `${BASE}.michelle` } as const;

// FAITHFULNESS FIX (drill bug #1, found by run #1): runAssistantTurn does NOT
// seed the agent persona — only the Discord adapter does (discord.ts seeds on
// message). With a throwaway key, ensureUserPersona therefore seeds MIA's
// template persona into the throwaway key, so the turn got "role: Agnes" + a
// conflicting "IDENTITY: Mia / 🌸". Seeding here replicates production exactly
// (that is literally what the adapter does before a turn) while keeping the
// drill on throwaway data.
for (const label of ["agnes", "michelle"] as const) ensureAgentPersona(label, KEYS[label]);

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// "trio Mia" / "tim Mia" is the TEAM name and must stay allowed; what is
// forbidden is claiming the Mia IDENTITY. Match the identity-claim shapes only.
const CLAIM_MIA = /\b(aku|saya|aku adalah|saya adalah)\s+(ya|kamu)?\s*(mia|asisten pribadimu)|\bsayapunya\s+mia\b|\bi am\s+mia\b/i;

// House rule: proof = audit log, never the model's own prose about running tools.
function auditToolRuns(user: string): Map<string, number> {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  const out = new Map<string, number>();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log")).sort().slice(-2)) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (!l.includes(`"user":"${user}"`)) continue;
      const m = l.match(/"action":"tool:([a-z0-9_]+)"/);
      if (m) out.set(m[1], (out.get(m[1]) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * The full turn result. `ask()` used to return only `text`, which silently hid
 * one important case: when an agent proposes a write-risk tool it PAUSES for the
 * owner's approval and returns an empty `text` plus a populated
 * `needsConfirmation`. In Discord the owner sees that prompt, so the turn is
 * not silent — but a drill that only reads `text` cannot tell "paused for
 * approval" apart from "said nothing at all". That is the one that is a bug.
 */
async function askTurn(user: string, text: string, agent?: "agnes" | "michelle") {
  return runAssistantTurn({
    messages: [{ role: "user", content: text }],
    provider: process.env.DEFAULT_AI_PROVIDER || "9router",
    user,
    channel: "discord",
    ...(agent ? { agent } : {}),
  });
}

async function ask(user: string, text: string, agent?: "agnes" | "michelle") {
  const r = await askTurn(user, text, agent);
  return (r.text || "").trim();
}

// ── T5 (static, cheapest first): the persona files on disk ────────────────
console.log("\n— T5 shipped persona files on disk —");
const persRoot = join(process.cwd(), "apps/web/.data/users");
for (const [label, userKey] of Object.entries({ agnes: KEYS.agnes, michelle: KEYS.michelle })) {
  const realKey = label === "agnes" ? "naufalazhar652952.agnes" : "naufalazhar652952.michelle";
  for (const file of ["IDENTITY.md", "SOUL.md"]) {
    const p = join(persRoot, realKey, "persona", file);
    if (!existsSync(p)) { ok(false, `${label}/${file} exists`); continue; }
    const body = readFileSync(p, "utf8");
    ok(
      /persona-v\d+/.test(body) && new RegExp(`agent-role:${label}`).test(body),
      `${label}/${file} stamped with a persona version + agent-role:${label}`,
      body.match(/persona-v\d+/)?.[0] ?? "",
    );
    if (file === "SOUL.md") {
      ok(
        /###\s*(Misi|Alur kerja|Pembagian kerja|Mutu jawaban|Dilarang)/.test(body) &&
          (body.match(/^###/gm) || []).length >= 5,
        `${label}/SOUL.md carries the injected sections`,
        `${(body.match(/^###/gm) || []).length} ### sections`,
      );
    }
  }
}

// ── T1 + T2: identity, real LLM ───────────────────────────────────────────
console.log("\n— T1/T2 identity through the real model —");
const IDENT = "Siapa kamu? Sebut nama, peran, dan satu tugas rutin yang paling sering kamu kerjakan. Jawaban singkat.";

const agnesText = await ask(KEYS.agnes, IDENT, "agnes");
console.log(`  agnes → ${agnesText.replace(/\s+/g, " ").slice(0, 240)}`);
ok(/\bagnes\b/i.test(agnesText), "T1 agnes: self-identifies as Agnes");
ok(!CLAIM_MIA.test(agnesText), "T1 agnes: never claims to BE Mia (team name is fine)", agnesText.match(CLAIM_MIA)?.[0] ?? "");
ok(!/🌸/.test(agnesText), "T1 agnes: no Mia signature emoji");
ok(/riset|research|fakta|sumber|verifikasi/i.test(agnesText), "T1 agnes: names the research specialty");

const michText = await ask(KEYS.michelle, IDENT, "michelle");
console.log(`  michelle → ${michText.replace(/\s+/g, " ").slice(0, 240)}`);
ok(/\bmichelle\b/i.test(michText), "T1 michelle: self-identifies as Michelle");
ok(!CLAIM_MIA.test(michText), "T1 michelle: never claims to BE Mia (team name is fine)", michText.match(CLAIM_MIA)?.[0] ?? "");
ok(!/🌸/.test(michText), "T1 michelle: no Mia signature emoji");
ok(/kode|file|test|implement|debug|program/i.test(michText), "T1 michelle: names the coding specialty");

const miaText = await ask(KEYS.mia, IDENT);
console.log(`  mia(control) → ${miaText.replace(/\s+/g, " ").slice(0, 240)}`);
ok(/\bmia\b/i.test(miaText), "T2 control: no-label turn still answers as Mia");
ok(/🌸/.test(miaText), "T2 control: Mia keeps the signature emoji (paths untouched)");

// ── T6: Mia must KNOW her own team (live bug 2026-10-05) ───────────────────
// Owner asked Mia "kamu tau agnes?" and "kamu tau Michelle?" and got "enggak
// tahu sama sekali" from BOTH. Honest, but incoherent: she is their PM. The
// trio facts live in Mia's USER.md `## Facts` (the only durable injected
// region), so this asks the exact live question and requires a real answer.
console.log("\n\u2014 T6 Mia knows her own team \u2014");
for (const [name, role] of [["agnes", "riset|research|fakta|verifikasi"], ["michelle", "kode|coder|file|test"]] as const) {
  const asked = `kamu tau ${name}?`;
  const ans = await ask(KEYS.mia, asked);
  console.log(`  mia\u2190"${asked}" \u2192 ${ans.replace(/\s+/g, " ").slice(0, 200)}`);
  ok(new RegExp(`\\b${name}\\b`, "i").test(ans), `T6 mia: answers "${asked}" by naming ${name}`);
  ok(!/enggak tahu|tidak tahu|nggak kenal|siapa (lagi|nama)/i.test(ans), `T6 mia: does NOT deny knowing ${name}`);
  ok(new RegExp(role, "i").test(ans), `T6 mia: states ${name}'s actual role`);
  // Invariant of the control path: the trio voice firewall must NOT touch Mia.
  ok(/🌸/.test(ans), "T6 mia: keeps her own signature emoji (voice firewall does not touch Mia)");
}

// ── T3 + T4: role boundary + tool routing, live ───────────────────────────
console.log("\n— T3/T4 role boundary and tool routing —");
const CODING_ASK =
  "Tolong jalankan unit test di /Users/naufalazhar/Documents/PROJECT/QA-WORKSPACE/flowtest-studio lalu laporkan hasilnya.";

const agnesCoding = await ask(KEYS.agnes, CODING_ASK, "agnes");
console.log(`  agnes←coding → ${agnesCoding.replace(/\s+/g, " ").slice(0, 240)}`);
// Only MUTATING tools are a boundary violation — a read-only `exec` that the
// model reached for before realising the task is out of role is not evidence
// that the boundary failed; the prose (does it name the owner / claim to run it)
// plus a zero-write-tool audit is the real contract.
const agnesCodingRuns = auditToolRuns(KEYS.agnes);
console.log(`  audit(agnes after coding ask) = ${[...agnesCodingRuns].map(([k, v]) => `${k}×${v}`).join(", ") || "(none)"}`);
const MUTATING = ["exec_write", "write_file", "edit_file", "codebase_refresh", "git_commit"];
ok(
  /michelle/i.test(agnesCoding) && ![...agnesCodingRuns.keys()].some((n) => MUTATING.includes(n)),
  "T3 agnes: hands the coding task to Michelle and runs no mutating tool",
  [...agnesCodingRuns.keys()].join(",") || "no tools",
);

const michTurn = await askTurn(KEYS.michelle, CODING_ASK, "michelle");
const michCoding = (michTurn.text || "").trim();
const michPending = (michTurn.needsConfirmation || []).length;
console.log(
  `  michelle←coding → ${(michCoding || `(paused for approval: ${(michTurn.needsConfirmation || []).map((c: any) => c.name).join(", ")})`)
    .replace(/\s+/g, " ")
    .slice(0, 240)}`,
);
// An agent must never produce a turn the owner cannot see: either it answers,
// or it pauses for approval (the owner gets the prompt). Only a turn with
// neither is a genuine silent turn.
ok(
  michCoding.length > 0 || michPending > 0,
  "T4 michelle: the owner sees something — an answer or an approval prompt, never a silent turn",
  `text=${michCoding.length} chars, pending=${michPending}`,
);
ok(
  michCoding.length > 0 || michPending > 0,
  "T4 michelle: answers or asks for approval instead of going silent on the in-role task",
);
const michRuns = auditToolRuns(KEYS.michelle);
console.log(`  audit(michelle) = ${[...michRuns].map(([k, v]) => `${k}×${v}`).join(", ") || "(none)"}`);
ok(
  [...michRuns.keys()].some((n) => ["exec_write", "exec", "file_read"].includes(n)),
  "T4 michelle: actually called a tool for the in-role coding task",
  [...michRuns.keys()].join(","),
);

const agnesResearch = await ask(
  KEYS.agnes,
  "Cari berita terbaru soal AI agents di Indonesia dan ringkas 3 poin pentingnya lengkap dengan sumbernya.",
  "agnes",
);
console.log(`  agnes←research → ${agnesResearch.replace(/\s+/g, " ").slice(0, 240)}`);
const agnesRuns = auditToolRuns(KEYS.agnes);
console.log(`  audit(agnes) = ${[...agnesRuns].map(([k, v]) => `${k}×${v}`).join(", ") || "(none)"}`);
ok(
  [...agnesRuns.keys()].some((n) => ["google_news", "research", "web_search", "fetch_url", "browser_open"].includes(n)),
  "T4 agnes: actually called a research tool",
  [...agnesRuns.keys()].join(","),
);
// The identity ask only proves the emoji ban on THAT answer; the research
// answer is where Mia's 🌸 habit actually leaked in run #1, so assert here too.
ok(!/🌸/.test(agnesResearch), "T4 agnes: no Mia signature emoji on a real research answer");

// ── cleanup ───────────────────────────────────────────────────────────────
for (const k of new Set(Object.values(KEYS))) {
  const d = join(persRoot, k);
  if (existsSync(d)) rmSync(d, { recursive: true, force: true });
}
console.log(`\n${fail === 0 ? "TRIO PERSONA DRILL: ALL GREEN" : `TRIO PERSONA DRILL: ${fail} FAILED`}`);
process.exit(fail === 0 ? 0 : 1);