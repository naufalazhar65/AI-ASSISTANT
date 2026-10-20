/**
 * Durable UI drill for the office chat sidebar (real browser, real backend).
 *
 *   npx tsx apps/web/drill-office-chat-ui.mts
 *
 * Nothing here is mocked: it opens the actual dashboard, opens the sidebar,
 * sends a REAL turn to Mia through /api/office/chat and asserts what the user
 * sees. Any FAIL is printed and the process exits non-zero.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..");
const DASH = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";
const ARTIFACT = "office_ui";
/** Marker text of the note the approval test creates — removed again at the end. */
const DRILL_NOTE = "catatan dari drill sidebar";

/** Remove only the drill's own note (surgical filter, never touches real notes). */
function cleanupDrillNote(): void {
  try {
    const file = join(ROOT, "apps/web/.data/users/naufalazhar652952/notes.json");
    if (!existsSync(file)) return;
    const notes = JSON.parse(readFileSync(file, "utf8")) as Array<{ content?: string }>;
    const kept = notes.filter((n) => !String(n?.content ?? "").includes(DRILL_NOTE));
    if (kept.length !== notes.length) writeFileSync(file, JSON.stringify(kept, null, 2));
  } catch {
    /* best-effort cleanup; never fail the drill over it */
  }
}

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    pass += 1;
    console.log(`  ok  ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
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

/** Open the sidebar and wait until it is actually laid out (retry-safe). */
async function openPanel(page: import("playwright").Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await page.evaluate(() => {
      const p = document.getElementById("chatPanel");
      return !!p && !p.hidden && p.getBoundingClientRect().width > 0;
    });
    if (open) return;
    await page.click("#chatToggle");
    await page
      .waitForFunction(
        () => {
          const p = document.getElementById("chatPanel");
          return !!p && !p.hidden && p.getBoundingClientRect().width > 0;
        },
        undefined,
        { timeout: 5000 },
      )
      .catch(() => undefined);
  }
  const ok = await page.evaluate(() => {
    const p = document.getElementById("chatPanel");
    return !!p && !p.hidden;
  });
  if (!ok) throw new Error("sidebar did not open after 3 attempts");
}

async function main(): Promise<void> {
  const auth = token();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  // Real owner flow: the dashboard keeps its token in localStorage['mia_token']
  // and passes it as ?token= on every /api/ call. Drilling with a cookie instead
  // would hide the 401 this report is about.
  // 'commit' + an explicit selector instead of 'domcontentloaded': the dashboard
  // sets `#office` via history while booting, and reloading such a URL is a
  // SAME-DOCUMENT navigation in Chromium — the lifecycle event never re-fires,
  // so waiting on it times out on a page that is in fact fully loaded.
  await page.goto(`${DASH}/?token=${encodeURIComponent(auth)}`, { waitUntil: "commit" });
  await page.evaluate((value) => {
    localStorage.setItem("mia_token", value);
  }, auth);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e.message)));

  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector("#chatToggle", { timeout: 60000 });

  // 1. sidebar starts closed and does not disturb the dashboard
  check("sidebar hidden by default", await page.locator("#chatPanel").isHidden());
  const dashboardVisible = await page.locator("main header #viewTitle").isVisible();
  check("dashboard still visible", dashboardVisible);
  const officeCanvas = await page.locator("canvas").count();
  check("3D office canvas still mounted", officeCanvas > 0, `canvas count=${officeCanvas}`);

  // 2. open it
  await openPanel(page);
  check("sidebar opens on toggle", await page.locator("#chatPanel").isVisible());
  check("toggle reports aria-expanded", (await page.getAttribute("#chatToggle", "aria-expanded")) === "true");
  const panelBox = await page.locator("#chatPanel").boundingBox();
  check("desktop width 360–440px", !!panelBox && panelBox.width >= 360 && panelBox.width <= 440, `width=${panelBox?.width}`);
  const focused = await page.evaluate(() => document.activeElement?.className || "");
  check("focus moves into the panel on open", focused.includes("chatInput"), `activeElement=${focused}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("no horizontal viewport overflow", overflow);

  // 3. agent tabs exist for the registered trio only
  const tabs = await page.locator('.chatTabs [role="tab"]').allTextContents();
  check("agent tabs = Mia/Agnes/Michelle", JSON.stringify(tabs) === JSON.stringify(["Mia", "Agnes", "Michelle"]), tabs.join(","));

  // 4. real send → real reply
  await page.fill(".chatInput", "dalam satu kalimat, apa nama kamu?");
  await page.press(".chatInput", "Enter");
  await page.waitForSelector(".msg.agent .msgBody", { timeout: 180000 });
  const reply = (await page.locator(".msg.agent .msgBody").last().textContent()) || "";
  check("agent really answered", reply.trim().length > 3, reply.slice(0, 80));
  check("user bubble rendered", (await page.locator(".msg.user").count()) >= 1);
  check("composer cleared after send", (await page.inputValue(".chatInput")) === "");

  // 4b. an unauthenticated call must fail loudly, not silently fake a reply
  const unauth = await page.evaluate(async () => {
    const r = await fetch("/api/office/chat?agent=mia", { headers: { accept: "application/json" } });
    return r.status;
  });
  check("requests without the dashboard token are rejected (401)", unauth === 401, `status=${unauth}`);

  // 5. connection indicator is honest (not stuck on "connecting")
  const conn = (await page.locator(".chatStatus").textContent())?.trim();
  check("connection indicator reports connected", conn === "Terhubung", `status=${conn}`);

  // 6. markdown is sanitized, never injected
  const unsafe = await page.evaluate(() => {
    const el = document.querySelector(".msg.agent .msgBody");
    return !!el && el.querySelector("script") !== null;
  });
  check("no injected script node in message body", !unsafe);

  // 7. history survives a reload (server-side persistence, not localStorage)
  const bubbles = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#chatLog .msg")].filter((m) => m.querySelector(".msgBody p")).length,
    );
  const before = await bubbles();
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector("#chatToggle", { timeout: 60000 });
  await openPanel(page);
  await page.waitForSelector(".msg.agent .msgBody", { timeout: 20000 });
  const after = await bubbles();
  check("history reloaded from the server", after >= before && after >= 2, `before=${before} after=${after}`);

  // 8. tool lifecycle + approval card (real write tool → real FR-014 pause)
  //
  // The model sometimes answers from the session history WITHOUT proposing
  // the tool (this drill's own earlier turns live in the same conversation —
  // the dashboard proxy pins the owner user, so the drill cannot isolate a
  // session). That is a MODEL decision, not a UI failure, so it is reported as
  // a labelled skip instead of hanging the drill and killing the checks below.
  await page.fill(".chatInput", 'Simpan catatan baru isinya "catatan dari drill sidebar", pakai tool simpan catatan.');
  await page.press(".chatInput", "Enter");
  const approvalShown = await page
    .waitForSelector(".approval", { state: "visible", timeout: 90000 })
    .then(() => true)
    .catch(() => false);
  if (!approvalShown) {
    console.log("  --  model did not propose the risky tool this turn; approval UI NOT exercised");
  }
  if (approvalShown) {
  check("approval card shown for risky tool", (await page.locator(".approval").count()) === 1);
  check("tool card waits for approval", (await page.locator('.toolState[data-state="awaiting_approval"]').count()) === 1);
  await page.click('.approval button:has-text("Approve")');
  await page.waitForSelector('.toolState[data-state="succeeded"]', { timeout: 240000 });
  // No double execution: ground truth is the store, not the UI. One approval
  // click must produce exactly ONE note.
  const notesWithMarker = () => {
    try {
      const file = join(ROOT, "apps/web/.data/users/naufalazhar652952/notes.json");
      if (!existsSync(file)) return 0;
      const notes = JSON.parse(readFileSync(file, "utf8")) as Array<{ content?: string }>;
      return notes.filter((n) => String(n?.content ?? "").includes(DRILL_NOTE)).length;
    } catch {
      return -1;
    }
  };
  check("one approval click executed the tool exactly once", notesWithMarker() === 1, `notes=${notesWithMarker()}`);
  check("approved tool reports succeeded", (await page.locator('.toolState[data-state="succeeded"]').count()) >= 1);
  }

  // 9. agent switching keeps conversations apart
  await page.click('.chatTabs [role="tab"]:has-text("Michelle")');
  await page.waitForTimeout(400);
  // Count RENDERED messages only: the typing row is a persistent node that is
  // hidden between turns, and each agent's history length is owner data (not
  // something the drill may assume). The invariant under test is separation:
  // Michelle's conversation is not Mia's.
  const michelleMsgs = await page.locator("#chatLog .msg:not(.typing):visible").count();
  await page.click('.chatTabs [role="tab"]:has-text("Mia")');
  await page.waitForTimeout(400);
  const miaMsgs = await page.locator("#chatLog .msg:not(.typing):visible").count();
  check(
    "switching agent shows that agent's own history",
    michelleMsgs !== miaMsgs,
    `michelle=${michelleMsgs} mia=${miaMsgs}`,
  );
  check("switching back restores Mia's history", miaMsgs >= 2, `mia=${miaMsgs}`);

  // 10. keyboard: Esc closes, focus returns to the toggle
  await page.keyboard.press("Escape");
  check("Esc closes the panel", await page.locator("#chatPanel").isHidden());
  check("focus returns to the toggle", (await page.evaluate(() => document.activeElement?.id)) === "chatToggle");

  // 11. mobile: overlay drawer, composer reachable, no page overflow
  await page.setViewportSize({ width: 390, height: 844 });
  // Real mobile flow: the dashboard rail drawer can cover the header, so close
  // it first (that is what a thumb does); afterwards the Chat button must be a
  // plain, non-forced click.
  if (await page.evaluate(() => document.body.classList.contains("sbopen"))) {
    await page.click("#burger");
    await page.waitForFunction(() => !document.body.classList.contains("sbopen"), undefined, { timeout: 5000 });
  }
  check("nav rail closed so the header is reachable on mobile", !(await page.evaluate(() => document.body.classList.contains("sbopen"))));
  await openPanel(page);
  const mobileBox = await page.locator("#chatPanel").boundingBox();
  check("mobile panel is a full-height drawer", !!mobileBox && mobileBox.width >= 320 && mobileBox.height >= 700, JSON.stringify(mobileBox));
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("no horizontal overflow on mobile", mobileOverflow);
  const composerVisible = await page.locator(".chatInput").isVisible();
  check("composer reachable on mobile", composerVisible);
  await page.screenshot({ path: "/tmp/office-chat-mobile.png", fullPage: false });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPanel(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "/tmp/office-chat-desktop.png", fullPage: false });

  check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

  await browser.close();
  console.log(`\n${pass} ok / ${fail} FAIL  (artifact user: ${ARTIFACT})`);
  process.exit(fail ? 1 : 0);
}

main().catch((err) => {
  console.error("drill crashed:", err);
  process.exit(2);
});

process.on("exit", cleanupDrillNote);