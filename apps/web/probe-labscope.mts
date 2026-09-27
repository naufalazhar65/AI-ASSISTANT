// Probe: is naufalv3.netlify.app now in scope, and is the refusal path reachable?
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isLabTarget, targetAllowed } from "./src/lib/security";
import { engagementAllows } from "./src/lib/engagement";

// Run from the REPO ROOT (house rule): .env.local lives at apps/web/.env.local.
const env = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of env.split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const HOSTS = [
  "naufalv3.netlify.app",                 // the newly added lab
  "https://naufalv3.netlify.app/cek-nik", // a path on it
  "https://naufalv3.netlify.app/api/x?q=1",
  "cozy-kangaroo-42f2e0.netlify.app",     // the pre-existing lab
  "example.com",                          // must stay OUT
  "naufalv3.netlify.app.evil.com",        // must stay OUT (suffix trick)
];
// EXPECTED per host. A lab host (with or without a path) must ALLOW; the two
// negatives must stay DENY — an unlisted host leaking into scope is the failure
// that matters, so the negatives are asserted, not just printed.
const EXPECT: Record<string, boolean> = {
  "naufalv3.netlify.app": true,
  "https://naufalv3.netlify.app/cek-nik": true,
  "https://naufalv3.netlify.app/api/x?q=1": true,
  "cozy-kangaroo-42f2e0.netlify.app": true,
  "example.com": false,
  "naufalv3.netlify.app.evil.com": false,
};

let fail = 0;
console.log("== scope gate: lab hosts + negative controls ==");
for (const h of HOSTS) {
  const lab = isLabTarget(h);
  const allowed = targetAllowed(h);
  const want = EXPECT[h];
  const got = allowed === true;
  const ok = got === want;
  if (!ok) fail++;
  const eng = engagementAllows ? (() => { try { return engagementAllows(h); } catch { return "n/a"; } })() : "n/a";
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${got ? "ALLOW" : "DENY "}  lab=${String(lab).padEnd(5)} eng=${String(eng).padEnd(5)}  ${h}`);
}
console.log(fail === 0 ? "\nSEMUA SCOPE GATE BENAR" : `\n${fail} scope gate salah`);
process.exit(fail ? 1 : 0);
