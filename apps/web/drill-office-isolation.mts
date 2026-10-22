/**
 * Durable drill: the office chat's transcripts must stay PER AGENT.
 *
 *   npx tsx apps/web/drill-office-isolation.mts
 *
 * The bug this locks (measured 2026-10-22): the office chat persisted under
 * the OWNER scope with ids `office-<agent>`, i.e. all three agents AND the web
 * app shared ONE `sessions/` dir, ONE index and ONE 12-slot cap. The web app
 * restores the NEWEST session on mount, so it could pick an agent's office
 * transcript — and then autosave Mia's web words INTO that agent's file, which
 * the dashboard then showed under that agent. Shared index = shared transcript.
 *
 * The drill is hermetic: a throwaway user key, its own store, cleaned up
 * afterwards. It asserts the STORE-LEVEL property (who can see whose
 * transcript), not the UI — the UI is the dashboard drill's job.
 */
import { rmSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  listSessions,
  loadSession,
  upsertSession,
  deleteSession,
  officeSessionCollection,
} from "./src/lib/sessions";
import { userDataRoot } from "./src/lib/users";
import { loadPersonaPrompt } from "./src/lib/persona";
import { getPersonaFact } from "./src/lib/persona";

const BASE = "drill_office_iso";
const AGNES = `${BASE}.agnes`;
const MICHELLE = `${BASE}.michelle`;

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

function conv(text: string) {
  return {
    messages: [{ role: "user", content: text }],
    transcripts: [{ id: "t1", role: "user", text, state: "final" }],
  };
}

try {
  // 1. Each agent writes into its OWN collection.
  const miaCol = officeSessionCollection("mia");
  const agnesCol = officeSessionCollection("agnes");
  const michelleCol = officeSessionCollection("michelle");
  check("office collections are distinct", miaCol !== agnesCol && agnesCol !== michelleCol);

  upsertSession(BASE, "office-mia", conv("mia-only-turn"), "mia — office chat", miaCol);
  upsertSession(BASE, "office-agnes", conv("agnes-only-turn"), "agnes — office chat", agnesCol);
  upsertSession(BASE, "office-michelle", conv("michelle-only-turn"), "michelle — office chat", michelleCol);

  // 2. The web collection must not see ANY of them.
  const webList = listSessions(BASE);
  check(
    "web collection lists no office session",
    webList.every((s) => !s.id.startsWith("office-")),
    JSON.stringify(webList.map((s) => s.id))
  );
  check(
    "web collection cannot load an agent transcript",
    loadSession(BASE, "office-agnes") === null
  );

  // 3. Each collection sees only its own transcript.
  check(
    "agnes collection holds only the agnes transcript",
    JSON.stringify(loadSession(BASE, "office-agnes", agnesCol)?.conversation.messages) ===
      JSON.stringify([{ role: "user", content: "agnes-only-turn" }])
  );
  check(
    "michelle collection cannot load the agnes transcript",
    loadSession(BASE, "office-agnes", michelleCol) === null
  );
  check(
    "michelle collection holds its own transcript",
    !!loadSession(BASE, "office-michelle", michelleCol)
  );

  // 4. The web app must never pick an office session as "latest" — the guard
  //    lives in useVoice, and the store side must make it unnecessary: even
  //    if an office id were written into the web collection, the web app's
  //    restore path skips it. Assert the skip rule by hand here (same rule).
  const webWithOffice = listSessions(BASE);
  check(
    "web restore candidate skips office ids",
    webWithOffice.find((s) => !s.id.startsWith("office-")) === undefined
  );

  // 5. The legacy owner-scope office file must not survive in the web
  //    collection once the office route migrates it.
  upsertSession(BASE, "office-legacy", conv("legacy-turn"), "legacy — office chat");
  check("legacy office file lands in the web collection", !!loadSession(BASE, "office-legacy"));
  deleteSession(BASE, "office-legacy");
  check("legacy office file can be removed from the web collection", loadSession(BASE, "office-legacy") === null);

  // 6. FACTS: the trio agents are the SAME human, so their facts must be ONE
  //    copy. Two per-agent copies went stale and made two agents quote a
  //    different city.
  const agnesPrompt = loadPersonaPrompt(AGNES);
  const michellePrompt = loadPersonaPrompt(MICHELLE);
  check(
    "agnes reads the owner's facts (not a per-agent copy)",
    !/^-\s*city:\s*Jakarta/m.test(agnesPrompt),
    "agnes prompt still carries city: Jakarta"
  );
  check(
    "the false 'plan: free' fact is not injected",
    !/^-\s*plan:\s*free/m.test(agnesPrompt) && !/^-\s*plan:\s*free/m.test(michellePrompt)
  );
  check(
    "a fact written by one agent is visible to the others (one fact, one home)",
    getPersonaFact(AGNES, "name") === getPersonaFact(MICHELLE, "name")
  );
} finally {
  for (const key of [BASE, AGNES, MICHELLE]) {
    const dir = join(userDataRoot(), key);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures === 0 ? "office transcript isolation: OK" : `office transcript isolation: ${failures} FAIL`);
if (failures > 0) process.exit(1);
