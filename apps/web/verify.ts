import { ConversationManager } from "./src/ai/ConversationManager";
import { MockProvider } from "@ai-provider/mock";
import { executeTool, getTOOLS } from "./src/lib/tools";
import { autoUpdateStatus, runAutoUpdate, runAutoUpdaterTick } from "./src/lib/autoUpdater";
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
import { tmpdir, homedir } from "node:os";
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

  // --- match-based selectors: act on an item WITHOUT listing first ---
  // (list_* lives in VERBATIM_LIST and ends the turn, so an index-only action
  //  tool could never get its identifier — tasks/notes/library/plan now take
  //  a text `match`; an ambiguous match must refuse, never guess.)
  const stamp = Date.now();
  const vu = "verify_selector_user";
  const et = (name: string, args: unknown) =>
    executeTool({ id: "t", name, arguments: JSON.stringify(args) }, vu);
  await et("add_task", { text: `Verify Nonton Cars ${stamp}` });
  await et("add_task", { text: `Verify Belajar TS ${stamp}` });
  const tDone = await et("complete_task", { match: `nonton cars ${stamp}` });
  if (!/marked done/.test(tDone)) throw new Error(`complete_task by match failed: ${tDone}`);
  const tAmb = await et("complete_task", { match: `${stamp}` });
  if (!/^Error:/.test(tAmb) || !/matches 2/.test(tAmb)) throw new Error(`ambiguous task match not guarded: ${tAmb}`);
  const tRes = await et("reschedule_task", { match: `belajar ts ${stamp}`, dueAt: new Date(Date.now() + 86_400_000).toISOString() });
  if (!/rescheduled/.test(tRes)) throw new Error(`reschedule_task by match failed: ${tRes}`);
  await et("save_note", { content: `verify-${stamp}.txt` });
  const nMatch = await et("delete_note", { match: `verify-${stamp}.txt` });
  if (!/^Deleted 1 note/.test(nMatch)) throw new Error(`delete_note by match failed: ${nMatch}`);
  await et("save_note", { content: `verify-${stamp}-all` });
  const nAll = await et("delete_note", { all: true });
  if (!/^Deleted \d+ note/.test(nAll)) throw new Error(`delete_note all failed: ${nAll}`);
  const libTag = `VerifyLib ${stamp}`;
  addLibraryEntry(vu, { url: `https://example.org/${stamp}`, title: libTag, summary: "s" });
  const libRem = await et("library_remove", { ref: libTag });
  if (!/Dihapus/.test(libRem)) throw new Error(`library_remove by title failed: ${libRem}`);
  const pc = await et("plan_create", { title: `Verify Plan ${stamp}`, goal: "tujuan verify" });
  const pid = (pc.match(/Plan created (\S+):/) || [])[1];
  if (!pid) throw new Error(`plan_create failed: ${pc}`);
  await et("plan_add_step", { plan_id: pid, title: `Riset verify ${stamp}` });
  const pu = await et("plan_update_step", { plan_match: `verify plan ${stamp}`, step_match: `riset verify ${stamp}`, status: "completed" });
  if (/^Error:/.test(pu) || !/completed/.test(pu)) throw new Error(`plan_update_step by match failed: ${pu}`);
  console.log("selector match (tasks/notes/library/plan): OK");

  // --- cinema showtimes parsers (offline fixtures; live fetch is network-gated) ---
  const { citySlug, parseNowPlaying, parseCinemaPage, parseFilmCityPage } = await import("./src/lib/cinema");
  if (citySlug("Tangsel") !== "tangerang" || citySlug("Tangerang Selatan") !== "tangerang") {
    throw new Error("cinema citySlug alias wrong");
  }
  const np = parseNowPlaying(
    '<div class="item movie"><h2><a href="https://jadwalnonton.com/film/2026/hope/" title="Hope">Hope</a></h2><span class="moket">Horror, Mystery, Action </span><span class="moket">156 menit</span></div>'
  );
  if (np.length !== 1 || np[0].title !== "Hope" || !/Horror/.test(np[0].genre) || np[0].duration !== "156 menit") {
    throw new Error(`parseNowPlaying: ${JSON.stringify(np)}`);
  }
  const cs = parseCinemaPage(
    '<div class="item"><h2><a href="/x">Hope</a><span class="right rating blue">13+</span></h2><p>Horror, Mystery, Action  - 156 Menit</p><span class="showgroup">Regular 2D</span><span class="htm"><i class="icon-ticket"></i>Tiket Rp 45.000</span><ul data-id="1" class="usch"><li class="active">14:45</li><li class="active">17:40</li></ul></div>'
  );
  if (cs.length !== 1 || cs[0].title !== "Hope" || cs[0].rating !== "13+" || cs[0].shows[0]?.price !== "45.000" || cs[0].shows[0]?.times.join(",") !== "14:45,17:40") {
    throw new Error(`parseCinemaPage: ${JSON.stringify(cs)}`);
  }
  const fc = parseFilmCityPage(
    '<div class="item" data-key="X"><h2><a href="https://jadwalnonton.com/bioskop/di-tangerang/x-xxi.html">X XXI</a></h2><b class="htm">Regular 2D</b><span class="htm">Tiket Rp. 25.000</span><ul><li>12:15</li><li data-tm="15:10">15:10</li></ul></div>'
  );
  if (fc.length !== 1 || fc[0].cinema !== "X XXI" || fc[0].shows[0]?.price !== "25.000" || fc[0].shows[0]?.times.join(",") !== "12:15,15:10") {
    throw new Error(`parseFilmCityPage: ${JSON.stringify(fc)}`);
  }
  console.log("cinema showtimes parsers: OK");

  // --- hotel helpers (offline; live Booking fetch is network/Playwright-gated) ---
  const { parseBudget, resolveStay, parseScore } = await import("./src/lib/hotel");
  if (parseBudget("400rb") !== 400000 || parseBudget("1.5jt") !== 1500000 || parseBudget("600000") !== 600000 || parseBudget("abc") !== null) {
    throw new Error("hotel parseBudget wrong");
  }
  const stay = resolveStay("2026-09-20", "2026-09-22");
  if (stay.nights !== 2 || stay.checkin !== "2026-09-20" || stay.checkout !== "2026-09-22") throw new Error(`hotel resolveStay wrong: ${JSON.stringify(stay)}`);
  if (resolveStay("2026-09-20").nights !== 1) throw new Error("hotel resolveStay default checkout wrong");
  let badDate = false;
  try { resolveStay("besok"); } catch { badDate = true; }
  if (!badDate) throw new Error("hotel resolveStay must reject non-ISO date");
  if (parseScore("Skor 9,3 9,3Luar biasa 39 ulasan") !== "9,3" || parseScore("Skor 10 10Luar biasa") !== "10") {
    throw new Error(`hotel parseScore wrong: ${parseScore("Skor 10 10Luar biasa")}`);
  }
  console.log("hotel helpers (budget/stay/score): OK");

  // --- provider tool cap: Groq rejects >128 tools per request ---
  const { toolsForUrl } = await import("./src/lib/agent");
  const liveTools = ["hotel_search", "cinema_showtimes", "train_search", "bus_search", "transcribe"];
  const groqTools = toolsForUrl("https://api.groq.com/openai/v1/chat/completions");
  if (groqTools.length > 128) throw new Error(`Groq tool cap not applied: ${groqTools.length}`);
  for (const cap of [
    { name: "groq", names: groqTools.map((t) => t.function.name), max: 128 },
    { name: "9router", names: toolsForUrl("http://localhost:20128/v1/chat/completions").map((t) => t.function.name), max: 64 },
  ]) {
    if (cap.names.length > cap.max) throw new Error(`${cap.name} tool cap not applied: ${cap.names.length}`);
    const missing = liveTools.filter((n) => !cap.names.includes(n));
    if (missing.length) throw new Error(`${cap.name} cap dropped live tools: ${missing.join(", ")}`);
  }
  if (toolsForUrl("https://opencode.ai/zen/go/v1/chat/completions").length <= 128) {
    throw new Error("tool cap wrongly applied to non-capped provider");
  }
  console.log("provider tool cap (groq<=128, 9router<=64, live tools kept): OK");

  // --- tool-call id normalization: blank/duplicate ids 400 strict gateways ---
  const { normalizeToolCallIds } = await import("./src/lib/agent");
  const normalized = normalizeToolCallIds([
    { id: "a", name: "api_spec", arguments: "{}" },
    { id: "a", name: "api_spec", arguments: "{}" },
    { id: "", name: "engagement_list", arguments: "{}" },
  ]);
  if (normalized[0].id !== "a") throw new Error("normalize changed a unique id");
  if (!normalized[1].id || normalized[1].id === "a") throw new Error("duplicate id not re-issued");
  if (!normalized[2].id) throw new Error("blank id not filled");
  if (new Set(normalized.map((c) => c.id)).size !== 3) throw new Error("tool-call ids not unique");
  console.log("tool-call id normalization (unique + non-blank): OK");

  // --- tamper_script generator + bola JSON field-diff ---
  const { buildTamperScript } = await import("./src/lib/tamper");
  const ts = buildTamperScript({ urlContains: "UpdateUserProfile", set: { UserId: "999999" }, add: { IsPremium: true } });
  for (const needle of ["UpdateUserProfile", "XMLHttpRequest", "PATCHED", "IsPremium", "999999"]) {
    if (!ts.includes(needle)) throw new Error(`tamper_script missing ${needle}`);
  }
  if (!buildTamperScript({ urlContains: "" }).startsWith("Error:")) throw new Error("tamper_script should reject empty url_contains");
  if (!buildTamperScript({ urlContains: "x" }).startsWith("Error:")) throw new Error("tamper_script should reject empty set/add");
  const { jsonFieldDiff } = await import("./src/lib/security");
  const diff = jsonFieldDiff({ a: 1, b: 2, nested: { id: 5 } }, { a: 1, b: 3, nested: { id: 6 } });
  if (diff.length !== 2 || !diff.some((d) => d.startsWith("b:")) || !diff.some((d) => d.includes("nested.id")))
    throw new Error(`jsonFieldDiff wrong: ${JSON.stringify(diff)}`);
  if (jsonFieldDiff({ a: 1 }, { a: 1 }).length !== 0) throw new Error("jsonFieldDiff false-positive on equal objects");
  console.log("tamper_script generator + bola field-diff: OK");

  // --- hunt log (agility memory) + new orchestrator scope guards ---
  const { huntSet, huntListText, huntGetText, normalizeTarget } = await import("./src/lib/huntLog");
  if (normalizeTarget("HTTPS://Example.com/") !== "example.com") throw new Error("normalizeTarget wrong");
  const huntLogUser = "verify_huntlog_tmp";
  if (!huntSet(huntLogUser, "example.com/admin", "dead", "catch-all rewrite").includes("dead")) throw new Error("huntSet note failed");
  huntSet(huntLogUser, "example.com/admin", "lead", "cookie tanpa HttpOnly");
  if (!huntListText(huntLogUser).includes("example.com/admin")) throw new Error("huntListText missing target");
  if (!huntGetText(huntLogUser, "example.com/admin").includes("lead")) throw new Error("huntGetText not updated");
  if (!huntSet(huntLogUser, "x", "bogus").startsWith("Error:")) throw new Error("huntSet should reject invalid status");
  rmSync(join(appRoot(), ".data", "users", huntLogUser), { recursive: true, force: true });
  const { authHunt, apiHunt } = await import("./src/lib/hunt");
  if (!(await authHunt("verify_scopeguard", "https://evil.example.com")).startsWith("Error: SCOPE")) throw new Error("authHunt scope guard failed");
  if (!(await apiHunt("verify_scopeguard", "https://evil.example.com")).startsWith("Error: SCOPE")) throw new Error("apiHunt scope guard failed");
  console.log("hunt_log store + auth_hunt/api_hunt scope guard: OK");

  // --- suite_hunt scope guard + engagement worklist + finding auto-evidence ---
  const { suiteHunt } = await import("./src/lib/hunt");
  if (!(await suiteHunt("verify_suite", "https://evil.example.com")).startsWith("Error: SCOPE")) throw new Error("suiteHunt scope guard failed");
  const { engagementTargetsText, scopeHostMatches } = await import("./src/lib/engagement");
  if (!/Engagement targets|Tidak ada engagement aktif/.test(engagementTargetsText("verify_engtargets"))) throw new Error("engagementTargetsText bad output");
  // Worklist join: a scope host must pick up a hunt-log note on one of its subdomains.
  if (!scopeHostMatches("member.example.com/admin", "example.com")) throw new Error("scopeHostMatches missed subdomain");
  if (!scopeHostMatches("example.com", "example.com")) throw new Error("scopeHostMatches missed exact");
  if (scopeHostMatches("notexample.com", "example.com")) throw new Error("scopeHostMatches false-positive");
  const { recordHttp } = await import("./src/lib/httpHistory");
  const { addFinding } = await import("./src/lib/security");
  const evidUser = "verify_finding_evid_tmp";
  recordHttp(evidUser, { method: "GET", url: "https://example.com/api/user/1", status: 200, bytes: 10, ms: 5, at: new Date().toISOString() });
  const evidFinding = addFinding(evidUser, { title: "evidence auto-attach", target: "example.com", cvss: 3.1 });
  if (evidFinding.severity !== "low") throw new Error(`CVSS 3.1 should be low, got ${evidFinding.severity}`);
  if (!evidFinding.evidence.includes("[auto from http_history]")) throw new Error("finding evidence auto-attach failed");
  rmSync(join(appRoot(), ".data", "users", evidUser), { recursive: true, force: true });
  console.log("suite_hunt guard + engagement worklist + finding auto-evidence: OK");

  // --- tool_calls must always have matching tool results (strict-gateway 400) ---
  const { ensureToolResults } = await import("./src/lib/agent");
  const msgs: Array<{ role: string; content?: unknown; tool_calls?: Array<{ id: string }>; tool_call_id?: string }> = [
    { role: "user", content: "hi" },
    { role: "assistant", tool_calls: [{ id: "a" }, { id: "b" }] },
    { role: "tool", tool_call_id: "a", content: "done" },
  ];
  ensureToolResults(msgs as never);
  const ids = msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  if (!ids.includes("a") || !ids.includes("b")) throw new Error("ensureToolResults did not fill the missing id");
  ensureToolResults(msgs as never);
  if (msgs.filter((m) => m.role === "tool" && m.tool_call_id === "b").length !== 1) throw new Error("ensureToolResults not idempotent");
  console.log("ensureToolResults (tool_call_id coverage + idempotent): OK");

  // --- CDP authenticated-testing tools: scope guards (no Chrome needed) ---
  const { cdpOpen, cdpRequest, cdpStatus } = await import("./src/lib/cdp");
  if (!(await cdpOpen("https://evil.example.com")).startsWith("Error: SCOPE")) throw new Error("cdpOpen scope guard failed");
  if (!(await cdpRequest({ tab: "x", url: "https://evil.example.com" })).startsWith("Error: SCOPE")) throw new Error("cdpRequest scope guard failed");
  if (!(await cdpOpen("ftp://x")).startsWith("Error:")) throw new Error("cdpOpen should reject non-http");
  if (!/CDP|Error:/.test(await cdpStatus())) throw new Error("cdpStatus bad output");
  console.log("cdp_* scope guards + status: OK");

  // --- poc_verify: scope guard + deterministic PoC against a local server ---
  const { pocVerify } = await import("./src/lib/poc");
  if (!(await pocVerify("v", { url: "https://evil.example.com" })).startsWith("Error: SCOPE")) throw new Error("pocVerify scope guard failed");
  if (!(await pocVerify("v", { url: "not-a-url" })).startsWith("Error:")) throw new Error("pocVerify url guard failed");
  {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/ok") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"secret":"hunter2"}'); return; }
      res.writeHead(403, { "content-type": "text/plain" }); res.end("forbidden");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const good = await pocVerify("v", { url: `http://127.0.0.1:${port}/ok`, times: 3, expect_status: 200, expect_contains: "hunter2", baseline_url: `http://127.0.0.1:${port}/no` });
    if (!good.includes("STABIL") && !good.includes("terkonfirmasi")) throw new Error(`pocVerify should confirm a deterministic 200: ${good.split("\n").slice(0, 4).join(" | ")}`);
    const bad = await pocVerify("v", { url: `http://127.0.0.1:${port}/no`, times: 2, expect_status: 200 });
    if (!bad.includes("assertion belum terpenuhi")) throw new Error("pocVerify should flag a failed assertion");
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log("poc_verify (scope + deterministic PoC + assertion): OK");

  // --- cloud misconfig + tech watch: pure classifiers ---
  const { cloudCandidates, classifyCloud } = await import("./src/lib/cloud");
  const cand = cloudCandidates("https://www.example.com/path");
  if (!cand.includes("example") || !cand.includes("example-com")) throw new Error(`cloudCandidates bad: ${JSON.stringify(cand)}`);
  if (cloudCandidates("") .length) throw new Error("cloudCandidates should be empty for blank");
  if (!classifyCloud("s3", { status: 200, body: "<ListBucketResult><Contents>" }).lead) throw new Error("classifyCloud missed open S3 listing");
  if (classifyCloud("s3", { status: 403, body: "AccessDenied" }).lead) throw new Error("classifyCloud false-positive on 403");
  if (!classifyCloud("firebase", { status: 200, body: '{"users":{"a":1}}' }).lead) throw new Error("classifyCloud missed open Firebase DB");
  if (classifyCloud("firebase", { status: 200, body: "null" }).lead) throw new Error("classifyCloud false-positive on Firebase null");
  const { detectTech } = await import("./src/lib/techWatch");
  const tech = detectTech({ server: "nginx", "x-powered-by": "PHP/8.1" }, '<meta name="generator" content="WordPress 6.4"> wp-content');
  if (!tech.some((t) => /nginx/.test(t)) || !tech.includes("wordpress") || !tech.some((t) => /PHP\/8\.1/.test(t)))
    throw new Error(`detectTech missed markers: ${JSON.stringify(tech)}`);
  if (detectTech({}, "nothing here").length) throw new Error("detectTech false-positive on plain body");
  console.log("cloudCandidates/classifyCloud + detectTech: OK");

  // --- nuclei_custom helpers (foreign addition) — audit regressions ---
  const nuc = await import("./src/lib/nuclei");
  if (nuc.normalizeSeverity("CRITICAL, high ") !== "critical,high") throw new Error("normalizeSeverity case/space");
  if (nuc.normalizeSeverity("critical,critical,high") !== "critical,high") throw new Error("normalizeSeverity dedupe");
  if (nuc.normalizeSeverity("bogus") !== null) throw new Error("normalizeSeverity should reject unknown");
  if (nuc.normalizeTags("xss sqli") !== "xss,sqli") throw new Error("normalizeTags should split on spaces");
  if (nuc.normalizeTags("xss;rm -rf /") !== null) throw new Error("normalizeTags should reject shell-ish input");
  if (!nuc.validateTags("xss,sqli")) throw new Error("validateTags false-negative");
  const nucArgv = nuc.nucleiArgv({ target: "127.0.0.1:4010" });
  if (!nucArgv || !nucArgv.includes("http://127.0.0.1:4010")) throw new Error("nucleiArgv target normalize");
  if (nuc.nucleiArgv({ target: "127.0.0.1", severity: "nope" }) !== null) throw new Error("nucleiArgv should reject bad severity");
  if (nuc.nucleiArgv({ target: "127.0.0.1", templates: "/etc/passwd" }) !== null) throw new Error("nucleiArgv should reject out-of-sandbox templates");
  const nucOut = "[tech-detect:nginx] [http] [info] http://x\n[cve-2024-1] [http] [high] http://y";
  const nucCounts = nuc.parseNucleiSeverityCounts(nucOut);
  if (nucCounts.info !== 1 || nucCounts.high !== 1) throw new Error(`parseNucleiSeverityCounts: ${JSON.stringify(nucCounts)}`);
  if (!nuc.summarizeNucleiOutput(nucOut).includes("2 temuan")) throw new Error("summarizeNucleiOutput count");
  console.log("nuclei_custom helpers (severity/tags/argv/counts): OK");

  // --- policy / flow / roi / dupes: pure helpers + flow runner E2E ---
  const { substitute, getPath, flowRun } = await import("./src/lib/flow");
  if (substitute("a/{{x}}/{{y}}", { x: "1" }) !== "a/1/{{y}}") throw new Error("substitute");
  if (getPath({ a: { b: [{ c: 2 }] } }, "a.b.0.c") !== "2") throw new Error("getPath nested");
  const { scoreHost, rankTargets } = await import("./src/lib/roi");
  if (scoreHost("api.example.com").score <= scoreHost("blog.example.com").score) throw new Error("scoreHost should rank api above blog");
  const ranked = rankTargets(["blog.example.com", "*.example.com", "api.example.com"]);
  if (ranked[0].host !== "*.example.com" && ranked[0].host !== "api.example.com") throw new Error("rankTargets order");
  const { similarity } = await import("./src/lib/dupes");
  if (similarity("IDOR in profile endpoint", "idor profile endpoint leak") < 0.4) throw new Error("similarity too low");
  if (similarity("alpha beta", "gamma delta") !== 0) throw new Error("similarity should be 0");
  const { autoApproveAllowed } = await import("./src/lib/policy");
  if (autoApproveAllowed("http_request", "write", { url: "https://evil.example.com" }, { hasActiveEngagement: true, urlAllowed: () => false })) throw new Error("policy should deny out-of-scope URL");
  if (autoApproveAllowed("delete_note", "delete", {}, { hasActiveEngagement: true, urlAllowed: () => true })) throw new Error("policy must never auto-approve delete");
  {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      if (req.url === "/a") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"id":"42"}'); return; }
      if (req.url === "/b/42") { res.writeHead(200); res.end('{"ok":true}'); return; }
      res.writeHead(404); res.end("no");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    const out = await flowRun("v", {
      flow: {
        name: "t",
        steps: [
          { url: `http://127.0.0.1:${port}/a`, expect_status: 200, extract: { id: "id" } },
          { url: `http://127.0.0.1:${port}/b/{{id}}`, expect_status: 200, expect_contains: "ok" },
        ],
      },
    });
    if (!out.includes("SELESAI")) throw new Error(`flowRun should complete: ${out.split("\n").join(" | ")}`);
    const bad = await flowRun("v", { flow: { steps: [{ url: `http://127.0.0.1:${port}/a`, expect_status: 500 }] } });
    if (!bad.includes("GAGAL")) throw new Error("flowRun should fail on assertion");
    await new Promise<void>((r) => server.close(() => r()));
  }
  console.log("policy/flow/roi/dupes + flow runner E2E: OK");

  // --- campaign status lookup must use hunt_log's key normalization ---
  const { huntStatusFor } = await import("./src/lib/campaign");
  const fakeEntries = [{ target: "127.0.0.1:4022", status: "lead" }];
  if (huntStatusFor(fakeEntries, "http://127.0.0.1:4022/") !== "lead") throw new Error("huntStatusFor key mismatch (trailing slash/scheme)");
  if (huntStatusFor(fakeEntries, "https://other.example.com") !== undefined) throw new Error("huntStatusFor false match");
  console.log("campaign huntStatusFor normalization: OK");

  // --- campaign/bounty default scope: ONE newest active engagement, never a union ---
  const { newestActiveEngagement, listEngagements } = await import("./src/lib/engagement");
  const actives = listEngagements().filter((e) => e.status === "active");
  const newest = newestActiveEngagement();
  if (actives.length && !newest) throw new Error("newestActiveEngagement returned null with active engagements");
  if (newest) {
    const maxCreated = actives.map((e) => e.createdAt || "").sort().slice(-1)[0] ?? "";
    if ((newest.createdAt || "") !== maxCreated) throw new Error("newestActiveEngagement picked the wrong one");
  }
  const { campaignRun } = await import("./src/lib/campaign");
  const noEng = await campaignRun("verify_campaign_scope", { engagement: "ENG-does-not-exist" });
  if (!/Tidak ada target/.test(noEng) || /→ lead/.test(noEng)) throw new Error(`campaignRun should refuse an unknown engagement: ${noEng.slice(0, 120)}`);
  console.log("campaign/bounty default engagement scope: OK");

  // --- bounty_run: lead classifier + no-engagement guard (no network) ---
  const { isHighSignalLead, bountyRun, bountyStatus } = await import("./src/lib/bounty");
  if (!isHighSignalLead("📂 BUCKET TERBUKA — listing publik")) throw new Error("isHighSignalLead missed open bucket");
  if (!isHighSignalLead("cookie sesi tanpa HttpOnly di /login")) throw new Error("isHighSignalLead missed cookie flag");
  if (isHighSignalLead("tidak ada sinyal otomatis")) throw new Error("isHighSignalLead false-positive");
  const noTargets = await bountyRun("verify_bounty", { engagement: "ENG-does-not-exist" });
  if (!/Tidak bisa jalan/.test(noTargets)) throw new Error(`bountyRun should refuse with an unknown engagement: ${noTargets.slice(0, 80)}`);
  if (typeof (await bountyStatus()) !== "string") throw new Error("bountyStatus bad");
  console.log("bounty_run classifier + guard: OK");

  // --- automation dedupe/merge (duplicate-push bug fix) ---
  const { promptsSimilar, addOrMergeAutomation, readAutomations } = await import("./src/lib/automations");
  if (!promptsSimilar("cek cuaca Lake Home tiap 2 jam", "Cek cuaca di Lake Home, Serpong tiap 2 jam")) throw new Error("promptsSimilar missed near-dup");
  if (promptsSimilar("cek cuaca hari ini", "kirim email laporan keuangan")) throw new Error("promptsSimilar false-positive");
  const autoUser = "verify_autodup_tmp";
  const r1 = addOrMergeAutomation("Cek cuaca Lake Home tiap 2 jam lalu kabari kalau mau hujan", "setiap 2 jam", autoUser);
  const r2 = addOrMergeAutomation("Cek cuaca Lake Home tiap 2 jam dan kabari kalau ada tanda hujan", "setiap 2 jam", autoUser);
  if (!r1 || r1.merged) throw new Error("first automation should be created, not merged");
  if (!r2?.merged) throw new Error("near-identical automation should MERGE, not duplicate");
  if (readAutomations(autoUser).length !== 1) throw new Error("automation duplicate not merged");
  const r3 = addOrMergeAutomation("Kirim ringkasan berita teknologi tiap pagi", "setiap pagi jam 8", autoUser);
  if (r3.merged) throw new Error("different automation should not merge");
  rmSync(join(appRoot(), ".data", "users", autoUser), { recursive: true, force: true });
  console.log("automation dedupe/merge: OK");

  // --- oauth redirect classifier + writeup renderer (pure) ---
  const { redirectVariants, classifyOauthRedirect } = await import("./src/lib/oauth");
  const rv = redirectVariants("id.example.com");
  if (rv.length < 4 || !rv.some((v) => v.value.includes("evil.example"))) throw new Error("redirectVariants bad");
  if (!classifyOauthRedirect(302, "https://evil.example/cb?code=1", ["id.example.com"]).open) throw new Error("classifyOauthRedirect missed off-host redirect");
  if (!classifyOauthRedirect(302, "//evil.example/cb", ["id.example.com"]).open) throw new Error("classifyOauthRedirect missed protocol-relative off-host redirect");
  if (classifyOauthRedirect(302, "https://id.example.com/cb", ["id.example.com"]).open) throw new Error("classifyOauthRedirect false-positive on own host");
  if (classifyOauthRedirect(200, "https://evil.example/", ["id.example.com"]).open) throw new Error("classifyOauthRedirect should ignore non-3xx");
  const { renderWriteup } = await import("./src/lib/writeup");
  const wu = renderWriteup({
    id: "F-x", title: "[DRAFT, belum diverifikasi] Cookie tanpa HttpOnly", severity: "low", cvss: 3.1, owasp: "A02:2025", cwe: "CWE-1004",
    target: "app.example.com", evidence: "[auto from http_history] GET https://app.example.com/x → 200", steps: "", impact: "session theft", rootCause: "", remediation: "set HttpOnly", references: "", status: "open", createdAt: new Date().toISOString(),
  });
  for (const needle of ["# Cookie tanpa HttpOnly", "Severity:", "Steps to reproduce", "Evidence", "Remediation", "STATUS: DRAFT"]) {
    if (!wu.includes(needle)) throw new Error(`writeup missing ${needle}`);
  }
  console.log("oauth classifier + writeup renderer: OK");

  // --- channel send-boundary scrub (tool-call markup must never reach a user) ---
  const { chunkText: chunkScrub, scrubToolMarkup } = await import("./src/channels/replyChunk");
  const leakedReply = `<tool_call>, sementara itu <invoke name="fetch_url">. <parameter name="url">https://bugcrowd, sementara itu com/x. Json</parameter>, sementara itu </invoke> ya beb 🌸`;
  const scrubbed = scrubToolMarkup(leakedReply);
  if (/<(?:invoke|tool_call|parameter|tool_use)/i.test(scrubbed)) throw new Error(`scrubToolMarkup left markup: ${scrubbed}`);
  if (!scrubbed.includes("ya beb")) throw new Error("scrubToolMarkup dropped the real text");
  const partial = scrubToolMarkup('hasilnya begini <invoke name="browser_open">');
  if (/<invoke/i.test(partial)) throw new Error(`scrubToolMarkup missed unclosed tag: ${partial}`);
  if (/<invoke/i.test(chunkScrub(leakedReply, 2000)[0])) throw new Error("chunkText did not scrub markup");
  if (chunkScrub("```\n<parameter name=\"x\">\n```", 5000)[0].includes("```") === false) throw new Error("chunkText lost code fence");
  console.log("channel scrub tool-markup: OK");

  // --- tool-arg body coercion (object body must not be silently dropped) ---
  const { asBodyString } = await import("./src/lib/args");
  if (asBodyString({ query: "{__typename}" }) !== '{"query":"{__typename}"}') throw new Error("asBodyString should stringify an object body");
  if (asBodyString('{"a":1}') !== '{"a":1}') throw new Error("asBodyString should pass a string through");
  if (asBodyString(undefined) !== undefined || asBodyString(null) !== undefined) throw new Error("asBodyString should return undefined for empty");
  if (asBodyString([1, 2]) !== "[1,2]") throw new Error("asBodyString should stringify arrays");
  const { asNumber, asStringArray } = await import("./src/lib/args");
  if (asNumber("3") !== 3 || asNumber(4) !== 4) throw new Error("asNumber should coerce numeric strings");
  if (asNumber("abc") !== undefined || asNumber("") !== undefined) throw new Error("asNumber should reject junk");
  if (JSON.stringify(asStringArray("a, b")) !== '["a","b"]') throw new Error("asStringArray should split a comma string");
  if (JSON.stringify(asStringArray(["x", "y"])) !== '["x","y"]') throw new Error("asStringArray should pass arrays through");
  if (asStringArray("") !== undefined) throw new Error("asStringArray should be undefined for empty");
  console.log("asBodyString (object/array/string body): OK");

  // --- local Indonesian TTS detector (FR-010 Indonesian) ---
  const { looksIndonesian } = await import("./src/lib/ttsLocal");
  if (!looksIndonesian("Halo Mas Naufal, apa kabar hari ini?")) throw new Error("looksIndonesian missed Indonesian");
  if (!looksIndonesian("Jangan lupa makan siang ya")) throw new Error("looksIndonesian missed Indonesian (2)");
  if (looksIndonesian("Please merge the pull request and deploy")) throw new Error("looksIndonesian false-positive English");
  if (looksIndonesian("مرحبا كيف حالك")) throw new Error("looksIndonesian should exclude Arabic");
  if (looksIndonesian("")) throw new Error("looksIndonesian should be false for empty");
  console.log("looksIndonesian (ID vs EN vs AR): OK");

  // --- memory noise filter + secret redaction (recap/memory hygiene) ---
  const { isNoiseLine, redactSecrets } = await import("./src/lib/memoryNoise");
  if (!isNoiseLine('Mia: query{ candidate(id: "auth0|6aaa6aa27123f6e684d7e009"){ documentId { value } } }')) throw new Error("isNoiseLine missed a GraphQL/tool line");
  if (!isNoiseLine('cdp_request tab=jobstreet.com url=https://graphql.seek.com/graphql method=POST')) throw new Error("isNoiseLine missed a tool-command line");
  if (!isNoiseLine('{"query":"{__typename}"}')) throw new Error("isNoiseLine missed a JSON payload");
  if (isNoiseLine("Halo Mas, tadi aku masak rendang buat keluarga.")) throw new Error("isNoiseLine false-positive on normal chat");
  if (redactSecrets("id auth0|6aaa6aa27123f6e684d7e009 ok").includes("auth0|")) throw new Error("redactSecrets left an auth0 id");
  if (redactSecrets("Bearer eyJhbGciOiJIUzI1NiJ9.abc.def").includes("eyJ")) throw new Error("redactSecrets left a JWT");
  console.log("memoryNoise (tool/secrets filtered, chat kept): OK");

  // --- scope-gating matrix: every ACTIVE tool must refuse an out-of-scope URL ---
  {
    const out = "https://evil.example.com";
    const matrix: [string, Record<string, unknown>][] = [
      ["security_hunt", { url: out }], ["suite_hunt", { url: out }], ["auth_hunt", { url: out }],
      ["api_hunt", { url: out }], ["oauth_hunt", { url: out }], ["poc_verify", { url: out }],
      ["tech_watch", { url: out }], ["cloud_misconfig", { base_domain: "evil.example.com" }],
      ["content_discover", { url: out }], ["param_fuzz", { url: out }], ["crawl", { url: out }],
      ["param_discover", { url: out }], ["race", { url: out }], ["ws_probe", { url: "ws://evil.example.com" }],
      ["recon_httpx", { domain: "evil.example.com" }], ["recon_ports", { host: "evil.example.com" }],
      ["recon_screenshot", { domain: "evil.example.com" }], ["recon_dnsbrute", { domain: "evil.example.com" }],
      ["bucket_enum", { domain: "evil.example.com" }], ["js_mine", { url: out }], ["graphql_probe", { url: out }],
      ["evidence_capture", { url: out }], ["http_request", { url: out }], ["pentest_scan", { tool: "nmap", target: out }],
      ["sqlmap_scan", { url: out }], ["nuclei_custom", { target: out }], ["cdp_request", { tab: "x", url: out }],
      ["cdp_open", { url: out }], ["flow_run", { flow: { steps: [{ url: out }] } }],
    ];
    for (const [name, args] of matrix) {
      const r = await executeTool({ id: "t", name, arguments: JSON.stringify(args) }, "verify_scope_matrix");
      if (!/SCOPE|lab|engagement|tidak diizinkan/i.test(r)) {
        throw new Error(`scope gate missing for ${name}: ${String(r).slice(0, 120)}`);
      }
    }
    console.log(`scope-gating matrix (${matrix.length} active tools refuse out-of-scope): OK`);

  // --- persona facts: canonical keys, conflicts, secrets, cap, split + tools ---
  {
    const pf = await import("./src/lib/personaFacts");
    if (pf.canonicalFactKey("favorite_food") !== "preference.food") throw new Error("canonical favorite_food");
    if (pf.canonicalFactKey("preference.food") !== "preference.food") throw new Error("canonical preference.food");
    if (pf.canonicalFactKey("name") !== "name") throw new Error("canonical name must stay");
    if (pf.canonicalFactKey("preference.crypto_monitor") !== "preference.crypto_monitor") throw new Error("non-preference key must stay");
    if (!pf.looksLikeSecret("auth0|6aaa6aa27123f6e684d7e009") || !pf.looksLikeSecret("eyJhbGciOiJIUzI1NiJ9.abc.def")) throw new Error("looksLikeSecret missed a token");
    if (pf.looksLikeSecret("nasi goreng")) throw new Error("looksLikeSecret false-positive");
    const m1 = pf.mergeFact([{ key: "name", value: "Naufal" }], "favorite_food", "nasi goreng");
    const m2 = pf.mergeFact(m1.facts, "preference.food", "bakso");
    if (m2.facts.filter((f) => f.key === "preference.food").length !== 1) throw new Error("canonical merge should collapse synonyms");
    if (!m2.superseded || m2.superseded.from !== "nasi goreng" || m2.superseded.to !== "bakso") throw new Error("mergeFact should report the superseded value");
    const capped = pf.capFacts(Array.from({ length: 100 }, (_, i) => ({ key: `k${i}`, value: "v" })), 80);
    if (capped.facts.length !== 80 || capped.dropped !== 20) throw new Error("capFacts wrong");
    const split = pf.splitFactFile("# U\n\n## Facts\n\n- name: Naufal\n\n## Superseded\n\n- [superseded] name: beb → Naufal (2026-01-01)\n");
    if (split.facts.length !== 1 || split.facts[0].key !== "name") throw new Error("splitFactFile should read only live facts");
    if (split.superseded.length !== 1) throw new Error("splitFactFile should keep superseded history");
    const pu = "verify_persona_tools";
    await executeTool({ id: "t", name: "persona_set", arguments: JSON.stringify({ key: "favorite_food", value: "nasi goreng" }) }, pu);
    const secretRes = await executeTool({ id: "t", name: "persona_set", arguments: JSON.stringify({ key: "token", value: "eyJhbGciOiJIUzI1NiJ9.abc.def" }) }, pu);
    if (!/tidak kusimpan|rahasia/i.test(secretRes)) throw new Error("persona_set should refuse a secret");
    const showRes = await executeTool({ id: "t", name: "persona_show", arguments: "{}" }, pu);
    if (!/preference\.food: nasi goreng/.test(showRes)) throw new Error(`persona_show missing canonical fact: ${showRes.slice(0, 120)}`);
    const forgetRes = await executeTool({ id: "t", name: "persona_forget", arguments: JSON.stringify({ query: "food" }) }, pu);
    if (!/Kuhapus/i.test(forgetRes)) throw new Error(`persona_forget should remove the fact: ${forgetRes}`);
    rmSync(join(appRoot(), ".data", "users", pu), { recursive: true, force: true });
    console.log("persona facts (canonical/secret/conflict/cap/split + tools): OK");

  // --- tool schema sanitizer (strict providers: array needs items) ---
  {
    const { sanitizeToolSchema } = await import("./src/lib/agent");
    const a = sanitizeToolSchema({ type: "object", properties: { hosts: { type: "array" } } }) as { properties: { hosts: { items?: unknown } } };
    if (!a.properties.hosts.items) throw new Error("sanitizeToolSchema should add items to an array param");
    const b = sanitizeToolSchema({ type: "object" }) as { properties?: unknown };
    if (!b.properties) throw new Error("sanitizeToolSchema should add empty properties to an object");
    const c = sanitizeToolSchema({ type: "array", items: { type: "object", properties: { a: { type: "array" } } } }) as { items: { properties: { a: { items?: unknown } } } };
    if (!c.items.properties.a.items) throw new Error("sanitizeToolSchema should recurse");
    console.log("sanitizeToolSchema (items/properties/recursive): OK");

  // --- automation push must not echo the schedule prompt ---
  {
    const { stripScheduleEcho } = await import("./src/lib/automationRunner");
    const prompt = "Cek cuaca terkini di Lake Home, Serpong, Tangerang Selatan pakai tool weather.";
    const withSuffix = `Malam beb 🌸 25°C, kelembapan 73%.\n\n(ini buat jadwal yang kamu minta: ${prompt})`;
    const cleaned = stripScheduleEcho(withSuffix, prompt);
    if (/ini buat jadwal|Cek cuaca terkini/i.test(cleaned)) throw new Error(`stripScheduleEcho left the schedule echo: ${cleaned}`);
    if (!/25°C/.test(cleaned)) throw new Error("stripScheduleEcho dropped the real answer");
    console.log("automation schedule-echo strip: OK");

  // --- secret redaction on every output/audit surface ---
  {
    const { redactArgsForDisplay } = await import("./src/lib/args");
    const { redactSecrets } = await import("./src/lib/memoryNoise");
    const a = redactArgsForDisplay(JSON.stringify({ url: "https://x", headers: { Authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb", Cookie: "sid=1" }, access_key: "rak_ABC123456789", secret_key: "rsk_SECRET123456" }));
    for (const bad of ["eyJ", "rak_", "rsk_", "sid=1"]) if (a.includes(bad)) throw new Error(`redactArgsForDisplay leaked ${bad}: ${a}`);
    if (!a.includes("https://x")) throw new Error("redactArgsForDisplay dropped non-secret args");
    const b = redactSecrets('{"password":"hunter2","note":"ok"} auth0|6aaa6aa27123f6e684d7e009');
    if (b.includes("hunter2") || b.includes("auth0|")) throw new Error(`redactSecrets leaked: ${b}`);
    if (!b.includes("ok")) throw new Error("redactSecrets dropped non-secret text");
    console.log("secret redaction (args display + logs/json): OK");

    // home-path masking at the channel send boundary
    const { scrubHomePath, chunkText: chunkHome } = await import("./src/channels/replyChunk");
    if (scrubHomePath("/Users/bob/app/x.ts", "/Users/bob") !== "~/app/x.ts") throw new Error("scrubHomePath wrong");
    const realHome = process.env.HOME || "/Users/bob";
    if (!/~\/app\/x.ts/.test(chunkHome(`buka ${realHome}/app/x.ts`, 500)[0])) throw new Error(`chunkText should mask the home path: ${chunkHome(`buka ${realHome}/app/x.ts`, 500)[0]}`);
    console.log("home-path masking: OK");

  // --- Spotify sleep timer plan (pure) ---
  {
    const { sleepTimerPlan } = await import("./src/lib/spotify");
    const a = sleepTimerPlan({ minutes: 20 }, null) as { ms: number };
    if (a.ms !== 20 * 60_000) throw new Error("sleepTimerPlan minutes wrong");
    const b = sleepTimerPlan({ after_track: true }, { is_playing: true, progress_ms: 60_000, item: { duration_ms: 180_000, name: "X" } }) as { ms: number; label: string };
    if (b.ms !== 121_500 || !/setelah lagu ini selesai/.test(b.label)) throw new Error(`sleepTimerPlan after_track wrong: ${JSON.stringify(b)}`);
    const c = sleepTimerPlan({ after_track: true }, { is_playing: false, item: { duration_ms: 1000 } }) as { error?: string };
    if (!c.error) throw new Error("paused playback should not plan an after_track stop");
    if (!("error" in (sleepTimerPlan({}, null) as object))) throw new Error("sleepTimerPlan should ask for after_track/minutes");
    console.log("spotify sleep timer plan: OK");

  // --- spotify intent: after-track must not pause immediately ---
  {
    const { detectSpotifyAfterTrack, detectSpotifyControl } = await import("./src/lib/spotifyIntent");
    for (const s of [
      "oke kalo lagunya udh selesai stop aja ya soalnya mau tidur",
      "stop aja kalau lagunya udah selesai",
      "matiin biar ga bablas sampe pagi",
    ]) {
      if (!detectSpotifyAfterTrack(s)) throw new Error(`after-track not detected: ${s}`);
      if (detectSpotifyControl(s) !== null) throw new Error(`after-track should not be an immediate control: ${s}`);
    }
    if (detectSpotifyAfterTrack("stop lagunya sekarang")) throw new Error("immediate stop wrongly treated as after-track");
    if (detectSpotifyControl("stop lagunya sekarang")?.action !== "pause") throw new Error("immediate pause no longer works");
    console.log("spotify after-track intent routing: OK");

  // --- "lagu favoritku" resolves to the persona fact, not a literal search ---
  {
    const { resolveFavoriteQuery } = await import("./src/lib/spotify");
    if (resolveFavoriteQuery("lagu favoritku dari m2m", "The Day You Went Away (M2M)", "M2M") !== "The Day You Went Away M2M")
      throw new Error("resolveFavoriteQuery should use the persona song");
    if (resolveFavoriteQuery("The Day You Went Away M2M", null, null) !== "The Day You Went Away M2M")
      throw new Error("resolveFavoriteQuery must not change a real song query");
    if (resolveFavoriteQuery("lagu favoritku", null, "M2M") !== "lagu favoritku")
      throw new Error("resolveFavoriteQuery should fall back when there is no saved song");
    const { getPersonaFact, setPersonaFact } = await import("./src/lib/persona");
    const pfUser = "verify_personafact";
    setPersonaFact(pfUser, "preference.song", "Uji Lagu (Band Uji)");
    if (getPersonaFact(pfUser, "preference.song") !== "Uji Lagu (Band Uji)") throw new Error("getPersonaFact round-trip failed");
    rmSync(join(appRoot(), ".data", "users", pfUser), { recursive: true, force: true });
    console.log("spotify favorite-song resolution + getPersonaFact: OK");

  // --- turn-dedupe: a spotify control maps to exactly one tool name ---
  {
    const { spotifyControlToolName } = await import("./src/lib/spotifyIntent");
    const map = [["pause", "spotify_pause"], ["next", "spotify_next"], ["previous", "spotify_previous"], ["volume", "spotify_volume"]] as const;
    for (const [action, tool] of map) {
      if (spotifyControlToolName(action) !== tool) throw new Error(`spotifyControlToolName(${action}) should be ${tool}`);
    }
    console.log("spotify control→tool dedupe key: OK");
  }
  }
  }
  }
  }
  }
  }

  // --- reminder questions must not be treated as set-intents ---
  {
    const { isReminderQuery } = await import("./src/lib/reminderIntent");
    if (!isReminderQuery("masih inget ga jadwal bangunin aku?")) throw new Error("reminder query not detected");
    if (!isReminderQuery("reminder-ku apa aja?")) throw new Error("reminder query (apa aja) not detected");
    if (isReminderQuery("ingetin aku jam 7 pagi")) throw new Error("set-phrase wrongly treated as a query");
    if (isReminderQuery("bangunin aku jam 6")) throw new Error("set-phrase wrongly treated as a query");
    console.log("reminder query vs set-intent guard: OK");

  // --- wake-reminder <-> persona wake_up_time sync (single source of truth) ---
  {
    const { isWakeIntent } = await import("./src/lib/reminderIntent");
    if (!isWakeIntent("Bangun tidur Mas Naufal")) throw new Error("isWakeIntent missed wake text");
    if (isWakeIntent("minum air")) throw new Error("isWakeIntent false-positive");
    const wu = "verify_wakesync";
    await executeTool({ id: "t", name: "remind_me", arguments: JSON.stringify({ text: "Bangun tidur Mas Naufal", when: "2026-09-17T05:00:00+07:00" }) }, wu);
    const wakePath = join(appRoot(), ".data", "users", wu, "persona", "USER.md");
    const wakeFile = readFileSync(wakePath, "utf8");
    if (!/wake_up_time: 05:00/.test(wakeFile)) throw new Error(`wake sync should set persona 05:00: ${wakeFile.match(/wake_up_time: \S+/)}`);
    await executeTool({ id: "t", name: "cancel_reminder", arguments: JSON.stringify({ query: "bangun" }) }, wu);
    const after = readFileSync(wakePath, "utf8");
    if (/wake_up_time: 05:00/.test(after)) throw new Error("cancel should drop the stale wake_up_time fact");
    rmSync(join(appRoot(), ".data", "users", wu), { recursive: true, force: true });
    console.log("wake reminder <-> persona wake_up_time sync: OK");
  }
  }
  }
  }

  // --- XML tool-call markup leak (opencodego/deepseek) is stripped ---
  const { stripToolCallProse: stripXmlProse } = await import("./src/lib/agent");
  const xmlLeaked = 'Aku cek ya <td>, sementara itu <invoke name="browser_open"><parameter name="url">https://x/y</parameter></invoke> ya beb 🌸';
  const xmlCleaned = stripXmlProse(xmlLeaked);
  if (/<invoke|<\/?parameter|antml:|<tool_call/i.test(xmlCleaned) || !/ya beb/.test(xmlCleaned)) {
    throw new Error(`XML tool markup not stripped: ${JSON.stringify(xmlCleaned)}`);
  }
  console.log("tool-call XML markup strip: OK");

  // --- transport parsers (offline fixtures; live fetch is network-gated) ---
  const { parseTravelokaSchedules, parseBusTable, slugify } = await import("./src/lib/transport");
  if (slugify("Jogja") !== "yogyakarta" || slugify("Jakarta Selatan") !== "jakarta" || slugify("Bandung") !== "bandung") {
    throw new Error(`transport slugify wrong: ${slugify("Jogja")}/${slugify("Jakarta Selatan")}`);
  }
  const nextData = JSON.stringify({
    props: { pageProps: { automationProps: { schedules: [
      { trainNumber: "130B", trainName: "Papandayan", seatClass: "Economy", fareFmt: { amount: 125000 }, departureTime: { hour: 6, minute: 35 }, arrivalTime: { hour: 9, minute: 20 }, durationFmt: { hour: 2, minute: 45 }, originStationLabel: "Gambir", destinationStationLabel: "Padalarang" },
    ] } } },
  });
  const trains = parseTravelokaSchedules(`<script id="__NEXT_DATA__" type="application/json">${nextData}</script>`);
  if (trains.length !== 1 || trains[0].name !== "Papandayan" || trains[0].depart !== "06:35" || trains[0].arrive !== "09:20" || trains[0].fare !== 125000) {
    throw new Error(`parseTravelokaSchedules wrong: ${JSON.stringify(trains)}`);
  }
  const buses = parseBusTable('<table><tr><th>Operator</th><th>Pertama</th><th>Terakhir</th><th>Perjalanan</th><th>Hari</th><th>Harga</th></tr><tr><td>Pasteur Trans<script>{"x":1}</script></td><td>04:30</td><td>21:20</td><td>1029</td><td>M T W</td><td><span>Rp </span>159,600</td></tr></table>');
  if (buses.length !== 1 || buses[0].operator !== "Pasteur Trans" || buses[0].first !== "04:30" || buses[0].price !== 159600) {
    throw new Error(`parseBusTable wrong: ${JSON.stringify(buses)}`);
  }
  console.log("transport parsers (train/bus): OK");

  // --- local Whisper STT (offline, keyless; the binary lives on the machine) ---
  const { whisperInfo, transcribeAudio } = await import("./src/lib/localStt");
  const wi = whisperInfo();
  if (typeof wi.available !== "boolean" || typeof wi.bin !== "string" || !Array.isArray(wi.models)) {
    throw new Error(`whisperInfo shape wrong: ${JSON.stringify(wi)}`);
  }
  let sttGuarded = 0;
  for (const bad of ["/tmp/mia-verify-missing-xyz.wav", "/tmp/mia-verify.txt"]) {
    try { await transcribeAudio(bad); } catch { sttGuarded++; }
  }
  if (sttGuarded !== 2) throw new Error("transcribeAudio did not guard missing file / bad extension");
  console.log("local whisper stt (info + guards): OK");

  // --- humanizer (deterministic; useLlm:false so no network) ---
  const { humanize } = await import("./src/lib/humanizer");
  const hz = await humanize(
    "## The Rise Of AI\n\nIt stands as a testament — a crucial role. Di era digital yang serba cepat, ini penting. Penting untuk dicatat bahwa kita harus siap. Sebagai kesimpulan, masa depan terlihat cerah.",
    { useLlm: false }
  );
  const hp = hz.humanized;
  if (/\ba (important|example)\b/i.test(hp)) throw new Error(`humanizer article agreement: ${hp}`);
  if (/ ,/.test(hp)) throw new Error(`humanizer em-dash spacing: ${hp}`);
  if (hp.includes("—")) throw new Error("humanizer left an em dash");
  if (/Penting untuk dicatat|Di era digital yang serba cepat|Sebagai kesimpulan/i.test(hp)) throw new Error(`humanizer ID fillers not removed: ${hp}`);
  if (!hz.patterns.some((p) => p.startsWith("p25")) || !hz.patterns.some((p) => p.startsWith("p26"))) {
    throw new Error(`humanizer ID patterns not detected: ${hz.patterns.join(",")}`);
  }
  console.log("humanizer (grammar + ID patterns): OK");

  // --- providerHeaders: OpenCode Go needs the session header on EVERY call ---
  const { providerHeaders } = await import("./src/lib/providers");
  const gh = providerHeaders({ url: "https://opencode.ai/zen/go/v1/chat/completions", apiKey: "k" }, "s1");
  if (gh["x-opencode-session"] !== "s1" || gh["User-Agent"] !== "mia-assistant/1.0" || gh.Authorization !== "Bearer k") {
    throw new Error(`providerHeaders go wrong: ${JSON.stringify(gh)}`);
  }
  if (providerHeaders({ url: "https://api.groq.com/openai/v1/chat/completions", apiKey: "g" })["x-opencode-session"]) {
    throw new Error("providerHeaders leaked the go session header to groq");
  }
  // article agreement must not over-correct ("a unique" stays; a important -> an)
  const hz2 = await humanize("a unique case and a important role", { useLlm: false });
  if (!/\ba unique\b/.test(hz2.humanized) || !/\ban important\b/.test(hz2.humanized)) {
    throw new Error(`humanizer article over-corrected: ${hz2.humanized}`);
  }
  console.log("provider headers + article agreement: OK");

  // --- learnings: dedup by Pattern-Key + recurrence + promotion (self-cleaning) ---
  const { logError: logLrn } = await import("./src/lib/learnings");
  const { repoRoot: repoRootFn } = await import("./src/lib/users");
  const lk = `verify.learnings.${Date.now()}`;
  const efile = join(repoRootFn(), ".learnings", "ERRORS.md");
  const n0 = existsSync(efile) ? (readFileSync(efile, "utf8").match(/## \[ERR-/g) || []).length : 0;
  for (let i = 0; i < 3; i++) logLrn({ skill: "verify_tool", summary: "verify dedup entry", error: "x", patternKey: lk });
  const etxt = readFileSync(efile, "utf8");
  const n1 = (etxt.match(/## \[ERR-/g) || []).length;
  if (n1 - n0 !== 1) throw new Error(`learnings dedup failed: +${n1 - n0} entries`);
  const eblk = etxt.split(/(?=^## \[)/m).find((p) => p.includes(`- Pattern-Key: ${lk}\n`));
  if (!eblk || Number(eblk.match(/Recurrence-Count:\s*(\d+)/)?.[1]) < 3) throw new Error("learnings recurrence not incremented");
  writeFileSync(efile, etxt.replace(eblk, "").replace(/\n{3,}/g, "\n\n"));
  for (const mp of [join(repoRootFn(), ".self-improving", "memory.md"), join(homedir(), "self-improving", "memory.md")]) {
    try {
      const m = readFileSync(mp, "utf8");
      writeFileSync(mp, m.split("\n").filter((l) => !l.includes(`[${lk}]`)).join("\n"));
    } catch { /* mirror may not exist */ }
  }
  console.log("learnings dedup+recurrence+promotion: OK");

  // --- tool registry integrity (structural; catches drift) ---
  const { getTOOLS: toolsFn } = await import("./src/lib/tools");
  const toolNames = toolsFn().map((t) => t.function.name);
  if (new Set(toolNames).size !== toolNames.length) throw new Error("duplicate tool names in registry");
  const RISKS = new Set(["read", "write", "delete", "transaction", "external"]);
  for (const t of toolsFn()) {
    if (t.type !== "function" || !/^[a-z0-9_]+$/.test(t.function.name)) throw new Error(`bad tool def: ${t.function.name}`);
    if (!t.function.description || !t.function.description.trim()) throw new Error(`tool ${t.function.name} has no description`);
    const params = t.function.parameters as { type?: string } | undefined;
    if (!params || params.type !== "object") throw new Error(`tool ${t.function.name} parameters not an object`);
    if (!RISKS.has(t.risk)) throw new Error(`tool ${t.function.name} bad risk: ${t.risk}`);
  }
  console.log(`tool registry integrity (${toolNames.length} tools): OK`);

  // --- pure intent detectors + text helpers (offline) ---
  const { detectMoodIntent: moodDetect } = await import("./src/lib/moodIntent");
  if (!moodDetect("aku lagi stres banget kerjaan numpuk")) throw new Error("moodIntent missed stressed");
  if (moodDetect("apa kabar?") !== null) throw new Error("moodIntent false-positive");
  const { detectCorrection: correctDetect } = await import("./src/lib/correctionIntent");
  if (!correctDetect("salah, seharusnya jam 9 bukan jam 8")) throw new Error("correctionIntent missed");
  if (correctDetect("halo apa kabar") !== null) throw new Error("correctionIntent false-positive");
  const { detectMonitorIntent: monDetect } = await import("./src/lib/monitorIntent");
  if (!monDetect("pantau harga bitcoin")) throw new Error("monitorIntent missed bitcoin");
  if (monDetect("apa kabar") !== null) throw new Error("monitorIntent false-positive");
  const { detectSpotifyControl: spotControl } = await import("./src/lib/spotifyIntent");
  if (spotControl("pause lagunya dong")?.action !== "pause") throw new Error("spotifyControl missed pause");
  const { detectSpotifyIntent: spInt } = await import("./src/lib/spotifyIntent");
  if (spInt("sedang putar lagu apa aku di spotify?")) throw new Error("spotify: status question wrongly treated as play");
  if (spInt("lagu apa yang lagi diputar")) throw new Error("spotify: 'lagu apa' wrongly play");
  if (!spInt("putar lagu Kotak")) throw new Error("spotify: explicit play not detected");
  const { chunkText: chunkReply } = await import("./src/channels/replyChunk");
  const big = "baris ".repeat(1000);
  const chunks = chunkReply(big, 2000);
  if (chunks.length < 2 || chunks.some((c) => c.length > 2000)) throw new Error("chunkText exceeded max");
  if (chunks.join("").replace(/\s/g, "") !== big.replace(/\s/g, "")) throw new Error("chunkText lost content");
  const { parseConfirmReply, pendingConfirmPrompt } = await import("./src/channels/replyChunk");
  const eq = (a: unknown, b: unknown, why: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${why}: got ${JSON.stringify(a)}`);
  };
  eq(parseConfirmReply("ya", 3), [true, true, true], "confirm all");
  eq(parseConfirmReply("tidak", 2), [false, false], "confirm none");
  eq(parseConfirmReply("ya 1,3", 3), [true, false, true], "confirm selective");
  eq(parseConfirmReply("ya 2", 3), [false, true, false], "confirm single index");
  eq(parseConfirmReply("halo", 2), null, "confirm unparsed reply");
  eq(parseConfirmReply("ya 9", 3), null, "confirm out-of-range index");
  if (!pendingConfirmPrompt([{ name: "security_hunt", arguments: '{"url":"https://x"}' }]).includes("security_hunt"))
    throw new Error("pendingConfirmPrompt missing tool name");
  if (!pendingConfirmPrompt([{ name: "a" }, { name: "b" }]).includes("1. **a**"))
    throw new Error("pendingConfirmPrompt multi not numbered");
  const { reminderMessage: remMsg } = await import("./src/lib/reminderMessage");
  const rmsg = remMsg("minum air", "07:00");
  if (!rmsg.includes("minum air") || (rmsg.match(/minum air/g) || []).length > 1) throw new Error(`reminderMessage bad: ${rmsg}`);
  console.log("pure detectors (mood/correction/monitor/spotify) + chunk/reminder: OK");



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
  const lsofOk = await ex("lsof -iTCP -sTCP:LISTEN -P -n");
  if (lsofOk.startsWith("Error:")) throw new Error(`exec lsof -i blocked: ${lsofOk}`);
  const lsofBare = await ex("lsof");
  if (!lsofBare.startsWith("Error:")) throw new Error("exec bare lsof must be blocked");
  const psOk = await ex("ps aux");
  if (psOk.startsWith("Error:")) throw new Error(`exec ps blocked: ${psOk}`);
  const whoOk = await ex("whoami");
  if (whoOk.startsWith("Error:")) throw new Error(`exec whoami blocked: ${whoOk}`);
  for (const [bad2, why2] of [["env", "env leaks secrets"], ["tail -f package.json", "tail -f hangs"], ["sysctl -w x=1", "sysctl -w writes"], ["sed -i s/a/b/ package.json", "sed -i writes"] ] as const) {
    const r2 = await ex(bad2);
    if (!r2.startsWith("Error:")) throw new Error(`exec not guarded (${why2}): ${bad2}`);
  }
  console.log("exec: OK");
  // --- security: secret_scan detects + redacts ---
  {
    const secTmp = mkdtempSync(join(tmpdir(), "mia-sec-"));
    const prevWs = process.env.ALLOWED_WORKSPACES;
    process.env.ALLOWED_WORKSPACES = secTmp;
    try {
      writeFileSync(join(secTmp, "leak.ts"), 'const k = "AKIAIOSFODNN7EXAMPLE"; // sample');
      const { scanForSecrets } = await import("./src/lib/security");
      const r = scanForSecrets(secTmp);
      if (!r.hits.some((h) => h.type === "AWS access key")) throw new Error("secret_scan missed AWS key");
      if (JSON.stringify(r.hits).includes("AKIAIOSFODNN7EXAMPLE")) throw new Error("secret_scan leaked the secret value");
    } finally {
      if (prevWs === undefined) delete process.env.ALLOWED_WORKSPACES;
      else process.env.ALLOWED_WORKSPACES = prevWs;
      rmSync(secTmp, { recursive: true, force: true });
    }
    console.log("security secret_scan (detect + redact): OK");
  {
    const { pentestResources } = await import("./src/lib/security");
    const pr = pentestResources();
    if (!/PortSwigger/.test(pr) || !/Hack The Box/.test(pr) || !/localhost:3001/.test(pr) || !/localhost:8081/.test(pr)) {
      throw new Error("pentest_resources missing platforms/local lab URLs");
    }
    if (!/SCOPE:/.test(pr) || !/melarang otomasi|JANGAN diautomasi/.test(pr)) throw new Error("pentest_resources missing scope/ToS note");
    if (!/BUG BOUNTY/.test(pr) || !/HackerOne|Bugcrowd/.test(pr) || !/scope/i.test(pr)) throw new Error("pentest_resources missing bug-bounty guidance");
    console.log("pentest_resources (platforms + local lab + scope): OK");
  {
    const { isLabTarget, addFinding, listFindingsText, generateReport } = await import("./src/lib/security");
    if (isLabTarget("8.8.8.8") || isLabTarget("google.com") || isLabTarget("http://203.0.113.5")) throw new Error("isLabTarget allowed a public target");
    if (isLabTarget("169.254.169.254") || isLabTarget("http://169.254.169.254/latest/meta-data/")) throw new Error("isLabTarget allowed the cloud metadata endpoint");
    for (const okT of ["http://localhost:3001", "127.0.0.1", "192.168.1.10:8081", "10.0.0.5", "172.16.0.9", "scanme.nmap.org", "testphp.vulnweb.com", "http://[::1]:4010", "::1"]) {
      if (!isLabTarget(okT)) throw new Error(`isLabTarget rejected lab target ${okT}`);
    }
    const u = "verify_pentest_user";
    addFinding(u, { title: "Reflected XSS", severity: "high", cvss: 8.7, owasp: "A03:2021 Injection", cwe: "CWE-79", target: "http://localhost:3001", evidence: "?q=<script>", impact: "session theft", remediation: "encode output" });
    if (!/Reflected XSS/.test(listFindingsText(u))) throw new Error("finding_list missing entry");
    const rep = generateReport(u);
    if (!/Laporan Pentest/.test(rep) || !/HIGH/.test(rep) || !/CVSS 8\.7/.test(rep) || !/A03:2021/.test(rep)) throw new Error("report_generate malformed");
    rmSync(appRoot() + "/.data/users/" + u, { recursive: true, force: true });
    console.log("pentest scope guard + findings/report: OK");
  {
    const { passwordStrength, hashIdentify, jwtInspect, iocExtract } = await import("./src/lib/security");
    if (!/LEMAH/.test(passwordStrength("password"))) throw new Error("passwordStrength weak detection");
    if (!/SHA-256/.test(hashIdentify("hello"))) throw new Error("hashIdentify compute");
    if (!/MD5/.test(hashIdentify("d41d8cd98f00b204e9800998ecf8427e"))) throw new Error("hashIdentify type");
    const jwt = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url") + "." + Buffer.from(JSON.stringify({ sub: "1", exp: 1 })).toString("base64url") + ".x";
    const j = jwtInspect(jwt);
    if (!/alg=none/.test(j) || !/kedaluwarsa/.test(j)) throw new Error(`jwtInspect flags: ${j}`);
    const ioc = iocExtract("cek hxxp://evil[.]com dan 8.8.8.8 email a@b.com hash d41d8cd98f00b204e9800998ecf8427e");
    if (!/8\.8\.8\.8/.test(ioc) || !/evil\.com/.test(ioc) || !/a@b\.com/.test(ioc)) throw new Error(`iocExtract: ${ioc}`);
    console.log("security analysis (password/hash/JWT/IOC): OK");
  {
    const { labFetch } = await import("./src/lib/security");
    const pub = await labFetch("https://example.com");
    if (!/SCOPE/.test(pub)) throw new Error("labFetch allowed a public target");
    console.log("lab_fetch scope guard: OK");
  {
    const { webAudit } = await import("./src/lib/security");
    for (const bad of ["http://169.254.169.254/", "http://127.0.0.1:4010", "http://10.0.0.5/"]) {
      const r = await webAudit(bad);
      if (!/^Error:/.test(r)) throw new Error(`web_audit allowed internal target ${bad}: ${r.slice(0, 80)}`);
    }
    console.log("web_audit SSRF guard: OK");
  }
  {
    const { TOOLS } = await import("./src/lib/tools");
    const ec = TOOLS.find((t) => t.function.name === "engagement_create");
    if (ec?.risk !== "write") throw new Error("engagement_create must be write/confirm (grants scan permission)");
    const { assertPublicUrl } = await import("./src/lib/netGuard");
    const blockedUrls = ["http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fc00::1]/", "http://[fe80::1]/", "http://169.254.169.254/", "http://127.0.0.1:4010/", "http://10.0.0.5/", "http://192.168.1.1/", "http://foo.local/", "http://svc.internal/", "ftp://example.com/", "http://example"];
    for (const bad of blockedUrls) {
      let blocked = false;
      try { assertPublicUrl(bad); } catch { blocked = true; }
      if (!blocked) throw new Error(`netGuard allowed ${bad}`);
    }
    if (!assertPublicUrl("https://example.com/x")) throw new Error("netGuard blocked a public URL");
    console.log("netGuard SSRF guard + engagement_create risk: OK");
  }
  {
    const { cleanDomain, parseCertNames, extractParams, reconHttpx } = await import("./src/lib/recon");
    if (cleanDomain("https://Sub.Example.com:443/x") !== "sub.example.com") throw new Error("cleanDomain url/port");
    if (cleanDomain("*.example.com") !== "example.com") throw new Error("cleanDomain wildcard");
    if (cleanDomain("example.com.") !== "example.com") throw new Error("cleanDomain trailing dot");
    if (cleanDomain("not a domain") !== "") throw new Error("cleanDomain should reject");
    const certs = parseCertNames(JSON.stringify([{ name_value: "a.example.com\nb.example.com\n*.example.com" }, { common_name: "evil.com" }]), "example.com");
    if (!certs.includes("a.example.com") || !certs.includes("b.example.com") || certs.includes("evil.com") || certs.includes("example.com")) throw new Error(`parseCertNames: ${certs}`);
    const params = extractParams(["https://x.example.com/a?id=1&q=z", "https://x.example.com/b?id=2", "https://notexample.com/?evil=1"], "example.com");
    if (!params.length || params[0].name !== "id" || !params[0].interesting) throw new Error(`extractParams: ${JSON.stringify(params)}`);
    if (params.some((p) => p.name === "evil")) throw new Error("extractParams leaked a non-subdomain host (notexample.com)");
    const blocked = await reconHttpx("verify_recon_user", "google.com");
    if (!/SCOPE/.test(blocked)) throw new Error("recon_httpx allowed a public non-scoped domain");
    const { isLabTarget } = await import("./src/lib/security");
    const prevEnv = process.env.PENTEST_LAB_TARGETS;
    process.env.PENTEST_LAB_TARGETS = "mycorp.example";
    try {
      if (!isLabTarget("app.mycorp.example")) throw new Error("PENTEST_LAB_TARGETS domain must cover its subdomains");
      if (isLabTarget("notmycorp.example") || isLabTarget("mycorp.example.evil.com")) throw new Error("PENTEST_LAB_TARGETS must not match unrelated/suffix-spoof hosts");
    } finally {
      if (prevEnv === undefined) delete process.env.PENTEST_LAB_TARGETS;
      else process.env.PENTEST_LAB_TARGETS = prevEnv;
    }
    console.log("recon (subdomains/params/scope): OK");
  }
  {
    const { securityPlaybook } = await import("./src/lib/securityPlaybook");
    const list = securityPlaybook();
    if (!/Security playbooks/.test(list) || !/counterevidence/.test(list)) throw new Error("security_playbook list");
    if ((list.match(/• /g) || []).length < 70) throw new Error("security_playbook catalog too small (packs missing?)");
    if (!/methodology/.test(list) || /tidak ditemukan/.test(securityPlaybook("owasp-top-10-testing"))) throw new Error("workflow (methodology) playbooks missing");
    if (!securityPlaybook(undefined, "blind sql injection").split("\n")[0].includes("PLAYBOOK: sql-injection")) throw new Error("playbook query ranking (sql vs nosql)");
    const pack = securityPlaybook("counterevidence");
    if (!/Closure/i.test(pack)) throw new Error("security_playbook load counterevidence");
    const missing = securityPlaybook("no-such-pack");
    if (!/tidak ditemukan/i.test(missing)) throw new Error("security_playbook missing-name should list catalog");
    if (/tidak ditemukan/.test(securityPlaybook("fix-verification"))) throw new Error("playbook name normalization (hyphen vs underscore)");
    if (/tidak ditemukan/.test(securityPlaybook("source_aware_discovery"))) throw new Error("playbook name normalization (underscore)");
    const { matchTakeover } = await import("./src/lib/recon");
    if (matchTakeover("foo.github.io") !== "GitHub Pages") throw new Error("matchTakeover github");
    if (matchTakeover("d123.cloudfront.net") !== "AWS CloudFront") throw new Error("matchTakeover cloudfront");
    if (matchTakeover("example.com") !== null) throw new Error("matchTakeover should be null");
    const { sastScan } = await import("./src/lib/security");
    const sast = await sastScan("");
    if (typeof sast !== "string" || !/semgrep|SAST/i.test(sast)) throw new Error(`sastScan: ${sast.slice(0, 80)}`);
    console.log("security_playbook + takeover + sast: OK");
  }
  {
    const { setSession, listSessions, deleteSession, sessionHeaders, parseCookieString } = await import("./src/lib/httpSession");
    if (parseCookieString("sid=abc; csrf=xyz").csrf !== "xyz") throw new Error("parseCookieString pairs");
    if (parseCookieString("sid=abc; Path=/; HttpOnly").Path !== undefined || parseCookieString("sid=abc; Path=/; HttpOnly").sid !== "abc") throw new Error("parseCookieString skips attributes");
    const su = "verify_http_session";
    setSession(su, "A", { cookie: "sid=aaa; csrf=t1", headers: { Authorization: "Bearer tokA" } });
    setSession(su, "B", { cookies: { sid: "bbb" } });
    const a = sessionHeaders(su, "A");
    if (!a || a.cookie !== "sid=aaa; csrf=t1" || a.headers.Authorization !== "Bearer tokA") throw new Error(`sessionHeaders: ${JSON.stringify(a)}`);
    if (!/A/.test(listSessions(su)) || !/B/.test(listSessions(su))) throw new Error("listSessions");
    if (!deleteSession(su, "A") || deleteSession(su, "A")) throw new Error("deleteSession");
    rmSync(appRoot() + "/.data/users/" + su, { recursive: true, force: true });
    const { oastPoll } = await import("./src/lib/oast");
    if (!/Belum ada OAST/i.test(await oastPoll("verify_oast_user"))) throw new Error("oastPoll no-token path");
    const { bolaDiff } = await import("./src/lib/security");
    if (!/SCOPE/.test(await bolaDiff("verify_bola", { url: "https://google.com", sessionA: "A", sessionB: "B" }))) throw new Error("bola_diff scope guard");
    const { contentDiscover } = await import("./src/lib/recon");
    if (!/SCOPE/.test(await contentDiscover("verify_cd", "https://google.com"))) throw new Error("content_discover scope guard");
    console.log("oast + http_session + bola_diff + content_discover: OK");
  }
  {
    const { jwtAttack } = await import("./src/lib/jwt");
    const forged = jwtAttack({ action: "hs256", secret: "secret", claims: '{"role":"admin"}' });
    const tok = (forged.match(/(\S+\.\S+\.\S+)/) || [])[1] || "";
    if (!tok) throw new Error("jwt hs256 forge");
    const payload = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString()) as { role?: string };
    if (payload.role !== "admin") throw new Error("jwt claims merge");
    if (!/secret/.test(jwtAttack({ action: "crack", token: tok }))) throw new Error("jwt crack");
    if (!/none/i.test(jwtAttack({ action: "none", token: tok }))) throw new Error("jwt none");
    const { paramFuzz, classify } = await import("./src/lib/paramFuzz");
    if (!/SCOPE/.test(await paramFuzz(undefined, { url: "https://google.com/?q=1" }))) throw new Error("param_fuzz scope guard");
    const base = { status: 200, body: "hello", loc: "", ms: 10, err: false };
    if (!classify("<script>x</script>", "xss", { status: 200, body: "echo <script>x</script>", loc: "", ms: 12, err: false }, base).some((s) => /reflection/.test(s))) throw new Error("classify reflection");
    if (!classify("'", "sqli", { status: 500, body: "SQL syntax error near", loc: "", ms: 11, err: false }, base).some((s) => /SQL error/.test(s))) throw new Error("classify sql error");
    const { evidenceCapture } = await import("./src/lib/evidence");
    if (!/SCOPE/.test(await evidenceCapture("verify_ev", { url: "https://google.com" }))) throw new Error("evidence scope guard");
    rmSync(appRoot() + "/.data/users/verify_ev", { recursive: true, force: true });
    console.log("jwt_attack + param_fuzz + evidence_capture: OK");
  }
  {
    const { parseScopeText, scopeImport } = await import("./src/lib/scopeImport");
    const sc = parseScopeText("In scope\n*.example.com\napi.example.com\nOut of scope\ndocs.example.com");
    if (!sc.inScope.includes("*.example.com") || !sc.inScope.includes("api.example.com") || sc.inScope.includes("docs.example.com") || !sc.outOfScope.includes("docs.example.com")) throw new Error(`parseScopeText: ${JSON.stringify(sc)}`);
    if (!/engagement_create/.test(await scopeImport({ text: "targets: app.acme.com" }))) throw new Error("scope_import suggestion");
    if (!/Error/.test(await scopeImport({}))) throw new Error("scope_import empty input");
    const { paramDiscover } = await import("./src/lib/paramFuzz");
    if (!/SCOPE/.test(await paramDiscover(undefined, { url: "https://google.com/?a=1" }))) throw new Error("param_discover scope guard");
    const { crawlSite, reconScreenshot } = await import("./src/lib/recon");
    if (!/SCOPE/.test(await crawlSite("verify_rc", "https://google.com"))) throw new Error("crawl scope guard");
    if (!/Tidak ada host|Error/.test(await reconScreenshot("verify_rc", "example.com"))) throw new Error("recon_screenshot no-hosts path");
    console.log("scope_import + crawl + param_discover + recon_screenshot: OK");
  }
  {
    const { substituteVars, requestSave, readRequests, requestDelete } = await import("./src/lib/requests");
    if (substituteVars("{{base}}/u/{{id}}", { base: "https://x", id: "7" }) !== "https://x/u/7") throw new Error("substituteVars");
    if (substituteVars("{{unknown}}", {}) !== "{{unknown}}") throw new Error("substituteVars keeps unknown");
    const ru = "verify_req";
    requestSave(ru, "login", { method: "POST", url: "{{base}}/login", body: "u=a&p=b" });
    if (readRequests(ru).login.method !== "POST" || !requestDelete(ru, "login") || requestDelete(ru, "login")) throw new Error("request store round-trip");
    const { parseOpenApi, parsePostman, apiSpec, graphqlProbe } = await import("./src/lib/apiSpec");
    const oa = parseOpenApi({ paths: { "/users/{id}": { get: { parameters: [{ name: "id" }] }, delete: {} } } });
    if (oa.length !== 2 || oa[0].method !== "GET" || !oa[0].params.includes("id")) throw new Error(`parseOpenApi: ${JSON.stringify(oa)}`);
    const pm = parsePostman({ item: [{ item: [{ name: "x", request: { method: "POST", url: { raw: "https://x/y" } } }] }] });
    if (pm.length !== 1 || pm[0].method !== "POST") throw new Error("parsePostman");
    const spec = await apiSpec({ text: JSON.stringify({ openapi: "3.0.0", paths: { "/a": { get: {} } } }) });
    if (!/GET \/a/.test(spec)) throw new Error("api_spec text mode");
    if (!/SCOPE/.test(await graphqlProbe("https://google.com/graphql"))) throw new Error("graphql_probe scope guard");
    const { platformFromCvss, platformSeverity, scanTextSecrets } = await import("./src/lib/security");
    if (platformFromCvss(9.8).vrt !== "P1" || platformFromCvss(6.1).h1 !== "medium" || platformFromCvss(0).vrt !== "P5") throw new Error("platformFromCvss");
    if (!/HackerOne "high" · Bugcrowd VRT P2/.test(platformSeverity({ cvss: 8.1 }))) throw new Error("platformSeverity number");
    if (!/HackerOne "critical" · Bugcrowd VRT P1/.test(platformSeverity({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }))) throw new Error(`platformSeverity vector: ${platformSeverity({ vector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" })}`);
    if (!scanTextSecrets('const k="AKIAIOSFODNN7EXAMPLE"').some((h) => h.type === "AWS access key")) throw new Error("scanTextSecrets");
    const { jsMine } = await import("./src/lib/recon");
    if (!/SCOPE/.test(await jsMine("verify_js", "https://google.com/app.js"))) throw new Error("js_mine scope guard");
    rmSync(appRoot() + "/.data/users/verify_req", { recursive: true, force: true });
    console.log("requests + platform_severity + api_spec + graphql_probe + js_mine: OK");
  }
  {
    const { cveIntel } = await import("./src/lib/cveIntel");
    if (!/Error/.test(await cveIntel(""))) throw new Error("cve_intel empty query");
    const { submissionTrack } = await import("./src/lib/submissions");
    const su = "verify_subs";
    const added = submissionTrack(su, "add", { title: "Reflected XSS on /greet", severity: "medium", cvss: 6.1, platform: "bugcrowd" });
    if (!/S-/.test(added)) throw new Error("submission add");
    const dupHint = submissionTrack(su, "add", { title: "XSS reflected on /greet param", severity: "medium" });
    if (!/Mirip|duplikat/i.test(dupHint)) throw new Error("submission dedup hint");
    if (!/Submission/.test(submissionTrack(su, "list", {}))) throw new Error("submission list");
    rmSync(appRoot() + "/.data/users/" + su, { recursive: true, force: true });
    const { reconPorts, bucketEnum, reconDnsBrute } = await import("./src/lib/recon");
    if (!/SCOPE/.test(await reconPorts(undefined, "https://google.com"))) throw new Error("recon_ports scope guard");
    if (!/SCOPE/.test(await bucketEnum(undefined, "google.com"))) throw new Error("bucket_enum scope guard");
    if (!/Error/.test(await reconDnsBrute("verify_dns", "not a domain"))) throw new Error("recon_dnsbrute invalid domain");
    console.log("cve_intel + submission_track + recon_dnsbrute/ports + bucket_enum: OK");
  }
  {
    const { parseCertspotter } = await import("./src/lib/recon");
    const cs = parseCertspotter(JSON.stringify([{ dns_names: ["*.example.com", "api.example.com", "evil.com"] }]), "example.com");
    if (!cs.includes("api.example.com") || cs.includes("evil.com") || cs.includes("example.com")) throw new Error(`parseCertspotter: ${JSON.stringify(cs)}`);
    const { corsVerdict, analyzeCsp, corsAudit, cspAudit } = await import("./src/lib/security");
    if (!corsVerdict("https://evil.example", "true", "https://evil.example").some((s) => /serius/.test(s))) throw new Error("corsVerdict reflect+creds");
    if (corsVerdict(null, null, "https://evil.example").length) throw new Error("corsVerdict clean");
    if (!analyzeCsp("script-src 'unsafe-inline' *").some((s) => /unsafe-inline/.test(s))) throw new Error("analyzeCsp unsafe-inline");
    if (!analyzeCsp("").some((s) => /tidak ada/.test(s))) throw new Error("analyzeCsp missing");
    if (!/SCOPE/.test(await corsAudit("https://google.com", "verify_cors"))) throw new Error("cors_audit scope guard");
    if (!/Error/.test(await cspAudit("ftp://x"))) throw new Error("csp_audit scheme guard");
    const { recordHttp, readHttpHistory, httpHistoryText } = await import("./src/lib/httpHistory");
    const hu = "verify_http_hist";
    recordHttp(hu, { method: "GET", url: "http://x/y", status: 200, bytes: 12, ms: 3, at: new Date().toISOString() });
    if (readHttpHistory(hu).length !== 1 || !/GET/.test(httpHistoryText(hu))) throw new Error("httpHistory record");
    rmSync(appRoot() + "/.data/users/" + hu, { recursive: true, force: true });
    rmSync(appRoot() + "/.data/users/verify_cors", { recursive: true, force: true });
    console.log("certspotter + cors_audit + csp_audit + http_history: OK");
  }
  {
    const { oastDnsPoll, oastDnsStop } = await import("./src/lib/oastDns");
    if (!/Belum ada DNS-OAST/.test(await oastDnsPoll("verify_oastdns"))) throw new Error("oastDnsPoll no-state");
    if (!/Tidak ada DNS-OAST/.test(await oastDnsStop("verify_oastdns"))) throw new Error("oastDnsStop no-state");
    const { passiveSubdomains } = await import("./src/lib/recon");
    if ((await passiveSubdomains("not a domain")).length) throw new Error("passiveSubdomains should reject invalid domain");
    console.log("oast_dns (no-state) + passiveSubdomains: OK");
  }
  {
    const { rapydSign, rapydRequest } = await import("./src/lib/rapyd");
    const sig = rapydSign("get", "/v1/payments", "", "ak", "sk", "salt123", "1700000000");
    if (!/^[A-Za-z0-9+/=]+$/.test(sig) || rapydSign("get", "/v1/payments", "", "ak", "sk", "salt123", "1700000000") !== sig) throw new Error("rapydSign format/determinism");
    if (!/sandbox/i.test(await rapydRequest("verify_rapyd", { path: "/v1/payments", access_key: "a", secret_key: "b", base: "https://api.rapyd.net" }))) throw new Error("rapyd_request must refuse non-sandbox");
    if (!/wajib/i.test(await rapydRequest("verify_rapyd", { path: "/v1/payments", access_key: "", secret_key: "" }))) throw new Error("rapyd_request must require keys");
    console.log("rapyd_request (signature + sandbox guard): OK");
  }
  {
    const { takeoverBodyMatches } = await import("./src/lib/recon");
    if (!takeoverBodyMatches("GitHub Pages", "There isn't a GitHub Pages site here")) throw new Error("takeover body github");
    if (takeoverBodyMatches("GitHub Pages", "welcome to my site")) throw new Error("takeover body false positive");
    const { raceAttack, wsProbe } = await import("./src/lib/attack");
    if (!/SCOPE/.test(await raceAttack("v", { url: "https://google.com" }))) throw new Error("race scope guard");
    if (!/ws:\/\//i.test(await wsProbe("v", "https://x"))) throw new Error("ws scheme guard");
    if (!/SCOPE/.test(await wsProbe("v", "wss://google.com/ws"))) throw new Error("ws scope guard");
    console.log("race + ws_probe + takeover body: OK");
  }
  {
    const { securityHunt } = await import("./src/lib/hunt");
    if (!/SCOPE/.test(await securityHunt("v", "https://google.com"))) throw new Error("security_hunt scope guard");
    if (!/Error/.test(await securityHunt("v", "not-a-url"))) throw new Error("security_hunt url guard");
    console.log("security_hunt (scope + url guards): OK");
  }
  {
    const { toolsForUrl } = await import("./src/lib/agent");
    const groq = new Set(toolsForUrl("https://api.groq.com/openai/v1/chat/completions").map((t) => t.function.name));
    if (groq.size > 128) throw new Error(`groq tool cap exceeded (${groq.size})`);
    for (const n of ["pentest_scan", "finding_add", "report_generate", "cvss_score", "engagement_create", "recon_httpx", "sast_scan", "security_playbook", "oast_create", "oast_poll", "bola_diff", "http_session", "content_discover", "scope_import", "crawl", "param_discover", "recon_diff", "recon_screenshot", "platform_severity", "js_mine", "api_spec", "graphql_probe", "request_save", "request_run", "cve_intel", "recon_dnsbrute", "recon_ports", "bucket_enum", "submission_track", "cors_audit", "csp_audit", "http_history", "rapyd_request", "security_hunt", "race", "ws_probe", "poc_verify", "oast_dns_create", "oast_dns_poll", "oast_dns_stop"]) {
      if (!groq.has(n)) throw new Error(`capped provider missing ${n}`);
    }
    const r9 = toolsForUrl("http://127.0.0.1:20128/v1/chat/completions");
    if (r9.length > 64) throw new Error(`9router tool cap exceeded (${r9.length})`);
    console.log("provider tool caps (groq keeps pentest suite): OK");
  }
  {
    // Preserve the owner's REAL engagements.json (this test must never destroy
    // user data) — snapshot and restore around the test.
    const fs = await import("node:fs");
    const engPath = appRoot() + "/.data/engagements.json";
    const engagementsBefore = fs.existsSync(engPath) ? fs.readFileSync(engPath, "utf8") : null;
    const { createEngagement, engagementAllows, closeEngagement } = await import("./src/lib/engagement");
    const { isLabTarget, targetAllowed } = await import("./src/lib/security");
    if (isLabTarget("app.ptx.co.id")) throw new Error("public host should not be a lab target");
    const e = createEngagement({ name: "Verify Eng", client: "PT X", authorization: "PO-123", scope: ["app.ptx.co.id"] });
    if (!engagementAllows("app.ptx.co.id") || !targetAllowed("https://app.ptx.co.id/x")) throw new Error("engagement scope not honored");
    if (targetAllowed("evil.coid") || engagementAllows("sub.app.ptx.co.id") !== true) throw new Error("engagement scope match wrong");
    if (engagementAllows("ptx.co.id") || engagementAllows("co.id")) throw new Error("parent domain authorized by a subdomain-only scope (scope escalation)");
    const ew = createEngagement({ name: "Verify Wildcard", client: "PT X", authorization: "PO-W", scope: ["*.wild.example"] });
    if (!engagementAllows("app.wild.example") || !engagementAllows("wild.example") || engagementAllows("evil.example")) throw new Error("wildcard scope not honored");
    closeEngagement(ew.id);
    closeEngagement(e.id);
    if (engagementAllows("app.ptx.co.id")) throw new Error("closed engagement still allows");
    if (engagementsBefore === null) rmSync(engPath, { force: true });
    else fs.writeFileSync(engPath, engagementsBefore);
    console.log("engagement scope guard: OK");
  {
    const { parseNpmLock, parseRequirements } = await import("./src/lib/security");
    const lock = JSON.stringify({ packages: { "": { name: "x", version: "1.0.0" }, "node_modules/lodash": { version: "4.17.20" } } });
    const npm = parseNpmLock(lock);
    if (npm.length !== 1 || npm[0].name !== "lodash" || npm[0].version !== "4.17.20") throw new Error(`parseNpmLock: ${JSON.stringify(npm)}`);
    const req = parseRequirements("# c\nflask==3.0.1\nrequests>=2.0\npyyaml==6.0");
    if (req.length !== 2 || req[0].name !== "flask" || req[1].ecosystem !== "PyPI") throw new Error(`parseRequirements: ${JSON.stringify(req)}`);
    console.log("dep_audit parsers (npm/pypi): OK");
  {
    const { addFinding, resolveFinding, hardeningPlan } = await import("./src/lib/security");
    const u = "verify_plan_user";
    addFinding(u, { title: "Test XSS", severity: "high", cvss: 8.7, remediation: "encode output" });
    addFinding(u, { title: "Test SQLi", severity: "critical", cvss: 9.8, remediation: "prepared statement" });
    const done = addFinding(u, { title: "Fixed Already", severity: "low", cvss: 1.0, remediation: "n/a" });
    resolveFinding(u, done.id);
    const plan = hardeningPlan(u);
    if (!/HARDENING PLAN/.test(plan) || plan.indexOf("SQLi") > plan.indexOf("XSS") || !/prepared statement/.test(plan)) throw new Error(`hardeningPlan: ${plan.slice(0,120)}`);
    if (/Fixed Already/.test(plan)) throw new Error("hardeningPlan leaked a resolved finding");
    rmSync(appRoot() + "/.data/users/" + u, { recursive: true, force: true });
    console.log("hardening_plan (priority order): OK");
  {
    const { encoding, addFinding, generateReport } = await import("./src/lib/security");
    if (encoding("encode", "base64", "hi") !== "aGk=") throw new Error("encoding base64 encode");
    if (encoding("decode", "base64", "aGk=") !== "hi") throw new Error("encoding base64 decode");
    if (encoding("decode", "url", "a%20b") !== "a b") throw new Error("encoding url decode");
    if (encoding("encode", "hex", "A") !== "41") throw new Error("encoding hex encode");
    const u = "verify_pro_fields";
    addFinding(u, { title: "Pro finding", severity: "high", cvss: 8.1, steps: "1. buka /x 2. kirim payload", rootCause: "output tak di-escape", references: "OWASP A03", remediation: "escape" });
    const rep = generateReport(u);
    if (!/Steps to Reproduce/.test(rep) || !/Root Cause/.test(rep) || !/References/.test(rep)) throw new Error("report missing pro fields");
    rmSync(appRoot() + "/.data/users/" + u, { recursive: true, force: true });
    console.log("encoding + pro report fields: OK");
  }
  {
    const { cvssScore, severityFromCvss, splitHostPort, normalizeUrlTarget, pentestArgv, addFinding, resolveFinding, exportFindings, listFindingsText } = await import("./src/lib/security");
    if (splitHostPort("127.0.0.1:4010").host !== "127.0.0.1" || splitHostPort("127.0.0.1:4010").port !== "4010") throw new Error("splitHostPort host:port");
    if (splitHostPort("http://[::1]:8080/x").host !== "::1" || splitHostPort("http://[::1]:8080/x").port !== "8080") throw new Error("splitHostPort ipv6 url");
    if (splitHostPort("scanme.nmap.org").host !== "scanme.nmap.org" || splitHostPort("scanme.nmap.org").port !== undefined) throw new Error("splitHostPort bare host");
    if (normalizeUrlTarget("127.0.0.1:4010") !== "http://127.0.0.1:4010" || normalizeUrlTarget("example.com:443") !== "https://example.com:443" || normalizeUrlTarget("https://x/y") !== "https://x/y") throw new Error("normalizeUrlTarget");
    const nmapA = pentestArgv("nmap", "127.0.0.1:4010") || [];
    if (!nmapA.includes("-p") || !nmapA.includes("4010")) throw new Error(`pentest nmap argv: ${nmapA.join(" ")}`);
    const ffA = pentestArgv("ffuf", "127.0.0.1:4010", "/w") || [];
    if (!ffA.includes("http://127.0.0.1:4010/FUZZ")) throw new Error(`pentest ffuf argv: ${ffA.join(" ")}`);
    const goA = pentestArgv("gobuster", "example.com:443", "/w") || [];
    if (!goA.includes("https://example.com:443")) throw new Error(`pentest gobuster argv: ${goA.join(" ")}`);
    const nucA = pentestArgv("nuclei", "127.0.0.1:4010") || [];
    if (!nucA.includes("http://127.0.0.1:4010")) throw new Error(`pentest nuclei argv: ${nucA.join(" ")}`);
    if ((pentestArgv("whatweb", "host:80") || [])[0] !== "http://host:80") throw new Error("pentest whatweb argv");
    if (!/9\.8/.test(cvssScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"))) throw new Error("cvssScore AV:N should be 9.8");
    if (!/5\.3/.test(cvssScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N"))) throw new Error("cvssScore C:L should be 5.3");
    // severity must follow the CVSS band (calibration), not the caller's label
    if (severityFromCvss(6.1) !== "medium" || severityFromCvss(9.8) !== "critical" || severityFromCvss(3.1) !== "low" || severityFromCvss(0) !== "info") throw new Error("severityFromCvss bands");
    const su = "verify_sev_user";
    const f1 = addFinding(su, { title: "XSS reflected", severity: "high", cvss: 6.1, remediation: "encode" });
    if (f1.severity !== "medium" || f1.cvss !== 6.1) throw new Error(`addFinding severity must follow cvss: ${f1.severity}/${f1.cvss}`);
    const f2 = addFinding(su, { title: "No cvss", severity: "high", remediation: "x" });
    if (f2.severity !== "high" || f2.cvss !== 8.1) throw new Error(`addFinding default cvss by severity: ${f2.severity}/${f2.cvss}`);
    rmSync(appRoot() + "/.data/users/" + su, { recursive: true, force: true });
    const u = "verify_resolve_user";
    const f = addFinding(u, { title: "Tutup aku", severity: "low", remediation: "x" });
    if (!resolveFinding(u, f.id) || /Tutup aku/.test(listFindingsText(u))) throw new Error("resolveFinding failed");
    const exp = exportFindings(u, "sarif");
    if (!/Tidak ada temuan terbuka|sarif/.test(exp)) throw new Error(`exportFindings empty: ${exp}`);
    rmSync(appRoot() + "/.data/users/" + u, { recursive: true, force: true });
    console.log("cvss_score + resolve + export: OK");
  {
    const { parseNpmLock, verifyPatch, addFinding, parseDepFinding } = await import("./src/lib/security");
    const { repoRoot: rr } = await import("./src/lib/users");
    const deps = parseNpmLock(readFileSync(join(rr(), "package-lock.json"), "utf8"));
    const d = deps.find((x) => x.name === "undici") || deps[0];
    if (!d) throw new Error("no deps in lock");
    if (parseDepFinding({ target: `npm:${d.name}@1.2.3`, remediation: "Upgrade ke >= 2.0.0" } as never)?.fixed !== "2.0.0") throw new Error("parseDepFinding fixed");
    const u = "verify_patch_user";
    addFinding(u, { title: "Dep X", severity: "medium", owasp: "A06:2021 Vulnerable and Outdated Components", target: `npm:${d.name}@${d.version}`, evidence: "GHSA-x", remediation: "Upgrade ke >= 0.0.1" });
    const out = verifyPatch(u, "", false);
    if (!/Sudah >= fixed/.test(out)) throw new Error(`verifyPatch should mark patched: ${out.slice(0,140)}`);
    const resolved = verifyPatch(u, "", true);
    if (!/apply/.test(resolved)) throw new Error("verifyPatch apply mode missing");
    rmSync(appRoot() + "/.data/users/" + u, { recursive: true, force: true });
    console.log("verify_patch (installed vs fixed): OK");
  }
  }
  }
  }
  }
  }
  {
    const { runSecurityWatchTick } = await import("./src/lib/securityWatch");
    await runSecurityWatchTick();
    if (!existsSync(join(appRoot(), ".data", "security-watch", "state.json"))) throw new Error("security watch state not written");
    console.log("security watch (ports/certs tick): OK");
  }
  }
    const { zapScan } = await import("./src/lib/security");
    let zapRejected = false;
    try { await zapScan("https://example.com"); } catch { zapRejected = true; }
    if (!zapRejected) throw new Error("zapScan allowed a public target");
    const { sqlmapScan } = await import("./src/lib/security");
    let sqlmapRejected = false;
    try { await sqlmapScan("https://example.com/?id=1"); } catch { sqlmapRejected = true; }
    if (!sqlmapRejected) throw new Error("sqlmapScan allowed a public target");
  }
  }
  }

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
  const { addReminder: addRem, readReminders, subscribeReminders: subRem } = await import("./src/lib/reminders");
  const unsubRem = subRem(() => true); // ack: a real target received the push
  try {
    addRem("minum", Date.now() + 3600_000, rUser);
    addRem("bangun", Date.now() - 1000, rUser);
    takeDueV(rUser); // fire the past one → acked → dropped from store
    const remaining = readReminders(rUser);
    if (remaining.some((r) => r.text.includes("bangun") || r.fired)) {
      throw new Error(`fired one-shot should be dropped from store: ${JSON.stringify(remaining)}`);
    }
    const { executeTool: execToolR } = await import("./src/lib/tools");
    const rl = await execToolR({ id: "r1", name: "reminders_list", arguments: "{}" }, rUser);
    if (!rl.includes("terjadwal") || !rl.includes("minum")) throw new Error(`reminders_list scheduled: ${rl}`);
    if (rl.includes("sudah terkirim") || rl.includes("bangun")) throw new Error(`reminders_list should not show delivered: ${rl}`);
  } finally {
    unsubRem();
  }
  rmSync(join(userDataRoot(), rUser), { recursive: true, force: true });
  console.log("reminders_list: OK (scheduled listed, delivered dropped from store)");

  // --- Reminder HONEST delivery (2026-09-14): a slot with NO listener ack must
  // never be marked delivered / burned — it stays due with missedAt recorded so
  // Mia can own up ("tadi kelewat") instead of pretending the slot fired. An
  // acked slot advances normally. ---
  {
    const mmUser = `verify_remmiss_${Date.now()}`;
    const addMM = (await import("./src/lib/reminders")).addReminder;
    addMM("bangun", Date.now() - 1000, mmUser); // due with zero subscribers
    const dueM = takeDueV(mmUser); // no ack available
    if (!dueM[0] || dueM[0].text !== "bangun") throw new Error(`missed delivery should still surface: ${JSON.stringify(dueM)}`);
    const kept = readReminders(mmUser);
    const m = kept.find((r) => r.text === "bangun");
    if (!m) throw new Error("un-acked one-shot must never be silently dropped");
    if (!m.missedAt || m.delivered !== false) throw new Error(`missed slot must be recorded: ${JSON.stringify(m)}`);
    const unsubMM = subRem(() => true);
    try {
      takeDueV(mmUser); // now acked → dropped
      if (readReminders(mmUser).some((r) => r.text === "bangun")) throw new Error("acked one-shot should drop");
    } finally {
      unsubMM();
    }
    rmSync(join(userDataRoot(), mmUser), { recursive: true, force: true });
    console.log("reminder missed delivery: OK (no-ack → kept + missedAt recorded; ack → advanced)");
  }

  // --- Reminder late-delivery honesty: an acked slot replayed well after its
  // scheduled time (device off) is recorded with a gap → "TELAT", so Mia never
  // claims a late replay fired on time. ---
  {
    const lateUser = `verify_remlate_${Date.now()}`;
    const addLate = (await import("./src/lib/reminders")).addReminder;
    addLate("bangun", Date.now() - 5 * 60 * 60 * 1000, lateUser, { repeat: "daily" }); // slot 5h ago
    const unsubLate = subRem(() => true);
    try {
      takeDueV(lateUser, Date.now()); // acked at `now` ≈ slot+5h
      const after = readReminders(lateUser);
      const d = after.find((r) => r.text === "bangun");
      if (!d || !d.delivered || !d.deliveredAt || !d.lastFiredAt) {
        throw new Error(`late delivery fields missing: ${JSON.stringify(d)}`);
      }
      if (d.deliveredAt - d.lastFiredAt < 30 * 60_000) throw new Error("delivery gap should exceed 30min");
      const rlLate = await (await import("./src/lib/tools")).executeTool({ id: "r1", name: "reminders_list", arguments: "{}" }, lateUser);
      if (!rlLate.includes("TELAT") || !rlLate.includes("device off")) throw new Error(`late honesty: ${rlLate}`);
    } finally {
      unsubLate();
    }
    rmSync(join(userDataRoot(), lateUser), { recursive: true, force: true });
    console.log("reminder late delivery: OK (gap >30min → TELAT, never claims on-time)");
  }

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

  // ── auto-updater (mandiri daily self-update, no .openclaw/Clawdbot) ──
  {
    const tools = getTOOLS().map((t) => t.function.name);
    if (!tools.includes("auto_update_status") || !tools.includes("auto_update")) {
      throw new Error("auto_updater tools not registered");
    }
    const st = autoUpdateStatus();
    if (!st.includes("Auto-Update Mia") || !st.includes("Jadwal") || !st.includes("Last run")) {
      throw new Error(`autoUpdateStatus missing fields: ${st.slice(0, 80)}`);
    }
    // Disabled path must short-circuit deterministically (no git/network side effects).
    const realEnabled = process.env.AUTO_UPDATE_ENABLED;
    process.env.AUTO_UPDATE_ENABLED = "0";
    try {
      const out = await runAutoUpdate({ deliver: false });
      if (!out.includes("disabled")) throw new Error(`expected disabled, got: ${out.slice(0, 60)}`);
    } finally {
      if (realEnabled === undefined) delete process.env.AUTO_UPDATE_ENABLED;
      else process.env.AUTO_UPDATE_ENABLED = realEnabled;
    }
    // Schedule window: tick when clearly OUTSIDE the daily window must be a no-op
    // (never triggers an update). Pick hour = next hour (never the current minute).
    const jkHour = Number(
      new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", hour: "2-digit", hour12: false }).format(new Date())
    );
    process.env.AUTO_UPDATE_HOUR = String((jkHour + 1) % 24);
    process.env.AUTO_UPDATE_GRACE_MIN = "0";
    try {
      await runAutoUpdaterTick();
    } finally {
      delete process.env.AUTO_UPDATE_HOUR;
      delete process.env.AUTO_UPDATE_GRACE_MIN;
    }
    console.log("auto-updater: OK (tools registered, status fields, disabled short-circuit, tick no-op out-of-hours)");
  }
}

main().catch((err) => {
  console.error("conversation-mock: FAIL", err.message);
  process.exit(1);
});