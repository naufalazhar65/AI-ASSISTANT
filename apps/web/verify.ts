import { ConversationManager } from "./src/ai/ConversationManager";
import { MockProvider } from "@ai-provider/mock";
import { executeTool } from "./src/lib/tools";
import { resolveInSandbox, appRoot, userDataRoot } from "./src/lib/users";
import {
  addLibraryEntry,
  captureLinkFromMessage,
  firstUrlInText,
  scheduleLinkCapture,
} from "./src/lib/library";
import { hygienizePersona } from "./src/lib/persona";
import { detectPlaceIntent, placeNudge } from "./src/lib/placeIntent";
import { appendDailyMemory } from "./src/lib/dailyMemory";
import { buildEveningRecap, readLastRecapDay, saveLastRecapDay } from "./src/lib/recap";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
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
  {
    const news = await executeTool({ id: "t", name: "google_news", arguments: "{}" });
    if (news.startsWith("Error:")) throw new Error(`google_news failed: ${news}`);
    if (!news.includes("•")) throw new Error(`google_news no bullet list: ${news.slice(0, 80)}`);
    const newsQ = await executeTool({ id: "t", name: "google_news", arguments: JSON.stringify({ query: "OpenAI", language: "en-US" }) });
    if (newsQ.startsWith("Error:")) throw new Error(`google_news query failed: ${newsQ}`);
    const newsRecent = await executeTool({ id: "t", name: "google_news", arguments: JSON.stringify({ query: "Indonesia", within: 72 }) });
    if (newsRecent.startsWith("Error:")) throw new Error(`google_news within failed: ${newsRecent}`);
  }
  {
    const res = await executeTool({ id: "t", name: "research", arguments: JSON.stringify({ query: "OpenAI", language: "en-US" }) });
    if (res.startsWith("Error:")) throw new Error(`research failed: ${res}`);
    if (!res.includes("•") && !res.includes("Web:")) throw new Error(`research digest empty: ${res.slice(0, 80)}`);
  }
  {
    const resMulti = await executeTool({ id: "t", name: "google_news", arguments: JSON.stringify({ query: "AI", region: "id-ID,en-US" }) });
    if (resMulti.startsWith("Error:")) throw new Error(`google_news multi-edition failed: ${resMulti}`);
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
    ["cat /etc/passwd", "absolute path outside sandbox"],
    ["ls /Users", "absolute dir outside sandbox"],
    ["cat ../../etc/passwd", "relative escape outside sandbox"],
    ["cat ~/.ssh/id_rsa", "tilde path"],
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
    // Byte-accurate limit: multibyte content must be capped by UTF-8 BYTES, not
    // JS string length (a 40k-char emoji string is 160k bytes).
    const emojiBig = "🌸".repeat(40000);
    const wTooBig = await wf(join(tmpWriteWs, "emoji.txt"), emojiBig);
    if (!wTooBig.startsWith("Error:")) throw new Error(`write_file byte limit not enforced: ${wTooBig.slice(0, 60)}`);
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

  // --- advanced memory: hybrid search (BM25 fallback when embeddings down) + recall ---
  const { cosine } = await import("./src/lib/embed");
  if (cosine([1, 0, 0], [0, 1, 0]) !== 0) throw new Error("cosine orthogonal should be 0");
  if (Math.abs(cosine([1, 0], [2, 0]) - 1) > 1e-6) throw new Error("cosine parallel should be 1");
  const { searchMemory, recallContext, clearEmbedCache } = await import("./src/lib/rag");
  const semUser = "verify_sem_" + Date.now().toString(36);
  const saved1 = await executeTool(
    { id: "t", name: "save_note", arguments: JSON.stringify({ content: "kode rahasia: mie favorit Naufal adalah indomie kari ayam" }) },
    semUser
  );
  if (!/^Saved note #/.test(saved1)) throw new Error(`save_note failed: ${saved1}`);
  const saved2 = await executeTool(
    { id: "t", name: "save_note", arguments: JSON.stringify({ content: "jadwal olahraga: badminton tiap sabtu sore di Gor" }) },
    semUser
  );
  if (!/^Saved note #/.test(saved2)) throw new Error(`save_note 2 failed: ${saved2}`);
  const prevEmbed = process.env.EMBED_API_BASE;
  process.env.EMBED_API_BASE = "http://127.0.0.1:1";
  try {
    const res = await searchMemory("mie favorit", semUser);
    if (!res.includes("mie favorit")) throw new Error(`search should degrade to BM25 when embeddings down: ${res.slice(0, 200)}`);
    const rc = await recallContext(semUser, "mie favorit");
    if (!rc.includes("mie favorit")) throw new Error(`recall should degrade to BM25 when embeddings unavailable: ${rc.slice(0, 120)}`);
  } finally {
    if (prevEmbed === undefined) delete process.env.EMBED_API_BASE;
    else process.env.EMBED_API_BASE = prevEmbed;
    clearEmbedCache(semUser);
    rm2(join(userDataRoot(), semUser), { recursive: true, force: true });
  }
  console.log("advanced memory (semantic degrade): OK");

  // --- heartbeat (periodic check-in, no throw when nothing pending) ---
  const { runHeartbeatTick, stopHeartbeat } = await import("./src/lib/heartbeat");
  await runHeartbeatTick();
  stopHeartbeat();
  console.log("heartbeat: OK");

  // --- knowledge consolidation (monthly summary, marker-gated, idempotent) ---
  const conUser = "verify_con_" + Date.now().toString(36);
  const { consolidateUser, listSummariesForUser } = await import("./src/lib/consolidate");
  const memRoot = join(userDataRoot(), conUser, "memory");
  mkdirSync(memRoot, { recursive: true });
  writeFileSync(join(memRoot, "2026-07-01.md"), "# Memory 2026-07-01\n\n## t\nUser: Naufal suka kopi americano\n");
  writeFileSync(join(memRoot, "2026-07-02.md"), "## t\nUser: rencana main badminton Sabtu\n");
  const made = await consolidateUser(conUser, async (month, days) => `SUMMARY(${month},${days.length}): kopi + badminton`);
  if (made.length !== 1 || made[0].month !== "2026-07") throw new Error(`consolidate should summarize 2026-07: ${JSON.stringify(made)}`);
  if (!existsSync(join(memRoot, "2026-07-summary.md"))) throw new Error("summary file missing");
  if (!readFileSync(join(memRoot, "2026-07-summary.md"), "utf8").includes("kopi + badminton")) throw new Error("summary content wrong");
  const again = await consolidateUser(conUser, async () => {
    throw new Error("should NOT re-summarize");
  });
  if (again.length !== 0) throw new Error("consolidate should be idempotent");
  if (!listSummariesForUser(conUser).includes("2026-07-summary.md")) throw new Error("listSummaries should find summary");
  rm2(join(userDataRoot(), conUser), { recursive: true, force: true });
  console.log("consolidate: OK");

  // --- context awareness: parser + tool does not throw ---
  const { parseActiveOutput } = await import("./src/lib/context");
  const parsed = parseActiveOutput("Code\nai-assistant - main.ts");
  if (parsed.app !== "Code" || parsed.window !== "ai-assistant - main.ts") throw new Error(`parseActiveOutput failed: ${JSON.stringify(parsed)}`);
  const ctxText = await executeTool({ id: "t", name: "context_active", arguments: "{}" });
  if (!ctxText || /^Error:/.test(ctxText)) throw new Error(`context_active should not error: ${ctxText.slice(0, 80)}`);
  console.log("context: OK");

  // --- proactive nudge: silent tanpa sinyal, muncul saat mood negatif kemarin ---
  const proUser = "verify_pro_" + Date.now().toString(36);
  const { buildProactiveMessage } = await import("./src/lib/proactive");
  const jktDay = (d: Date) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
  const writeMood = (mood: string, note: string, atMs: number) => {
    mkdirSync(join(userDataRoot(), proUser), { recursive: true });
    writeFileSync(join(userDataRoot(), proUser, "moods.json"), JSON.stringify([{ id: "t", mood, note, at: atMs }]));
  };
  // Seed "yesterday" in JAKARTA terms (noon WIB of the Jkt-yesterday date) —
  // a UTC-based seed lands on the day BEFORE yesterday when the test runs
  // after Jakarta midnight (00:00–07:00 WIB) and the test fails spuriously.
  const yJkt = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const yAtMs = Date.parse(`${yJkt}T12:00:00+07:00`);
  if (buildProactiveMessage(proUser) !== "") throw new Error("proactive should be silent with no signal");
  const prevStart = process.env.PROACTIVE_HOUR_START;
  const prevEnd = process.env.PROACTIVE_HOUR_END;
  process.env.PROACTIVE_HOUR_START = "0";
  process.env.PROACTIVE_HOUR_END = "24";
  try {
    const hut = new Date();
    if (jktDay(hut) === yJkt) throw new Error("test setup: today !== yesterday");
    writeMood("stressed", "kerjaan numpuk", yAtMs);
    const msg = buildProactiveMessage(proUser, hut);
    if (msg === "") throw new Error("proactive should fire after a negative mood yesterday");
    if (!msg.includes("berat")) throw new Error("proactive message should mention heavy day");
    writeMood("great", "happy", yAtMs);
    if (buildProactiveMessage(proUser, hut) !== "") throw new Error("proactive should stay silent after a positive-only day");
  } finally {
    if (prevStart === undefined) delete process.env.PROACTIVE_HOUR_START;
    else process.env.PROACTIVE_HOUR_START = prevStart;
    if (prevEnd === undefined) delete process.env.PROACTIVE_HOUR_END;
    else process.env.PROACTIVE_HOUR_END = prevEnd;
    rm2(join(userDataRoot(), proUser), { recursive: true, force: true });
  }
  console.log("proactive: OK");

  // --- briefing: silent tanpa agenda, lengkap saat ada task/reminder/hal kemarin ---
  const briUser = "verify_bri_" + Date.now().toString(36);
  const { buildMorningBriefing } = await import("./src/lib/briefing");
  if (buildMorningBriefing(briUser) !== "") throw new Error("briefing should be silent with no agenda");
  const { addTask } = await import("./src/lib/tasks");
  const { addReminder } = await import("./src/lib/reminders");
  const todayB = jktDay(new Date());
  const todayStartB = Date.parse(`${todayB}T00:00:00+07:00`);
  mkdirSync(join(userDataRoot(), briUser, "memory"), { recursive: true });
  writeFileSync(join(join(userDataRoot(), briUser, "memory"), `${yJkt}.md`), "# Memory\n\n## t\nUser: persiapan deploy fitur intelligence\n");
  mkdirSync(join(userDataRoot(), briUser), { recursive: true });
  writeFileSync(join(userDataRoot(), briUser, "moods.json"), JSON.stringify([{ id: "t", mood: "stressed", note: "lelah", at: yAtMs }]));
  try {
    addTask("finish deploy fitur intelligence", briUser, todayStartB + 5 * 3600 * 1000);
    addReminder("minum air putih", todayStartB + 2 * 3600 * 1000, briUser, undefined);
    const brief = buildMorningBriefing(briUser);
    if (!brief) throw new Error("briefing should fire when there is an agenda");
    if (!brief.includes("finish deploy fitur intelligence")) throw new Error("briefing should list the due task");
    if (!brief.includes("minum air putih")) throw new Error("briefing should list the reminder");
    if (!brief.includes("berat")) throw new Error("briefing should carry yesterday's heavy-mood note");
  } finally {
    rm2(join(userDataRoot(), briUser), { recursive: true, force: true });
  }
  console.log("briefing: OK");

  // --- rolling summary: chat pendek tak tersentuh, panjang di-roll (tail utuh, cache) ---
  const { buildSummarizedMessages, deterministicDigest } = await import("./src/lib/summarize");
  const shortChat = Array.from({ length: 5 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `pesan pendek ${i}` }));
  if ((await buildSummarizedMessages({ messages: shortChat, force: true })) !== shortChat)
    throw new Error("rolling summary should leave a short chat untouched");
  const longChat: { role: string; content: string }[] = Array.from({ length: 20 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `baris ${i} `.repeat(180), // ~1400 chars each → total > default trigger 24000
  }));
  let summarizeCalls = 0;
  const rollUser = "verify_roll_" + Date.now().toString(36);
  const rolled = await buildSummarizedMessages({
    messages: longChat,
    user: rollUser,
    provider: "9router",
    force: true,
    summarize: async (texts) => {
      summarizeCalls++;
      return `RINGKASAN_${texts.length}`;
    },
  });
  if (rolled.length !== 9) throw new Error(`rolling summary should keep recent+1 messages, got ${rolled.length}`);
  if (!String(rolled[0].content).includes("RINGKASAN_12")) throw new Error("rolling summary should carry the summarized prefix");
  if (rolled[rolled.length - 1] !== longChat[longChat.length - 1]) throw new Error("rolling summary must keep the tail verbatim");
  await buildSummarizedMessages({ messages: longChat, user: "verify_roll_x", force: true, summarize: async () => { summarizeCalls++; return "X"; } });
  await buildSummarizedMessages({ messages: longChat, user: "verify_roll_x2", force: true, summarize: async () => { summarizeCalls++; return "X"; } });
  if (summarizeCalls !== 1) throw new Error(`rolling summary should reuse cache (calls=${summarizeCalls})`);
  const fallback = await buildSummarizedMessages({
    messages: longChat.map((m, i) => ({ ...m, content: i % 2 ? m.content : `beda ${i} `.repeat(200) })),
    user: "verify_roll_fallback",
    force: true,
    summarize: async () => {
      throw new Error("boom");
    },
  });
  if (!String(fallback[0].content).includes("-")) throw new Error("rolling summary fallback digest should be bulleted");
  if (!deterministicDigest(["halo", "ini tes"]).includes("-")) throw new Error("deterministicDigest output shape");
  for (const ru of [rollUser, "verify_roll_x", "verify_roll_x2", "verify_roll_fallback"]) {
    rm2(join(userDataRoot(), ru), { recursive: true, force: true });
  }
  console.log("rolling summary: OK");

  // --- link intelligence (library store + deterministic capture) ---
  const libUser = "verify_lib";
  rm2(join(userDataRoot(), libUser), { recursive: true, force: true });
  const savedLib = await addLibraryEntry(libUser, {
    url: "https://example.com/artikel-1",
    title: "Artikel Tes Vedro",
    summary: "Ringkasan tes offline.",
  });
  if (!savedLib) throw new Error("addLibraryEntry should persist");
  const dupLib = await addLibraryEntry(libUser, {
    url: "https://example.com/artikel-1",
    title: "duplikat",
    summary: "x",
  });
  if (dupLib) throw new Error("addLibraryEntry must dedupe by URL");
  const libListed = await executeTool({ id: "t", name: "library_list", arguments: "{}" }, libUser);
  if (!String(libListed).includes("Artikel Tes Vedro")) throw new Error(`library_list should show saved entry: ${libListed}`);
  if (!String(libListed).includes("Ringkasan tes offline")) throw new Error(`library_list should show its summary: ${libListed}`);
  const libRemoved = await executeTool({ id: "t", name: "library_remove", arguments: JSON.stringify({ ref: "1" }) }, libUser);
  if (!String(libRemoved).toLowerCase().includes("dihapus")) throw new Error(`library_remove should delete by ref: ${libRemoved}`);
  const libAfter = await executeTool({ id: "t", name: "library_list", arguments: "{}" }, libUser);
  if (String(libAfter).includes("Artikel Tes Vedro")) throw new Error("library_remove should clear the entry");
  const capUser = "verify_lib_cap";
  rm2(join(userDataRoot(), capUser), { recursive: true, force: true });
  const captured = await captureLinkFromMessage({
    messages: [
      { role: "user", content: "halo" },
      { role: "assistant", content: "hai" },
      {
        role: "user",
        content: "baca ini dong https://news.example.com/kopi-arabika.html lalu simpan!",
      },
    ],
    user: capUser,
    provider: "9router",
    fetchHtml: async () =>
      "<html><head><title>7 Rahasia Kopi Arabika</title><meta property=\"og:description\" content=\"Panduan singkat meracik kopi arabika premium.\"></head><body><article><p>Isi artikel panjang tentang biji kopi arabika yang ditanam di dataran tinggi.</p></article></body></html>",
    summarize: async () => "Ringkasan offline: arabika tumbuh di dataran tinggi dan diseduh dengan suhu 90 derajat.",
  });
  if (!captured) throw new Error("captureLinkFromMessage should save a link entry");
  if (captured.url !== "https://news.example.com/kopi-arabika.html") throw new Error(`captured url mismatch: ${captured.url}`);
  if (captured.title !== "7 Rahasia Kopi Arabika") throw new Error(`captured title mismatch: ${captured.title}`);
  if (!captured.summary.includes("arabika")) throw new Error(`captured summary mismatch: ${captured.summary}`);
  const capListed = await executeTool({ id: "t", name: "library_list", arguments: "{}" }, capUser);
  if (!String(capListed).includes("7 Rahasia Kopi Arabika")) throw new Error(`capture should be listable: ${capListed}`);
  const noUrl = await captureLinkFromMessage({
    messages: [{ role: "user", content: "hitung 2+2" }],
    user: capUser,
    fetchHtml: async () => "",
    summarize: async () => "",
  });
  if (noUrl) throw new Error("captureLinkFromMessage must skip messages without a URL");
  const duplicate = await captureLinkFromMessage({
    messages: [{ role: "user", content: "baca https://news.example.com/kopi-arabika.html" }],
    user: capUser,
    fetchHtml: async () => "<title>duplikat</title>",
    summarize: async () => "x",
  });
  if (duplicate) throw new Error("captureLinkFromMessage must skip already-saved URLs");
  const suffixated = scheduleLinkCapture(
    [{ role: "user", content: "coba baca https://example.org/x" }],
    capUser,
    "9router",
    undefined,
    "Oke, aku sudah baca.",
  );
  if (!suffixated.includes("daftar bacaan")) throw new Error(`scheduleLinkCapture should append a suffix: ${suffixated}`);
  const noSuffix = scheduleLinkCapture(
    [{ role: "user", content: "coba baca https://example.org/x" }],
    capUser,
    "9router",
    undefined,
    "Oke, sudah kusimpan ke daftar bacaan.",
  );
  if (noSuffix.includes("(Udah kusimpan")) throw new Error("scheduleLinkCapture must not double-announce when the model already mentioned saving");
  if (!firstUrlInText("lihat https://a.com/x.html, oke?")?.startsWith("https://a.com/x.html")) throw new Error("firstUrlInText should strip trailing punctuation");
  rm2(join(userDataRoot(), capUser), { recursive: true, force: true });
  rm2(join(userDataRoot(), libUser), { recursive: true, force: true });
  console.log("link intelligence: OK");

  // --- memory hygiene (persona dedupe + conflict report) ---
  const hygUser = "verify_hyg";
  const hygDir = join(userDataRoot(), hygUser, "persona");
  mkdirSync(hygDir, { recursive: true });
  writeFileSync(
    join(hygDir, "USER.md"),
    [
      "# USER.md",
      "",
      "Notes: stable facts.",
      "",
      "- name: Naufal",
      "- name: beb",
      "- name: Naufal",
      "- nickname: beb",
      "- nickname: beb",
      "- city: Jakarta",
      "",
      "## Facts",
      "",
      "- city: Tangerang Selatan",
      "- name: Naufal",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(hygDir, "SOUL.md"),
    ["# SOUL.md", "", "- tone: kasual", "- tone: warm", "- tone: kasual", "", "## Style", "", "- tone: warm", ""].join("\n"),
    "utf8",
  );
  const firstRun = hygienizePersona(hygUser);
  const user1 = firstRun.find((r) => r.file === "USER.md")!;
  if (user1.removed !== 5) throw new Error(`hygiene USER should drop 5 duplicate rows, got ${user1.removed}`);
  if (!user1.changed) throw new Error("hygiene USER should mark changed");
  const keptName = user1.conflicts.find((c) => c.key === "name");
  if (!keptName || keptName.kept !== "Naufal" || keptName.superseded !== "beb") {
    throw new Error(`hygiene should report name conflict Naufal/beb: ${JSON.stringify(user1.conflicts)}`);
  }
  const keptCity = user1.conflicts.find((c) => c.key === "city");
  if (!keptCity || keptCity.kept !== "Tangerang Selatan") {
    throw new Error(`hygiene should keep the newest city: ${JSON.stringify(user1.conflicts)}`);
  }
  const userFileAfter = readFileSync(join(hygDir, "USER.md"), "utf8");
  if ((userFileAfter.match(/- name:/g) || []).length !== 1) throw new Error("hygiene should leave exactly one name row");
  if (!/city: Tangerang Selatan/.test(userFileAfter)) throw new Error("hygiene should keep newest city value");
  const soul = firstRun.find((r) => r.file === "SOUL.md")!;
  if (soul.removed !== 2) throw new Error(`hygiene SOUL should drop only exact duplicates, got ${soul.removed}`);
  if (soul.conflicts.length !== 0) throw new Error("SOUL different tone values are NOT conflicts");
  const soulFileAfter = readFileSync(join(hygDir, "SOUL.md"), "utf8");
  if ((soulFileAfter.match(/- tone: kasual/g) || []).length !== 1) throw new Error("SOUL exact duplicate should collapse");
  if (!/tone: warm/.test(soulFileAfter)) throw new Error("SOUL legit tone values should survive");
  const secondRun = hygienizePersona(hygUser);
  if (secondRun.some((r) => r.removed !== 0 || r.changed)) throw new Error("hygiene must be idempotent");
  const toolMsg = await executeTool({ id: "t", name: "memory_hygiene", arguments: "{}" }, hygUser);
  if (!String(toolMsg).includes("sudah bersih")) throw new Error(`memory_hygiene after clean should say clean: ${toolMsg}`);
  rm2(join(userDataRoot(), hygUser), { recursive: true, force: true });
  console.log("memory hygiene: OK");

  // --- place verification honesty guard (detect + nudge) ---
  const placePos = [
    "enaknya ngopi dimana ya di tangsel?",
    "rekomendasi cafe di jakarta",
    "kopi praja masih buka?",
    "toko itu udah tutup belum?",
    "mau makan malam enak di bintaro",
  ];
  for (const s of placePos) {
    if (!detectPlaceIntent(s)) throw new Error(`placeIntent should detect: ${s}`);
  }
  const placeNeg = [
    "yang sepi dimana?",
    "hitung 2+2",
    "apa kabar hari ini",
    "cepet banget nih app-nya",
    "baca dong https://example.com/artikel",
  ];
  for (const s of placeNeg) {
    if (detectPlaceIntent(s)) throw new Error(`placeIntent must NOT detect: ${s}`);
  }
  if (placeNudge("Kopi Praja, Bintaro: vibes industrial.", false) === "")
    throw new Error("placeNudge should add a caveat when not verified");
  if (placeNudge("Kopi Praja, Bintaro: vibes industrial.", true) !== "")
    throw new Error("placeNudge should NOT add a caveat after web_search");
  if (placeNudge("Coba cek dulu ya di Google ya beb.", false) !== "")
    throw new Error("placeNudge should skip when model already hedged");
  if (placeNudge("", false) !== "") throw new Error("placeNudge should skip empty answers");
  console.log("place honesty guard: OK");

  // --- browser automation — just check tools are registered (no heavy launch in verify) ---
  const { getTool } = await import("./src/lib/tools");
  if (!getTool("browser_open") || !getTool("browser_snapshot")) throw new Error("browser tools not registered");
  console.log("browser: OK (tools registered)");

  // --- device nodes — check tools registered and pairing (no real device needed) ---
  if (!getTool("device_list") || !getTool("device_exec") || !getTool("device_screenshot")) throw new Error("device tools not registered");
  const devList0 = await executeTool({ id: "t", name: "device_list", arguments: JSON.stringify({}) });
  if (!devList0.includes("No devices") && !devList0.includes("paired")) throw new Error(`device_list unexpected: ${devList0.slice(0, 100)}`);
  console.log("device: OK (tools registered)");

  // --- Spotify — tools registered; not-connected path returns the auth link ---
  const spTools = ["spotify_link", "spotify_status", "spotify_search", "spotify_play", "spotify_pause", "spotify_next", "spotify_previous", "spotify_volume", "spotify_devices"];
  for (const name of spTools) if (!getTool(name)) throw new Error(`spotify tool not registered: ${name}`);
  const spLink = await executeTool({ id: "t", name: "spotify_link", arguments: "{}" }, "spotifyprobe");
  if (!spLink.includes("Spotify") || (!spLink.includes("dikonfigurasi") && !spLink.includes("Hubungkan"))) throw new Error(`spotify_link unexpected: ${spLink.slice(0, 120)}`);
  const spStatus = await executeTool({ id: "t", name: "spotify_status", arguments: "{}" }, "spotifyprobe");
  if (!spStatus.includes("Spotify" )) throw new Error(`spotify_status unexpected: ${spStatus.slice(0, 120)}`);
  // Intent detectors (deterministic play/price route, feature "no more …"):
  const { detectSpotifyIntent } = await import("./src/lib/spotifyIntent");
  const { detectPriceIntent } = await import("./src/lib/priceIntent");
  const { cryptoSubject } = await import("./src/lib/monitorIntent");
  const spYes = detectSpotifyIntent("Mia play lagu mr big nothing but love dong di spotify");
  if (!spYes || !/mr big nothing but love/i.test(spYes.query) || spYes.kind !== "track") throw new Error(`spotifyIntent mismatch: ${JSON.stringify(spYes)}`);
  const spPlay = detectSpotifyIntent("coba play playlist M.Y di spotify");
  if (!spPlay || spPlay.kind !== "playlist") throw new Error(`spotifyIntent playlist mismatch: ${JSON.stringify(spPlay)}`);
  if (detectSpotifyIntent("apa kabar banyak bug?") !== null) throw new Error("spotifyIntent false positive");
  // Deictic "lagu itu" (referencing conversation context) must NOT become a search query —
  // the model's own context-aware spotify_play query wins in that case (2026-09-06 bug fix).
  if (detectSpotifyIntent("hahaha, coba play lagu itu") !== null) throw new Error("spotifyIntent deictic should be null");
  const priceYes = detectPriceIntent("harga bitcoin sekarang berapa?");
  if (!priceYes || cryptoSubject(priceYes.subject) !== "bitcoin") throw new Error(`priceIntent mismatch: ${JSON.stringify(priceYes)}`);
  if (detectPriceIntent("halo apa kabar") !== null) throw new Error("priceIntent false positive");
  console.log("spotify: OK (tools registered, not-connected path, intent detectors)");

  // --- fun tools: mala determinism, game matching, holiday info ---
  const funTools = ["mala", "game_start", "game_guess", "game_quit", "hari_libur", "recap"];
  for (const name of funTools) if (!getTool(name)) throw new Error(`fun tool not registered: ${name}`);
  const { buildMala, renderMala } = await import("./src/lib/mala");
  const malaA = buildMala("probe");
  const malaB = buildMala("probe");
  if (malaA.date !== malaB.date || malaA.number !== malaB.number || malaA.mood !== malaB.mood) throw new Error("mala not stable within a day");
  const malaC = buildMala("probe2");
  if (malaC.number === malaA.number && malaC.mood === malaA.mood) throw new Error("mala identical across users");
  if (!renderMala("probe").includes("Ramalan")) throw new Error("renderMala unexpected");
  const { answerMatches } = await import("./src/lib/game");
  const secret = { id: "x", name: "Nothing But Love", artists: ["Mr. Big"] };
  if (!answerMatches("nothing but love", secret)) throw new Error("answerMatches title miss");
  if (!answerMatches("big", secret)) throw new Error("answerMatches artist miss");
  if (answerMatches("all alone", secret)) throw new Error("answerMatches false positive");
  const gStart = await executeTool({ id: "t", name: "game_start", arguments: "{}" }, "spotifyprobe");
  if (!/Spotify belum tersambung|Tebak Lagu/.test(gStart)) throw new Error(`game_start unexpected: ${gStart.slice(0, 120)}`);
  const hInfo = await executeTool({ id: "t", name: "hari_libur", arguments: "{}" });
  if (!hInfo.includes("Tanggal merah") || !hInfo.includes("2026")) throw new Error(`hari_libur unexpected: ${hInfo.slice(0, 120)}`);
  const recap = await executeTool({ id: "t", name: "recap", arguments: "{}" }, "spotifyprobe");
  console.log("fun: OK (mala stable/deterministic, game match logic, hari_libur/recap via tools)");

  // --- recap output hygiene: never leak timestamps/automation/persona junk ---
  const recapUser = "recapprobe";
  appendDailyMemory(recapUser, "[persona] USER.favorite_drink=kopi americano");
  appendDailyMemory(recapUser, "User: selamat malam mia ku\nMia: Malam Mas Naufal! 🌸 seneng banget kamu nyapa malam gini.");
  appendDailyMemory(recapUser, "User: Ini laporan terjadwal (automation). Tugasmu: jawab langsung dari pengetahuanmu, atau pakai web_search.\nMia: Terima kasih, beb. Semangat juga buat hari ini.");
  const cleanRecap = buildEveningRecap(recapUser);
  if (/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(cleanRecap)) throw new Error("recap leaked a raw timestamp");
  if (/\[persona\]/i.test(cleanRecap)) throw new Error("recap leaked a persona log line");
  if (/terjadwal \(automation\)|laporan terjadwal/i.test(cleanRecap)) throw new Error("recap leaked automation/system text");
  if (!/Malam Mas Naufal|selamat malam/.test(cleanRecap)) throw new Error(`recap lost the real conversation: ${cleanRecap.slice(0, 120)}`);
  if (!/Refleksi/.test(cleanRecap)) throw new Error("recap missing its title");
  console.log("recap hygiene: OK");

  // --- recap day dedup survives restart (persisted state) ---
  const prevRecapDay = readLastRecapDay();
  const probeDay = "2099-12-31";
  saveLastRecapDay(probeDay);
  if (readLastRecapDay() !== probeDay) throw new Error("recap day did not persist");
  saveLastRecapDay(prevRecapDay); // restore
  if (readLastRecapDay() !== prevRecapDay) throw new Error("recap day restore failed");
  console.log("recap dedup persist: OK");

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

  // --- Fase 5: config precedence (env > .data/config.json > default) ---
  const { resetConfigCache, rateLimitPerMin, cfgStr, toolsDeny } = await import("./src/lib/config");
  const prevRl = process.env.RATE_LIMIT_TURNS_PER_MIN;
  const cfgFile = join(appRoot(), ".data", "config.json");
  resetConfigCache();
  const hadCfg = existsSync(cfgFile);
  const oldCfg = hadCfg ? readFileSync(cfgFile, "utf8") : null;
  try {
    writeFileSync(cfgFile, JSON.stringify({ RATE_LIMIT_TURNS_PER_MIN: 7, MIA_TEST_ONLY: "fromfile", TOOLS_DENY: "exec,write_file" }), "utf8");
    resetConfigCache();
    if (cfgStr("MIA_TEST_ONLY", "def") !== "fromfile") throw new Error("config file override failed");
    if (rateLimitPerMin() !== 7) throw new Error("config file int override failed");
    process.env.RATE_LIMIT_TURNS_PER_MIN = "99";
    resetConfigCache();
    if (rateLimitPerMin() !== 99) throw new Error("env precedence over file failed");
    const denied = toolsDeny();
    if (!denied.includes("exec") || !denied.includes("write_file")) throw new Error("toolsDeny list parse failed");
    // TOOLS_DENY blocks a tool even though it's registered.
    const deniedOut = await executeTool({ id: "t", name: "exec", arguments: "{\"cmd\":\"ls\"}" }, "cfgprobe");
    if (!/dinonaktifkan/.test(deniedOut)) throw new Error(`denied tool not blocked: ${deniedOut}`);
  } finally {
    if (prevRl === undefined) delete process.env.RATE_LIMIT_TURNS_PER_MIN;
    else process.env.RATE_LIMIT_TURNS_PER_MIN = prevRl;
    if (hadCfg) writeFileSync(cfgFile, oldCfg!, "utf8");
    else rmSync(cfgFile, { force: true });
    process.env.TOOLS_DENY = "";
    resetConfigCache();
  }
  console.log("fase5 config: OK (env > file > default, TOOLS_DENY blocks tools)");

  // --- Fase 5: auth guard (pure, edge-safe) + app logger ---
  const { authEnabled, isAuthorized, isPublicPath, authToken } = await import("./src/lib/authGuard");
  const prevAuth = process.env.AUTH_TOKEN;
  try {
    process.env.AUTH_TOKEN = "s3cret";
    if (!authEnabled()) throw new Error("authEnabled false with token set");
    if (!isAuthorized("s3cret", null)) throw new Error("cookie auth failed");
    if (!isAuthorized(null, "s3cret")) throw new Error("bearer auth failed");
    if (isAuthorized("wrong", null)) throw new Error("wrong cookie accepted");
    if (!isPublicPath("/login") || !isPublicPath("/api/auth/login") || !isPublicPath("/api/webhook") || !isPublicPath("/api/spotify/callback")) {
      throw new Error("public path classification wrong");
    }
    if (isPublicPath("/api/llm") || isPublicPath("/")) throw new Error("private path misclassified");
  } finally {
    if (prevAuth === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = prevAuth;
  }
  const { logInfo } = await import("./src/lib/appLogger");
  logInfo("verify", "probe line");
  const logFile = join(appRoot(), ".data", "logs", `APP-${new Date().toISOString().slice(0, 10)}.log`);
  if (!existsSync(logFile)) throw new Error("app logger file missing");
  if (!readFileSync(logFile, "utf8").includes("probe line")) throw new Error("app logger line missing");
  console.log("fase5 auth+log: OK (AUTH_TOKEN gate, public paths, app logger writes)");

  // --- Fase 2: deterministic comma-before-call-name fix (textStyle.ts) ---
  const { fixAddressComma } = await import("./src/lib/textStyle");
  const cases: [string, string][] = [
    ["Selalu ada buat kamu, beb 🌸 Mau ngobrol apa sekarang?", "Selalu ada buat kamu beb 🌸 Mau ngobrol apa sekarang?"],
    ["Mau dengar apa, beb?", "Mau dengar apa beb?"],
    ["terima kasih, mas", "terima kasih mas"],
    ["kamu,bang", "kamu bang"],
    ["kalau, masak begini", "kalau, masak begini"],
    ["jangan, beb, jangan bebas ya", "jangan beb, jangan bebas ya"],
    ["tolong, bangunkan aku", "tolong, bangunkan aku"],
    ["ngomong-ngomong, saya suka begini, kak", "ngomong-ngomong, saya suka begini kak"],
    ["kmmu, masak nasi", "kmmu, masak nasi"],
  ];
  for (const [input, expected] of cases) {
    const got = fixAddressComma(input);
    if (got !== expected) throw new Error(`fixAddressComma(${JSON.stringify(input)}) -> ${JSON.stringify(got)} expected ${JSON.stringify(expected)}`);
  }
  if (fixAddressComma("") !== "") throw new Error("fixAddressComma empty failed");
  console.log("fase2 textstyle: OK (comma-before-call removed, non-call words untouched)");

  // --- Tool-call prose strip: 9router writes "mood_log(mood='stressed', ...)"
  // as plain text; that line must never reach the user (code fences kept). ---
  const { stripToolCallProse } = await import("./src/lib/agent");
  const leaked = `mood_log(mood='stressed', note='cuaca panas banget')\nIya beb, panas banget ya. 🌸`;
  const cleaned = stripToolCallProse(leaked);
  if (cleaned !== "Iya beb, panas banget ya. 🌸") throw new Error(`stripToolCallProse leak: ${JSON.stringify(cleaned)}`);
  const fenced = "Contoh pemanggilan:\n```js\nweb_search(query='cuaca')\n```\nItu contohnya.";
  if (stripToolCallProse(fenced) !== fenced) throw new Error("stripToolCallProse stripped inside code fence");
  if (stripToolCallProse("Balasan biasa tanpa prosa.") !== "Balasan biasa tanpa prosa.") throw new Error("stripToolCallProse altered normal text");
  console.log("toolcall prose strip: OK (leaked mood_log removed, code fence kept)");

  // --- Mood reply quality: telegraphic model replies to mood statements get a
  // warm deterministic rewrite; warm replies pass through untouched. ---
  const { ensureMoodReplyQuality } = await import("./src/lib/agent");
  const moodMsgs = [{ role: "user" as const, content: "capek banget hari ini duhh" }];
  const rewritten = ensureMoodReplyQuality(moodMsgs, "Beb lelah. Hari berat. Istirahat dulu.");
  if (rewritten === "Beb lelah. Hari berat. Istirahat dulu.") throw new Error("telegraphic mood reply not rewritten");
  if (!/🌸/.test(rewritten)) throw new Error("rewritten mood reply lacks warmth/emoji");
  const warm = "Duh beb, capek banget ya 🌸 Istirahat dulu bentar ya.";
  if (ensureMoodReplyQuality(moodMsgs, warm) !== warm) throw new Error("warm mood reply got rewritten");
  if (ensureMoodReplyQuality([{ role: "user" as const, content: "berapa 2+2?" }], "4.") !== "4.") throw new Error("non-mood turn altered");
  console.log("mood reply quality: OK (telegraphic rewritten, warm passes through)");

  // Greeting turns get the same telegraphic guard ("Sapa terima. Beb panggil.").
  const greet = ensureMoodReplyQuality([{ role: "user" as const, content: "hai mia ku sayang" }], "Sapa terima. Beb panggil. Bantu apa?");
  if (!/🌸/.test(greet) || greet === "Sapa terima. Beb panggil. Bantu apa?") throw new Error(`greeting not rewritten: ${greet}`);
  // Reminder asks that mention a clock are NOT greetings.
  if (ensureMoodReplyQuality([{ role: "user" as const, content: "ingetin aku ya jam 1 siang makan" }], "Siap, nanti kuingetin.") !== "Siap, nanti kuingetin.") throw new Error("reminder ask treated as greeting");
  // Greeting MUST never be answered with a stale reminder list (9router called
  // reminders_list on "halo mia"). The greeting-shortlist guard replaces it warm.
  const greetList = ensureMoodReplyQuality(
    [{ role: "user" as const, content: "halo mia" }],
    "Daftar reminder kamu beb — 2 total 🌸\n• 11/09, 16.00 — \"Makan siang Mas Naufal 🍛\" — siap aku ingetin ⏰ (terjadwal)"
  );
  if (greetList.includes("Daftar reminder") || !/🌸/.test(greetList)) throw new Error(`greeting answered with reminder list: ${greetList}`);
  console.log("greeting reply quality: OK (telegraphic rewritten, reminder asks untouched)");

  // --- Indonesian clock parsing: "jam 1 siang" = 13:00 (NOT 12:00), 12 siang
  // stays noon, pagi/malam unchanged. ---
  const { parseClockTime } = await import("./src/lib/reminderIntent");
  const clockCases: Array<[string, number]> = [
    ["jam 1 siang", 13],
    ["jam 2 siang", 14],
    ["jam 3 siang", 15],
    ["jam 11 siang", 11],
    ["jam 12 siang", 12],
    ["jam 9 pagi", 9],
    ["jam 8 malam", 20],
    ["jam 3 sore", 15],
  ];
  for (const [input, expectHour] of clockCases) {
    const got = parseClockTime(input);
    if (!got || got.hour !== expectHour) throw new Error(`parseClockTime(${input}) -> ${JSON.stringify(got)}, expected hour ${expectHour}`);
  }
  console.log("reminder clock id: OK (1 siang=13, 12 siang=12, sore/malam +12)");

  // Bare clock times ("jam 8 pas", no suffix) resolve to the interpretation
  // nearest in the future: evening ask → tonight, night ask → next morning.
  const { detectReminderIntents } = await import("./src/lib/reminderIntent");
  const evening = detectReminderIntents("yaudah ingetin aku jam 8 pas ya mau cari makan", Date.parse("2026-09-07T19:50:00+07:00"));
  if (!evening?.length || evening[0].atMs !== Date.parse("2026-09-07T20:00:00+07:00")) {
    throw new Error(`bare evening clock: ${evening && new Date(evening[0].atMs).toString()}`);
  }
  const night = detectReminderIntents("bangunin aku jam 8 ya", Date.parse("2026-09-07T22:00:00+07:00"));
  if (!night?.length || night[0].atMs !== Date.parse("2026-09-08T08:00:00+07:00")) {
    throw new Error(`bare night clock: ${night && new Date(night[0].atMs).toString()}`);
  }
  const morning = detectReminderIntents("ingetin aku jam 9", Date.parse("2026-09-07T07:00:00+07:00"));
  if (!morning?.length || morning[0].atMs !== Date.parse("2026-09-07T09:00:00+07:00")) {
    throw new Error(`bare morning clock: ${morning && new Date(morning[0].atMs).toString()}`);
  }
  console.log("reminder bare clock: OK (evening→tonight 20:00, night→besok pagi, morning→hari ini)");

  // --- Recall-verb guard (2026-09-12 bug): "kamu masih ingat mood aku
  // kemarin2 gimana?" must NOT be read as a reminder. Two false triggers were
  // stacked: bare "ingat" (recall, not a command) matched INTENT_RE, and the
  // clock regex treated the "2" in "kemarin2" as 02:00 → Mia replied "...mood
  // membaik" then appended "(Sudah kusetel pukul 02:00 PM, nanti kubangunkan🌸)".
  // Regression: recall questions can't schedule reminders, and embedded digits
  // in slang words can't parse as clocks. ---
  const recall = detectReminderIntents("kamu masih ingat mood aku kemarin2 gimana?", Date.parse("2026-09-10T12:21:00+07:00"));
  if (recall) throw new Error(`recall question should not schedule a reminder: ${JSON.stringify(recall)}`);
  const { detectReminderCancels: recallCancels } = await import("./src/lib/reminderIntent");
  if (recallCancels("kamu masih ingat mood aku kemarin2 gimana?").length) throw new Error(`recall question should not cancel reminders`);
  const embedded = parseClockTime("mood aku kemarin2 gimana");
  if (embedded) throw new Error(`embedded digit in "kemarin2" must not parse as clock: ${JSON.stringify(embedded)}`);
  const realRem = detectReminderIntents("tolong ingetin aku sikat gigi jam 9 pagi", Date.parse("2026-09-10T12:21:00+07:00"));
  if (!realRem?.length) throw new Error(`real imperative reminder should still schedule: ${JSON.stringify(realRem)}`);
  console.log("reminder recall-guard: OK (masih ingat / kemarin2 → null; ingetin jam 9 pagi → bertahan)");

  // --- Inline tool-call prose: a call embedded mid-sentence is stripped while
  // the surrounding words survive. ---
  const inlineLeak = stripToolCallProse("Oke aku catat remind_me(text='x') ya beb");
  if (inlineLeak !== "Oke aku catat ya beb") throw new Error(`inline strip: ${JSON.stringify(inlineLeak)}`);
  console.log("toolcall inline strip: OK");

  // --- Model-authored reminder variants: parse + attach + delivery rotation. ---
  const { parseVariantLines } = await import("./src/lib/reminderVariants");
  const vParsed = parseVariantLines("1. Waktunya minum dulu ya beb 🌸\n- Nih, minum yang banyak biar nggak dehidrasi 😄\n\n\"Udah jam segini, minum dulu dong\"\n\n\nSaatnya rehidrasi ☀️");
  if (vParsed.length !== 4) throw new Error(`parseVariantLines: ${JSON.stringify(vParsed)}`);
  if (vParsed[0] !== "Waktunya minum dulu ya beb 🌸") throw new Error(`parseVariantLines bullet: ${vParsed[0]}`);
  const { addReminder: addReminderV, attachVariants, takeDueReminders: takeDueV } = await import("./src/lib/reminders");
  const vUser = `verify_vars_${Date.now()}`;
  const r = addReminderV("minum", Date.now() - 1000, vUser);
  if (!attachVariants(vUser, "minum", vParsed)) throw new Error("attachVariants failed");
  const due = takeDueV(vUser);
  if (due[0]?.id !== r.id || due[0]?.text !== vParsed[0]) throw new Error(`variant delivery: ${due[0]?.text}`);
  rmSync(join(userDataRoot(), vUser), { recursive: true, force: true });
  console.log("reminder variants: OK (parse strips bullets, attach + delivery uses variant[0])");

  // --- OpenCode Go provider: registered publicly (Settings UI) + resolves from
  // env or the opencode CLI auth.json fallback (server-side only). ---
  const { PUBLIC_PROVIDERS, isProviderId } = await import("./src/lib/providers");
  if (!PUBLIC_PROVIDERS.some((p) => p.id === "opencodego")) throw new Error("opencodego missing from PUBLIC_PROVIDERS");
  if (!isProviderId("opencodego")) throw new Error("isProviderId rejects opencodego");
  const { ensureOpenCodeGoKey } = await import("./src/lib/serverKeys");
  ensureOpenCodeGoKey();
  const goResolved = await (async () => {
    const { resolveProvider } = await import("./src/lib/providers");
    return resolveProvider("opencodego");
  })();
  if (!goResolved || !goResolved.apiKey) throw new Error("opencodego did not resolve (no env key / no auth.json)");
  console.log("opencodego provider: OK (registered + key resolved server-side, model " + goResolved.defaultModel + ")");

  // --- Codebase QA: chunk, index (temp workspace), search with file:line refs,
  // deny rules (.env / node_modules skipped), and real-repo smoke. ---
  const { chunkText, buildIndexFromRoots, searchCodebaseIn, saveIndex } = await import("./src/lib/codebaseIndex");
  const { getTOOLS } = await import("./src/lib/tools");
  if (!getTOOLS().some((t) => t.function.name === "codebase_search")) throw new Error("codebase_search not registered");
  if (!getTOOLS().some((t) => t.function.name === "codebase_refresh")) throw new Error("codebase_refresh not registered");

  const short = chunkText("one\ntwo\nthree");
  if (short.length !== 1 || short[0].start !== 1 || short[0].end !== 3) throw new Error("chunkText short file");

  const tmpCode = mkdtempSync(join(tmpdir(), "mia-code-"));
  writeFileSync(join(tmpCode, "calc.ts"), [
    "export function calculateFoo(n: number): number {",
    "  // the secret sauce of foobar",
    "  return n * 42 + 7;",
    "}",
  ].join("\n"));
  writeFileSync(join(tmpCode, ".env"), "SECRET=1");
  mkdirSync(join(tmpCode, "node_modules"));
  writeFileSync(join(tmpCode, "node_modules", "evil.ts"), "export const evil = 1;");
  const tmpIdx = buildIndexFromRoots([tmpCode]);
  if (!tmpIdx.docs.some((d) => d.id.includes("calc.ts#L1-L4"))) throw new Error("index missing calc.ts chunk");
  if (tmpIdx.docs.some((d) => d.id.includes(".env") || d.id.includes("node_modules"))) throw new Error("deny rules leaked secret/deps into index");
  const hit = searchCodebaseIn(tmpIdx, "calculateFoo foobar");
  if (!hit.includes("calc.ts#L1-L4") || !hit.includes("calculateFoo")) throw new Error(`code search miss: ${hit.slice(0, 120)}`);
  const miss = searchCodebaseIn(tmpIdx, "zzzqqqxyzzy");
  if (!/No matching code/.test(miss)) throw new Error("garbage query should miss");

  // Real-repo smoke: build + persist so the live index starts warm.
  const { repoRoot } = await import("./src/lib/users");
  const realIdx = buildIndexFromRoots([repoRoot()]);
  if (realIdx.fileCount < 50) throw new Error(`real repo indexed too few files: ${realIdx.fileCount}`);
  if (!realIdx.docs.some((d) => d.id.includes("recap.ts"))) throw new Error("real repo index missing recap.ts");
  saveIndex(realIdx);
  rmSync(tmpCode, { recursive: true, force: true });
  console.log(`codebase index: OK (${realIdx.fileCount} files, ${realIdx.docs.length} chunks; temp search + deny rules OK)`);

  // --- Weekly insight: deterministic build from seeded data; junk-free; silent
  // when a user has nothing. ---
  const { buildWeeklyInsight, readLastFiredDate, saveLastFiredDate, lastNDays } = await import("./src/lib/weeklyInsight");
  const wUser = `verify_weekly_${Date.now()}`;
  const { addMood } = await import("./src/lib/mood");
  const { addTask: addTaskW } = await import("./src/lib/tasks");
  const { appendDailyMemory: appendW } = await import("./src/lib/dailyMemory");
  addMood("tired", wUser, "capek kerjaan");
  addMood("stressed", wUser);
  addMood("good", wUser, "senang badminton");
  addTaskW("kerjakan weekly insight", wUser);
  appendW(wUser, "User: lagi semangat ngerjain flowtest-studio nih\nMia: Siap beb 🌸");
  appendW(wUser, "User: [persona] user.name=x");
  appendW(wUser, "User: Ini laporan terjadwal (automation) laporan terjadwal");
  // A second day (yesterday) so the theme spans 2 days — day-based counting.
  const wyday = lastNDays(new Date(), 7)[5];
  mkdirSync(join(userDataRoot(), wUser, "memory"), { recursive: true });
  writeFileSync(join(userDataRoot(), wUser, "memory", `${wyday}.md`), `## ${wyday}T10:00:00.000Z\nUser: flowtest-studio error di halaman login\nMia: Kucek dulu ya 🌸\n`);
  const wMsg = buildWeeklyInsight(wUser);
  if (!wMsg.includes("Insight Mingguanmu")) throw new Error("weekly insight missing title");
  if (!wMsg.includes("capek 1x") || !wMsg.includes("stres 1x") || !wMsg.includes("senang 1x")) throw new Error(`weekly mood line wrong: ${wMsg}`);
  if (!wMsg.includes("flowtest") || !wMsg.includes("(2 hari)")) throw new Error(`weekly theme wrong: ${wMsg}`);
  if (/undefined|NaN|## 20|\[persona\]|automation|laporan terjadwal/.test(wMsg)) throw new Error(`weekly insight junk: ${wMsg}`);
  const wEmpty = buildWeeklyInsight(`verify_weekly_empty_${Date.now()}`);
  if (wEmpty !== "") throw new Error("empty user should be silent");
  const prevWeekly = readLastFiredDate();
  saveLastFiredDate("2099-01-01");
  if (readLastFiredDate() !== "2099-01-01") throw new Error("weekly state persist failed");
  saveLastFiredDate(prevWeekly);
  rmSync(join(userDataRoot(), wUser), { recursive: true, force: true });
  console.log("weekly insight: OK (title+mood counts+theme, junk-free, silent-empty, state persists)");

  // --- Mac health monitors: battery/storage kind, real local metrics, alert +
  // re-arm (this also exercises checkMonitorsAndAlert — the heartbeat wiring). ---
  const { addMonitor, checkMonitorsAndAlert, listMonitors, removeMonitor } = await import("./src/lib/monitor");
  const { detectMonitorIntent } = await import("./src/lib/monitorIntent");
  const bat = detectMonitorIntent("kalo batre udh 20% kasih tau ya");
  if (!bat || bat.kind !== "device" || bat.subject !== "battery" || bat.threshold !== 20) {
    throw new Error(`battery intent: ${JSON.stringify(bat)}`);
  }
  const sto = detectMonitorIntent("storage mac 90% kabarin ya");
  if (!sto || sto.kind !== "device" || sto.subject !== "storage" || sto.threshold !== 90) {
    throw new Error(`storage intent: ${JSON.stringify(sto)}`);
  }
  const stoAuto = detectMonitorIntent("kasih tau kalau storage hampir penuh");
  if (!stoAuto || stoAuto.kind !== "device" || stoAuto.threshold !== 90) {
    throw new Error(`storage auto-threshold: ${JSON.stringify(stoAuto)}`);
  }
  // Compound ask: BOTH monitors with their OWN thresholds (bug: first % paired
  // with battery → "Baterai ≤90%").
  const { detectMonitorIntents } = await import("./src/lib/monitorIntent");
  const compound = detectMonitorIntents("kalo storage mac ku udah mencapai 90% atau hampir penuh tolong kasih tau ya, terus kalau batre udh 20% kasih tau juga");
  const stoI = compound.find((i) => i.subject === "storage");
  const batI = compound.find((i) => i.subject === "battery");
  if (!stoI || stoI.threshold !== 90 || stoI.direction !== "above") throw new Error(`compound storage: ${JSON.stringify(stoI)}`);
  if (!batI || batI.threshold !== 20 || batI.direction !== "below") throw new Error(`compound battery: ${JSON.stringify(batI)}`);
  const mUser = `verify_mon_${Date.now()}`;
  addMonitor({ name: "Baterai Mac", kind: "device", subject: "battery", threshold: 100, direction: "below", rawUser: mUser });
  const alerts1 = await checkMonitorsAndAlert(mUser);
  if (!alerts1.length || !alerts1[0].includes("Baterai Mac")) throw new Error(`battery alert missing: ${alerts1.join("|")}`);
  const alerts2 = await checkMonitorsAndAlert(mUser);
  if (alerts2.length) throw new Error("battery alert should be armed-off after first fire");
  const list = listMonitors(mUser);
  if (!list.includes("Baterai Mac") || !list.includes("[device]")) throw new Error(`listMonitors device: ${list}`);
  // Storage metric readable on this Mac (any percent 0-100).
  const { fetchPrice } = await import("./src/lib/monitor");
  const storagePct = await fetchPrice({ id: "x", name: "Storage Mac", kind: "device", subject: "storage", threshold: 50, direction: "above", at: 0 });
  if (storagePct === null || storagePct < 0 || storagePct > 100) throw new Error(`storage metric: ${storagePct}`);
  for (const m of (await import("./src/lib/monitor")).readMonitors(mUser)) removeMonitor(m.id, mUser);
  rmSync(join(userDataRoot(), mUser), { recursive: true, force: true });
  console.log(`mac monitor: OK (intents, battery alert fires+re-arms, storage ${storagePct}%)`);

  // --- Hysteresis: a value sitting ON the threshold (storage at its current
  // percent @ that same threshold) must alert ONCE, then stay silent while it
  // hovers (the overnight alert/re-arm flood). Re-arm happens only when clearly
  // away (>=5 away). Threshold is pinned to the CURRENT storage percent read a
  // few lines above so the test is deterministic on any host (a fixed 90 would
  // fail on machines already below 90%, 2026-09-11). ---
  const { addMonitor: addMonH, checkMonitorsAndAlert: checkMonH } = await import("./src/lib/monitor");
  const hUser = `verify_mon_${Date.now()}`;
  addMonH({ name: "Storage Mac", kind: "device", subject: "storage", threshold: storagePct as number, direction: "above", rawUser: hUser });
  const a1 = await checkMonH(hUser);
  if (!a1.length) throw new Error("hysteresis: first crossing should alert");
  const a2 = await checkMonH(hUser);
  if (a2.length) throw new Error("hysteresis: still-on-threshold must NOT re-alert");
  const a3 = await checkMonH(hUser);
  if (a3.length) throw new Error("hysteresis: hovering must stay silent");
  for (const m of (await import("./src/lib/monitor")).readMonitors(hUser)) removeMonitor(m.id, hUser);
  rmSync(join(userDataRoot(), hUser), { recursive: true, force: true });
  const { isTestUserKey } = await import("./src/lib/users");
  if (!isTestUserKey("verify_x") || !isTestUserKey("probe-go") || isTestUserKey("naufalazhar652952") || isTestUserKey("shared")) {
    throw new Error("isTestUserKey classification wrong");
  }
  console.log("monitor hysteresis + test-user guard: OK");

  // --- reminders_list: honest reminder state for the model (scheduled only —
  // delivered one-shots drop out of the store immediately, so the list never
  // accumulates "sudah terkirim" clutter). ---
  const rUser = `verify_remlist_${Date.now()}`;
  const { addReminder: addRem, readReminders } = await import("./src/lib/reminders");
  addRem("minum", Date.now() + 3600_000, rUser);
  addRem("bangun", Date.now() - 1000, rUser);
  takeDueV(rUser); // fire the past one → dropped from store
  const remaining = readReminders(rUser);
  if (remaining.some((r) => r.text.includes("bangun") || r.fired)) {
    throw new Error(`fired one-shot should be dropped from store: ${JSON.stringify(remaining)}`);
  }
  const { executeTool: execToolR } = await import("./src/lib/tools");
  const rl = await execToolR({ id: "r1", name: "reminders_list", arguments: "{}" }, rUser);
  if (!rl.includes("terjadwal") || !rl.includes("minum")) throw new Error(`reminders_list scheduled: ${rl}`);
  if (rl.includes("sudah terkirim") || rl.includes("bangun")) throw new Error(`reminders_list should not show delivered: ${rl}`);
  rmSync(join(userDataRoot(), rUser), { recursive: true, force: true });
  console.log("reminders_list: OK (scheduled listed, delivered dropped from store)");

  // --- buildReminderList (agent.ts): the verbatim "Daftar reminder … • …"
  // reader used to REBUILD the reply list from the POST-move/POST-add store so
  // a list the model fetched *before* this turn's action never shows stale
  // hours (2026-09-11 live: "ubah lagi jadi jam 2 siang" replied "• 13.00 …"
  // while the store already moved to 14.00). It must read live store state and
  // be null when nothing is scheduled. ---
  const { buildReminderList } = await import("./src/lib/agent");
  const blUser = `verify_remlistbuild_${Date.now()}`;
  if (buildReminderList(blUser) !== null) throw new Error("empty reminder store should build null list");
  const b1 = new Date(); b1.setHours(16, 0, 0, 0);
  addRem("kopi ☕", b1.getTime(), blUser);
  const blText = buildReminderList(blUser);
  if (!blText || !blText.includes("Daftar reminder") || !blText.includes("16.00") || !blText.includes("• ")) {
    throw new Error(`buildReminderList should reflect the live store: ${JSON.stringify(blText)}`);
  }
  rmSync(join(userDataRoot(), blUser), { recursive: true, force: true });
  console.log("reminders_list build: OK (buildReminderList reflects live store hours)");

  // --- Reminder cancel/repoint intent parsing: "jam 9 pagi aja, yang jam 7
  // hapus aja" must DELETE the 07:00 slot and MERGE into the existing 09:00
  // (keeping the nicer title) — never schedule junk like "jadi yang hapus aja"
  // or stack a duplicate "bangunin tidurnya aja" at the same clock. ---
  const rcUser = `verify_remcancel_${Date.now()}`;
  const { addReminder: addRemC, readReminders: readRemC, deleteRemindersAtTime } = await import("./src/lib/reminders");
  const { detectReminderIntents: detectInts, detectReminderCancels } = await import("./src/lib/reminderIntent");
  const day7 = new Date(); day7.setHours(7, 0, 0, 0);
  const day9 = new Date(); day9.setHours(9, 0, 0, 0);
  addRemC("bangunin aku jam 7 pagi", day7.getTime() - 86400000, rcUser, { repeat: "daily" });
  addRemC("Bangun tidur Mas Naufal! ☀️🌸", day9.getTime() - 86400000, rcUser, { repeat: "daily" });
  const rcMsg = "Mia, reminder bangunin tidurnya jam 9 pagi aja ya, jadi yang jam 7 pagi hapus aja";
  const cancels = detectReminderCancels(rcMsg);
  if (!cancels.length || cancels[0].hour !== 7) throw new Error(`cancel clause not detected: ${JSON.stringify(cancels)}`);
  for (const c of cancels) if (c.hour !== undefined && c.minute !== undefined) deleteRemindersAtTime(rcUser, c.hour, c.minute);
  const rcIntents = detectInts(rcMsg) ?? [];
  if (rcIntents.some((i) => i.cancel || i.text.includes("hapus"))) throw new Error(`cancel clause leaked into adds: ${JSON.stringify(rcIntents)}`);
  for (const i of rcIntents) addRemC(i.text, i.atMs, rcUser, { mergeAtClock: i.repoint, repoint: i.repoint });
  const rcAfter = readRemC(rcUser);
  if (rcAfter.some((r) => r.text.includes("hapus") || r.text.includes("bangunin tidurnya"))) {
    throw new Error(`junk reminders left behind: ${JSON.stringify(rcAfter)}`);
  }
  if (rcAfter.length !== 1 || !rcAfter[0].text.includes("Bangun tidur")) {
    throw new Error(`re-point should merge into existing 09:00 and keep its title: ${JSON.stringify(rcAfter)}`);
  }
  rmSync(join(userDataRoot(), rcUser), { recursive: true, force: true });
  console.log("reminder cancel/repoint: OK (07:00 deleted, 09:00 merged, no junk)");

  // --- Reminder MOVE ("ubah bangunin tidurnya jadi jam 10 pagi aja, jangan jam
  // 9"): the 09:00 daily must RELOCATE to 10:00 (keeping its nicer title and
  // daily repeat) rather than the model's `cancel_reminder` deleting it + junk
  // "mia coba ubah aja deh tidurnya jadi aja" / "jangan" being scheduled. ---
  const rmvUser = `verify_remmove_${Date.now()}`;
  const { moveReminder } = await import("./src/lib/reminders");
  const day7v = new Date(); day7v.setHours(7, 0, 0, 0);
  const day9v = new Date(); day9v.setHours(9, 0, 0, 0);
  const day10 = new Date(); day10.setHours(10, 0, 0, 0);
  addRemC("sunrise hero practice", day7v.getTime() - 86400000, rmvUser, { repeat: "daily" });
  addRemC("Bangun tidur Mas Naufal! ☀️🌸", day9v.getTime() - 86400000, rmvUser, { repeat: "daily" });
  const rmvMsg = "mia coba ubah aja deh bangunin tidurnya jadi jam 10 pagi aja, jangan jam 9";
  const rmvIntents = detectInts(rmvMsg) ?? [];
  const repoint = rmvIntents.find((i) => i.repoint);
  if (!repoint) throw new Error(`re-point intent not detected: ${JSON.stringify(rmvIntents)}`);
  if (repoint.text.includes("jangan")) throw new Error(`cancel clause leaked into move intent: ${JSON.stringify(rmvIntents)}`);
  const moved = moveReminder(rmvUser, repoint.text, repoint.atMs);
  if (!moved || !moved.text.includes("Bangun tidur Mas Naufal")) {
    throw new Error(`move should relocate the wake daily (keep title): ${JSON.stringify(moved ?? null)}`);
  }
  const rmvAfter = readRemC(rmvUser);
  if (rmvAfter.some((r) => r.text.includes("jadi aja") || r.text.includes("jangan") || r.text.includes("mia coba"))) {
    throw new Error(`junk move text scheduled: ${JSON.stringify(rmvAfter)}`);
  }
  const at10 = rmvAfter.find((r) => new Date(r.at).getHours() === 10);
  if (!at10 || !at10.text.includes("Bangun tidur") || at10.repeat !== "daily") {
    throw new Error(`wake daily should now be 10:00 daily: ${JSON.stringify(rmvAfter)}`);
  }
  if (rmvAfter.filter((r) => new Date(r.at).getHours() === 9).length !== 0) {
    throw new Error(`09:00 slot should be empty after move: ${JSON.stringify(rmvAfter)}`);
  }
  const rmvCancels = detectReminderCancels(rmvMsg);
  const cancel9 = rmvCancels.find((c) => c.hour === 9);
  if (!cancel9) throw new Error(`"jangan jam 9" should cancel slot 9: ${JSON.stringify(rmvCancels)}`);
  rmSync(join(userDataRoot(), rmvUser), { recursive: true, force: true });
  console.log("reminder move: OK (bangun tidur 09:00 → 10:00 daily, no junk, jangan jam 9 cancelled)");

  // --- Reminder BARE re-point (2026-09-11 live bug): "ubah aja deh makan
  // satenya jam 1 siang" contains NO imperative intent verb (no bangunin/
  // ingetin/remind), yet MUST be detected as a repoint and the existing
  // reminder relocated 12:00 → 13:00. Before the fix, detectReminderIntents
  // returned null (INTENT_RE gate missed move verbs) and the model's verbal
  // "sudah aku ubah ke jam 13.00" was a lie — the reminder stayed at 12:00. ---
  const rbareUser = `verify_rembare_${Date.now()}`;
  const { moveReminder: moveBare } = await import("./src/lib/reminders");
  const noonB = new Date(); noonB.setHours(12, 0, 0, 0);
  addRemC("Makan sate maranggi mas naufal 🍢🌸", noonB.getTime(), rbareUser);
  const bareMsg = "ubah aja deh makan satenya jam 1 siang";
  const bareIntents = detectInts(bareMsg) ?? [];
  if (!bareIntents.length || !bareIntents.some((i) => i.repoint)) {
    throw new Error(`bare repoint intent not detected: ${JSON.stringify(bareIntents)}`);
  }
  const bare = bareIntents.find((i) => i.repoint)!;
  const bareMoved = moveBare(rbareUser, bare.text, bare.atMs);
  if (!bareMoved || new Date(bareMoved.at).getHours() !== 13) {
    throw new Error(`bare repoint should move sate reminder to 13:00: ${JSON.stringify(bareMoved ?? null)}`);
  }
  rmSync(join(userDataRoot(), rbareUser), { recursive: true, force: true });
  console.log("reminder bare repoint: OK (ubah aja deh makan satenya jam 1 siang → 13:00)");

  // --- Reminder GANTI re-point (2026-09-11 live Telegram bug): the user wrote
  // "ganti lagi deh jadwal makan siangnya jadi jam 4 sore" — "ganti" is the
  // move verb but was ALSO absent from INTENT_RE/MOVE_RE, so detectReminderIntents
  // returned null (the 2026-09-11 "ubah" fix covered only ubah/jadiin/pindah/
  // geser) and the reminder stayed at 14:00 while the model claimed to move it. ---
  const rgantiUser = `verify_remganti_${Date.now()}`;
  const { moveReminder: moveGanti } = await import("./src/lib/reminders");
  const twoPmG = new Date(); twoPmG.setHours(14, 0, 0, 0);
  const fourPmG = new Date(); fourPmG.setHours(16, 0, 0, 0);
  addRemC("Makan siang Mas Naufal 🍛", twoPmG.getTime(), rgantiUser);
  const gantiMsg = "ganti lagi deh jadwal makan siangnya jadi jam 4 sore";
  const gantiIntents = detectInts(gantiMsg) ?? [];
  if (!gantiIntents.length || !gantiIntents.some((i) => i.repoint)) {
    throw new Error(`ganti repoint intent not detected: ${JSON.stringify(gantiIntents)}`);
  }
  const ganti = gantiIntents.find((i) => i.repoint)!;
  const gantiMoved = moveGanti(rgantiUser, ganti.text, ganti.atMs);
  if (!gantiMoved || new Date(gantiMoved.at).getHours() !== 16) {
    throw new Error(`ganti repoint should move meal reminder to 16:00: ${JSON.stringify(gantiMoved ?? null)}`);
  }
  rmSync(join(userDataRoot(), rgantiUser), { recursive: true, force: true });
  console.log("reminder ganti repoint: OK (ganti lagi deh jadwal makan siangnya jadi jam 4 sore → 16:00)");

  // --- Reminder clean text strips the assistant name + vet "mia ingetin aku
  // makan jam 3 sore" → "makan" (2026-09-11 live: the reminder was stored as
  // "mia makan" because "mia" is the addressing word, not a topic noun). ---
  const cleanInts = detectInts("mia ingetin aku makan jam 3 sore ya") ?? [];
  if (!cleanInts.length || cleanInts[0].text !== "makan" || new Date(cleanInts[0].atMs).getHours() !== 15) {
    throw new Error(`"mia ingetin aku makan jam 3 sore ya" should clean to "makan"@15:00: ${JSON.stringify(cleanInts)}`);
  }
  console.log("reminder clean mia: OK (\"mia ingetin aku makan jam 3 sore ya\" → \"makan\"@15:00)");

  // --- Reminder STEM convergience (2026-09-11 live Telegram bug): the meal
  // reminder text is "Waktunya makan Mas Naufal 🍴" but the re-point clause
  // says "makannya". The stemmer must reduce both to the same token ("mak")
  // — it previously stripped ONE suffix only, yielding "makannya"→"makan" vs
  // "makan"→"mak", so the anchor never matched and the re-point stacked a junk
  // duplicate ("deh ingetinnya makannya jadi") instead of relocating 15:00→13:00. ---
  const rstemUser = `verify_remstem_${Date.now()}`;
  const { moveReminder: moveStem } = await import("./src/lib/reminders");
  const fivePmU = new Date(); fivePmU.setHours(15, 0, 0, 0);
  const onePmU = new Date(); onePmU.setHours(13, 0, 0, 0);
  addRemC("Waktunya makan Mas Naufal 🍴", fivePmU.getTime(), rstemUser);
  const stemMsg = "ya ubah aja deh ingetinnya makannya jadi jam 1 siang";
  const stemIntents = detectInts(stemMsg) ?? [];
  if (!stemIntents.some((i) => i.repoint)) {
    throw new Error(`stem repoint intent not detected: ${JSON.stringify(stemIntents)}`);
  }
  const stemMoved = moveStem(rstemUser, "deh ingetinnya makannya jadi", onePmU.getTime());
  if (!stemMoved || new Date(stemMoved.at).getHours() !== 13 || !stemMoved.text.includes("Waktunya makan")) {
    throw new Error(`stem move should relocate meal reminder to 13:00 keeping title: ${JSON.stringify(stemMoved ?? null)}`);
  }
  const stemAfter = readRemC(rstemUser);
  if (stemAfter.filter((r) => new Date(r.at).getHours() === 13).length !== 1) {
    throw new Error(`exactly one 13:00 reminder after stem move: ${JSON.stringify(stemAfter)}`);
  }
  rmSync(join(userDataRoot(), rstemUser), { recursive: true, force: true });
  console.log("reminder stem convergence: OK (makannya ≈ makan → 15:00 moved to 13:00, no junk)");

  // --- Reminder confirmation variety: the real reminderMoveSuffix /
  // reminderAddSuffix helpers (exported from agent.ts) must rotate through all
  // lines across a week — the user complained the old fixed
  // "Sudah kupindahkan ke pukul X ya." read robotic on every "ubah jamnya". ---
  const { reminderMoveSuffix, reminderAddSuffix } = await import("./src/lib/agent");
  const moveLines = new Set<string>();
  const addLines = new Set<string>();
  const DAY = 86400000;
  const realNow = Date.now;
  for (let i = 0; i < 7; i++) {
    Date.now = () => realNow() + i * DAY;
    try {
      moveLines.add(reminderMoveSuffix("10:00"));
      addLines.add(reminderAddSuffix("10:00", "setiap hari "));
    } finally {
      Date.now = realNow;
    }
  }
  if (moveLines.size < 7 || addLines.size < 7) {
    throw new Error(
      `reminder confirmations should rotate (moves ${moveLines.size}/7, adds ${addLines.size}/7 distinct)`
    );
  }
  console.log(`reminder confirmation variety: OK (${moveLines.size}+${addLines.size} distinct lines across 7 days)`);

  // --- Anti-repetition pass (2026-09-12): every other deterministic Mia
  // confirmation (delete reminder / plan / monitor / spotify play-resume /
  // spotify control / link-saved / wind-down) also rotates day by day. All use
  // the shared `dayRotated` picker — a pool of 1 would mean no rotation, so
  // each must yield ≥2 distinct lines across a week and differ from its neighbors. ---
  const {
    appendDeleteSuffix,
    planCreateSuffix,
    monitorAddSuffix,
    spotifyPlaySuffix,
    spotifyResumeSuffix,
    confirmSuffixFor,
  } = await import("./src/lib/agent");
  const linkSavedPool = await import("./src/lib/library");
  const windDown = await import("./src/lib/windDown");
  const dedicatedPools: Record<string, () => string> = {
    delete: () => appendDeleteSuffix("Oke, sudah."),
    plan: () => planCreateSuffix("Bangun jam 6", 4),
    monitor: () => monitorAddSuffix("batre (alert di bawah 20%)"),
    spotifyPlay: () => spotifyPlaySuffix("Love Bites — In This Moment", true),
    spotifyResume: () => spotifyResumeSuffix("dilanjutkan"),
    spotifyPause: () => confirmSuffixFor({ action: "pause" }),
    spotifyNext: () => confirmSuffixFor({ action: "next" }),
    spotifyPrevious: () => confirmSuffixFor({ action: "previous" }),
    spotifyVolume: () => confirmSuffixFor({ action: "volume", value: 50 }),
    linkSaved: () => linkSavedPool.linkSavedSuffix(),
    windDown: () => windDown.windDownMessage(),
  };
  for (const [name, fn] of Object.entries(dedicatedPools)) {
    const seen = new Set<string>();
    for (let i = 0; i < 7; i++) {
      Date.now = () => realNow() + i * DAY;
      try {
        seen.add(fn());
      } finally {
        Date.now = realNow;
      }
    }
    if (seen.size < 2) {
      throw new Error(`anti-repetition pool "${name}" should rotate (got ${seen.size} distinct in 7 days): ${[...seen].join(" | ")}`);
    }
  }
  const linkSavedLines = new Set<string>();
  for (let i = 0; i < 7; i++) {
    Date.now = () => realNow() + i * DAY;
    try {
      const l = linkSavedPool.linkSavedSuffix();
      if (!l.includes("daftar bacaan")) throw new Error(`link-saved line must mention "daftar bacaan": ${l}`);
      linkSavedLines.add(l);
    } finally {
      Date.now = realNow;
    }
  }
  if (linkSavedLines.size < 2) throw new Error(`link-saved should rotate (${linkSavedLines.size} distinct in 7 days)`);
  console.log(
    `anti-repetition variety: OK (${Object.keys(dedicatedPools).length - 1} pools renewed day-by-day, link-saved rotates + keeps "daftar bacaan")`
  );
}

main().catch((err) => {
  console.error("conversation-mock: FAIL", err.message);
  process.exit(1);
});