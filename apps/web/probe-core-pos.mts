// Where does engagement_create sit inside CORE, and where is the 9router-64 cut?
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (v) process.env[m[1]] = v;
}
const { CORE_TOOL_NAMES, toolsForUrl } = await import("./src/lib/agent");

const order = [...CORE_TOOL_NAMES];
console.log(`CORE total = ${order.length} (harap 128)`);

const WANT = ["engagement_create", "engagement_list", "pentest_resources", "target_brain", "finding_list", "http_request", "report_pdf"];
console.log("\n── posisi di CORE (1-based) vs jendela 9router-64 ──");
const win = new Set(toolsForUrl("http://127.0.0.1:20128/v1").map((t) => t.function.name));
for (const n of WANT) {
  const i = order.indexOf(n);
  console.log(`  ${String(i + 1).padStart(3)}  ${win.has(n) ? "dalam-window" : "DI LUAR    "}  ${n}`);
}

console.log(`\njendela 9router = ${win.size} tool; CORE = ${order.length}`);
console.log(`CORE di luar jendela = ${order.length - win.size}`);

const missing = order.filter((n) => !win.has(n));
console.log(`\n── ${missing.length} tool CORE di luar jendela 9router, urut ──`);
for (const n of missing) {
  const i = order.indexOf(n) + 1;
  console.log(`  ${String(i).padStart(3)}  ${n}`);
}
