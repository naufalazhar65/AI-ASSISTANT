// probe-greeting-clock.mts — LIVE check of the 19:48 fixes (owner: "kenapa dia
// bilang 'Sore'? padahal sekarang jam 19:50, apakah mereka tidak bisa liat jam
// realtime?").
//
// Why a probe and not only unit tests: the unit tests prove the clock-driven
// pool returns the right band. They CANNOT prove what the MODEL answers before
// my deterministic rescue overwrites it, nor that the rescue is what finally
// ships. That composition only exists in a real turn.
//
// It checks every delivered reply for:
//   - a FOREIGN time word for the current WIB hour (the exact 19:50 bug),
//   - a self-introduction ("Aku Agnes/Michelle"),
//   - an unearned work claim ("lagi siap-siap …"),
//   - a 🌸 / "beb" leak into the trio (Mia keeps her 🌸 by design).
//
// Safety: no Discord gateway, no outbound messages, run-unique throwaway user
// keys, auto-cleanup. Run from repo root:
//   npx tsx apps/web/probe-greeting-clock.mts
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { userDataRoot } from "./src/lib/users";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn } = await import("./src/lib/agent");
const { ensureAgentPersona } = await import("./src/channels/discord");
const { setPersonaFact } = await import("./src/lib/persona");
const { dayPartAt } = await import("./src/lib/agentRole");
const { wibParts } = await import("./src/lib/time");

const STAMP = Date.now();
const BASE = `verify_greetclock_${STAMP}`;
const KEYS = { mia: BASE, agnes: `${BASE}.agnes`, michelle: `${BASE}.michelle` } as const;
for (const label of ["agnes", "michelle"] as const) ensureAgentPersona(label, KEYS[label]);
for (const k of Object.values(KEYS)) setPersonaFact(k, "name", "Naufal");

const ASK = "halo semua";
/** Words that are CORRECT for a different band than the current one. The check
 *  is deliberately the inverse of the pool: the pool picks one band, so a reply
 *  naming any OTHER band is a clock mismatch. */
const BAND_WORD = { pagi: /sore|malam|siang/i, siang: /pagi|sore|malam/i, sore: /pagi|siang|malam/i, malam: /pagi|siang|sore/i } as const;
const SELF_INTRO = /\b(?:aku|saya)\s+(?:agnes|michelle|mia)\b/i;
const WORK_CLAIM = /\b(?:lagi|sedang|baru saja|barusan)\s+\S+/i;
const GLYPH = /\u{1F338}/u;

const now = Date.now();
const part = dayPartAt(now);
const clock = `${String(wibParts(now).h).padStart(2, "0")}.${String(wibParts(now).mi).padStart(2, "0")}`;
console.log(`\n=== greeting clock probe — now ${clock} WIB (band: ${part}) — ask: "${ASK}" ===\n`);

let fails = 0;
const say = (ok: boolean, msg: string): void => {
  if (!ok) fails++;
  console.log(`  ${ok ? "✓" : "✗"} ${msg}`);
};

try {
  for (const agent of ["mia", "agnes", "michelle"] as const) {
    const r = await runAssistantTurn({
      messages: [{ role: "user", content: ASK }],
      user: KEYS[agent],
      channel: "discord",
      agent,
    });
    const text = (r.text || "").replace(/\s+/g, " ").trim();
    console.log(`[${agent}] ${text}\n`);
    if (!text) {
      say(false, `${agent}: empty reply`);
      continue;
    }
    const foreign = BAND_WORD[part].test(text);
    say(!foreign, `${agent}: no foreign time word for band "${part}"`);
    say(!SELF_INTRO.test(text), `${agent}: no self-introduction`);
    say(!WORK_CLAIM.test(text), `${agent}: no unearned work claim`);
    if (agent === "mia") say(GLYPH.test(text), `${agent}: keeps her own 🌸`);
    else say(!GLYPH.test(text) && !/\bbeb\b/i.test(text), `${agent}: no 🌸 / "beb" leak`);
    say(!/^\s*(?:halo|hai|hei|hi|ohai)\s+mas\s+naufal\s*[.!]?\s*$/i.test(text), `${agent}: not a bare echo`);
  }
} finally {
  for (const k of new Set(Object.values(KEYS))) rmSync(join(userDataRoot(), k), { recursive: true, force: true });
}

console.log(`\n=== ${fails === 0 ? "ALL GREEN" : `${fails} FAIL`} ===\n`);
process.exit(fails === 0 ? 0 : 1);