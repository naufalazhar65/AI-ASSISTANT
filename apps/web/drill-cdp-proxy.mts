// Live drill: cdp_proxy against the owner's Kohona lab in the debug Chrome.
// Opens the lab in the debugged browser, arms the mini-proxy, fires real
// in-page traffic (fetch + XHR from the page context — exactly what mining
// live traffic means), drains, and asserts: endpoints found, values stripped,
// target_brain fed. Uses the throwaway drill user; brain checked via brainBrief.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, ".env.local"), "utf8").split("\n")) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !m[1].startsWith("NEXT_PUBLIC")) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

const { cdpProxy } = await import("./src/lib/cdpProxy");
const { cdpOpen, cdpStatus } = await import("./src/lib/cdp");
const { brainBrief } = await import("./src/lib/targetBrain");

const U = "verify_cdppx_drill";
const LAB = "https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app";

let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) fail++;
};

console.log(await cdpStatus());
// 1. navigate the debugged tab to the lab (scope-gated cdp_open)
const openOut = await cdpOpen(LAB);
console.log("cdp_open:", openOut.slice(0, 120));

// 2. arm the mini-proxy for 12s
const armPromise = cdpProxy(U, { tab: "netlify", seconds: 12, brain: true });

// 3. fire REAL in-page traffic ~2s after arming (fetch + XHR, values included
//    on purpose — the proxy must strip them)
await new Promise((r) => setTimeout(r, 2000));
const { cdpEval } = await import("./src/lib/cdp");
const fire = await cdpEval("netlify", `(async () => {
  const out = [];
  try { await fetch("/api/dokumen?id=4&token=SECRETVAL", { credentials: "include" }); out.push("fetch-dokumen"); } catch (e) { out.push("fetch-err:" + e); }
  try {
    await new Promise((res, rej) => {
      const x = new XMLHttpRequest();
      x.open("POST", "/api/login?debug=1");
      x.onload = res; x.onerror = () => res(null);
      x.send(JSON.stringify({ username: "admin", password: "hunter2" }));
    });
    out.push("xhr-login");
  } catch (e) { out.push("xhr-err:" + e); }
  try { await fetch("https://cozy-kangaroo-42f2e0.netlify.app/api/cek-nik?id=1&q=RAHASIA"); out.push("fetch-ceknik"); } catch (e) { out.push("f2-err:" + e); }
  return out.join(",");
})()`, 15000);
console.log("in-page traffic:", fire.value || fire.error);

// 4. drain result
const out = await armPromise;
console.log("\n=== cdp_proxy output ===");
console.log(out);
console.log("========================\n");

ok(!/^Error:/.test(out), "no error");
ok(/\/api\/dokumen\?id( ×\d+)?/.test(out), "dokumen endpoint captured (with param name)", "");
ok(/\/api\/login/.test(out), "login endpoint captured");
ok(/\/api\/cek-nik\?id/.test(out), "cek-nik captured");
ok(!/SECRETVAL|hunter2|RAHASIA/.test(out), "VALUES NEVER appear in output");
ok(/target_brain|🧠/.test(out), "brain line present");
const brief = brainBrief(U, "cozy-kangaroo-42f2e0.netlify.app");
console.log("\n=== brain brief ===\n" + brief.split("\n").slice(0, 14).join("\n"));
ok(!/SECRETVAL|hunter2|RAHASIA/.test(brief), "brain stores names only");

// cleanup: remove drill user data (brain is under .data/users/<u>)
const { rmSync } = await import("node:fs");
const { appRoot } = await import("./src/lib/users");
rmSync(join(appRoot(), ".data", "users", U), { recursive: true, force: true });
console.log(fail === 0 ? "\nDRILL: ALL PASS" : `\nDRILL: ${fail} FAIL`);
process.exit(fail === 0 ? 0 : 1);
