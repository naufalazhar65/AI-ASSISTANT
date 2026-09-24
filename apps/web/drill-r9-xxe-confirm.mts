// LIVE drill — 9router (production Discord provider), two phases:
//   A) OOB XXE via http_request — the owner policy auto-approves http_request
//      on own-lab targets, so the model fires it in-round; interactsh must name
//      the attributed carrier p1-xxe (DNS callback proof on the 9router path).
//   B) PURE confirm-path via race_attack (write, in the 9router-64 window, NOT
//      in the owner policy) — propose → approve with a SINGLE-SHAPE top-level
//      decision call → execute → the follow-up completion must REPLAY cleanly
//      (real narration, NOT the digest fallback). This is the dual-shape fix
//      end-to-end on the production provider.
// Run under tmux (background nohup gets reaped). From REPO ROOT.
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { runAssistantTurn, toolsForUrl } = await import("./src/lib/agent");
const { executeTool } = await import("./src/lib/tools");

const USER = `verify_r9xxe_${Date.now()}`;
let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

function auditToolRuns(user: string, name: string): string[] {
  const dir = join(process.cwd(), "apps/web/.data/audit");
  if (!existsSync(dir)) return [];
  const hits: string[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".log")).sort().slice(-2)) {
    for (const l of readFileSync(join(dir, f), "utf8").split("\n")) {
      if (l.includes(`"user":"${user}"`) && l.includes(`"action":"tool:${name}"`)) hits.push(l.slice(0, 130));
    }
  }
  return hits;
}

// ── Toy surface: XML parser (Phase A) + plain POST counter (Phase B) ──
const http = await import("node:http");
let toyFetches = 0;
let raceHits = 0;
const toy = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => { body += c; });
  req.on("end", async () => {
    if (req.url?.startsWith("/api/import")) {
      const decl = /<!ENTITY\s+(\w+)\s+SYSTEM\s+"([^"]+)"/.exec(body);
      const ref = decl?.[1]; const uri = decl?.[2];
      if (decl && ref && uri && body.includes(`&${ref};`)) {
        console.log(`  [toy] entity → ${uri.slice(0, 80)}`);
        toyFetches++;
        try { const r = await fetch(uri, { signal: AbortSignal.timeout(6000) }); await r.text().catch(() => {}); body = body.replace(`&${ref};`, "[resolved]"); }
        catch (e) { body = body.replace(`&${ref};`, "[x]"); console.log(`  [toy] failed: ${String(e).slice(0, 60)}`); }
      } else {
        // Phase B race volley lands here too (the model follows the URL named
        // in Phase A) — a POST without an XXE entity is a race hit.
        raceHits++;
      }
      res.writeHead(200, { "content-type": "application/xml" }); res.end(`<r><status>ok</status></r>`); return;
    }
    raceHits++;
    res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
  });
});
await new Promise<void>((r) => toy.listen(0, "127.0.0.1", () => r()));
const toyBase = `http://127.0.0.1:${(toy.address() as { port: number }).port}`;

try {
  const r9 = toolsForUrl("http://127.0.0.1:20128/v1/chat/completions").map((t: { function: { name: string } }) => t.function.name);
  ok(r9.includes("http_request") && r9.includes("race_attack"), "9router-64 delivers http_request + race_attack");

  // 1) OAST domain (attributed callback)
  const created = await executeTool({ id: "o1", name: "oast_dns", arguments: JSON.stringify({ action: "create" }) }, USER);
  const dom = /domain unik:\s*(\S+)/.exec(created)?.[1] || "";
  ok(!!dom, "interactsh domain obtained", dom || "(none)");
  if (!dom) throw new Error("no OAST domain");
  const dnsCallback = `http://p1-xxe.${dom}`;

  // ── Phase A: OOB XXE via http_request (policy auto-approves own-lab) ──
  console.log("\n── A: OOB XXE via http_request (policy auto-approve) ──");
  const askA = `kirim payload XML XXE OOB dengan entity SYSTEM "${dnsCallback}/oob" ke ${toyBase}/api/import pakai http_request method=POST content_type=application/xml`;
  const ra = await runAssistantTurn({ messages: [{ role: "user", content: askA }], provider: "9router", user: USER, channel: "discord" });
  console.log("A text:", (ra.text || "").slice(0, 200));
  ok(auditToolRuns(USER, "http_request").length >= 1, "A: http_request executed (policy auto-approve or confirm)");
  ok(toyFetches >= 1, "A: toy parser resolved the OOB entity server-side", `${toyFetches} fetch(es)`);
  await new Promise((r) => setTimeout(r, 15000));
  let poll = await executeTool({ id: "o2", name: "oast_dns", arguments: JSON.stringify({ action: "poll" }) }, USER);
  if (!/p1-xxe/i.test(poll)) { await new Promise((r) => setTimeout(r, 10000)); poll = await executeTool({ id: "o2b", name: "oast_dns", arguments: JSON.stringify({ action: "poll" }) }, USER); }
  console.log(poll.split("\n").slice(0, 6).join("\n"));
  ok(/p1-xxe/i.test(poll), "A: OOB DNS callback captured with p1-xxe attribution (9router path)");

  // ── Phase B: PURE confirm-path via race_attack (write, NOT in policy) ──
  console.log("\n── B: confirm-path via race_attack (needs approval) ──");
  const askB = `uji race condition di ${toyBase}/api/import pakai race_attack dengan count=5 method=POST body=ping`;
  type Turn = Awaited<ReturnType<typeof runAssistantTurn>>;
  let r1: Turn | undefined;
  let finalAsk = askB;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ask = attempt === 1 ? askB : `${askB}. PANGGIL tool race_attack sekarang — jangan menarasikan usulannya.`;
    r1 = await runAssistantTurn({ messages: [{ role: "user", content: ask }], provider: "9router", user: USER, channel: "discord" });
    finalAsk = ask;
    const names = (r1.needsConfirmation || []).map((c) => c.name);
    console.log(`attempt ${attempt}: proposed:`, names.join(",") || "(none)", "| head:", (r1.text || "").slice(0, 110));
    if (names.includes("race_attack")) break;
  }
  const call = (r1!.needsConfirmation || []).find((c) => c.name === "race_attack");
  ok(!!call, "B: model proposed race_attack (needsConfirmation)", (r1!.text || "").slice(0, 110));
  const runsBefore = auditToolRuns(USER, "race_attack").length;
  if (!call) throw new Error("no race_attack proposal");
  console.log("B proposed args:", (call.arguments || "").slice(0, 160));

  // APPROVE — single-shape TOP-LEVEL decision + echoed message (the pre-fix
  // 400 shape). The lib must run it AND replay the follow-up cleanly.
  const t0 = Date.now();
  const r2 = await runAssistantTurn({
    messages: [
      { role: "user", content: finalAsk },
      { role: "assistant", content: null, tool_calls: [call] as never },
    ],
    provider: "9router",
    user: USER,
    channel: "discord",
    confirm_calls: [{ call, allow: true }],
  });
  console.log(`B turn done in ${Math.round((Date.now() - t0) / 1000)}s`);
  console.log("\n=== B output ===\n" + (r2.text || "").slice(0, 700));

  ok(auditToolRuns(USER, "race_attack").length > runsBefore, "B: audit tool:race_attack EXECUTED", `${auditToolRuns(USER, "race_attack").length} total`);
  ok(!(r2.needsConfirmation || []).length, "B: no pending confirmation left");
  const digest = /Aksimu sudah dijalankan|tersendat/i.test(r2.text || "");
  ok(!digest, "B: REAL narration (no digest fallback) — gateway replay accepted the canonicalized shape");
  ok(raceHits >= 3, "B: toy actually received the race volley", `${raceHits} hits`);
} finally {
  try { await executeTool({ id: "o3", name: "oast_dns", arguments: JSON.stringify({ action: "stop" }) }, USER); } catch { /* noop */ }
  toy.close();
  rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
}
console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
