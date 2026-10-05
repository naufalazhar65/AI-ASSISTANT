import { buildSlimSystemPrompt } from "./src/lib/agent";
import { loadPersonaPrompt } from "./src/lib/persona";

const U = "naufalazhar652952";
const persona = loadPersonaPrompt(U);
const p = buildSlimSystemPrompt(U, "discord", "http://127.0.0.1:20128/v1/chat/completions");

const marks = [
  "teammate_michelle",
  "teammate_agnes",
  "trio_role",
  "You are Mia",
  "## Facts",
  "Address the user by the exact name",
  "TOOL",
];
console.log("persona chars:", persona.length, "| prompt chars:", p.length);
for (const m of marks) {
  const i = p.indexOf(m);
  console.log(`  ${JSON.stringify(m)} -> idx ${i} (${i < 0 ? "MISSING" : Math.round((i / p.length) * 100) + "%"})`);
}
const fi = p.indexOf("teammate_michelle");
if (fi >= 0) {
  console.log("\n--- context around teammate_michelle ---");
  console.log(p.slice(Math.max(0, fi - 600), fi + 300));
}
console.log("\n--- first 400 chars of prompt ---");
console.log(p.slice(0, 400));
