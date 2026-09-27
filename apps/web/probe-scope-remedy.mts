// Two-way lock: the scope remedy must reach the CAPPED path (where the live
// 2026-09-27 dead-end happened) and the hint, and it must be ONE copy so the two
// cannot drift. Also locks that engagement_create stays honestly described as
// sometimes-undelivered rather than promised as a universal path.
import { readFileSync } from "node:fs";
for (const line of readFileSync(new URL("./.env.local", import.meta.url), "utf8").split("\n")) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!m) continue;
  const v = m[2].trim().replace(/^["']|["']$/g, "");
  if (v) process.env[m[1]] = v;
}
const { buildSlimSystemPrompt, CORE_TOOL_NAMES, toolsForUrl } = await import("./src/lib/agent");

let fail = 0;
const check = (ok: boolean, label: string, detail = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? "  — " + detail : ""}`);
};

// The hint is not exported, so exercise it the way production does: the tool
// budget is rendered for a CAPPED provider. Recompute the same predicate.
const slim = buildSlimSystemPrompt();
const win = toolsForUrl("http://127.0.0.1:20128/v1").map((t) => t.function.name);

console.log("── FIRE: remedy harus ada di jalur capped ──");
check(/TARGET DI LUAR SCOPE/.test(slim), "slim prompt memuat blok SCOPE_REMEDY");
check(/PENTEST_LAB_TARGETS/.test(slim) && /tidak bisa ditulis tool/.test(slim),
  "remedy menyebut env sebagai konfigurasi yang tak bisa ditulis tool");
check(/JANGAN mengulang tool yang sama/.test(slim), "remedy melarang retry tool yang sama");
check(/mau aku fokus uji bagian mana/.test(slim), "remedy melarang defleksi 'mau fokus bagian mana'");
check(/engagement_create/.test(slim) && /bila engagement_create ter-delivery/.test(slim),
  "remedy mengconditionalkan engagement_create, tidak menjanjikan");
// One copy: the remedy must be a module constant referenced by the hint, so a
// future edit to one cannot leave the other stale. Grep the source for it.
const src = readFileSync(new URL("src/lib/agent.ts", import.meta.url), "utf8");
const defs = (src.match(/const SCOPE_REMEDY\s*=/g) || []).length;
const uses = (src.match(/SCOPE_REMEDY/g) || []).length;
check(defs === 1, "SCOPE_REMEDY didefinisikan SATU kali", `defs=${defs}`);
check(uses >= 3, "SCOPE_REMEDY dipakai di >=2 jalur (prompt+hint) + definisi", `uses=${uses}`);

console.log("\n── SILENT: tidak boleh menjanjikan jalur yang tak ada ──");
check(!win.includes("engagement_create"),
  "engagement_create memang DI LUAR jendela 9router (fakta, bukan janji)");
check(CORE_TOOL_NAMES.size === 128, "CORE tetap 128", String(CORE_TOOL_NAMES.size));
// The hint must NOT claim engagement_create is available on a capped provider.
check(!/engagement_create/.test(slim.split("TOOL BUDGET")[0] || "") ||
      slim.indexOf("TARGET DI LUAR SCOPE") < slim.indexOf("engagement_create"),
  "remedy mengconditionalkan, tidak men MURNI-murNI blouse engagement_create sebagai jalur universal");

console.log(`\nPROBE_EXIT=${fail ? 1 : 0}`);
process.exit(fail ? 1 : 0);
