// LIVE drill — DNS-OAST opened end-to-end: interactsh-client sanity, then
// blind_ssrf with REAL param attribution against a toy SSRF surface that
// actually fetches the URL server-side (the DNS callback must name p0-url).
// Run from REPO ROOT (sibling-drill gotcha). tsx does not load .env.local.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}

const { executeTool } = await import("./src/lib/tools");
const { blindSsrf } = await import("./src/lib/blindSsrf");
const { targetAllowed } = await import("./src/lib/security");

const USER = `verify_oastdrill_${Date.now()}`;
let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };
const call = async (name: string, args: unknown) =>
  executeTool({ id: `x-${name}-${Math.random().toString(36).slice(2, 7)}`, name, arguments: JSON.stringify(args) }, USER);

try {
  // ── 1) DNS-OAST create via the TOOL path (spawns interactsh-client) ──
  console.log("── 1) oast_dns create ──");
  const created = await call("oast_dns", { action: "create" });
  console.log(created.split("\n").slice(0, 3).join("\n"));
  const dom = /domain unik:\s*(\S+)/.exec(created)?.[1] || "";
  ok(!!dom && /\.oast\.(pro|fun|site|online|site|pro)$/.test(dom), "interactsh domain obtained", dom || "(none)");
  if (!dom) throw new Error("no OAST domain — client not usable");

  // ── 2) DNS-callback sanity: resolve p9-sanity.<domain> via public resolver ──
  console.log("\n── 2) DNS callback sanity (dig via 8.8.8.8) ──");
  const { execFile } = await import("node:child_process");
  await new Promise<void>((res) => execFile("dig", [`p9-sanity.${dom}`, "@8.8.8.8", "+time=3", "+tries=1"], () => res()));
  await new Promise((r) => setTimeout(r, 9000)); // interactsh poll cycle ≈5s — 4s missed it
  const poll1 = await call("oast_dns", { action: "poll" });
  console.log(poll1.split("\n").slice(0, 4).join("\n"));
  ok(/p9-sanity/i.test(poll1), "DNS interaction captured (sanity subdomain visible in poll)");
  // NOTE: blind_ssrf below auto-creates its OWN client, replacing this one
  // (domain will change — one client per user, create kills previous).

  // ── 3) blind_ssrf end-to-end: toy server really fetches ?url=<canary> ──
  console.log("\n── 3) blind_ssrf (toy SSRF surface, real server-side fetch) ──");
  const http = await import("node:http");
  let fetched = 0;
  const toy = http.createServer((req, res) => {
    const u = new URL(req.url || "/", `http://127.0.0.1`);
    if (u.pathname === "/api/fetch") {
      const target = u.searchParams.get("url") || "";
      fetched++;
      if (/^https?:\/\//i.test(target)) {
        // REAL server-side fetch (DNS resolution happens — that's the OOB proof)
        fetch(target, { signal: AbortSignal.timeout(6000) }).then(async (r) => { await r.text().catch(() => {}); }).catch(() => {});
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, fetched: target ? "dispatched" : "empty" }));
      return;
    }
    res.writeHead(404); res.end("nope");
  });
  await new Promise<void>((r) => toy.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(toy.address() as { port: number }).port}`;
  ok(targetAllowed(base), "toy 127.0.0.1 passes scope (own lab)");

  const out = await blindSsrf(USER, { url: `${base}/api/fetch`, params: "url,redirect", seconds: 15 });
  console.log("\n=== blind_ssrf output ===");
  console.log(out.split("\n").slice(0, 14).join("\n"));
  console.log("=========================");
  ok(/1 probe|probes|\d+ probe terkirim/.test(out) || /probe terkirim/.test(out), "probe volley reported");
  ok(/SSRF LEADS/.test(out), "SSRF LEADS found (OOB proof)");
  ok(/param #0\s+"url"/.test(out) || /p0-url/.test(out), "param ATTRIBUTION names p0-url (not just a raw hit)");
  ok(/SINYAL OOB/.test(out), "honest signal framing (verifikasi sebelum finding_add)");
  console.log("\ntoy fetch dispatches:", fetched);

  // ── cleanup: stop the client (kills pid) + remove drill user ──
  const stopped = await call("oast_dns", { action: "stop" });
  console.log("\n" + stopped.slice(0, 80));
  toy.close();
} finally {
  rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
}
console.log(fail === 0 ? "\nDRILL DONE — all parts green" : `\nDRILL: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
