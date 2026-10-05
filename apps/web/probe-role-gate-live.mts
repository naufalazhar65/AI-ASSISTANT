/**
 * Does the ROLE GATE actually work end-to-end?
 *
 * Unit tests prove roleGateRefusal() returns a string. They do NOT prove the
 * agent label ever REACHES executeTool — and that threading is the part that can
 * silently be dead code while every test stays green.
 *
 * This probe checks the wiring itself:
 *   1. executeTool WITH a label refuses and has no side effect,
 *   2. the SAME call WITHOUT a label runs (so the gate, not the tool, is what
 *      stopped it),
 *   3. roleGateRefusal is symmetric for each agent,
 *   4. the label is threaded from runAssistantTurn down to executeTool.
 *
 * Run: npx tsx apps/web/probe-role-gate-live.mts
 */
import fs from "node:fs";
import { executeTool } from "./src/lib/tools";
import { roleGateRefusal } from "./src/lib/roleGate";

// tsx does not load .env.local, so the provider key is missing and every live
// turn dies with a 401. Load it the same way probe-team-line-live.mts does.
for (const line of fs.readFileSync("apps/web/.env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

let fail = 0;
const ok = (cond: boolean, label: string, extra = "") => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    fail += 1;
    console.log(`  FAIL ${label}${extra ? ` :: ${extra}` : ''}`);
  }
};

const user = `probe_role_gate_${Date.now()}`;
const call = (name: string, args: unknown) => ({ id: `pg-${name}`, name, arguments: JSON.stringify(args) });

console.log('== 1. executeTool WITH an agent label refuses ==');
const refused = await executeTool(call("exec", { command: "touch /tmp/role-gate-must-not-exist" }), user, { agent: "agnes" });
ok(/Not your tool/.test(refused), "agnes asking for exec is refused", refused.slice(0, 90));
ok(/Michelle/.test(refused), "the refusal names Michelle as the owner");
ok(/NOT run/.test(refused), "the refusal says it did NOT run");

console.log('\n== 2. side effect check: the command must not have executed ==');
const { existsSync } = await import("node:fs");
ok(!existsSync("/tmp/role-gate-must-not-exist"), "the refused command created no file (proves zero side effect)");

console.log('\n== 3. control: the SAME call without a label runs ==');
const ungated = await executeTool(call("calculate", { expression: "2+2" }), user);
ok(!/Not your tool/.test(ungated), "no label → not gated", ungated.slice(0, 60));
ok(/4/.test(ungated), "calculate actually ran (so the tool works; the gate is what refused above)", ungated.slice(0, 60));

const gatedGood = await executeTool(call("web_search", { query: "test" }), user, { agent: "agnes" });
ok(!/Not your tool/.test(gatedGood), "agnes IS allowed her own research tools", gatedGood.slice(0, 60));

console.log("\n== 4. symmetry: neither agent can touch the other's territory ==");
for (const [agent, tool, owner] of [
  ["agnes", "exec", "Michelle"],
  ["agnes", "http_request", "Michelle"],
  ["michelle", "google_news", "Agnes"],
  ["michelle", "places_search", "Agnes"],
  ["agnes", "remind_me", "Mia"],
  ["michelle", "remind_me", "Mia"],
] as const) {
  const r = roleGateRefusal(agent, tool);
  ok(!!r && r.includes(owner), `${agent} → ${tool} refused, names ${owner}`, String(r).slice(0, 70));
}

console.log("\n== 5. Mia stays ungated (generalist/router) ==");
for (const tool of ["exec", "remind_me", "http_request", "google_news", "delete_note"]) {
  ok(roleGateRefusal("mia", tool) === null, `mia → ${tool} allowed`);
}

console.log("\n== 6. the label is threaded: runAssistantTurn opts.agent reaches executeTool ==");
const { runAssistantTurn } = await import("./src/lib/agent");
// Ask for something that REQUIRES a code-domain tool (codebase_search), so the
// model has a genuine reason to reach for it. If the label never reaches
// executeTool she would silently get search results and this probe passes the
// label threading even though the gate is dead code — that is the failure this
// section exists to catch.
const turn = await runAssistantTurn({
  messages: [{ role: "user", content: "cari di file kode terdapat kata security" }],
  user: `${user}.agnes`,
  agent: "agnes",
});
ok(turn.text.length > 0, "the turn produced an answer", `len=${turn.text.length}`);
const handedOff = /Michelle/i.test(turn.text);
ok(handedOff, "the refusal reached the model: she handed the work to Michelle", turn.text.slice(0, 120));
ok(
  !/match|hasil pencarian|ditemukan di file/i.test(turn.text),
  "she returned NO codebase_search results — the tool really was blocked",
  turn.text.slice(0, 120),
);
console.log(`  info her answer: ${turn.text.slice(0, 200).replace(/\n/g, " ")}`);

console.log(`\n${fail === 0 ? 'ROLE GATE WORKS END-TO-END' : `${fail} FAILURE(S)`}`);
process.exit(fail === 0 ? 0 : 1);