/**
 * Before/after screenshot probe for the office dashboard.
 *
 *   node apps/office-dashboard/probe-design-screenshot.mjs <outDir>
 *
 * DESIGN.md §19/§20: "a before/after screenshot inspected at the same viewport
 * size" and "source-code edits alone are not proof of visual success".
 * The probe is deterministic: fixed viewport, fixed wait, fixed file names, so
 * two runs can be compared side by side.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const OUT = process.argv[2] || "/tmp/office-design";
const URL = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";
const VIEWPORT = { width: 1440, height: 900 };

/** The dashboard is token-locked; use the same owner flow the drill uses. */
function token() {
  const env = readFileSync(
    join(import.meta.dirname, "..", "web", ".env.local"),
    "utf8",
  );
  const m = env.match(/^AUTH_TOKEN=(.*)$/m);
  if (!m) throw new Error("AUTH_TOKEN not found in apps/web/.env.local");
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/** Click without Playwright's post-click navigation wait (the dashboard keeps an SSE stream open, so that wait can hang). */
async function safeClick(page, selector) {
  /* DOM click only: page.click waits for "scheduled navigations to finish" and
     this page holds an open SSE stream, so the wait can time out after the
     click already happened and the old fallback clicked a second time. */
  await page.evaluate((s) => document.querySelector(s)?.click(), selector);
}

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const auth = token();
await page.goto(`${URL}/?token=${encodeURIComponent(auth)}`, { waitUntil: "commit" });
await page.evaluate((value) => localStorage.setItem("mia_token", value), auth);
await page.reload({ waitUntil: "commit" });
await page.waitForSelector("#modeBtn", { timeout: 20000 });
await page.waitForSelector("#chatToggle", { timeout: 20000 });
// The 3D office renders on a canvas; give it a beat to settle.
await page.waitForTimeout(2500);

await page.screenshot({ path: join(OUT, "01-office-light.png") });

// The GTA VI release billboard stands on the back lawn. The office's own
// cameras have to read it — that is the whole proof — so shoot it from the
// default room (the workspace camera the owner sees on load) and from the
// wide room.
await page.screenshot({ path: join(OUT, "01b-office-billboard-work.png") });
await page.evaluate(() => document.querySelector("#roomBar button")?.click());
await page.waitForTimeout(1600);
await page.screenshot({ path: join(OUT, "01c-office-billboard-all.png") });
await page.evaluate(() => document.querySelectorAll("#roomBar button")[1]?.click());
await page.waitForTimeout(1200);

// Dark theme (the toggle is #modeBtn; the attribute is html[data-theme]).
await safeClick(page, "#modeBtn");
await page.waitForTimeout(900);
await page.screenshot({ path: join(OUT, "02-office-dark.png") });

// Chat panel open, dark.
// Chat panel: wide screens dock it open, so only open it when it is closed.
await safeClick(page, "#modeBtn");
await page.waitForTimeout(400);
const chatOpen = await page.evaluate(() => !!document.querySelector("#chatPanel.open"));
if (!chatOpen) {
  await safeClick(page, "#chatToggle");
  await page.waitForTimeout(1200);
}
await page.screenshot({ path: join(OUT, "03-office-chat.png") });

// Constrained desktop + tablet widths (the plan asks for 1440/1280/1024/560).
for (const width of [1280, 1024]) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, `w${width}-light.png`) });
  await safeClick(page, "#modeBtn");
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(OUT, `w${width}-dark.png`) });
  await safeClick(page, "#modeBtn");
  await page.waitForTimeout(500);
}

// Narrow viewport: the chat drawer breakpoint. The chat is closed by default
// here, so open it — the panel itself is what needs inspecting.
await page.setViewportSize({ width: 560, height: 900 });
await page.waitForTimeout(900);
const narrowOpen = await page.evaluate(() => !!document.querySelector("#chatPanel.open"));
if (!narrowOpen) {
  await safeClick(page, "#chatToggle");
  await page.waitForTimeout(900);
}
await page.screenshot({ path: join(OUT, "04-office-narrow.png") });

// The Findings view (DESIGN.md §14 report surface): evidence, source,
// confidence, remediation and verification must be distinguishable.
await page.setViewportSize(VIEWPORT);
await page.waitForTimeout(800);
const findingsNav = page.locator('button[data-view="findings"]');
if (await findingsNav.count()) {
  await page.evaluate(() => document.querySelector('button[data-view="findings"]')?.click());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(OUT, "05-office-findings.png") });
} else {
  console.log("WARN: findings nav button not found — the view is missing");
}

// The Mission Control view: the counters, the agent roll-up and the task list
// must all come from the real backend.
const missionNav = page.locator('button[data-view="mission"]');
if (await missionNav.count()) {
  await page.evaluate(() => document.querySelector('button[data-view="mission"]')?.click());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(OUT, "06-office-mission.png") });
  // The same view in dark theme — that is the theme the owner reads it in.
  await safeClick(page, "#modeBtn");
  await page.waitForTimeout(900);
  await page.screenshot({ path: join(OUT, "06b-office-mission-dark.png") });
  await safeClick(page, "#modeBtn");
  await page.waitForTimeout(400);
  // The task detail overlay (information, stages, timeline).
  await page.evaluate(() => document.querySelector("#view-mission [data-mission-open]")?.click());
  await page.waitForTimeout(700);
  await page.screenshot({ path: join(OUT, "07-office-mission-detail.png") });
  await page.evaluate(() => document.querySelector("[data-mission-close]")?.click());
  await page.waitForTimeout(300);
} else {
  console.log("WARN: mission nav button not found — the view is missing");
}

await browser.close();
console.log(`screenshots -> ${OUT}`);
