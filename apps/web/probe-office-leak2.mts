/**
 * Decisive probe: does agent B's OUTGOING LLM REQUEST contain agent A's
 * transcript?
 *
 * The static prompt probe (probe-office-leak.mts) only looked at the prompt
 * builders. This one drives the REAL turn through a fake OpenAI-compatible
 * upstream and inspects the request body that is actually sent — the only
 * place a leak can hide.
 *
 * Hermetic: it uses a throwaway base key (leakprobe) so no real owner data is
 * written or read. The owner's real scope is never touched.
 */
import { createServer } from "node:http";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runAssistantTurn } from "./src/lib/agent";
import { appendDailyMemory } from "./src/lib/dailyMemory";
import { userDataRoot } from "./src/lib/users";

const BASE = "leakprobe";
const AGNES = `${BASE}.agnes`;
const MICHELLE = `${BASE}.michelle`;
const MARKER = "RAHASIA-LILIT-7Q2X";

const bodies: string[] = [];

const upstream = createServer((req, res) => {
  let buf = "";
  req.on("data", (d) => {
    buf += d.toString();
  });
  req.on("end", () => {
    bodies.push(buf);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write('data: {"choices":[{"delta":{"content":"siap"}}]}\n\n');
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
const port = (upstream.address() as { port: number }).port;

process.env.LLM_API_BASE = `http://127.0.0.1:${port}/v1/chat/completions`;
process.env.LLM_API_KEY = "probe-key";
process.env.LLM_MODEL = "probe-model";

async function turn(label: string, user: string, agent: "mia" | "agnes" | "michelle") {
  bodies.length = 0;
  try {
    await runAssistantTurn({
      messages: [{ role: "user", content: "apa kabar?" }],
      user,
      agent,
      channel: "text",
      provider: "9router",
    });
  } catch (e) {
    console.log(`[${label}] turn error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = bodies.join("\n");
  const inSystem = /"role":"system"[^]*?RAHASIA-LILIT-7Q2X/.test(body);
  const anywhere = body.includes(MARKER);
  console.log(`[${label}] user=${user} bodies=${bodies.length} markerAnywhere=${anywhere} markerInSystem=${inSystem}`);
  if (anywhere) {
    const idx = body.indexOf(MARKER);
    console.log(`[${label}] context: ...${body.slice(Math.max(0, idx - 160), idx + 60).replace(/\n/g, " ")}...`);
  }
  return body;
}

// 1. Seed the OWNER-scope daily memory with a marker — this is what "chatting
//    with Mia" leaves behind (Mia's agent key has no suffix, so her scope IS
//    the base scope).
appendDailyMemory(BASE, `User: ${MARKER}\nMia: ${MARKER}`);
console.log("seeded owner-scope memory for", BASE);

// 2. Control: Mia's own turn must see it (her scope = base scope).
const miaBody = await turn("mia (control)", BASE, "mia");

// 3. The real question: do the other agents see it?
const agnesBody = await turn("agnes", AGNES, "agnes");
const michelleBody = await turn("michelle", MICHELLE, "michelle");

const verdict = {
  miaControlSees: miaBody.includes(MARKER),
  agnesSees: agnesBody.includes(MARKER),
  michelleSees: michelleBody.includes(MARKER),
};
console.log("VERDICT", JSON.stringify(verdict));

upstream.close();
for (const key of [BASE, AGNES, MICHELLE]) {
  const dir = join(userDataRoot(), key);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
console.log("cleaned throwaway scopes");
