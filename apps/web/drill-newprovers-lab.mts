// LIVE drill (no LLM) — run each NEW 2026-09-24 prover directly (executeTool)
// against the owner's Netlify lab. Complements drill-fullpentest-discord.mts:
// that one proves delivery/confirmation/PDF through the LLM; this one proves
// the provers themselves handle a REAL target without crashing, respect scope,
// and report honest negatives (the lab is unlikely vulnerable to every class).
//
// House rules: user run-unique + auto-cleanup; tsx parses .env.local manually;
// proof = tool output verdicts (honest negative is a PASS), never prose.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { executeTool } = await import("./src/lib/tools");
const { isLabTarget } = await import("./src/lib/security");

const USER = `verify_fplab_${Date.now()}`;
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

if (!isLabTarget(LAB)) { console.error("lab not authorized — aborting"); process.exit(1); }

async function run(name: string, args: Record<string, unknown>) {
  try {
    const out = await executeTool({ id: `d-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name, arguments: JSON.stringify(args) }, USER);
    return out;
  } catch (e) {
    return `Error: ${(e as Error).message}`;
  }
}
const isErr = (s: string) => s.startsWith("Error:");
const head = (s: string, n = 110) => s.replace(/\s+/g, " ").slice(0, n);

console.log(`── live prover sweep on ${LAB} (user ${USER}) ──\n`);

// 1. path_traversal — reflective param probe; honest negative expected.
//    Arg = `params` (string koma), BUKAN `param` — `param` diabaikan diam-diam.
const pt = await run("path_traversal", { url: `${LAB}/api/cek-nik?id=1`, params: "id" });
ok(!isErr(pt), "path_traversal: no crash on real target", head(pt));
ok(!isErr(pt) && /tidak|no |none|jel|anomaly|bukan temuan|info/i.test(pt), "path_traversal: honest negative or lead (not a fake claim)", head(pt, 90));

// 2. ssti_enum — fingerprint only, never sends RCE payloads
const se = await run("ssti_enum", { url: `${LAB}/`, param: "q" });
ok(!isErr(se), "ssti_enum: no crash", head(se));
ok(!isErr(se) && !/RCE payload|execute\(|eval\(/i.test(se), "ssti_enum: fingerprint-only (no RCE payloads sent)", head(se, 90));

// 3. param_miner — unkeyed discovery; noise tolerance on static site
const pm = await run("param_miner", { url: `${LAB}/index.html` });
ok(!isErr(pm), "param_miner: no crash", head(pm));

// 4. otp_hunt — no OTP flow on the lab → honest negative expected (user_value = akun A)
const oh = await run("otp_hunt", { url: `${LAB}/api/login`, user_value: "verify@lab.test" });
ok(!isErr(oh), "otp_hunt: no crash on target without OTP flow", head(oh));

// 5. account_recovery — forgot endpoint arg is request_url; 404-ish → honest negative
const ar = await run("account_recovery", { request_url: `${LAB}/api/login` });
ok(!isErr(ar), "account_recovery: no crash", head(ar));

// 6. csv_inject — needs export endpoint; honest negative expected
const ci = await run("csv_inject", { url: `${LAB}/api/export` });
ok(!isErr(ci), "csv_inject: no crash", head(ci));

// 7. blind_cmdi — time-based pair (6s) + auto-OAST; slowest, run last.
//    `params` (string koma), bukan `param` — time_only:1 agar tak bergantung egress OAST.
const bc = await run("blind_cmdi", { url: `${LAB}/api/cek-nik?id=1`, params: "id", time_only: true });
ok(!isErr(bc), "blind_cmdi: no crash (time-based + OAST path)", head(bc));

console.log(fail === 0 ? "\nLAB SWEEP DONE — all provers handled a real target" : `\nLAB SWEEP: ${fail} FAIL`);
rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
