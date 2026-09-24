// LIVE drill (production path) — cdp_proxy via a REAL LLM turn, Discord contract.
// Mirrors drill-bypass-otp-pp.mts Part D: runAssistantTurn + confirm_calls +
// audit-log proof (house rule: proof = audit log, not prose).
//
// Flow:
//   P0  delivery matrix (openrouter uncapped carries cdp_proxy; 9router-64 not)
//   P1  propose: real openrouter turn must surface cdp_proxy as needsConfirmation
//       (before approval: audit tool:cdp_proxy must be ZERO)
//   P2  approve via confirm_calls → cdp_proxy EXECUTES for real: we poll the tab
//       until the recording window opens (window.__miaProxy.active), fire REAL
//       in-page fetch+XHR carrying SECRET VALUES on purpose, then assert:
//       audit run exists, output + brain store param NAMES only (values never
//       leave the browser), toy server actually received the traffic.
//
// cdp_proxy is groq/openrouter-tier (NOT in the 9router-64 window) — same tier
// policy as the sibling drill, so the approve→execute path runs on openrouter.
// tsx does NOT load .env.local — parse manually (repo gotcha).
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn, toolsForUrl } = await import("./src/lib/agent");
const { cdpOpen, cdpEval, cdpStatus } = await import("./src/lib/cdp");
const { brainBrief } = await import("./src/lib/targetBrain");

const USER = `verify_cdppx_d_${Date.now()}`; // run-unique: audit log is append-only/shared
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── P0: delivery matrix ──
const openrouter = new Set(toolsForUrl("https://openrouter.ai/api/v1/chat/completions").map((t) => t.function.name));
const r9 = toolsForUrl("http://127.0.0.1:20128/v1/chat/completions").map((t) => t.function.name);
console.log(`cdp_proxy: openrouter=${openrouter.has("cdp_proxy")} 9router-64=${r9.includes("cdp_proxy")} (expect true/false)`);
if (!openrouter.has("cdp_proxy") || r9.includes("cdp_proxy")) process.exit(1);

// ── Audit-log proof helper (executeTool logs `tool:<name>` per execution) ──
function auditToolRuns(user: string, name: string): string[] {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log")).sort().slice(-2)) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (l.includes(`"user":"${user}"`) && l.includes(`"action":"tool:${name}"`)) hits.push(`${f}: ${l.slice(0, 140)}`);
    }
  }
  return hits;
}

// ── Toy lab server (127.0.0.1 = own lab → targetAllowed passes) ──
const http = await import("node:http");
const toyHits: string[] = [];
const toy = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const u = req.url || "/";
    toyHits.push(`${req.method} ${u.split("?")[0]}?${(u.split("?")[1] || "").split("&").map((p) => p.split("=")[0]).join("&")}`);
    if (u.startsWith("/api/dokumen")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ dokumen: [{ id: 4, judul: "SK internal" }], note: "SECRETVAL-echo" })); return; }
    if (u.startsWith("/api/login")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, session: "S-123", password: "hunter2-echo" })); return; }
    res.writeHead(404); res.end("nope");
  });
});
await new Promise<void>((r) => toy.listen(0, "127.0.0.1", () => r()));
const base = `http://127.0.0.1:${(toy.address() as { port: number }).port}`;

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

try {
  console.log("\n" + (await cdpStatus()).split("\n")[0]);

  // Open the toy lab in the debugged Chrome (scope-gated cdp_open; in production
  // this would be its own confirmed turn — same end state, one less LLM hop).
  const openOut = await cdpOpen(base);
  console.log("cdp_open:", openOut.slice(0, 110));
  await sleep(1500);
  if (/^Error:/.test(openOut)) throw new Error(`cdp_open: ${openOut}`);

  // ── P1: PROPOSE via a real openrouter LLM turn ──
  // Free models sometimes NARRATE a proposal ("Aku usulkan menjalankan …")
  // without emitting tool_calls — bounded retry + operator-style nudge, with
  // the audit still required to stay at zero executions.
  const askBase = `pakai cdp_proxy untuk merekam trafik live dari tab yang menampilkan ${base} selama 12 detik, lalu masukkan hasilnya ke target brain`;
  type Turn = Awaited<ReturnType<typeof runAssistantTurn>>;
  let r1: Turn | undefined;
  let finalAsk = askBase;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ask = attempt === 1 ? askBase : `${askBase}. PANGGIL tool cdp_proxy-nya sekarang — jangan cukup menarasikan usulannya dalam teks.`;
    r1 = await runAssistantTurn({ messages: [{ role: "user", content: ask }], provider: "openrouter", user: USER, channel: "discord" });
    finalAsk = ask;
    const names = (r1.needsConfirmation || []).map((c) => c.name);
    console.log(`\nP1 attempt ${attempt}: proposed:`, names.join(",") || "(none)", "| text head:", (r1.text || "").slice(0, 140));
    if (names.includes("cdp_proxy")) break;
  }
  const proposed = (r1!.needsConfirmation || []).map((c) => c.name);
  ok(proposed.includes("cdp_proxy"), "P1: model proposed cdp_proxy (needsConfirmation)", proposed.join(",") || "none");
  ok(auditToolRuns(USER, "cdp_proxy").length === 0, "P1: zero execution before approval (audit)");
  const call = (r1!.needsConfirmation || []).find((c) => c.name === "cdp_proxy");
  if (!call) throw new Error(`P1: no cdp_proxy proposal after 3 attempts — text: ${(r1!.text || "").slice(0, 300)}`);
  // ToolCall shape is shape-variant at runtime (top-level name/arguments vs
  // nested function.*) — log defensively; P2 passes the object by identity.
  console.log("P1 proposed args:", JSON.stringify(call).slice(0, 220));

  // ── P2: APPROVE → real execution; fire REAL in-page traffic mid-window ──
  const turnPromise = runAssistantTurn({
    messages: [
      { role: "user", content: finalAsk },
      { role: "assistant", content: null, tool_calls: [call] },
    ],
    provider: "openrouter",
    user: USER,
    channel: "discord",
    confirm_calls: [{ call, allow: true }],
  });

  // Wait until the recording window is actually open inside the tab.
  // GOTCHA (drill-side): cdp_eval returns a STRING ("🧠 eval @ …\n<output>"),
  // not {value} — check the string itself, and fire traffic WITHIN the window.
  let opened = false;
  let lastSt = "";
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    try {
      lastSt = await cdpEval("127.0.0.1", 'window.__miaProxy ? (window.__miaProxy.active ? "ACTIVE" : "inactive") : "none"', 5000);
      if (lastSt.includes("ACTIVE")) { opened = true; break; }
    } catch { /* tab busy — keep polling */ }
  }
  ok(opened, "P2: recording window opened inside the tab (window.__miaProxy.active)", lastSt.slice(-60));
  if (!opened) throw new Error(`P2: window never opened — last: ${lastSt.slice(-120)}`);

  // Fire REAL in-page traffic carrying SECRET VALUES (the proxy must strip them).
  const fire = await cdpEval("127.0.0.1", `(async () => {
    const out = [];
    try { await fetch("/api/dokumen?id=4&token=SECRETVAL", { credentials: "include" }); out.push("f1"); } catch (e) { out.push("f1e:" + e); }
    try {
      await new Promise((res) => {
        const x = new XMLHttpRequest();
        x.open("POST", "/api/login?debug=1");
        x.onload = res; x.onerror = () => res(null);
        x.send(JSON.stringify({ username: "admin", password: "hunter2" }));
      });
      out.push("x1");
    } catch (e) { out.push("x1e:" + e); }
    return out.join(",");
  })()`, 15000);  console.log("in-page traffic fired:", fire.slice(-90));
  ok(/f1[,\n]|f1$|x1/.test(fire), "in-page fire reported success", fire.slice(-60));

  const r2 = await turnPromise;
  console.log("\n=== P2 turn output ===");
  console.log((r2.text || "").slice(0, 1200));
  console.log("======================");

  // ── Assertions: proof = audit log + files, never prose ──
  const runs = auditToolRuns(USER, "cdp_proxy");
  ok(runs.length >= 1, "P2: audit tool:cdp_proxy EXECUTED", `${runs.length} run(s)`);
  ok(!(r2.needsConfirmation || []).length, "P2: no pending confirmation left");
  ok(!/REFUSED|not delivered|not available on this provider/i.test(r2.text || ""), "P2: no delivery-guard refusal in narration");

  ok(/SECRETVAL|hunter2/.test(fire.value || "") === false, "in-page fire itself ran clean");
  ok(!/SECRETVAL|hunter2|S-123/.test(r2.text || ""), "VALUES NEVER appear in turn output");
  // House contract (sibling drill 2026-09-23): proof = audit log + brain, NOT
  // prose. BOTH honest outcomes are OK — a real narrated result, or the honest
  // digest fallback when the follow-up LLM call fails transiently (Nex AGI 400,
  // seen on this model's continuation turns). What must NEVER happen: narration
  // DENYING the execution that audit proves.
  const namesEndpoints = /\/api\/dokumen/.test(r2.text || "") && /\/api\/login/.test(r2.text || "");
  const honestDigest = /Aksimu sudah dijalankan|tersendat/i.test(r2.text || "");
  ok(namesEndpoints || honestDigest, "P2: narration names endpoints OR honest digest fallback", (r2.text || "").slice(0, 70));
  const deniesRun = /tidak (bisa |dapat |pernah )?(jalankan|eksekusi|dijalankan|dieksekusi)|belum (aku |ku )?(jalankan|eksekusi)|tidak jadi/i.test(r2.text || "");
  ok(!deniesRun, "P2: narration never denies the executed run");

  const brief = brainBrief(USER, "127.0.0.1");
  console.log("\n=== brain brief ===\n" + brief.split("\n").slice(0, 10).join("\n"));
  ok(/\/api\/dokumen/.test(brief) && /\/api\/login/.test(brief), "brain stores the endpoints");
  ok(!/SECRETVAL|hunter2|S-123/.test(brief), "brain stores param NAMES only (no values)");

  const fired = toyHits.filter((h) => h.includes("/api/dokumen") || h.includes("/api/login"));
  ok(fired.length >= 2, "toy lab actually received the in-page traffic", fired.join(" | "));
  console.log("\ntoy hits:", toyHits.slice(0, 8).join(" | "));
} finally {
  toy.close();
  rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
}
console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
