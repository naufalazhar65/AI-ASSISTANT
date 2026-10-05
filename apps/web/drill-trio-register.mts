// LIVE drill for the trio REGISTER firewall (agentRole.ts, 2026-10-05).
//
// Why a drill and not unit tests: the unit tests prove the detector fires on the
// transcribed stiff answer and stays silent on Mia's warm one. They CANNOT prove
// the production chain actually rewrites the answer — the polish pass is an LLM
// call, and the strip is wired inside runAgent where a renamed variable would
// silently disable it (the stale-server lesson from 2026-09-23 17:34).
//
// What is proven here, against the REAL provider the three bots use:
//   R1  the live question ("tau jaksel?", transcribed from the Discord turn the
//       owner called stiff) comes back in a spoken register — no encyclopedia
//       opener, no "want to know more?" closer, and a length that fits a
//       three-word question.
//   R2  CONTROL: Mia, asked the SAME question in the same turn shape, keeps her
//       own voice. A firewall that also rewrote Mia would be a bug, so this is
//       the assertion that keeps the guard honest.
//   R3  Michelle answers a short ask short — the same length rule must reach
//       the Coder, not just the Researcher.
//   R4  WIRING: the deployed code contains the firewall call and the detector in
//       runAgent. Proven by reading the source, because a live run cannot
//       distinguish "the strip fired" from "the model simply wrote better".
//
// Safety: no Discord gateway, no outbound messages, run-unique throwaway user
// keys, auto-cleanup. Run from repo root: npx tsx apps/web/drill-trio-register.mts
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn } = await import("./src/lib/agent");
const { isEncyclopedicRegister } = await import("./src/lib/agentRole");
const { ensureAgentPersona } = await import("./src/channels/discord");

const STAMP = Date.now();
const BASE = `verify_register_${STAMP}`;
const KEYS = { mia: BASE, agnes: `${BASE}.agnes`, michelle: `${BASE}.michelle` } as const;
for (const label of ["agnes", "michelle"] as const) ensureAgentPersona(label, KEYS[label]);

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
};

// The exact question from the live transcript the owner called stiff.
const JAKSEL = "tau jaksel?";

async function turn(user: string, agent?: "agnes" | "michelle", text = JAKSEL): Promise<string> {
  const r = await runAssistantTurn({
    messages: [{ role: "user", content: text }],
    user,
    channel: "discord",
    ...(agent ? { agent } : {}),
  });
  return (r.text ?? "").trim();
}

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Register features, kept in the drill (not imported) so a lib change that
 *  weakened the detector cannot silently weaken the assertion too. */
function stiffSignals(s: string): string[] {
  const bad: string[] = [];
  if (/^\s*(tentu saja|baiklah|oke,|sip,|wah,)/i.test(s)) bad.push("acknowledging opener");
  if (/(adalah|merupakan)\s+(salah satu|sebuah)\s+\S+/i.test(s)) bad.push("definitional opener");
  if (/\bterletak\b|\byang dikenal sebagai\b/i.test(s)) bad.push("encyclopedic connector");
  if (/\b(ada hal (khusus|lain)|apakah ada (hal|lain)|silakan (bertanya|menanyakan))\b[^.?!]*\?/i.test(s)) {
    bad.push("formal closer");
  }
  return bad;
}

try {
  // R1 — Agnes on the live question.
  const agnesReply = await turn(KEYS.agnes, "agnes");
  console.log(`\n[agnes] ${agnesReply}\n`);
  const agnesBad = stiffSignals(agnesReply);
  ok(agnesBad.length === 0, "R1a Agnes: no stiff register markers", agnesBad.join(", ") || "clean");
  ok(wordCount(agnesReply) <= 60, "R1b Agnes: length fits a three-word question", `${wordCount(agnesReply)} words`);
  ok(!isEncyclopedicRegister(agnesReply), "R1c Agnes: detector is silent on what the user actually received");
  ok(/\bmak\b|mas\b|\bkamu\b|\bni\b|\bsih\b|\bya\b/i.test(agnesReply), "R1d Agnes: everyday register reached the user", agnesReply.slice(0, 60));

  // R2 — CONTROL: Mia, same question, must keep her own voice (🌸, her warmth).
  const miaReply = await turn(KEYS.mia, undefined);
  console.log(`\n[mia] ${miaReply}\n`);
  ok(miaReply.length > 0, "R2a Mia: still answers the same question");
  ok(/\u{1F338}/u.test(miaReply), "R2b Mia: keeps her signature — the firewall is trio-only", miaReply.slice(0, 60));

  // R3 — Michelle, short ask, short answer.
  const michelleReply = await turn(KEYS.michelle, "michelle", "repo ini ada file apa aja?");
  console.log(`\n[michelle] ${michelleReply}\n`);
  const michelleBad = stiffSignals(michelleReply);
  ok(michelleBad.length === 0, "R3a Michelle: no stiff register markers", michelleBad.join(", ") || "clean");
  ok(!/\u{1F338}/u.test(michelleReply), "R3b Michelle: no borrowed signature glyph");

  // R4 — WIRING. A live run cannot tell "the strip fired" from "the model wrote
  // better this time", so prove the deployed source still contains the hook.
  const src = readFileSync(join(process.cwd(), "apps/web/src/lib/agent.ts"), "utf8");
  ok(src.includes("stripFormalRegisterFrame(text, opts.agent)"), "R4a runAgent calls the deterministic strip");
  ok(/registerStiff\s*\|\|?\s*isEncyclopedicRegister|isEncyclopedicRegister\(text\)/.test(src), "R4b runAgent feeds the detector into the polish pass");
  const persona = readFileSync(join(process.cwd(), "apps/web/persona/agents/agnes.SOUL.md"), "utf8");
  ok(/Panjang jawaban ikut pertanyaan/.test(persona), "R4c the shipped persona carries the length rule");
  ok(existsSync(join(process.cwd(), "apps/web/.data/users", KEYS.agnes, "persona", "SOUL.md")), "R4d the drill's seeded persona exists");

  // R5 — the place nudge is appended AFTER the firewall, so its SHAPE is part of
  // the register contract (live defect 2026-10-05 23:09: the hardcoded Mia string
  // pasted a glyph + a formal delegating closer into Michelle's coffee answer).
  const nudgeSrc = readFileSync(join(process.cwd(), "apps/web/src/lib/placeIntent.ts"), "utf8");
  ok(/TRIO_NUDGE/.test(nudgeSrc), "R5a placeIntent carries a separate trio shape");
  ok(/agent\?\: AgentLabel \| null/.test(nudgeSrc), "R5b placeNudge takes the agent label");
  ok(/schedulePlaceCheckFromIntent\(messages, text, collector\.webSearchSuccess, opts\.agent\)/.test(src), "R5c the main path threads the label in");
  ok(/schedulePlaceCheckFromIntent\(messages, opencodeText \|\| "", false, opts\.agent\)/.test(src), "R5d the opencode path threads the label in");
} finally {
  for (const k of [BASE, KEYS.agnes, KEYS.michelle]) {
    rmSync(join(process.cwd(), "apps/web/.data/users", k), { recursive: true, force: true });
  }
}

console.log(`\n${fail === 0 ? "ALL GREEN" : `FAIL (${fail})`}`);
process.exit(fail === 0 ? 0 : 1);
