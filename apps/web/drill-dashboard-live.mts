/**
 * Durable drill for the dashboard's Gemini Live proxy (real server, real HTTP).
 *
 *   npx tsx apps/web/drill-dashboard-live.mts
 *
 * Nothing here touches Google or a real Live session: the drill stands up a
 * fake Mia upstream that RECORDS the headers it receives, points the dashboard
 * proxy at it, and asserts what actually crossed the wire.
 *
 * The property under test is identity: the browser may pick WHICH of the three
 * known agents answers, and it may NOT claim to be somebody else. The proxy
 * pins `x-mia-user` / `x-mia-agent` server-side, and it uses Mia's own bearer
 * upstream so no dashboard secret leaks into Mia's routes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DASH_ENTRY = join(ROOT, "apps", "office-dashboard", "server.js");
const ENV_FILE = join(ROOT, "apps", "web", ".env.local");

const DASH_TOKEN = "drill-dashboard-token";
const OWNER = "drill-owner";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

interface Captured {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Mia's own AUTH_TOKEN — what the proxy must present upstream. */
function miaAuthToken(): string {
  if (!existsSync(ENV_FILE)) return "";
  const text = readFileSync(ENV_FILE, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = trimmed.indexOf("=");
    if (i < 0) continue;
    if (trimmed.slice(0, i).trim() === "AUTH_TOKEN") {
      return trimmed
        .slice(i + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
  return "";
}

const upstream: Captured[] = [];
let upstreamServer: Server | null = null;
let dash: ChildProcess | null = null;

function startUpstream(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        upstream.push({
          method: req.method || "",
          url: req.url || "",
          headers: Object.fromEntries(
            Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]),
          ),
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ token: "fake", results: [{ id: "1", name: "x", result: "ok" }] }));
      });
    });
    upstreamServer = server;
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });
}

async function waitForHealth(port: number): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function main(): Promise<void> {
  const upstreamPort = await startUpstream();
  const dashPort = 14000 + (upstreamPort % 1000);

  dash = spawn(process.execPath, [DASH_ENTRY], {
    env: {
      ...process.env,
      PORT: String(dashPort),
      MIA_WEB_BASE: `http://127.0.0.1:${upstreamPort}`,
      DASHBOARD_TOKEN: DASH_TOKEN,
      OFFICE_OWNER_USER: OWNER,
    },
    stdio: "ignore",
  });

  const up = await waitForHealth(dashPort);
  if (!up) throw new Error("dashboard did not come up on port " + dashPort);

  const base = `http://127.0.0.1:${dashPort}`;
  const miaToken = miaAuthToken();

  /* 1. The happy path: the agent is pinned server-side. */
  upstream.length = 0;
  const ok = await fetch(`${base}/api/gemini-live/token?agent=agnes`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${DASH_TOKEN}`,
      "content-type": "application/json",
      // The browser TRIES to claim another identity. It must not win.
      "x-mia-user": "attacker",
      "x-mia-agent": "mallory",
    },
    body: JSON.stringify({ taskHint: "halo" }),
  });
  check("proxy answers 200 for a known agent", ok.status === 200, `status=${ok.status}`);
  check("proxy forwards to Mia's live route", upstream.length === 1 && upstream[0].url.includes("/api/gemini-live/token"), JSON.stringify(upstream.map((u) => u.url)));
  const got = upstream[0];
  check("x-mia-user is pinned to the agent's own key", got?.headers["x-mia-user"] === `${OWNER}.agnes`, got?.headers["x-mia-user"]);
  check("x-mia-agent is pinned to the chosen agent", got?.headers["x-mia-agent"] === "agnes", got?.headers["x-mia-agent"]);
  check("the browser's spoofed identity never crosses the wire", !JSON.stringify(got?.headers ?? {}).includes("attacker"));
  check("upstream carries Mia's own bearer, not the dashboard token", !!got?.headers.authorization && got.headers.authorization !== `Bearer ${DASH_TOKEN}`, got?.headers.authorization);
  if (miaToken) check("upstream bearer IS Mia's AUTH_TOKEN", got?.headers.authorization === `Bearer ${miaToken}`);
  check("the request body is forwarded unchanged", got?.body.includes("taskHint"), got?.body?.slice(0, 80));

  /* 2. An unknown agent is rejected, not silently downgraded to Mia. */
  const bad = await fetch(`${base}/api/gemini-live/token?agent=mallory`, {
    method: "POST",
    headers: { authorization: `Bearer ${DASH_TOKEN}` },
    body: "{}",
  });
  check("an unknown agent is rejected", bad.status === 400, `status=${bad.status}`);
  check("a rejected agent never reaches Mia", upstream.length === 1, `upstream calls=${upstream.length}`);

  /* 3. An unknown Live sub-route is a 404, not a pass-through. */
  const nf = await fetch(`${base}/api/gemini-live/not-a-route`, {
    method: "POST",
    headers: { authorization: `Bearer ${DASH_TOKEN}` },
    body: "{}",
  });
  check("an unknown live sub-route is 404", nf.status === 404, `status=${nf.status}`);

  /* 4. The dashboard's own gate still applies — no token, no Live. */
  const noAuth = await fetch(`${base}/api/gemini-live/token?agent=mia`, {
    method: "POST",
    body: "{}",
  });
  check("an unauthenticated live call is 401", noAuth.status === 401, `status=${noAuth.status}`);

  /* 5. The bundle the dashboard loads must exist and stay browser-safe. */
  const bundle = join(ROOT, "apps", "office-dashboard", "vendor", "live.bundle.js");
  check("the committed live bundle exists", existsSync(bundle));
  if (existsSync(bundle)) {
    const src = readFileSync(bundle, "utf8");
    check("the bundle has no node builtins", !/from\s*["']node:|require\(["']node:/.test(src));
    check("the bundle publishes the MiaLive global", /var MiaLive|MiaLive\s*=/.test(src));
  }
  const liveMjs = join(ROOT, "apps", "office-dashboard", "live.mjs");
  check("the dashboard live transport exists", existsSync(liveMjs));
  if (existsSync(liveMjs)) {
    const src = readFileSync(liveMjs, "utf8");
    check("the live transport never names a user key itself", !/headers\[['"`]x-mia-user|['"`]x-mia-user['"`]\s*:/.test(src));
    check("the live transport picks the agent in the query", /agent=/.test(src));
  }
  const chatJs = join(ROOT, "apps", "office-dashboard", "chat.js");
  check("the chat panel exists", existsSync(chatJs));
  if (existsSync(chatJs)) {
    const src = readFileSync(chatJs, "utf8");
    check("the chat panel imports the live transport", /from '\.\/live\.mjs'/.test(src));
    check("the chat panel has a mic button", /chatMic/.test(src));
    check("the chat panel sends with an icon, not a word", /#i-send/.test(src) && !/textContent = 'Kirim'/.test(src));
  }
  const dashHtml = join(ROOT, "apps", "office-dashboard", "index.html");
  if (existsSync(dashHtml)) {
    const src = readFileSync(dashHtml, "utf8");
    check("Live lives inside the chat panel, not as a panel of its own", !/src="\/live\.js"|src="\/live\.mjs"|href="\/live\.css"/.test(src));
    check("the sprite carries the send and mic icons", /id="i-send"/.test(src) && /id="i-mic"/.test(src));
  }
}

main()
  .then(() => {
    console.log(failures === 0 ? "\ndashboard live proxy: OK" : `\ndashboard live proxy: ${failures} FAIL`);
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch((err) => {
    console.error("dashboard live proxy: FAIL", err?.message || err);
    process.exitCode = 1;
  })
  .finally(() => {
    try { dash?.kill(); } catch { /* already gone */ }
    try { upstreamServer?.close(); } catch { /* already gone */ }
  });
