// A/B: does the word "sayang" change the reply? (2026-09-27)
// Owner's hypothesis, tested rather than assumed. Both messages are sent through
// the real runAssistantTurn with the same prior context, so the only difference
// is the term of endearment.
//
// tsx does NOT load .env.local (documented in AGENTS), so the provider key has
// to be read in before agent.ts resolves anything — otherwise every case comes
// back 401 and the test silently measures nothing.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
for (const line of readFileSync(join(import.meta.dirname, ".env.local"), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { runAssistantTurn } = await import("./src/lib/agent");

// Run-unique throwaway user (house rule).
// v1 used the OWNER's key, so every A/B case appended its synthetic turn to the
// owner's daily memory and fed the persona auto-capture with a fabricated
// context ("PDF laporannya sudah jadi", "Heey beb…") that the owner never
// said. The probe is self-contained — it ships its own `prior` context — so it
// needs no real store: it now measures the SAME wording difference over a
// scratch user that is deleted on exit.
const USER = `verify_intimacy_${Date.now()}`;

// A condensed version of the real context: several pentest turns, so the
// anchoring effect is present the way it was in production.
const prior: any[] = [
  { role: "user", content: "mia coba lakukan full pentest secara menyeluruh di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/login dan buatkan report pdf nya" },
  { role: "assistant", content: "Siap Mas Naufal, PDF laporannya sudah jadi dan bisa kamu cek di reports/." },
  { role: "user", content: "sekarang aku tdr dulu ya" },
  { role: "assistant", content: "Heey beb 🌸 Untung kamu nyapa — mau cerita apa sekadar nge-chat aja nih?" },
];

const cases: Array<[string, string]> = [
  ["A  tanpa 'sayang'", "iya, sekarang aku tdr dulu ya"],
  ["B  dengan 'sayang'", "iya sayang, sekarang aku tdr dulu ya"],
  ["C  farewell lain", "aku mau tidur sekarang, besok pagi lagi ya"],
  ["D  socialize saja", "halo,Apa kabar?"],
];

for (const [label, msg] of cases) {
  try {
    const r: any = await runAssistantTurn({
      messages: [...prior, { role: "user", content: msg }],
      provider: "9router",
      user: USER,
      channel: "discord",
    });
    const text = String(r?.text || "").replace(/\s+/g, " ").trim();
    console.log(`\n### ${label}\n    pesan : ${msg}\n    balasan: ${text.slice(0, 300)}`);
  } catch (e) {
    console.log(`\n### ${label}\n    ERROR: ${String(e).slice(0, 160)}`);
  }
}

// Cleanup the scratch user's data dir (nothing was ever under the owner key).
try {
  rmSync(join(import.meta.dirname, ".data", "users", USER), { recursive: true, force: true });
} catch { /* best-effort */ }
