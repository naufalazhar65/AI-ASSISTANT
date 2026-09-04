import { ConversationManager } from "./src/ai/ConversationManager";
import { MockProvider } from "@ai-provider/mock";
import { executeTool } from "./src/lib/tools";
import { resolveInSandbox } from "./src/lib/users";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  // --- normal turn ---
  const provider = new MockProvider();
  const manager = new ConversationManager([provider]);

  const states: string[] = [];
  let text = "";
  manager.on((e) => {
    if (e.type === "state") states.push(e.state);
    if (e.type === "transcript" && e.entry.role === "assistant") text = e.entry.text;
  });

  await manager.start();
  manager.sendText("Apa itu Playwright?");

  await delay(600);

  if (states[0] !== "LISTENING") throw new Error(`expected LISTENING, got ${states[0]}`);
  if (!states.includes("PROCESSING")) throw new Error("missing PROCESSING");
  if (!states.includes("SPEAKING")) throw new Error("missing SPEAKING");
  if (!text.includes("asisten")) throw new Error(`unexpected text: ${text}`);
  if (text.length < 20) throw new Error(`text too short: ${text}`);
  // Simulate the UI: audio drained, so the turn ends via finishTurn.
  manager.finishTurn();
  // AI finished talking -> state must have returned to LISTENING (TURN_END).
  if (states[states.length - 1] !== "LISTENING")
    throw new Error(`expected final LISTENING via TURN_END, got ${states[states.length - 1]}`);

  console.log("conversation-mock: OK");
  console.log("  states:", states.join(" -> "));
  console.log("  assistant text:", text.slice(0, 40) + "...");

  // --- interrupt during SPEAKING must abort streaming and return to LISTENING ---
  const provider2 = new MockProvider();
  const manager2 = new ConversationManager([provider2]);
  const states2: string[] = [];
  let assistantGrewAfterInterrupt = false;
  let assistantLenAtInterrupt = 0;
  manager2.on((e) => {
    if (e.type === "state") states2.push(e.state);
    if (e.type === "transcript" && e.entry.role === "assistant") {
      if (assistantLenAtInterrupt) {
        // Interrupted already; entry text must not keep growing.
        if (e.entry.text.length > assistantLenAtInterrupt) assistantGrewAfterInterrupt = true;
      }
    }
  });

  await manager2.start();
  manager2.sendText("Mulai turn panjang yang akan diinterupsi");

  await delay(250); // mid-stream
  manager2.interrupt();
  assistantLenAtInterrupt = 1; // armed: next assistant transcript event is a mutation check
  await delay(300);

  if (!states2.includes("INTERRUPTED")) throw new Error("missing INTERRUPTED after interrupt");
  if (states2[states2.length - 1] !== "LISTENING")
    throw new Error(`expected final LISTENING, got ${states2[states2.length - 1]}`);
  if (assistantGrewAfterInterrupt)
    throw new Error("old generation kept streaming after interrupt");

  console.log("interrupt: OK");
  console.log("  states:", states2.join(" -> "));

  // --- tool calling (calculator is pure logic; web_search needs network) ---
  const calc = (expr: string) =>
    executeTool({ id: "t", name: "calculate", arguments: JSON.stringify({ expression: expr }) });
  for (const [expr, expected] of [
    ["2000000 * 0.15", "300000"],
    ["(10 + 5) * 2", "30"],
    ["10 / 4", "2.5"],
    ["100 % 7", "2"],
    ["-3 + 2", "-1"],
  ]) {
    const got = await calc(expr);
    if (got !== expected) throw new Error(`calculate("${expr}") = ${got}, expected ${expected}`);
  }
  if (!(await calc("1 / 0")).startsWith("Error:")) throw new Error("1 / 0 not guarded");
  if (!(await calc("2 ** 3")).startsWith("Error:")) throw new Error("unsupported operator not rejected");
  if (!(await executeTool({ id: "t", name: "nope", arguments: "{}" })).startsWith("Error:")) {
    throw new Error("unknown tool not rejected");
  }

  // --- persistent notes store (save/list/delete round-trip on disk) ---
  const tag = "verify note " + Date.now();
  const saved = await executeTool({ id: "t", name: "save_note", arguments: JSON.stringify({ content: tag }) });
  if (!/^Saved note #/.test(saved)) throw new Error(`save_note failed: ${saved}`);
  const listed = await executeTool({ id: "t", name: "list_notes", arguments: "{}" });
  if (!listed.includes(tag)) throw new Error(`save->list mismatch`);
  const num = listed.split("\n").length;
  const del = await executeTool({ id: "t", name: "delete_note", arguments: JSON.stringify({ number: num }) });
  if (!/^Deleted note #/.test(del)) throw new Error(`delete_note failed: ${del}`);
  const delBad = await executeTool({ id: "t", name: "delete_note", arguments: JSON.stringify({ number: 999 }) });
  if (!delBad.startsWith("Error:")) throw new Error("delete_note out-of-range not guarded");
  const after = await executeTool({ id: "t", name: "list_notes", arguments: "{}" });
  if (after.includes(tag)) throw new Error(`note not removed; list=${after}`);

  // --- file access tool (read-only, sandboxed to project root) ---
  const fr = (p: string) => executeTool({ id: "t", name: "file_read", arguments: JSON.stringify({ path: p }) });
  const readTools = await fr("apps/web/src/lib/tools.ts");
  if (!readTools.includes("export") || readTools.startsWith("Error:")) throw new Error("file_read can't read source");
  const dirList = await fr("apps/web");
  if (dirList.startsWith("Error:") || !/src/.test(dirList)) throw new Error("file_read can't list dir");
  for (const [bad, why] of [
    ["../.env.local", "escape + env"],
    ["/etc/passwd", "absolute"],
    [".env", "blocked env"],
    ["node_modules", "blocked segment"],
    ["~/foo", "tilde"],
    ["..", "root escape"],
  ] as const) {
    const r = await fr(bad);
    if (!r.startsWith("Error:")) throw new Error(`file_read not guarded: ${bad} -> ${r}`);
  }

  // --- exec tool (read-only, strict allowlist) ---
  const ex = (c: string) => executeTool({ id: "t", name: "exec", arguments: JSON.stringify({ command: c }) });
  const gitOut = await ex("git status");
  if (gitOut.startsWith("Error:")) throw new Error(`exec git status failed: ${gitOut}`);
  const lsOut = await ex("ls apps");
  if (lsOut.startsWith("Error:")) throw new Error(`exec ls failed: ${lsOut}`);
  const catOut = await ex("cat package.json");
  if (catOut.startsWith("Error:") || !catOut.includes("name")) throw new Error(`exec cat failed: ${catOut}`);
  const pwdOut = await ex("pwd");
  if (pwdOut.startsWith("Error:")) throw new Error(`exec pwd failed: ${pwdOut}`);
  for (const [badCmd, why] of [
    ["rm -rf .", "mutating command not allowlisted"],
    ["node -e 'process.exit(1)'", "node subcommand -e not allowed"],
    ["git push", "mutating git subcommand"],
    ["cat ../.env.local", "escape + env"],
    ["ls | head", "pipeline shell operator"],
    ["cat package-lock.json", "blocked path"],
    ["unknowncmd", "not allowlisted"],
    ["git status extra1 extra2 extra3 extra4 extra5", "too many args"],
  ] as const) {
    const r = await ex(badCmd);
    if (!r.startsWith("Error:")) throw new Error(`exec not guarded: ${badCmd} -> ${r}`);
  }
  console.log("tools (notes + file access): OK");
  console.log("exec: OK");

  // --- write_file / edit_file (sandboxed, requires write, but executeTool bypasses confirmation) ---
  const tmpWriteWs = mkdtempSync(join(tmpdir(), "mia-write-"));
  const prevWriteWs = process.env.ALLOWED_WORKSPACES;
  process.env.ALLOWED_WORKSPACES = tmpWriteWs;
  try {
    const wf = (path: string, content: string) => executeTool({ id: "t", name: "write_file", arguments: JSON.stringify({ path, content }) });
    const ef = (path: string, old_string: string, new_string: string) => executeTool({ id: "t", name: "edit_file", arguments: JSON.stringify({ path, old_string, new_string }) });
    const w1 = await wf(join(tmpWriteWs, "hello.txt"), "hello world");
    if (w1.startsWith("Error:")) throw new Error(`write_file failed: ${w1}`);
    const r1 = await executeTool({ id: "t", name: "file_read", arguments: JSON.stringify({ path: join(tmpWriteWs, "hello.txt") }) });
    if (!r1.includes("hello world")) throw new Error(`file_read after write failed: ${r1}`);
    const e1 = await ef(join(tmpWriteWs, "hello.txt"), "world", "mia");
    if (e1.startsWith("Error:")) throw new Error(`edit_file failed: ${e1}`);
    const r2 = await executeTool({ id: "t", name: "file_read", arguments: JSON.stringify({ path: join(tmpWriteWs, "hello.txt") }) });
    if (!r2.includes("hello mia")) throw new Error(`edit not applied: ${r2}`);
    // Guarded: write to blocked path should fail
    const wBad = await wf(join(tmpWriteWs, ".env"), "secret");
    if (!wBad.startsWith("Error:")) throw new Error(`write_file not guarded for .env: ${wBad}`);
    const eBad = await ef(join(tmpWriteWs, "hello.txt"), "not-exist-xyz", "x");
    if (!eBad.startsWith("Error:")) throw new Error(`edit_file not guarded for missing old_string: ${eBad}`);
  } finally {
    if (prevWriteWs === undefined) delete process.env.ALLOWED_WORKSPACES;
    else process.env.ALLOWED_WORKSPACES = prevWriteWs;
    rmSync(tmpWriteWs, { recursive: true, force: true });
  }
  console.log("write_file/edit_file: OK");

  // --- daily memory (memory/YYYY-MM-DD.md + memory_get) ---
  const memUser = "verify_mem_" + Date.now().toString(36);
  const noMem = await executeTool({ id: "t", name: "memory_get", arguments: JSON.stringify({ date: "2099-01-01" }) });
  if (!noMem.includes("No memory")) throw new Error(`memory_get should miss on empty: ${noMem}`);
  const { appendDailyMemory, todayStr, readDailyMemory } = await import("./src/lib/dailyMemory");
  appendDailyMemory(memUser, "User: test entry for verify");
  const today = todayStr();
  const direct = readDailyMemory(memUser, today);
  if (!direct.includes("test entry")) throw new Error(`dailyMemory not persisted: ${direct.slice(0, 200)}`);
  const todayAlias = readDailyMemory(memUser, "today");
  if (!todayAlias.includes("test entry")) throw new Error(`memory_get today alias failed`);
  const { userDataRoot } = await import("./src/lib/users");
  const { rmSync: rm2 } = await import("node:fs");
  rm2(join(userDataRoot(), memUser), { recursive: true, force: true });
  console.log("daily memory: OK");

  // --- heartbeat (periodic check-in, no throw when nothing pending) ---
  const { runHeartbeatTick, stopHeartbeat } = await import("./src/lib/heartbeat");
  await runHeartbeatTick();
  stopHeartbeat();
  console.log("heartbeat: OK");

  // --- browser automation — just check tools are registered (no heavy launch in verify) ---
  const { getTool } = await import("./src/lib/tools");
  if (!getTool("browser_open") || !getTool("browser_snapshot")) throw new Error("browser tools not registered");
  console.log("browser: OK (tools registered)");

  // --- multi-root sandbox (ALLOWED_WORKSPACES): path stays inside listed roots ---
  const tmpWs = mkdtempSync(join(tmpdir(), "mia-ws-"));
  writeFileSync(join(tmpWs, "note.txt"), "hi from workspace");
  const prevWs = process.env.ALLOWED_WORKSPACES;
  process.env.ALLOWED_WORKSPACES = tmpWs;
  try {
    // Absolute workspace paths resolve inside the allowed root.
    if (resolveInSandbox(join(tmpWs, "note.txt")) !== join(tmpWs, "note.txt")) throw new Error("workspace absolute resolve failed");
    // Absolute paths outside every root are rejected.
    if (resolveInSandbox(join(tmpdir(), "outside-me")) !== null) throw new Error("outside path not blocked");
    // Relative paths still resolve against the repo root (default sandbox).
    if (!resolveInSandbox("package.json")?.includes("ai-assistant")) throw new Error("repo relative resolve failed");
    if (resolveInSandbox("../somewhere") !== null) throw new Error("repo escape not blocked");
    if (resolveInSandbox("~/.ssh/id_rsa") !== null) throw new Error("tilde path not blocked");
  } finally {
    if (prevWs === undefined) delete process.env.ALLOWED_WORKSPACES;
    else process.env.ALLOWED_WORKSPACES = prevWs;
    rmSync(tmpWs, { recursive: true, force: true });
  }
  console.log("sandbox multi-root: OK");
}

main().catch((err) => {
  console.error("conversation-mock: FAIL", err.message);
  process.exit(1);
});