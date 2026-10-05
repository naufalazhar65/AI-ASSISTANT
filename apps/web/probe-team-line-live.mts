import fs from "node:fs";
import { runAssistantTurn } from "./src/lib/agent";

// load .env.local manually (tsx does not)
for (const line of fs.readFileSync("apps/web/.env.local", "utf8").split("\n")) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const U = "naufalazhar652952";
const asks = ["kamu tau agnes?", "kamu tau Michelle?", "who is Michelle?"];
for (const q of asks.slice(0, 3)) {
  const r = await runAssistantTurn({ messages: [{ role: "user", content: q }], user: U, channel: "discord" });
  const t = (r.text || "").replace(/\s+/g, " ").trim();
  const denies = /enggak tahu|tidak tahu|nggak kenal|nggak tau|siapa (lagi|nama)|emang dia siapa/i.test(t);
  const knows = q.toLowerCase().includes("michelle") ? /michelle/i.test(t) && /coder|kode|file|test/i.test(t)
    : /agnes/i.test(t) && /riset|research|fakta|verifikasi|sumber/i.test(t);
  console.log(`Q: ${q}\nA: ${t.slice(0, 260)}\n  denies=${denies} knowsRole=${knows}\n`);
}
