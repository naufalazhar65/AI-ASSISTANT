// One-shot replay of the live 2026-09-25 02:11 turn (verbatim hijack) to prove
// the URL-not-prose + pentest-verb fix frees the turn: no stale-findings dump,
// work proceeds (reads run / a write prover is proposed). Run from repo root.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const envRaw = readFileSync(join(process.cwd(), "apps/web/.env.local"), "utf8");
for (const line of envRaw.split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
}
const { runAssistantTurn } = await import("./src/lib/agent");

const USER = `verify_replay_${Date.now()}`;
const ASK = "mia coba lakukan full pentest secara menyeluruh di https://6a90ef33c41c07dd3335811e--cozy-kangaroo-42f2e0.netlify.app/cek-nik dan buatkan report pdfnya";

const r = (await runAssistantTurn({
  messages: [{ role: "user", content: ASK }],
  provider: "9router",
  user: USER,
  channel: "discord",
})) as Awaited<ReturnType<typeof runAssistantTurn>>;

const text = r.text || "";
let fail = 0;
const ok = (cond: boolean, label: string, detail = "") => { console.log(`${cond ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`); if (!cond) fail++; };

ok(!/^6 temuan/.test(text.trim()), "turn NOT hijacked into the stale 6-findings dump", text.slice(0, 90).replace(/\n/g, " "));
ok(!!(r.needsConfirmation || []).length || /recon|finding_list|pentest_resources|http_request|uji|memetakan/i.test(text), "turn proceeds as work (proposal or recon narrative)");
console.log("proposed:", (r.needsConfirmation || []).map((c) => c.name).join(",") || "none");

rmSync(join(process.cwd(), "apps/web/.data/users", USER), { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
