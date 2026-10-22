/**
 * Durable drill: "cek email" must show the inbox ONCE.
 *
 * Live 2026-10-22 (owner): the office panel showed the inbox header TWICE
 * (the card's generic result line + the inbox head) and the list TWICE (the
 * card + the deterministic digest pasted into Mia's reply). Three seams are
 * proven here:
 *
 *   1. the AGENT — a card-rendering surface never receives the deterministic
 *      inbox digest and never keeps an inbox block the model pasted;
 *   2. the CARD — the card carries the inbox (subject/sender/time/snippet);
 *   3. the BROWSER — the visible panel text contains the inbox head exactly
 *      ONCE and every email item exactly once.
 *
 * Needs the real Mia (a live provider turn + the real Gmail), so this drill
 * is LOCAL — it is NOT part of CI.
 *
 * Run: npx tsx apps/web/drill-office-gmail-dedup.mts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DASH = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";
const OWNER = process.env.OFFICE_OWNER_USER || "naufalazhar652952";
const SESSION_FILE = join(ROOT, "apps/web/.data/users", OWNER, "sessions-office-mia", "office-mia.json");

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failed += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function token(): string {
  const envPath = join(ROOT, "apps/web/.env.local");
  if (!existsSync(envPath)) throw new Error("apps/web/.env.local not found (AUTH_TOKEN needed)");
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = /^AUTH_TOKEN=(.*)$/.exec(line.trim());
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("AUTH_TOKEN missing from apps/web/.env.local");
}

/** One real office turn through the dashboard proxy (the real agent + Gmail). */
async function liveTurn(auth: string): Promise<{ text: string; cards: unknown[] }> {
  const res = await fetch(`${DASH}/api/office/chat?agent=mia`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${auth}` },
    body: JSON.stringify({ agent: "mia", messages: [{ role: "user", content: "cek email" }] }),
  });
  if (!res.ok) throw new Error(`office chat returned ${res.status}`);
  const raw = await res.text();
  const frames = raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as { type?: string; text?: string; cards?: unknown[] });
  const msg = frames.find((f) => f.type === "message");
  if (!msg) throw new Error(`no message frame in: ${raw.slice(0, 400)}`);
  return { text: msg.text ?? "", cards: msg.cards ?? [] };
}

async function main(): Promise<void> {
  const auth = token();
  const sessionBackup = existsSync(SESSION_FILE) ? readFileSync(SESSION_FILE, "utf8") : null;
  try {
    console.log("live turn: cek email");
    const turn = await liveTurn(auth);

    console.log("agent seam:");
    check("the reply has no pasted inbox block", !turn.text.includes("Ringkasan Inbox"), turn.text.slice(0, 200));
    check("the reply has no deterministic inbox digest", !turn.text.includes("Email terbaru"), turn.text.slice(0, 200));
    const inboxCard = (turn.cards as { name?: string; inbox?: { count?: number } }[]).find(
      (c) => c.name === "gmail_list" && c.inbox,
    );
    check("the card carries the inbox", !!inboxCard, JSON.stringify(turn.cards).slice(0, 200));
    const expected = inboxCard?.inbox?.count ?? 0;
    check("the inbox has entries", expected > 0, `count=${expected}`);

    console.log("browser seam:");
    const browser = await chromium.launch({ args: ["--no-sandbox"] });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${DASH}/?token=${encodeURIComponent(auth)}`, { waitUntil: "commit" });
    await page.evaluate((value) => {
      localStorage.setItem("mia_token", value);
    }, auth);
    await page.reload({ waitUntil: "commit" });
    await page.waitForSelector("#chatToggle", { timeout: 60000 });
    // The chat panel is open by default on a wide screen; make sure of it.
    await page.waitForFunction(
      () => {
        const p = document.getElementById("chatPanel");
        return !!p && !p.hidden && p.getBoundingClientRect().width > 0;
      },
      undefined,
      { timeout: 20000 },
    );
    await page.waitForFunction(
      () => {
        const p = document.getElementById("chatPanel");
        return !!p && (p.innerText || "").includes("Ringkasan Inbox");
      },
      undefined,
      { timeout: 30000 },
    );
    const seen = await page.evaluate(() => {
      const panel = document.getElementById("chatPanel");
      const text = panel ? panel.innerText || "" : "";
      return {
        heads: (text.match(/Ringkasan Inbox/g) || []).length,
        items: panel ? panel.querySelectorAll(".inboxItem").length : 0,
      };
    });
    check("the visible panel shows the inbox head exactly once", seen.heads === 1, `heads=${seen.heads}`);
    check("every email appears exactly once", seen.items === expected, `items=${seen.items} expected=${expected}`);
    await browser.close();
  } finally {
    if (sessionBackup !== null) writeFileSync(SESSION_FILE, sessionBackup);
  }

  console.log(failed ? `\nFAIL ${failed} check(s)` : "\nall checks passed");
  process.exit(failed ? 1 : 0);
}

void main();
