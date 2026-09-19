// Audit probe: edge paths of the 5 superpower tools via executeTool (real dispatch).
import fs from "node:fs";
for (const l of fs.readFileSync(".env.local", "utf8").split("\n")) {
  const m = l.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
}
const { executeTool, getTOOLS } = await import("./src/lib/tools");
const u = "audit_superpowers_probe";
const p = (name: string, args: Record<string, unknown> = {}) => executeTool({ id: "a1", name, arguments: JSON.stringify(args) }, u);
console.log("tools total:", getTOOLS().length);
console.log("1 brain no-target:", (await p("target_brain", {})).slice(0, 60));
console.log("2 brain bad-host:", (await p("target_brain", { target: "bukan host!!" })).slice(0, 60));
console.log("3 retest_add bad-url:", (await p("retest_add", { title: "x", url: "notaurl" })).slice(0, 60));
console.log("4 retest_run no match:", (await p("retest_run", { id: "R-none" })).slice(0, 60));
console.log("5 matrix bad granted:", (await p("auth_matrix", { endpoints: ["http://127.0.0.1:9/x"], sessions: ["a"], granted_status_max: 9999 })).slice(0, 80));
console.log("6 matrix nosess:", (await p("auth_matrix", { endpoints: ["http://127.0.0.1:9/x"], sessions: ["ghost"] })).slice(0, 120));
console.log("7 dom_taint nothing:", (await p("dom_taint", {})).slice(0, 80));
console.log("8 learning_query zzz:", (await p("learning_query", { query: "zzz" })).slice(0, 80));
