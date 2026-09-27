// Forensics probe: kyzuch-productivity-hub.vercel.app (live turn 13:19-13:20, 2026-09-27)
//
// GOTCHA (house rule): tsx does NOT load .env.local, so PENTEST_LAB_TARGETS
// would be EMPTY here and every host would DENY — a false conclusion. The first
// version of this probe made exactly that mistake. Parse it before importing.
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (v) process.env[m[1]] = v;
}

const { targetAllowed, isLabTarget } = await import("./src/lib/security");
const { toolsForUrl, buildSlimSystemPrompt } = await import("./src/lib/agent");

const HOST = "kyzuch-productivity-hub.vercel.app";
const KNOWN_LAB = "naufalv3.netlify.app";

const EXPECT: Record<string, boolean> = {
  [`https://${HOST}/`]: false,
  [`https://${HOST}/api/tools`]: false,
  [`https://${KNOWN_LAB}/`]: true,
};

let fail = 0;
console.log("── targetAllowed (SCOPE gate) ──");
for (const [u, want] of Object.entries(EXPECT)) {
  const got = targetAllowed(u);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${got ? "ALLOW" : "DENY "}  ${u}   (harap ${want ? "ALLOW" : "DENY"})`);
}
console.log(`isLabTarget(${HOST}) = ${isLabTarget(HOST)}  (harap false — env tidak memuatnya)`);

// Was the MANDATORY pre-check even reachable? The prompt demands
// engagement_list + pentest_resources before any scope refusal.
console.log("\n── pre-check wajib sampai ke model? (window 9router-64) ──");
const w = toolsForUrl("http://127.0.0.1:20128/v1").map((t) => t.function.name);
console.log(`window 9router = ${w.length} tool`);
for (const n of ["engagement_list", "pentest_resources", "target_brain", "engagement_create"]) {
  console.log(`  ${w.includes(n) ? "TER-DELIVERY  " : "TIDAK ada    "} ${n}`);
}
// Does the prompt tell the model to use tools it CANNOT see? A rule the model
// physically cannot follow is a rule that will be ignored, silently.
console.log("\n── hint/prompt menyebut tool yang tak ter-delivery? ──");
const prompt = buildSlimSystemPrompt();
for (const n of ["engagement_list", "engagement_create", "target_brain", "pentest_resources"]) {
  const delivered = w.includes(n);
  const demanded = new RegExp(`\\b${n}\\b`).test(prompt);
  const verdict = demanded && !delivered ? "⚠️  DIWAJIBKAN tapi TIDAK ter-delivery" : "ok";
  console.log(`  ${verdict}  ${n}  (di prompt: ${demanded}, ter-delivery: ${delivered})`);
}

console.log("\nPROBE_EXIT=" + (fail ? 1 : 0));
process.exit(fail ? 1 : 0);
