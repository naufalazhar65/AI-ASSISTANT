import { ConversationManager } from "./src/ai/ConversationManager";
import { MockProvider } from "@ai-provider/mock";
import { executeTool } from "./src/lib/tools";

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
  console.log("tools (notes + file access): OK");
}

main().catch((err) => {
  console.error("conversation-mock: FAIL", err.message);
  process.exit(1);
});