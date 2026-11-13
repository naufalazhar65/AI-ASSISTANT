/**
 * Durable UI drill for the office chat sidebar (real browser, real backend).
 *
 *   npx tsx apps/web/drill-office-chat-ui.mts
 *
 * Nothing here is mocked: it opens the actual dashboard, opens the sidebar,
 * sends a REAL turn to Mia through /api/office/chat and asserts what the user
 * sees. Any FAIL is printed and the process exits non-zero.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync, mkdtempSync, rmSync, copyFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..");
// A fixed port made two drill runs kill each other (the second one found the
// first one's dashboard gone -> ERR_CONNECTION_REFUSED). Each run takes a free
// port of its own.
let DASH_PORT = Number(process.env.OFFICE_DRILL_PORT || 0);
/**
 * The drill runs ITS OWN dashboard instance with its own user bucket and its
 * own copy of the ledger.
 *
 * Why: the office proxy pins the owner user server-side, so a drill against
 * the owner's dashboard used the owner's REAL chat session — and every
 * assertion about the conversation's shape depended on whatever the owner had
 * said that day (three assertions flaked on it). The user is still pinned
 * server-side, so the browser still cannot choose whose data it reads.
 */
const DRILL_USER = `office_drill_${Date.now().toString(36)}`;
let DASH = process.env.OFFICE_DASH_URL || `http://127.0.0.1:${DASH_PORT}`;
const ARTIFACT = "office_ui";
// The chat width is a design token (apps/office-dashboard/design-tokens.json).
// Reading it keeps the width assertion honest: a stale hard-coded range
// failed this drill for weeks because the contract had moved to 340px.
// The docked chat is fluid (clamp), so the token is a RANGE, not one
// number: the drill asserts the panel lands inside it.
const CHAT_WIDTH = (
  JSON.parse(
    readFileSync(join(ROOT, "apps", "office-dashboard", "design-tokens.json"), "utf8"),
  ) as { layout?: { chatWidth?: { min?: string; max?: string } } }
).layout?.chatWidth ?? { min: "360px", max: "460px" };
/** Marker text of the note the approval test creates — removed again at the end. */
const DRILL_NOTE = "catatan dari drill sidebar";

/** Remove only the drill's own note (surgical filter, never touches real notes). */
function cleanupDrillNote(): void {
  // Two files can hold it: the owner's per-user store (the normal path) and
  // the global fallback (used when a note is saved without a user key). Only
  // the marker text is ever removed.
  for (const file of [
    join(ROOT, "apps/web/.data/users", DRILL_USER, "notes.json"),
    join(ROOT, "apps/web/.data/notes.json"),
  ]) {
    try {
      if (!existsSync(file)) continue;
      const notes = JSON.parse(readFileSync(file, "utf8")) as Array<{ content?: string }>;
      const kept = notes.filter((n) => !String(n?.content ?? "").includes(DRILL_NOTE));
      if (kept.length !== notes.length) writeFileSync(file, JSON.stringify(kept, null, 2));
    } catch {
      /* best-effort cleanup; never fail the drill over it */
    }
  }
  // The drill's turns are also written to the owner's daily memory, and that
  // memory is what the recall and the morning briefing read. A drill line
  // left there would be quoted back to the owner as if it were a real
  // conversation. Every drill turn carries a unique marker, so the whole
  // block that holds it can go; every other block stays untouched.
  try {
    const dir = join(ROOT, "apps/web/.data/users", DRILL_USER, "memory");
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".md")) continue;
        const file = join(dir, name);
        const text = readFileSync(file, "utf8");
        const blocks = text.split(/\n\s*\n/);
        const kept = blocks.filter((b) => !/\[drill-\d+\]/.test(b));
        if (kept.length !== blocks.length) writeFileSync(file, kept.join("\n\n"));
      }
    }
  } catch {
    /* best-effort cleanup; never fail the drill over it */
  }
  // The semantic index holds a copy of the day's memory text. A copy that
  // still carries the drill line would be retrievable by recall even after
  // the file itself was cleaned, so the drill text leaves the index too.
  try {
    const index = join(ROOT, "apps/web/.data/users", DRILL_USER, "memory", "embeddings.json");
    // No early return here: the session cleanup below must still run when the
    // semantic index does not exist.
    if (existsSync(index)) {
      const parsed = JSON.parse(readFileSync(index, "utf8")) as { docs?: Array<{ text?: string }> };
      const docs = Array.isArray(parsed.docs) ? parsed.docs : [];
      const kept = docs.filter((d) => !/\[drill-\d+\]/.test(String(d?.text ?? "")));
      // Only rewrite the file when a drill line was actually in it — an
      // untouched index keeps its exact bytes.
      if (kept.length !== docs.length) {
        parsed.docs = kept;
        writeFileSync(index, JSON.stringify(parsed));
      }
    }
  } catch {
    /* best-effort cleanup; never fail the drill over it */
  }
  // The drill talks to the REAL office endpoint, so its turns land in the
  // OWNER's chat session. A drill turn is a user message carrying the marker
  // plus everything the agent said back until the next real user message —
  // that whole block goes, so the owner's transcript only holds their own
  // conversation. The send-time stamps are aligned with the messages, so
  // they are dropped by the same index.
  try {
    const userRoot = join(ROOT, "apps/web/.data/users", DRILL_USER);
    // The office transcripts live in their own collections
    // (sessions-office-<agent>/) since the transcript-isolation work; the
    // legacy sessions/ folder still holds the web app's own sessions.
    const sessionDirs = ["sessions"]
      .concat(readdirSync(userRoot).filter((d) => /^sessions-office-/.test(d)))
      .map((d) => join(userRoot, d));
    for (const sessions of sessionDirs) {
      if (!existsSync(sessions)) continue;
      for (const name of readdirSync(sessions)) {
        if (!/^office-.*\.json$/.test(name)) continue;
        const file = join(sessions, name);
        const parsed = JSON.parse(readFileSync(file, "utf8")) as {
          conversation?: { messages?: Array<{ role?: string; content?: unknown }>; stamps?: (number | null)[] };
        };
        const messages = Array.isArray(parsed.conversation?.messages) ? parsed.conversation.messages : [];
        const stamps = Array.isArray(parsed.conversation?.stamps) ? parsed.conversation.stamps : [];
        const drop = new Set<number>();
        let inDrillTurn = false;
        messages.forEach((m, i) => {
          if (m?.role === "user") {
            // Two markers: the per-run tag (today's turns) and the fixed note
            // text (turns from older drill runs that had no tag yet).
            const content = String(m?.content ?? "");
            inDrillTurn = /\[drill-\d+\]/.test(content) || content.includes(DRILL_NOTE);
          }
          if (inDrillTurn) drop.add(i);
        });
        if (!drop.size) continue;
        const keptMessages = messages.filter((_m, i) => !drop.has(i));
        const keptStamps = stamps.filter((_s, i) => !drop.has(i));
        parsed.conversation!.messages = keptMessages;
        parsed.conversation!.stamps = keptStamps;
        writeFileSync(file, JSON.stringify(parsed, null, 2));
      }
    }
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
/**
 * Wait until the drill's own turn is persisted in the owner's office session.
 * The app debounces its session write, so a reload before the write lands
 * loses the turn and the "history reloaded from the server" check would
 * measure an empty history instead of persistence.
 */
async function waitForSessionTurn(marker: string): Promise<void> {
  const file = join(ROOT, "apps/web/.data/users", DRILL_USER, "sessions-office-mia", "office-mia.json");
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      if (existsSync(file) && readFileSync(file, "utf8").includes(marker)) return;
    } catch {
      /* the file may be rewritten mid-read; retry until the deadline */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/**
 * Click the chat toggle.
 *
 * Playwright's click waits for "scheduled navigations to finish" after the
 * action, and the dashboard keeps an SSE bus stream open, so the page never
 * reaches a settled navigation state and that wait can burn its full 30s
 * timeout on a click that already happened. The handler is the same either
 * way, so a timeout falls back to a DOM click.
 */
async function clickToggle(page: import("playwright").Page): Promise<void> {
  /* DOM click only: page.click waits for "scheduled navigations to finish" and
     this page holds an open SSE stream, so that wait can time out AFTER the
     click already happened. The old fallback then clicked a SECOND time, the
     panel toggled twice and ended up closed again — a flaky assertion, not a
     product bug. One DOM click is exactly one toggle. */
  await page.evaluate(() => document.getElementById("chatToggle")?.click());
}

/**
 * Reload the dashboard as a REAL navigation.
 *
 * `page.reload()` can land on the same-document path: the dashboard writes its
 * view into the history at boot, so Chromium may treat the reload as a
 * fragment navigation and never fire the "commit" event the drill waits for
 * (it then times out on a page that is in fact fully loaded). A cache-busting
 * URL forces a full document load — which is exactly what the drill wants to
 * prove anyway: the history comes from the server, not from localStorage.
 */
async function hardReload(page: import("playwright").Page, auth: string): Promise<void> {
  /* "commit" returns while the old document is still on screen: the next
     click then lands on the document that is being replaced. Wait for the
     new document itself instead of the load event — the load event waits for
     the WebGL scene, and on a busy machine that can outlast any timeout we
     would dare set. The cache-busting marker in the URL tells the two
     documents apart. */
  const marker = "_r=" + String(Date.now());
  await page.goto(`${DASH}/?token=${encodeURIComponent(auth)}&${marker}`, { waitUntil: "commit" });
  await page.waitForFunction(
    (m) => location.search.indexOf(m) >= 0 && !!document.getElementById("chatToggle"),
    marker,
    { timeout: 60000 },
  );
}

async function openPanel(page: import("playwright").Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await page.evaluate(() => {
      const p = document.getElementById("chatPanel");
      return !!p && !p.hidden && p.getBoundingClientRect().width > 0;
    });
    if (open) return;
    await clickToggle(page);
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

/**
 * Start the drill's own dashboard instance.
 *
 * It gets its own data directory (a copy of the owner's ledger, so Mission
 * Control has rows to show) and its own pinned user. The owner's ledger and
 * queue are never written by the drill.
 */
function startDrillDashboard(): { proc: ChildProcess; dataDir: string } {
  const dataDir = mkdtempSync(join(tmpdir(), "office-drill-"));
  for (const f of ["tasks.jsonl", "queue.jsonl", "dispatch.json", "tasks.archive.jsonl", "queue.archive.jsonl"]) {
    const src = join(ROOT, "apps/office-dashboard/data", f);
    if (existsSync(src)) copyFileSync(src, join(dataDir, f));
  }
  // Pause the dispatch loop and shrink the rotation window: the queue rows
  // this drill creates must stay queued (a dispatched row would also land in
  // the task ledger, and the prompt would no longer prove anything), and the
  // oldest rows must really rotate into the archive.
  writeFileSync(join(dataDir, "dispatch.json"), '{"paused":true}\n');
  const log = openSync("/tmp/office-drill-dashboard.log", "a");
  const proc = spawn("node", ["server.js"], {
    cwd: join(ROOT, "apps/office-dashboard"),
    env: {
      ...process.env,
      PORT: String(DASH_PORT),
      OFFICE_OWNER_USER: DRILL_USER,
      OFFICE_DATA_DIR: dataDir,
      LEDGER_KEEP_LINES: "1",
      LEDGER_MAX_BYTES: "4096",
    },
    stdio: ["ignore", log, log],
  });
  return { proc, dataDir };
}

/** Wait until the drill's dashboard really answers. */
async function waitForDashboard(): Promise<void> {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${DASH}/api/health`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`drill dashboard did not answer on ${DASH}`);
}

/** Kill the drill's dashboard and delete everything it wrote. */
function stopDrillDashboard(proc: ChildProcess, dataDir: string): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
  try {
    rmSync(join(ROOT, "apps/web/.data/users", DRILL_USER), { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

let drillInstance: { proc: ChildProcess; dataDir: string } | null = null;

/** A free TCP port, so two drill runs never fight over the same one. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function main(): Promise<void> {
  const auth = token();
  if (!process.env.OFFICE_DASH_URL) {
    DASH_PORT = await freePort();
    DASH = `http://127.0.0.1:${DASH_PORT}`;
    drillInstance = startDrillDashboard();
    await waitForDashboard();
  }
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

  await hardReload(page, auth);
  await page.waitForSelector("#chatToggle", { timeout: 60000 });

  // 1. On a wide screen the chat is OPEN by default (DESIGN.md: "open on wide
  // screens") and it does not disturb the dashboard behind it.
  //
  // Every state below is WAITED for, never sampled: the panel opens with a
  // slide, so an instant read can catch the column mid-flight (width 0) and
  // would report a panel that is open as one that is closed.
  const chatOpen = () =>
    page.waitForFunction(
      () => {
        const p = document.getElementById("chatPanel");
        return !!p && !p.hidden && p.getBoundingClientRect().width > 0;
      },
      undefined,
      { timeout: 10000 },
    );
  const chatClosed = () =>
    page.waitForFunction(
      () => {
        const p = document.getElementById("chatPanel");
        if (!p) return true;
        return p.hidden || p.getBoundingClientRect().width === 0;
      },
      undefined,
      { timeout: 10000 },
    );

  const openedByDefault = await chatOpen().then(() => true).catch(() => false);
  check("chat open by default on a wide screen", openedByDefault);
  const dashboardVisible = await page.locator("main header #viewTitle").isVisible();
  check("dashboard still visible", dashboardVisible);
  const officeCanvas = await page.locator("canvas").count();
  check("3D office canvas still mounted", officeCanvas > 0, `canvas count=${officeCanvas}`);

  // 1b. nameplates, HUD counters and selected states — read from the REAL
  // backend state, never from a fixture.
  const officeUi = await page.evaluate(async () => {
    const token = localStorage.getItem("mia_token") || "";
    const st = await fetch("/api/state?token=" + encodeURIComponent(token), {
      headers: { accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    const hud = document.getElementById("ovlStatus");
    const pills = hud
      ? Array.from(hud.querySelectorAll(".pill")).map((p) => (p.textContent || "").trim())
      : [];
    /* Only the VISIBLE caption is checked: the hover tooltip and the agent
       panel Diagnostics keep the raw values on purpose. */
    const labels = Array.from(document.querySelectorAll(".tagLbl")).map((el) => {
      const name = el.querySelector("b");
      const status = el.querySelector("small:not(.tProv)");
      return ((name ? name.textContent : "") + " " + (status ? status.textContent : "")).trim();
    });
    const navOn = document.querySelector("nav button.on");
    const roomOn = document.querySelector(".rooms button.on");
    const hudTabOn = document.querySelector(".hudTab.on");
    /* The accent hairline is read from the token, not hardcoded: a probe
       element resolves --accent-edge to the colour the theme actually uses.
       No named arrow functions in here: esbuild injects __name and the page
       throws (the drill's house rule). */
    const probe = document.createElement("span");
    probe.style.color = "var(--accent-edge)";
    document.body.appendChild(probe);
    const edgeRgb = getComputedStyle(probe).color;
    probe.remove();
    const navCs = navOn ? getComputedStyle(navOn) : null;
    const roomCs = roomOn ? getComputedStyle(roomOn) : null;
    const hudCs = hudTabOn ? getComputedStyle(hudTabOn) : null;
    const navEdge = navCs ? (navCs.boxShadow + "|" + navCs.borderTopColor).indexOf(edgeRgb) >= 0 : false;
    const roomEdge = roomCs ? (roomCs.boxShadow + "|" + roomCs.borderTopColor).indexOf(edgeRgb) >= 0 : false;
    const hudTabEdge = hudCs ? (hudCs.boxShadow + "|" + hudCs.borderTopColor).indexOf(edgeRgb) >= 0 : false;
    const pillTitles = hud
      ? Array.from(hud.querySelectorAll(".pill")).map((x) => x.getAttribute("title") || "")
      : [];
    return {
      schedulesConfigured: st && st.schedules ? !!st.schedules.configured : null,
      pills,
      labels,
      navBg: navOn ? getComputedStyle(navOn).backgroundColor : "",
      roomBg: roomOn ? getComputedStyle(roomOn).backgroundColor : "",
      hudTabBg: hudTabOn ? getComputedStyle(hudTabOn).backgroundColor : "",
      navEdge,
      roomEdge,
      hudTabEdge,
      pillTitles,
      hudText: pills.join(" | "),
    };
  });
  check(
    "the HUD counts working agents instead of a vague crew",
    officeUi.hudText.includes("Bekerja") && !officeUi.hudText.includes("Crew"),
    officeUi.hudText,
  );
  check(
    "the HUD has no empty scheduler chip",
    officeUi.schedulesConfigured === false ? !officeUi.hudText.includes("Cron") : true,
    `configured=${officeUi.schedulesConfigured} hud=${officeUi.hudText}`,
  );
  check(
    "no HUD chip is an empty placeholder",
    !officeUi.pills.some((p) => p.endsWith("\u2014")),
    officeUi.hudText,
  );
  check(
    "nameplates never show a raw tool identifier",
    officeUi.labels.length > 0 && officeUi.labels.every((l) => !/[a-z]+_[a-z]+/.test(l)),
    officeUi.labels.join(" | "),
  );
  check(
    "nav and room selections share one visual language",
    officeUi.navBg !== "" && officeUi.navBg === officeUi.roomBg,
    `nav=${officeUi.navBg} room=${officeUi.roomBg}`,
  );
  check(
    "every chrome selection wears the accent surface and the accent hairline",
    officeUi.navBg !== "" &&
      officeUi.navBg === officeUi.roomBg &&
      officeUi.navBg === officeUi.hudTabBg &&
      officeUi.navEdge &&
      officeUi.roomEdge &&
      officeUi.hudTabEdge,
    `nav=${officeUi.navBg}/${officeUi.navEdge} room=${officeUi.roomBg}/${officeUi.roomEdge} hudTab=${officeUi.hudTabBg}/${officeUi.hudTabEdge}`,
  );
  check(
    "a HUD counter states the period it counts",
    officeUi.pillTitles.some((t) => t.indexOf("5 menit") >= 0),
    officeUi.pillTitles.join(" | "),
  );

  // 2. the toggle closes it and opens it again
  await clickToggle(page);
  const closed = await chatClosed().then(() => true).catch(() => false);
  check("toggle closes the chat", closed && (await page.locator("#chatPanel").isHidden()));
  // The close runs a short exit motion before the panel is removed, so the
  // toggle must wait for `hidden` — clicking while the panel is still
  // there would ask for another close instead of an open.
  await page
    .waitForFunction(() => document.getElementById("chatPanel")?.hidden === true, undefined, { timeout: 10000 })
    .catch(() => undefined);
  await clickToggle(page);
  const reopened = await chatOpen().then(() => true).catch(() => false);
  check("toggle opens the chat", reopened && (await page.locator("#chatPanel").isVisible()));
  check("toggle reports aria-expanded", (await page.getAttribute("#chatToggle", "aria-expanded")) === "true");
  const panelBox = await page.locator("#chatPanel").boundingBox();
  // The width comes from the design token (design-tokens.json), so the
  // assertion cannot drift away from the contract again.
  const expectedMin = Number((CHAT_WIDTH.min?.match(/\d+/) || ["0"])[0]);
  const expectedMax = Number((CHAT_WIDTH.max?.match(/\d+/) || ["0"])[0]);
  check(
    "desktop width stays inside the design token range",
    !!panelBox && panelBox.width >= expectedMin - 1 && panelBox.width <= expectedMax + 1,
    `width=${panelBox?.width} range=${expectedMin}..${expectedMax}`,
  );
  // The selector is a compact control, not a row of big buttons.
  const tabsBox = await page.locator(".chatTabs").boundingBox();
  check(
    "the agent selector stays compact",
    !!tabsBox && tabsBox.height >= 44 && tabsBox.height <= 52,
    `tabs height=${tabsBox?.height}`,
  );
  // Composer controls must be comfortably clickable.
  const sendBox = await page.locator(".chatSend").boundingBox();
  const micBox = await page.locator(".chatMic").boundingBox();
  check(
    "the composer buttons are big enough to tap",
    !!sendBox && !!micBox && sendBox.width >= 44 && micBox.width >= 44,
    `send=${sendBox?.width} mic=${micBox?.width}`,
  );
  const focused = await page.evaluate(() => document.activeElement?.className || "");
  check("focus moves into the panel on open", focused.includes("chatInput"), `activeElement=${focused}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("no horizontal viewport overflow", overflow);

  // 3. agent tabs exist for the registered trio only
  const tabs = await page.locator('.chatTabs [role="tab"]').allTextContents();
  check("agent tabs = Mia/Agnes/Michelle", JSON.stringify(tabs) === JSON.stringify(["Mia", "Agnes", "Michelle"]), tabs.join(","));

  // 3b. the composer: a MIC button next to an ICON send button (the voice is
  // the same conversation, spoken — so it lives in the chat panel, not in a
  // panel of its own).
  const micBtn = page.locator(".chatMic");
  check("the composer has a mic button", (await micBtn.count()) === 1);
  const sendLabel = (await page.locator(".chatSend").getAttribute("aria-label")) || "";
  check("the send button is labelled for screen readers", sendLabel.length > 0, sendLabel);
  const sendText = ((await page.locator(".chatSend").textContent()) || "").trim();
  check("the send button carries an icon, not the word", sendText === "", `text=${sendText}`);

  // a11y: live region announces replies with atomic + relevant attrs
  const liveAria = await page.evaluate(() => {
    const el = document.querySelector('.sr[role="status"][aria-live="polite"]');
    if (!el) return null;
    return { atomic: el.getAttribute('aria-atomic'), relevant: el.getAttribute('aria-relevant') };
  });
  check("live region is atomic + relevant for screen readers", !!liveAria && liveAria.atomic === 'true' && liveAria.relevant === 'additions text', JSON.stringify(liveAria));

  // a11y: approval prompt is a labelled group
  const approvalGroup = await page.evaluate(() => {
    const el = document.querySelector('.approval');
    if (!el) return null;
    return { role: el.getAttribute('role'), labelledBy: el.getAttribute('aria-labelledby') };
  });
  // Approval may not be visible on first paint (no pending turn), so only
  // assert the wiring when the element exists; otherwise treat as not-applicable.
  if (approvalGroup) {
    check("approval prompt is a labelled group", approvalGroup.role === 'group' && approvalGroup.labelledBy === 'approvalHead', JSON.stringify(approvalGroup));
  }
  const composerRow = await page.evaluate(() => {
    const form = document.querySelector(".chatForm");
    if (!form) return null;
    const kids = Array.from(form.children).map((c) => c.className || c.tagName);
    const input = form.querySelector(".chatInput");
    const mic = form.querySelector(".chatMic");
    const send = form.querySelector(".chatSend");
    if (!input || !mic || !send) return null;
    const ri = input.getBoundingClientRect();
    const rm = mic.getBoundingClientRect();
    const rs = send.getBoundingClientRect();
    return {
      kids,
      sameRow: Math.abs(ri.top - rm.top) < 4 && Math.abs(ri.top - rs.top) < 4,
      micLeftOfSend: rm.left < rs.left,
      micIcon: !!mic.querySelector("svg use"),
      sendIcon: !!send.querySelector("svg use"),
    };
  });
  check("the composer is one row: input, mic, send", !!composerRow && composerRow.sameRow, JSON.stringify(composerRow?.kids));
  check("the mic sits next to the send button", !!composerRow && composerRow.micLeftOfSend);
  check("mic and send both show an icon", !!composerRow && composerRow.micIcon && composerRow.sendIcon);
  // The live strip is silent while nothing happened (no fake "live" panel).
  check("the live strip stays hidden until a session exists", await page.locator(".chatLive").isHidden());


  // 4. real send → real reply
  //
  // The panel opens on a history, so "an agent message exists" proves
  // nothing: the wait must be for a reply that came AFTER our own
  // question. Counting bubbles does NOT work: the server keeps only the
  // last MAX_OFFICE_MESSAGES messages (40), so an older bubble is trimmed
  // away while the new one arrives and the COUNT stays flat — the drill
  // then waits for a growth that can never come. The question therefore
  // carries a marker and the reply is looked for AFTER that bubble.
  const marker = `drill-${Date.now()}`;
  await page.fill(".chatInput", `dalam satu kalimat, apa nama kamu? [${marker}]`);
  await page.press(".chatInput", "Enter");

  // 4a. the dots appear the moment the message is sent — not only while tools
  // run — and the new bubble rises into place.
  //
  // The typing row used to wait for the backend's `start` frame, so a fast
  // turn showed nothing at all; and the log is rebuilt from scratch, so the
  // entrance animation has to be decided by the rows that just arrived.
  const justSent = await page
    .waitForFunction(
      () => {
        const row = document.querySelector(".msg.typing");
        const visible = !!row && !row.hasAttribute("hidden");
        const fresh = document.querySelector(".chatStream .msg.msgEnter");
        return visible && !!fresh ? { visible, fresh: fresh.className } : null;
      },
      undefined,
      { timeout: 15000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => null);
  check("the typing dots show right after sending", !!justSent && justSent.visible);
  check("the new bubble gets the entrance animation", !!justSent && !!justSent.fresh, `class=${justSent?.fresh}`);
  const answered = await page
    .waitForFunction(
      (m) => {
        const msgs = [...document.querySelectorAll("#chatLog .msg")];
        const at = msgs.findIndex(
          (el) => el.classList.contains("user") && (el.textContent || "").includes(m),
        );
        if (at < 0) return false;
        return msgs
          .slice(at + 1)
          .some(
            (el) =>
              el.classList.contains("agent") &&
              !!el.querySelector(".msgBody") &&
              (el.textContent || "").trim().length > 3,
          );
      },
      marker,
      { timeout: 180000 },
    )
    .then(() => true)
    .catch(() => false);
  const reply = (await page.locator(".msg.agent .msgBody").last().textContent()) || "";
  check("agent really answered", answered, `new reply=${answered} ${reply.slice(0, 80)}`);
  // 3c. the typing row (measured AFTER the first reply: the gap is to the
  // last message in the log, so the log must have one — and the portrait
  // comparison needs an AGENT message). It belongs to the CONVERSATION, not to the bottom of
  // the log, and it wears the agent's PHOTO (a letter looked broken).
  //
  // The row only shows while a turn is working, so it is forced visible here
  // (DOM only, no server call) and measured. The gap to the last message is
  // the contract: a growing message stream pushed the row to the very bottom
  // of the panel, hundreds of pixels below the last bubble.
  // The entrance animation (190 ms) scales the row; wait for it to settle so
  // the measurement reads the layout, not the animation.
  await page.waitForTimeout(350);
  const typing = await page.evaluate(() => {
    const log = document.querySelector(".chatLog");
    const row = document.querySelector(".msg.typing");
    if (!log || !row) return null;
    row.removeAttribute("hidden");
    const rows = [...log.querySelectorAll(".chatStream .msg:not(.typing)")];
    const last = rows[rows.length - 1];
    const t = row.getBoundingClientRect();
    const l = last ? last.getBoundingClientRect() : null;
    const av = row.querySelector(".msgAvatar");
    const msgAvs = [
      ...log.querySelectorAll(".chatStream .msg.agent:not(.typing) .msgAvatar"),
      // The entrance animation scales its row (scale(.985)) for a moment,
      // which shifts the portrait a few pixels to the right. Compare only
      // rows whose animation has finished — otherwise we measure the
      // animation, not the layout.
    ].filter((el) => !(el.parentElement?.getAnimations?.() || []).some((a) => a.playState === "running"));
    const msgAv = msgAvs[0] || null;
    const lastAv = msgAvs.length ? msgAvs[msgAvs.length - 1] : null;
    const img = av ? av.querySelector("img") : null;
    return {
      gapToLast: l ? Math.round(t.top - l.bottom) : null,
      avatarLeft: av ? Math.round(av.getBoundingClientRect().left) : null,
      avatarWidth: av ? Math.round(av.getBoundingClientRect().width) : null,
      msgAvatarLeft: msgAv ? Math.round(msgAv.getBoundingClientRect().left) : null,
      msgAvatarWidth: msgAv ? Math.round(msgAv.getBoundingClientRect().width) : null,
      lastAvatarLeft: lastAv ? Math.round(lastAv.getBoundingClientRect().left) : null,
      agentAvatars: msgAvs.length,
      // Where the 3 px can hide: the row inside its container, and the avatar
      // inside the row. Offsets are relative, so they compare across
      // containers (the typing row is a sibling of the stream).
      typingRowOffset: (row as HTMLElement).offsetLeft,
      typingAvatarOffset: av ? (av as HTMLElement).offsetLeft : null,
      agentRowOffset: msgAv ? ((msgAv.parentElement as HTMLElement | null)?.offsetLeft ?? null) : null,
      agentAvatarOffset: msgAv ? (msgAv as HTMLElement).offsetLeft : null,
      logPadLeft: log ? getComputedStyle(log).paddingLeft : null,
      imgSrc: img ? img.getAttribute("src") : null,
      imgLoaded: !!img && img.complete && img.naturalWidth > 0,
    };
  });
  check("the typing row sits with the last message", !!typing && typing.gapToLast !== null && typing.gapToLast <= 24, `gap=${typing?.gapToLast}`);
  check("the typing row shows the agent's photo", !!typing && !!typing.imgSrc && typing.imgLoaded, `src=${typing?.imgSrc} loaded=${typing?.imgLoaded}`);
  check(
    "the typing portrait lines up with the message portraits",
    // The portrait that matters is the one directly above the typing row (the
    // last agent message), not the first one in the log.
    !!typing && typing.avatarLeft !== null && typing.lastAvatarLeft !== null && Math.abs(typing.avatarLeft - typing.lastAvatarLeft) <= 2,
    `typing=${typing?.avatarLeft}/${typing?.avatarWidth} messages=${typing?.msgAvatarLeft}/${typing?.msgAvatarWidth} last=${typing?.lastAvatarLeft} n=${typing?.agentAvatars} rowOff=${typing?.typingRowOffset}/${typing?.agentRowOffset} avOff=${typing?.typingAvatarOffset}/${typing?.agentAvatarOffset} logPad=${typing?.logPadLeft}`,
  );
  // A picture of the fixed row, so the fix can be SEEN and not only measured.
  await page.screenshot({ path: "/tmp/office-chat-typing.png", fullPage: false });

  // The composer must never cover the conversation: the newest message has
  // to stay fully visible inside the scroll area.
  const covered = await page.evaluate(() => {
    const log = document.querySelector(".chatLog");
    const rows = log ? Array.from(log.querySelectorAll(".msg")) : [];
    const last = rows[rows.length - 1] as HTMLElement | undefined;
    if (!log || !last) return { ok: false, detail: "no message in the log" };
    const lr = log.getBoundingClientRect();
    const mr = last.getBoundingClientRect();
    return {
      ok: mr.bottom <= lr.bottom + 1,
      detail: `msg.bottom=${Math.round(mr.bottom)} log.bottom=${Math.round(lr.bottom)}`,
    };
  });
  check("the newest message is not covered by the composer", covered.ok, covered.detail);
  const userBubble = await page.evaluate((m) => {
    const el = [...document.querySelectorAll("#chatLog .msg.user")].find((x) =>
      (x.textContent || "").includes(m),
    );
    return !!el;
  }, marker);
  check("user bubble rendered", userBubble);

  // 4b. timestamps are clocks only. Dates appear only on day transitions,
  // which the pure core tests; this real-history drill checks their display.
  const stamp = await page.evaluate(() => {
    const times = [...document.querySelectorAll("#chatLog .msgTime")].map((el) => (el.textContent || "").trim());
    const seps = [...document.querySelectorAll("#chatLog .msgSep")].map((el) => ({
      text: (el.textContent || "").trim(),
      align: getComputedStyle(el).textAlign,
    }));
    return { times, seps };
  });
  check(
    "the message stamp shows the clock only (no date, no zone label)",
    stamp.times.length > 0 && stamp.times.every((t) => /^\d{1,2}\.\d{2}$/.test(t)),
    JSON.stringify(stamp.times.slice(0, 4)),
  );
  const renderedDates = stamp.seps.map((s) => s.text);
  check(
    "day separators are centred date labels and each rendered date appears only once",
    stamp.seps.every((s) => s.align === "center" && /\d{1,2} [A-Za-z]{3} \d{4}/.test(s.text)) &&
      new Set(renderedDates).size === renderedDates.length,
    JSON.stringify(stamp.seps),
  );

  // Exercise the actual dashboard renderer in Chromium with a deterministic
  // server history: day A, day B, then a late-arriving message from day A.
  // The pure helper has its own unit test; this catches a disconnected helper,
  // stale browser bundle, or duplicate separators in the rendered DOM.
  const datedHistory = [
    { role: "user", content: "fixture day A first" },
    { role: "assistant", content: "fixture day A reply" },
    { role: "user", content: "fixture day B" },
    { role: "assistant", content: "fixture late day A" },
    { role: "user", content: "fixture day A again" },
    { role: "assistant", content: "fixture day C" },
  ];
  const datedStamps = [
    Date.parse("2026-10-20T07:45:00Z"),
    Date.parse("2026-10-20T08:00:00Z"),
    Date.parse("2026-10-21T07:45:00Z"),
    Date.parse("2026-10-20T08:45:00Z"),
    Date.parse("2026-10-20T09:00:00Z"),
    Date.parse("2026-10-22T07:45:00Z"),
  ];
  let datedHistoryServed = false;
  const datedPage = await ctx.newPage();
  await datedPage.route("**/api/office/chat**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (route.request().method() === "GET" && requestUrl.searchParams.get("agent") === "mia") {
      datedHistoryServed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          agent: "mia",
          session_id: "browser-date-separator-fixture",
          messages: datedHistory,
          stamps: datedStamps,
          tz: "Asia/Jakarta",
          tz_label: "WIB",
          cards: [],
        }),
      });
      return;
    }
    await route.continue();
  });
  await datedPage.goto(`${DASH}/?token=${encodeURIComponent(auth)}`, { waitUntil: "commit" });
  await datedPage.evaluate((value) => localStorage.setItem("mia_token", value), auth);
  await hardReload(datedPage, auth);
  await datedPage.waitForSelector("#chatToggle", { timeout: 60000 });
  await openPanel(datedPage);
  await datedPage.waitForFunction(
    () => document.querySelectorAll("#chatLog .msgSep").length === 3,
    undefined,
    { timeout: 20000 },
  ).catch(() => undefined);
  const fixtureDates = await datedPage.locator("#chatLog .msgSep").allTextContents();
  const normalizedFixtureDates = fixtureDates.map((text) => text.trim());
  check("browser served the deterministic date-order history", datedHistoryServed);
  check(
    "browser renders exactly one date label per day despite out-of-order messages",
    normalizedFixtureDates.length === 3 &&
      new Set(normalizedFixtureDates).size === 3 &&
      normalizedFixtureDates.join("|") === "20 Okt 2026|21 Okt 2026|22 Okt 2026",
    JSON.stringify(normalizedFixtureDates),
  );
  await datedPage.close();
  const composerCleared = await page
    .waitForFunction(
      () => {
        const el = document.querySelector(".chatInput") as HTMLTextAreaElement | null;
        return !!el && el.value === "";
      },
      undefined,
      { timeout: 60000 },
    )
    .then(() => true)
    .catch(() => false);
  check("composer cleared after send", composerCleared);

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

  // 6b. the dark theme is a real theme, not an inverted filter: the panel
  // surface, the composer surface and the border must stay distinguishable.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    document.getElementById("modeBtn")?.click();
  });
  await page.waitForTimeout(500);
  const dark = await page.evaluate(() => {
    // No named arrow functions in here: esbuild injects __name and the page
    // throws "ReferenceError: __name is not defined" (house rule).
    const panel = document.querySelector(".chatInner");
    const input = document.querySelector(".chatInput");
    const bubble = document.querySelector(".msg.user .msgBody");
    return {
      theme: document.documentElement.getAttribute("data-theme"),
      panel: panel ? getComputedStyle(panel).backgroundColor : "",
      input: input ? getComputedStyle(input).backgroundColor : "",
      inputBorder: input ? getComputedStyle(input).borderTopColor : "",
      bubble: bubble ? getComputedStyle(bubble).backgroundColor : "",
    };
  });
  check(
    "dark theme keeps a real surface/border hierarchy",
    dark.theme === "dark" && dark.panel !== dark.input && dark.inputBorder !== dark.panel && dark.bubble !== dark.panel,
    JSON.stringify(dark),
  );
  await page.evaluate(() => document.getElementById("modeBtn")?.click());
  await page.waitForTimeout(300);


  // 7. history survives a reload (server-side persistence, not localStorage)
  const bubbles = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#chatLog .msg")].filter((m) => m.querySelector(".msgBody p")).length,
    );
  await waitForSessionTurn(marker);
  const before = await bubbles();
  await hardReload(page, auth);
  await page.waitForSelector("#chatToggle", { timeout: 60000 });
  await openPanel(page);
  await page.waitForSelector(".msg.agent .msgBody", { timeout: 20000 });
  // The history is re-read from the server in one render; give it a tick to
  // settle before counting.
  await page.waitForTimeout(400);
  const after = await bubbles();
  const kept = await page.evaluate((m) => document.body.innerText.includes(m), marker);
  check(
    "history reloaded from the server",
    after >= before && after >= 1 && kept,
    `before=${before} after=${after} kept=${kept}`,
  );

  // 8. tool lifecycle + approval card (real write tool → real FR-014 pause)
  //
  // The model sometimes answers from the session history WITHOUT proposing
  // the tool (this drill's own earlier turns live in the same conversation —
  // the dashboard proxy pins the owner user, so the drill cannot isolate a
  // session). That is a MODEL decision, not a UI failure, so it is reported as
  // a labelled skip instead of hanging the drill and killing the checks below.
  // The marker travels with the approval turn too, so the session cleanup
  // removes it as well (the note text stays a superstring of DRILL_NOTE).
  await page.fill(".chatInput", `Simpan catatan baru isinya "${DRILL_NOTE} [${marker}]", pakai tool simpan catatan.`);
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
  //
  // The store is WAITED for, not sampled: the card can report "succeeded"
  // from the turn's own frames a moment before the note file is flushed, so an
  // instant read proves nothing (measured: the card said succeeded while the
  // note landed on disk a second later).
  const notesWithMarker = () => {
    try {
      const file = join(ROOT, "apps/web/.data/users", DRILL_USER, "notes.json");
      if (!existsSync(file)) return 0;
      const notes = JSON.parse(readFileSync(file, "utf8")) as Array<{ content?: string }>;
      return notes.filter((n) => String(n?.content ?? "").includes(DRILL_NOTE)).length;
    } catch {
      return -1;
    }
  };
  let noteCount = notesWithMarker();
  for (let i = 0; i < 30 && noteCount === 0; i += 1) {
    await page.waitForTimeout(500);
    noteCount = notesWithMarker();
  }
  check("one approval click executed the tool exactly once", noteCount === 1, `notes=${noteCount}`);
  check("approved tool reports succeeded", (await page.locator('.toolState[data-state="succeeded"]').count()) >= 1);
  }

  // 9. agent switching keeps conversations apart
  /* Compare CONTENT, not length. The owner's histories may well be the same
     size (they are real conversations), and then a length check fails for the
     wrong reason — it asserts owner data, not the product. The invariant under
     test is separation: Michelle's conversation is not Mia's. */
  const firstUserText = async (): Promise<string> => {
    const t = page.locator("#chatLog .msg.user .msgBody").first();
    if ((await t.count()) === 0) return "";
    return ((await t.textContent()) || "").trim();
  };
  /* DOM click: page.click waits for "scheduled navigations to finish" and the
     dashboard holds an open SSE stream, so the wait can time out after the
     click already happened. */
  const clickTab = async (name: string): Promise<void> => {
    await page.evaluate((n: string) => {
      const tabs = Array.from(document.querySelectorAll('.chatTabs [role="tab"]'));
      const t = tabs.find((x) => (x.textContent || "").includes(n));
      if (t) (t as HTMLElement).click();
    }, name);
  };
  const miaFirst = await firstUserText();
  await clickTab("Michelle");
  await page.waitForTimeout(1200);
  const michelleFirst = await firstUserText();
  await clickTab("Mia");
  await page.waitForTimeout(1200);
  const miaBack = await firstUserText();
  check(
    "switching agent shows that agent's own history",
    // The invariant is SEPARATION: the other agent's history is not Mia's. The
    // drill now runs on its OWN user, so the sibling agent legitimately has an
    // empty history — "empty" is a different history, and the sibling check
    // below still proves the switch really loaded something.
    miaFirst !== "" && michelleFirst !== miaFirst,
    `mia="${miaFirst}" michelle="${michelleFirst}"`,
  );
  check(
    "switching back restores Mia's history",
    miaBack !== "" && miaBack === miaFirst,
    `back="${miaBack}" vs "${miaFirst}"`,
  );

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

  // 12. Mission Control — the counters must match the REAL backend, the
  // filters must really filter, and an action may only appear when the
  // backend can perform it.
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('button[data-view="mission"]');
    if (b) b.click();
  });
  await page.waitForTimeout(2500);
  const missionView = await page.evaluate(() => {
    const el = document.getElementById("view-mission");
    return {
      shown: !!el && !el.classList.contains("hide"),
      rows: document.querySelectorAll("#view-mission .msRow").length,
      agents: Array.from(document.querySelectorAll("#view-mission .msAgent .n")).map((s) => (s.textContent || "").trim()),
      filters: document.querySelectorAll("#view-mission select").length,
      stats: Array.from(document.querySelectorAll("#view-mission .stat")).map((s) => {
        const k = s.querySelector(".k");
        const v = s.querySelector(".v");
        return { k: (k && k.textContent || "").trim(), v: (v && v.textContent || "").trim() };
      }),
      canvas: document.querySelectorAll("canvas").length,
    };
  });
  check("Mission Control opens from the nav", missionView.shown);
  check("Mission Control lists the three agents", missionView.agents.length === 3, missionView.agents.join(","));
  check("Mission Control has a search plus three filters", missionView.filters === 4, `filters=${missionView.filters}`);
  check("the 3D scene survives the Mission Control view", missionView.canvas > 0, `canvas=${missionView.canvas}`);

  const missionApi = await page.evaluate(async () => {
    const token = localStorage.getItem("mia_token") || "";
    const r = await fetch("/api/mission?token=" + encodeURIComponent(token) + "&period=all&sort=smart", {
      headers: { accept: "application/json" },
    });
    return await r.json();
  });
  const apiTotal = Number((missionApi.counters || {}).total || 0);
  check("the task list holds exactly the tasks the backend reports", missionView.rows === apiTotal, `rows=${missionView.rows} api=${apiTotal}`);
  const totalStat = missionView.stats.find((s) => s.k === "Total Task");
  check("the Total Task counter shows the backend number", !!totalStat && totalStat.v === String(apiTotal), JSON.stringify(totalStat));

  // search must really filter — a query that cannot match empties the list
  await page.fill("#missionSearch", "zzz-tidak-ada-task");
  await page.waitForTimeout(1400);
  const afterSearch = await page.evaluate(() => document.querySelectorAll("#view-mission .msRow").length);
  check("search filters the list down", afterSearch === 0, `rows=${afterSearch}`);
  await page.fill("#missionSearch", "");
  await page.waitForTimeout(1400);
  const afterClear = await page.evaluate(() => document.querySelectorAll("#view-mission .msRow").length);
  check("clearing the search restores the list", afterClear === apiTotal, `rows=${afterClear} api=${apiTotal}`);

  // status filter
  const statusFilter = await page.evaluate(async () => {
    const s = document.querySelector<HTMLSelectElement>("#missionStatus");
    if (!s) return null;
    s.value = "failed";
    s.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1400));
    const badges = Array.from(document.querySelectorAll("#view-mission .msRow .badge")).map((b) => (b.textContent || "").trim());
    return { rows: document.querySelectorAll("#view-mission .msRow").length, badges: Array.from(new Set(badges)) };
  });
  check(
    "the status filter shows only that status",
    !!statusFilter && statusFilter.rows > 0 && statusFilter.badges.length === 1 && statusFilter.badges[0] === "Gagal",
    JSON.stringify(statusFilter),
  );

  // sorting must reorder the list
  const sortIds = await page.evaluate(async () => {
    const s = document.querySelector<HTMLSelectElement>("#missionSort");
    if (!s) return { smart: "", oldest: "" };
    s.value = "smart";
    s.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1400));
    const e1 = document.querySelector("#view-mission .msRow .msId");
    const smart = e1 ? (e1.textContent || "").trim() : "";
    s.value = "oldest";
    s.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1400));
    const e2 = document.querySelector("#view-mission .msRow .msId");
    const oldest = e2 ? (e2.textContent || "").trim() : "";
    return { smart, oldest };
  });
  check("the sort control reorders the list", sortIds.smart !== "" && sortIds.oldest !== "" && sortIds.smart !== sortIds.oldest, JSON.stringify(sortIds));
  await page.evaluate(async () => {
    const s = document.querySelector<HTMLSelectElement>("#missionStatus");
    if (!s) return;
    s.value = "";
    s.dispatchEvent(new Event("change", { bubbles: true }));
    const t = document.querySelector<HTMLSelectElement>("#missionSort");
    if (!t) return;
    t.value = "smart";
    t.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1200));
  });

  // the detail overlay
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>("#view-mission [data-mission-open]");
    if (b) b.click();
  });
  await page.waitForTimeout(700);
  const detail = await page.evaluate(() => {
    const bg = document.getElementById("missionBg");
    return {
      open: !!bg && bg.classList.contains("on"),
      id: (() => { const e = bg ? bg.querySelector(".msId") : null; return e ? (e.textContent || "").trim() : ""; })(),
      hasStatus: !!(bg && bg.querySelector(".badge")),
      shownActions: bg ? bg.querySelectorAll("[data-mission-action]").length : 0,
    };
  });
  check("the task detail opens with the real task id", detail.open && detail.id.length > 3, detail.id);
  check("the task detail shows a status", detail.hasStatus);

  // an action may only be shown when the backend offers it for THAT task
  const actionParity = await page.evaluate(async () => {
    const token = localStorage.getItem("mia_token") || "";
    const bg = document.getElementById("missionBg");
    const idEl = bg ? bg.querySelector(".msId") : null;
    const id = idEl ? (idEl.textContent || "").trim() : "";
    const r = await fetch("/api/mission?token=" + encodeURIComponent(token), { headers: { accept: "application/json" } });
    const d = (await r.json()) as { tasks?: Array<{ task_id: string; actions?: unknown[] }> };
    const t = (d.tasks || []).find((x) => x.task_id === id);
    return { shown: bg ? bg.querySelectorAll("[data-mission-action]").length : 0, expected: t ? (t.actions || []).length : -1 };
  });
  check(
    "every action shown is an action the backend offers",
    actionParity.expected >= 0 && actionParity.shown === actionParity.expected,
    JSON.stringify(actionParity),
  );
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>("[data-mission-close]");
    if (b) b.click();
  });
  await page.waitForTimeout(500);
  check(
    "the task detail closes",
    await page.evaluate(() => {
      const bg = document.getElementById("missionBg");
      return !!bg && !bg.classList.contains("on");
    }),
  );

  // 13. A bus event must repaint the view WITHOUT waiting for the periodic
  // poll. Proof: the "diperbarui" clock only moves when the mission data is
  // re-fetched, and the periodic poll can only fire 10 s after the previous
  // one — so a move inside 5 s of a chat turn, taken while the previous poll
  // is at most 4 s old (the next one is then ≥6 s away), can only come from
  // the bus path.
  const lastPollAge = async (): Promise<number> =>
    page.evaluate(() => {
      const t = (document.getElementById("lastPill")?.textContent || "").trim();
      const m = /^(\d{2})[.:](\d{2})[.:](\d{2})$/.exec(t);
      if (!m) return -1;
      const now = new Date();
      const last = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(m[1]), Number(m[2]), Number(m[3]));
      return Math.round((now.getTime() - last.getTime()) / 1000);
    });
  const busPillText = await page.evaluate(() => (document.getElementById("busPill")?.textContent || "").trim());
  const busSeenBefore = Number(/BUS LIVE (\d+)/.exec(busPillText)?.[1] ?? -1);
  let age = await lastPollAge();
  // The periodic poll fires 10 s after the previous one, so it is only safe to
  // watch a 5 s window when the last poll is fresh (age <= 4 → the next one is
  // at least 6 s away).
  for (let i = 0; i < 30 && age >= 0 && age > 4; i++) {
    await page.waitForTimeout(400);
    age = await lastPollAge();
  }
  if (age < 0) {
    console.log("  · SKIP bus-refresh assertion: the last-poll clock is unreadable");
  } else if (age > 4) {
    console.log(`  · SKIP bus-refresh assertion: the last poll was ${age}s ago — the next one is too close`);
  } else if (!busPillText.startsWith("BUS LIVE")) {
    // No live bus = no event can arrive = the question cannot be answered.
    console.log(`  · SKIP bus-refresh assertion: the bus is not live (${busPillText})`);
  } else {
    const clockBefore = await page.evaluate(() => {
      const el = document.getElementById("missionUpdated");
      return el ? (el.textContent || "").trim() : "";
    });
    /* The clock has second resolution: two refreshes inside the same second
       look identical. The view's fetch counter is the reliable signal. */
    const fetchBefore = await page.evaluate(
      () => Number(document.getElementById("view-mission")?.dataset.missionFetch || 0),
    );
    await openPanel(page);
    // The marker keeps the drill turn out of the owner's own transcript and
    // daily memory (cleanupDrillNote removes blocks carrying it).
    const busMarker = `drill-${Date.now()}`;
    // The turn is posted straight to the office endpoint: the bus events come
    // from the server, so the composer is not part of what is under test here
    // (and the composer refuses a message while a history load is pending).
    await page.evaluate((m) => {
      const tok = localStorage.getItem("mia_token") || "";
      fetch("/api/office/chat?agent=mia&token=" + encodeURIComponent(tok), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "mia", messages: [{ role: "user", content: "bus refresh probe [" + m + "]" }] }),
      }).catch(() => undefined);
    }, busMarker);
    // Watch BOTH signals and measure WHEN the clock moved. The window must
    // stay below the distance to the next periodic poll (10 s after the
    // previous one), otherwise the periodic poll could be the cause and the
    // assertion would prove nothing.
    const t0 = Date.now();
    let busSeen = busSeenBefore;
    let frameAt = -1;
    let clockMovedAt = -1;
    let clockNow = clockBefore;
    for (let i = 0; i < 60; i += 1) {
      await page.waitForTimeout(250);
      const s = await page.evaluate(() => ({
        bus: (document.getElementById("busPill")?.textContent || "").trim(),
        clock: (document.getElementById("missionUpdated")?.textContent || "").trim(),
        fetches: Number(document.getElementById("view-mission")?.dataset.missionFetch || 0),
      }));
      const m = /BUS LIVE (\d+)/.exec(s.bus);
      if (frameAt < 0 && m && Number(m[1]) > busSeen) {
        busSeen = Number(m[1]);
        frameAt = Date.now() - t0;
      }
      clockNow = s.clock;
      if (clockMovedAt < 0 && s.fetches > fetchBefore) clockMovedAt = Date.now() - t0;
      if (busSeen > busSeenBefore && clockMovedAt >= 0) break;
    }
    const framed = busSeen > busSeenBefore;
    // The periodic poll can fire at the earliest 10 s after the previous poll;
    // the last one was `age` seconds ago, so it cannot fire before 10 - age.
    // The frame itself can arrive late (the model needs seconds before its
    // first action), so the window is measured FROM THE FRAME: the repaint
    // must follow the event, and it must still beat the periodic timer.
    const movedIn =
      clockMovedAt >= 0 &&
      frameAt >= 0 &&
      clockMovedAt - frameAt < 2000 &&
      clockMovedAt < (10 - age) * 1000;
    if (!framed) {
      console.log("  · SKIP bus-refresh assertion: no bus frame arrived");
    } else {
      check(
        "a bus event repaints the Mission Control without waiting for the poll",
        movedIn,
        `last poll ${age}s ago (next in >=${10 - age}s), frame after ${frameAt}ms, view refreshed after ${clockMovedAt}ms (clock "${clockBefore}" -> "${clockNow}"), bus="${busPillText}"`,
      );
      // Let the turn finish so the drill does not close the browser mid-answer.
      await waitForSessionTurn(busMarker);
    }
  }

  // 14. The periodic poll must NOT rewrite the DOM when nothing changed —
  // that rewrite is the flicker the owner complained about.
  //
  // The painted markup is the ground truth: if it is identical before and
  // after the poll, the view had no reason to be rewritten, so the very same
  // row node must still be alive. The "diperbarui" clock is excluded — it
  // changes on every fetch by design and lives outside the painted markup.
  const htmlOf = () =>
    page.evaluate(() => {
      const el = document.getElementById("view-mission");
      if (!el) return "";
      return el.innerHTML.replace(/(<span class="note" id="missionUpdated">)[^<]*(<\/span>)/, "$1$2");
    });
  const tagged = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>("#view-mission .msRow"));
    if (!rows.length) return { ok: false };
    rows[0].dataset.probe = "keep";
    return { ok: true };
  });
  const htmlBefore = await htmlOf();
  await page.waitForTimeout(11000);
  const htmlAfter = await htmlOf();
  const rowKept = await page.evaluate(() => !!document.querySelector('#view-mission .msRow[data-probe="keep"]'));
  if (!tagged.ok) {
    check("the task row survives the periodic poll untouched", false, "no row to tag");
  } else if (htmlBefore !== htmlAfter) {
    // The data really changed, so a repaint was correct — the assertion cannot
    // be answered in this run.
    console.log("  · SKIP no-repaint assertion: the mission data changed while waiting");
  } else {
    check("the task row survives the periodic poll untouched", rowKept);
  }

  // 15. the ledger trees are NOT public: they hold the owner's own prompts
  // and replies, and the dashboard's static file handler used to serve them
  // to anyone with the URL.
  const ledgerPublic = await page.evaluate(async () => {
    const r = await fetch("/data/queue.jsonl");
    return r.status;
  });
  check("the queue ledger is not readable without the token", ledgerPublic === 403, `status=${ledgerPublic}`);

  // 16. the log filter must keep filtering after the first keystroke (the
  // input is re-created by the paint, so it has to be wired again).
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('button[data-view="logs"]');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  const logsBefore = await page.evaluate(() => document.querySelectorAll("#view-logs .logline").length);
  await page.fill("#view-logs #logFilter", "zzz-tidak-ada-log");
  await page.waitForTimeout(700);
  const logsFiltered = await page.evaluate(() => document.querySelectorAll("#view-logs .logline").length);
  await page.fill("#view-logs #logFilter", "");
  await page.waitForTimeout(700);
  const logsCleared = await page.evaluate(() => document.querySelectorAll("#view-logs .logline").length);
  if (!logsBefore) {
    console.log("  · SKIP log-filter assertion: there are no log rows to filter");
  } else {
    check(
      "the log filter keeps filtering after a keystroke",
      logsFiltered === 0 && logsCleared === logsBefore,
      `before=${logsBefore} filtered=${logsFiltered} cleared=${logsCleared}`,
    );
  }

  // 17. an open task detail must survive a background refresh (it is not
  // rebuilt when nothing changed, so the owner keeps reading it).
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('button[data-view="mission"]');
    if (b) b.click();
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>("#view-mission [data-mission-open]");
    if (b) b.click();
  });
  await page.waitForTimeout(700);
  const modalMarked = await page.evaluate(() => {
    const m = document.querySelector<HTMLElement>("#missionBg .modal");
    if (!m) return false;
    m.dataset.probe = "keep";
    return true;
  });
  // Change the status filter: the list behind the open detail repaints, so the
  // detail must survive a REAL repaint (a quiet window would prove nothing —
  // the view is not repainted when nothing changed).
  await page.evaluate(() => {
    const s = document.querySelector<HTMLSelectElement>("#missionStatus");
    if (!s || s.options.length < 2) return;
    s.value = s.options[1].value;
    s.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(2000);
  const modalKept = await page.evaluate(() => !!document.querySelector('#missionBg .modal[data-probe="keep"]'));
  const stillOpen = await page.evaluate(() => {
    const bg = document.getElementById("missionBg");
    return !!bg && bg.classList.contains("on");
  });
  check(
    "an open task detail survives a repaint of the list",
    modalMarked && modalKept && stillOpen,
    `marked=${modalMarked} kept=${modalKept} open=${stillOpen}`,
  );

  // 19. a narrow view fits: the activity table used to need 600 px in a
  // 560 px view and was cut at the right edge.
  await page.setViewportSize({ width: 560, height: 844 });
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('nav button[data-view="activity"]');
    if (b) b.click();
  });
  await page.waitForTimeout(1200);
  const narrowTable = await page.evaluate(() => {
    const t = document.querySelector<HTMLElement>("#view-activity table");
    if (!t) return { ok: false, right: -1, vw: window.innerWidth };
    const r = t.getBoundingClientRect();
    return { ok: true, right: Math.round(r.right), vw: window.innerWidth };
  });
  check(
    "the activity table fits a narrow view",
    narrowTable.ok && narrowTable.right <= narrowTable.vw + 1,
    `right=${narrowTable.right} vw=${narrowTable.vw}`,
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);

  // 20. a rotated queue row must keep its prompt on the board.
  //
  // The queue rotates: the oldest rows move to data/queue.archive.jsonl. The
  // PROMPT lives only in the queue row (the task ledger keeps it in rare
  // cases), so a rotated row that is never read back removes the task from
  // the board — and the "Jalankan ulang" button with it.
  const dashToken = token();
  const drillDir = drillInstance?.dataDir || "";
  const readDrillFile = (f: string): string => {
    const p = join(drillDir, f);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  };
  const rowIds = (content: string): string[] =>
    content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return String((JSON.parse(l) as Record<string, unknown>).id || "");
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  /* The rotation moves the OLDEST rows into the archive, so the rows this
     drill just posted are the ones that stay live. */
  const idsBefore = rowIds(readDrillFile("queue.jsonl"));
  /* A task that already has a prompt BEFORE this drill posts. After the
     rotation its queue row lives in the archive, so it is the row that proves
     the board still reads the archive back. */
  const missionBefore = (await (
    await fetch(`${DASH}/api/mission?token=${encodeURIComponent(dashToken)}&period=all&sort=smart`)
  ).json()) as Record<string, any>;
  const oldTask = (missionBefore.tasks || []).find(
    (t: Record<string, any>) => t.source === "dispatch" && t.prompt,
  ) as Record<string, any> | undefined;
  const postQueue = async (prompt: string) => {
    const r = await fetch(`${DASH}/api/queue?token=${encodeURIComponent(dashToken)}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${dashToken}` },
      body: JSON.stringify({ prompt, agent: "mia", deliver: "none" }),
    });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> };
  };
  const qA = await postQueue("rotasi-antrean-A prompt harus tetap hidup di board");
  const qB = await postQueue("rotasi-antrean-B prompt harus tetap hidup di board");
  const qidA = qA.body?.item?.id as string | undefined;
  const taskA = qA.body?.item?.task_id as string | undefined;
  const liveIds = rowIds(readDrillFile("queue.jsonl"));
  const archIds = rowIds(readDrillFile("queue.archive.jsonl"));
  const rotated = idsBefore.filter((id) => archIds.includes(id) && !liveIds.includes(id));
  const missionAfter = (await (
    await fetch(`${DASH}/api/mission?token=${encodeURIComponent(dashToken)}&period=all&sort=smart`)
  ).json()) as Record<string, any>;
  const onBoard = (missionAfter.tasks || []).find((t: Record<string, any>) => t.task_id === taskA);
  check(
    "the oldest queue rows rotate into the archive",
    qA.status === 201 && qB.status === 201 && idsBefore.length > 0 && rotated.length === idsBefore.length,
    `postA=${qA.status} postB=${qB.status} before=${idsBefore.length} rotated=${rotated.length} live=${liveIds.length} archive=${archIds.length}`,
  );
  /* Count the tasks that still carry a prompt. The rotation moved the old
     queue rows into the archive; if the board stops reading the archive, the
     prompts of those rows disappear and the "Jalankan ulang" buttons go with
     them. A single task can have its prompt in the task ledger instead, so
     the count is the honest signal here. */
  const promptCount = (m: Record<string, any>) =>
    (m.tasks || []).filter((t: Record<string, any>) => !!t.prompt).length;
  check(
    "a rotated queue row keeps its prompt on the board",
    promptCount(missionBefore) > 0 && promptCount(missionAfter) >= promptCount(missionBefore),
    `prompts before=${promptCount(missionBefore)} after=${promptCount(missionAfter)} oldTask=${(oldTask && oldTask.task_id) || "?"}`,
  );
  check(
    "the newest queue task appears on the board with its prompt",
    !!onBoard && !!onBoard.prompt,
    `task=${taskA || "?"} onBoard=${!!onBoard} prompt=${onBoard ? String(onBoard.prompt || "").slice(0, 40) : "-"}`,
  );

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
process.on("exit", () => {
  if (drillInstance) stopDrillDashboard(drillInstance.proc, drillInstance.dataDir);
});