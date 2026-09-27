import { buildSlimSystemPrompt, HINT_UNDELIVERED } from "./src/lib/agent";
const slim = buildSlimSystemPrompt("x", "discord", "http://127.0.0.1:20128/v1/chat/completions");
const i = (s: string) => slim.indexOf(s);
console.log("len(slim) =", slim.length);
for (const s of ["engagement_create", "TARGET DI LUAR SCOPE", "TOOL BUDGET"]) {
  console.log(`indexOf(${JSON.stringify(s)}) =`, i(s));
}
console.log("\nHINT_UNDELIVERED punya 'TARGET DI LUAR SCOPE'?",
  HINT_UNDELIVERED.includes("TARGET DI LUAR SCOPE"));
console.log("HINT_UNDELIVERED punya engagement_create?", HINT_UNDELIVERED.includes("engagement_create"));
const at = i("engagement_create");
if (at >= 0) console.log("\nkonteks di sekitar kemunculan pertama:\n…", slim.slice(Math.max(0, at - 260), at + 120).replace(/\n/g, " ⏎ "), "…");
