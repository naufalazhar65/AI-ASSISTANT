// Prove the full Discord-shaped turn now completes: compulsory sweep runs, the
// policy module resolves (was the missing lazy chunk), and the reply is backed
// by real observations instead of a stale findings dump.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const env = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of env.split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  let v = m[2].trim().replace(/^["']|["']$/g, "");
  if (v) process.env[m[1]] = v;
}

const { runAssistantTurn } = await import("./src/lib/agent");
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const user = `verify_sweeplive_${Date.now()}`;

const r = await runAssistantTurn({
  messages: [{ role: "user", content: `mia coba melakukan full pentest menyeluruh di ${LAB}/cek-nik dan buatkan report markdown nya` }],
  provider: "9router",
  user,
  channel: "discord",
});

console.log("needsConfirmation:", r.needsConfirmation?.length ?? 0);
console.log("providerUsed     :", r.providerUsed);
console.log("text length      :", r.text.length);
console.log("--- text (700) ---");
console.log(r.text.slice(0, 700));
console.log("\n--- honesty markers present? ---");
for (const k of ["Catatan jujur", "tidak menyentuh", "BELUM masuk daftar", "terpotong"]) {
  if (r.text.includes(k)) console.log(`  ✓ "${k}"`);
}
