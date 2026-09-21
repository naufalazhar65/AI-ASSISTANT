// LIVE drill — js_deobfuscate against the owner's Netlify lab SPA.
// tsx does NOT load .env.local — parse it manually (AGENTS gotcha) so
// PENTEST_LAB_TARGETS is present for targetAllowed before any import.
import { readFileSync } from "node:fs";
import { join } from "node:path";
const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/index.html";

// Scope pre-check (same gate the tool uses)
const { targetAllowed } = await import("./src/lib/security");
console.log("targetAllowed(LAB):", targetAllowed(LAB));

const { executeTool } = await import("./src/lib/tools");
const usr = "naufalazhar652952";

console.log("\n── js_deobfuscate — live on Netlify lab SPA ──");
const out = await executeTool(
  { name: "js_deobfuscate", arguments: JSON.stringify({ url: LAB }) },
  usr
);
console.log((out || "").slice(0, 2500));

console.log("\n── sanity: endpoint signals present? ──");
const ok = /\/api\//.test(out) || /endpoint/i.test(out);
console.log("api-endpoints surfaced:", ok ? "YES" : "no (maybe inline/empty bundle)");