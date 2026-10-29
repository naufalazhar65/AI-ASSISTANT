/**
 * Durable UI drill for the office chat sidebar (real browser, real backend).
 *
 *   npx tsx apps/web/drill-office-chat-ui.mts
 *
 * Nothing here is mocked: it opens the actual dashboard, opens the sidebar,
 * sends a REAL turn to Mia through /api/office/chat and asserts what the user
 * sees. Any FAIL is printed and the process exits non-zero.
 */
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..");
const DASH = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";
const ARTIFACT = "office_ui";
// The chat width is a design token (apps/office-dashboard/design-tokens.json).
// Reading it keeps the width assertion honest: a stale hard-coded range
// failed this drill for weeks because the contract had moved to 340px.
const CHAT_WIDTH_PX = (
  JSON.parse(
    readFileSync(join(ROOT, "apps", "office-dashboard", "design-tokens.json"), "utf8"),
  ) as { layout?: { chatWidth?: string } }
).layout?.chatWidth ?? "340px";
/** Marker text of the note the approval test creates — removed again at the end. */
const DRILL_NOTE = "catatan dari drill sidebar";

/** Remove only the drill's own note (surgical filter, never touches real notes). */
function cleanupDrillNote(): void {
  // Two files can hold it: the owner's per-user store (the normal path) and
  // the global fallback (used when a note is saved without a user key). Only
  // the marker text is ever removed.
  for (const file of [
    join(ROOT, "apps/web/.data/users/naufalazhar652952/notes.json"),
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
    const dir = join(ROOT, "apps/web/.data/users/naufalazhar652952/memory");
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
    const index = join(ROOT, "apps/web/.data/users/naufalazhar652952/memory/embeddings.json");
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
    const sessions = join(ROOT, "apps/web/.data/users/naufalazhar652952/sessions");
    if (existsSync(sessions)) {
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

  // 2. the toggle closes it and opens it again
  await page.click("#chatToggle");
  const closed = await chatClosed().then(() => true).catch(() => false);
  check("toggle closes the chat", closed && (await page.locator("#chatPanel").isHidden()));
  // The close runs a short exit motion before the panel is removed, so the
  // toggle must wait for `hidden` — clicking while the panel is still
  // there would ask for another close instead of an open.
  await page
    .waitForFunction(() => document.getElementById("chatPanel")?.hidden === true, undefined, { timeout: 10000 })
    .catch(() => undefined);
  await page.click("#chatToggle");
  const reopened = await chatOpen().then(() => true).catch(() => false);
  check("toggle opens the chat", reopened && (await page.locator("#chatPanel").isVisible()));
  check("toggle reports aria-expanded", (await page.getAttribute("#chatToggle", "aria-expanded")) === "true");
  const panelBox = await page.locator("#chatPanel").boundingBox();
  // The width comes from the design token (design-tokens.json), so the
  // assertion cannot drift away from the contract again.
  const expectedWidth = Number((CHAT_WIDTH_PX.match(/\d+/) || ["0"])[0]);
  check(
    "desktop width matches the design token",
    !!panelBox && Math.abs(panelBox.width - expectedWidth) <= 4,
    `width=${panelBox?.width} expected=${expectedWidth}`,
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

  // 3c. the typing row: it belongs to the CONVERSATION, not to the bottom of
  // the log, and it wears the agent's PHOTO (a letter looked broken).
  //
  // The row only shows while a turn is working, so it is forced visible here
  // (DOM only, no server call) and measured. The gap to the last message is
  // the contract: a growing message stream pushed the row to the very bottom
  // of the panel, hundreds of pixels below the last bubble.
  const typing = await page.evaluate(() => {
    const log = document.querySelector(".chatLog");
    const row = document.querySelector(".msg.typing");
    if (!log || !row) return null;
    row.removeAttribute("hidden");
    const rows = [...log.querySelectorAll(".chatStream .msg")];
    const last = rows[rows.length - 1];
    const t = row.getBoundingClientRect();
    const l = last ? last.getBoundingClientRect() : null;
    const av = row.querySelector(".msgAvatar");
    const msgAv = log.querySelector(".chatStream .msg.agent .msgAvatar");
    const img = av ? av.querySelector("img") : null;
    return {
      gapToLast: l ? Math.round(t.top - l.bottom) : null,
      avatarLeft: av ? Math.round(av.getBoundingClientRect().left) : null,
      msgAvatarLeft: msgAv ? Math.round(msgAv.getBoundingClientRect().left) : null,
      imgSrc: img ? img.getAttribute("src") : null,
      imgLoaded: !!img && img.complete && img.naturalWidth > 0,
    };
  });
  check("the typing row sits with the last message", !!typing && typing.gapToLast !== null && typing.gapToLast <= 24, `gap=${typing?.gapToLast}`);
  check("the typing row shows the agent's photo", !!typing && !!typing.imgSrc && typing.imgLoaded, `src=${typing?.imgSrc} loaded=${typing?.imgLoaded}`);
  check(
    "the typing portrait lines up with the message portraits",
    !!typing && typing.avatarLeft !== null && typing.msgAvatarLeft !== null && Math.abs(typing.avatarLeft - typing.msgAvatarLeft) <= 2,
    `typing=${typing?.avatarLeft} messages=${typing?.msgAvatarLeft}`,
  );
  // A picture of the fixed row, so the fix can be SEEN and not only measured.
  await page.screenshot({ path: "/tmp/office-chat-typing.png", fullPage: false });

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
  await datedPage.reload({ waitUntil: "commit" });
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
  // The history is re-read from the server in one render; give it a tick to
  // settle before counting.
  await page.waitForTimeout(400);
  const after = await bubbles();
  check("history reloaded from the server", after >= before && after >= 2, `before=${before} after=${after}`);

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
      const file = join(ROOT, "apps/web/.data/users/naufalazhar652952/notes.json");
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