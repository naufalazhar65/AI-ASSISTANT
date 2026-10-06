// probe-style-sweep.mts — broad LIVE style sweep across the whole office-style
// guard battery (owner 2026-10-06: "coba test lagi, pastikam tidak ada yg aneh").
//
// Why a probe and not only unit tests: the unit tests prove each guard fires on
// the exact string that once shipped. They CANNOT prove that the chain as a
// whole leaves nothing weird across ORDINARY asks — the whack-a-mole class of
// bug this repo keeps hitting (a rule fixed in isolation, another one leaking
// through the next day).
//
// What it does: runs a matrix of casual everyday asks through all three agents
// on the real provider, then re-checks EVERY delivered reply against the full
// battery — pronouns, glyph/pet-name leaks (trio only), closing menu offer,
// unearned work claim, bare vocative, corporate opener, forced numbered list,
// CJK, runaway length. A reply that already contains something a guard should
// have rewritten is a FAIL even when it reads nicely.
//
// Safety: no Discord gateway, no outbound messages, run-unique throwaway user
// keys, auto-cleanup. Run from repo root:
//   npx tsx apps/web/probe-style-sweep.mts
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import { userDataRoot } from "./src/lib/users";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn } = await import("./src/lib/agent");
const role = await import("./src/lib/agentRole");
const { ensureAgentPersona } = await import("./src/channels/discord");
const { setPersonaFact } = await import("./src/lib/persona");

const STAMP = Date.now();
const BASE = `verify_stylesweep_${STAMP}`;
const KEYS = { mia: BASE, agnes: `${BASE}.agnes`, michelle: `${BASE}.michelle` } as const;
for (const label of ["agnes", "michelle"] as const) ensureAgentPersona(label, KEYS[label]);
for (const k of Object.values(KEYS)) setPersonaFact(k, "name", "Naufal");

const AGENTS = ["mia", "agnes", "michelle"] as const;
type Agent = (typeof AGENTS)[number];

/** Everyday asks, chosen to cover the turns that have actually broken before:
 *  greeting (bare echo / invented work), trivia (encyclopedic register),
 *  capability question (menu offer), mood, thanks, plan + place intent
 *  (the deterministic nudge), technical, and a terse Jaksel aside. */
const ASKS = [
  "halo semua",
  "tau jaksel?",
  "kamu bisa apa aja?",
  "aku lagi capek banget hari ini",
  "makasih ya udah nungguin",
  "udah makan? enaknya makan apa malem ini",
  "jelasin singkat dong apa itu prompt injection",
  "makanya gitu?",
] as const;

const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
const CJK = /[\u3000-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/;

interface Finding { agent: Agent; ask: string; kind: string; detail: string }
const findings: Finding[] = [];
const note = (agent: Agent, ask: string, kind: string, detail = "") =>
  findings.push({ agent, ask, kind, detail });

async function turn(user: string, agent: Agent | undefined, ask: string): Promise<string> {
  const r = await runAssistantTurn({
    messages: [{ role: "user", content: ask }],
    user,
    channel: "discord",
    ...(agent ? { agent } : {}),
  });
  return (r.text ?? "").trim();
}

function inspect(agent: Agent, ask: string, text: string) {
  const trio = agent !== "mia";

  if (!text) { note(agent, ask, "empty reply"); return; }

  // 1. banned pronouns (owner spec: aku/kamu, never gue/gua/lu/lo)
  const pron = text.match(/\b(gue|gua|lo|lu)\b/gi);
  if (pron) note(agent, ask, "banned pronoun", [...new Set(pron)].join(", "));

  // 2. signature glyph + Mia's pet name must never reach the trio
  if (trio) {
    if (/\u{1F338}/u.test(text)) note(agent, ask, "🌸 leaked into trio");
    if (/\bbeb\b/i.test(text)) note(agent, ask, "Mia's pet name 'beb' used by trio");
  }

  // 3. closing menu offer — re-run the guard: if it would still rewrite, the
  //    deployed chain let one through.
  const afterMenu = role.stripClosingMenuQuestion(text);
  if (afterMenu !== text) note(agent, ask, "menu offer survived", text.slice(-70));

  // 4. unearned work claim (ranTool:false is the honest reading for a casual
  //    ask that ran nothing; a still-rewritable claim means one leaked).
  const afterClaim = role.stripUnearnedWorkClaim(text, { ranTool: false });
  if (afterClaim !== text) note(agent, ask, "work claim survived", text.slice(-70));

  // 5. bare vocative right after a greeting (must be "Mas + name")
  if (/^(?:halo|hai|hey|hi|ohai|hei|oi)\s+[A-Z]/.test(text) && !/\b(?:Mas|Mba|Mb|Bang|Bpk|Bu|Pak|Kak|Sir|Mam|Om)\b/.test(text.slice(0, 30))) {
    note(agent, ask, "bare vocative", text.slice(0, 40));
  }

  // 6. corporate / formal opener
  if (/^\s*(Certainly|Acknowledged|Understood|Noted|As per|In accordance|I would be happy|Permit me|Here is|Here are)\b/i.test(text)) {
    note(agent, ask, "corporate opener", text.slice(0, 50));
  }

  // 7. forced numbered list on a casual ask
  if (/^\s*1[.)]\s+/m.test(text) && !/\?/.test(text.split("\n")[0])) {
    note(agent, ask, "forced numbered list", text.slice(0, 50));
  }

  // 8. CJK must never ship (the stripNonLatinChars guard exists for this)
  if (CJK.test(text)) note(agent, ask, "CJK leaked");

  // 9. runaway length for a one-line ask
  if (words(text) > 90) note(agent, ask, "runaway length", `${words(text)} words`);

  // 10. mangled punctuation (a guard that cut mid-sentence leaves this behind)
  // An ellipsis ("rasanya...") is legitimate Indonesian punctuation, so a run of two or
  // more dots is NOT mangled — only a space before punctuation or a doubled "?!" is.
  if (/(?:\s+[.,!?]|[?!]{2,})/.test(text)) note(agent, ask, "mangled punctuation", text.slice(0, 60));
}

/** Informational only — Mia still says "sejak ini" (residual #3, out of scope).
 *  Noted so the sweep stays honest instead of pretending it is clean. */
const SOFT = /\bsejak (?:ini|kemarin|lusa)\b/gi;

console.log(`style sweep — ${ASKS.length} asks × ${AGENTS.length} agents on provider 9router\n`);
const softHits: string[] = [];
let miaGlyph = 0;
const replies: string[] = [];

for (const ask of ASKS) {
  for (const agent of AGENTS) {
    const user = KEYS[agent];
    let text = "";
    try {
      text = await turn(user, agent === "mia" ? undefined : agent, ask);
    } catch (e) {
      note(agent, ask, "turn threw", String(e).slice(0, 80));
      console.log(`✗ ${agent.padEnd(8)} ${ask} — threw ${String(e).slice(0, 60)}`);
      continue;
    }
    replies.push(`[${agent}] ${ask} → ${text}`);
    console.log(`${text ? "·" : "✗"} ${agent.padEnd(8)} ${text}`);
    if (agent === "mia" && /\u{1F338}/u.test(text)) miaGlyph++;
    if (SOFT.test(text)) softHits.push(`${agent}: ${text.match(SOFT)?.[0]}`);
    SOFT.lastIndex = 0;
    inspect(agent, ask, text);
  }
  console.log("");
}

console.log(`\n=== scorecard ===`);
if (findings.length === 0) {
  console.log(`✓ ${ASKS.length * AGENTS.length} replies, 0 anomalies across the whole battery`);
} else {
  for (const f of findings) console.log(`✗ [${f.agent}] "${f.ask}" → ${f.kind}${f.detail ? ` — ${f.detail}` : ""}`);
  console.log(`✗ ${findings.length} anomalies`);
}
console.log(`· Mia kept 🌸 on ${miaGlyph}/${ASKS.length} replies (her signature, not a defect)`);
if (softHits.length) console.log(`· soft (known residual #3, out of scope): ${softHits.length} → ${[...new Set(softHits)].join(", ")}`);

for (const k of Object.values(KEYS)) {
  const dir = join(userDataRoot(), k);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
console.log("\nprobe users cleaned up");

process.exit(findings.length === 0 ? 0 : 1);