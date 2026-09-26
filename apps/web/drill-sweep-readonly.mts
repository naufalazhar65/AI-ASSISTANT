import { rmSync } from "node:fs";
import { join } from "node:path";
import { runPentestSweep, summarizeBody, sweepTargetFromAsk } from "./src/lib/pentestSweep";

// run-unique + auto-cleanup: the sweep writes http-history for its user, so a
// hardcoded key left a permanent .data/users/verify_sweep_probe behind (found
// and removed 2026-09-26). Same idiom as the other durable drills.
const USER = `verify_sweepprobe_${Date.now()}`;
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";
const ask = `full pentest menyeluruh di ${LAB}/cek-nik dan buatkan report markdown`;

console.log("targetFromAsk:", sweepTargetFromAsk(ask));
console.log("--- summarizeBody(JSON PII) ---");
console.log(summarizeBody('{"nik":"3571010101010001","nama":"Suharto"}'));

const t0 = Date.now();
const r = await runPentestSweep(USER, ask);
console.log("\nops:", r.ops.join(" | "), "| elapsed:", Date.now() - t0, "ms");
console.log("--- sweep text (700 char) ---");
console.log(r.text.slice(0, 700));
console.log("\n--- PII leaked into sweep text? ---", /3571010101010001|Suharto/.test(r.text) ? "YES (BUG)" : "no ✓");
console.log("--- sweep reported its own calls? ---", r.calls.length ? r.calls.map((c) => c.name).join(", ") : "(none)");

rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
