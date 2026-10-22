// LIVE probe — does Mia still over-act after the natural-style fix?
//
// Owner brief (2026-10-22): Mia must sound like a friend, not a customer-service
// bot: no praise openers, no mandatory trailing question, no service menu, no
// padded long answers, small answers stay small.
//
// This probe drives EIGHT scripted turns through the real production turn path
// (runAssistantTurn, provider 9router, channel discord) with a run-unique
// throwaway user, then measures the reply text.
//
// HARD failures (exit 1):
//   - service-menu offer anywhere in the reply (opening OR closing)
//   - forced " ya beb 🌸" suffix      (the deterministic tic we deleted)
//   - performative affection          (seneng bisa bantu / aku senang / …)
//   - over-claiming memory           (ingat semua hal kecil / kamu spesial)
//   - length blow-up on a short turn
//   - the honorific in EVERY reply     (call-centre tic: "Mas Naufal" every time)
//   - an emoji on a one-liner reply
//
// A turn that dies on provider infra (502/timeout) is recorded as ERROR and the
// run continues; the probe then exits 2 = INCONCLUSIVE (not a style verdict).
//
// tsx does NOT load .env.local — parse manually (repo gotcha).
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn } = await import("./src/lib/agent");

const USER = `probe_natural_${Date.now()}`; // run-unique: audit log is append-only/shared
const USER_DIR = join(process.cwd(), "apps/web/.data/users", USER);

// Whole-reply service-menu detector: an offer at the START counts as much as one
// at the end (run 1 showed "ada yang bisa aku bantu hari ini?" sliding through
// because the old regex only knew the "kubantu" spelling).
const MENU =
  /ada yang bisa (aku |k )?bantu|ada yang (mau |bisa )|mau aku (bantu|bantuin|lanjutin|lanjut)|bisa kubantuin|butuh bantuan apa|bantu apa\?|mau lanjut\b/i;
const AFFECTION = /seneng bisa bantu|aku senang|senang kamu|terima kasih sudah|beneran seneng|aku senang sekali/i;
const MEMORY_OVERCLAIM = /ingat semua hal kecil|kamu spesial|selalu ingat semua|selalu diingat|pasti selalu ingat|selalu ingat/i;
const VOCATIVE = /\bMas Naufal\b|\bbeb\b/i;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

const TURNS: { ask: string; short: boolean; label: string }[] = [
  { ask: "halo", short: true, label: "greeting" },
  { ask: "makasih ya", short: true, label: "thanks" },
  { ask: "lagi ngapain?", short: true, label: "status" },
  { ask: "kamu masih ingat?", short: true, label: "memory" },
  { ask: "berapa 17 x 23?", short: true, label: "technical" },
  { ask: "hari ini capek banget sih", short: true, label: "mood" },
  { ask: "tau gak apa itu Quantum Bakery di Bandung?", short: true, label: "unknown" },
  { ask: "terus yang tadi?", short: false, label: "follow-up" },
];

let fail = 0;
let errored = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
};
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const endsWithQuestion = (s: string) => /[?？]\s*$/.test(s.trim());

type Msg = { role: "user" | "assistant"; content: string };
const history: Msg[] = [];
const replies: { label: string; text: string; words: number }[] = [];
let trailingQuestions = 0;
let totalWords = 0;

try {
  for (const t of TURNS) {
    history.push({ role: "user", content: t.ask });
    let text = "";
    try {
      const res = await runAssistantTurn({
        messages: history as never,
        provider: "9router",
        user: USER,
        channel: "discord",
      });
      text = (res.text ?? "").trim();
    } catch (e) {
      errored++;
      console.log(`\n── ${t.label}: "${t.ask}" → ERROR (infra, not a style verdict)`);
      console.log(`   ${String(e).slice(0, 200)}`);
      continue;
    }
    history.push({ role: "assistant", content: text });
    const w = words(text);
    totalWords += w;
    replies.push({ label: t.label, text, words: w });
    if (endsWithQuestion(text)) trailingQuestions++;
    console.log(`\n── ${t.label}: "${t.ask}" → ${w} words`);
    console.log(`   ${text.replace(/\n/g, " ⏎ ")}`);

    ok(!MENU.test(text), `${t.label}: no service-menu offer`, MENU.test(text) ? text.slice(0, 90) : "");
    ok(!/ya beb 🌸\s*$/.test(text), `${t.label}: no forced "ya beb 🌸" suffix`);
    ok(!AFFECTION.test(text), `${t.label}: no performative affection`, AFFECTION.test(text) ? text.slice(0, 90) : "");
    ok(!MEMORY_OVERCLAIM.test(text), `${t.label}: no memory over-claim`);
    if (t.short) ok(w <= 30, `${t.label}: short answer stays short`, `${w} words`);
    if (w <= 12) ok(!EMOJI.test(text), `${t.label}: short reply carries no emoji`, text.slice(0, 60));
  }
} finally {
  if (existsSync(USER_DIR)) rmSync(USER_DIR, { recursive: true, force: true });
  console.log(`\ncleanup: removed ${USER_DIR}`);
}

// The honorific must not be in EVERY reply — that is the call-centre tic.
const withVocative = replies.filter((r) => VOCATIVE.test(r.text)).length;
if (replies.length > 0) {
  ok(withVocative < replies.length, "the honorific is not in every reply", `${withVocative}/${replies.length}`);
}

const measured = replies.length;
console.log(
  `\nSOFT: trailing question on ${trailingQuestions}/${measured} turns · avg ${measured ? Math.round(totalWords / measured) : 0} words/turn · vocative in ${withVocative}/${measured} · emoji in ${replies.filter((r) => EMOJI.test(r.text)).length}/${measured}`,
);
if (errored) console.log(`ERROR: ${errored} turn(s) died on provider infra → INCONCLUSIVE`);
console.log(
  fail === 0 ? (errored ? "NATURAL STYLE PROBE: INCONCLUSIVE" : "NATURAL STYLE PROBE: PASS") : `NATURAL STYLE PROBE: ${fail} FAIL`,
);
process.exit(fail === 0 ? (errored ? 2 : 0) : 1);
