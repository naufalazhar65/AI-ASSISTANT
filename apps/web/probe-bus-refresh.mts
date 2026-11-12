/**
 * Probe: does a bus event repaint the Mission Control without waiting for
 * the periodic poll?
 *
 *   npx tsx apps/web/probe-bus-refresh.mts
 *
 * It opens the real dashboard, opens the Mission Control view and prints what
 * the page shows while a REAL turn starts on Mia. The "diperbarui" clock only
 * moves when the mission data is re-fetched, so a clock that moves right after
 * a turn starts proves the bus path works. Nothing here asserts anything —
 * it prints the evidence.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..");
const DASH = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";

function token(): string {
  for (const line of readFileSync(join(ROOT, "apps/web/.env.local"), "utf8").split("\n")) {
    const m = /^AUTH_TOKEN=(.*)$/.exec(line.trim());
    if (m) return m[1].replace(/^"|"$/g, "");
  }
  throw new Error("AUTH_TOKEN missing from apps/web/.env.local");
}

async function main(): Promise<void> {
  const auth = token();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${DASH}/?token=${encodeURIComponent(auth)}`, { waitUntil: "commit" });
  // The dashboard's api() reads the token from localStorage, not from the URL.
  await page.evaluate((v) => localStorage.setItem("mia_token", v), auth);
  await page.goto(`${DASH}/?token=${encodeURIComponent(auth)}&_r=${Date.now()}`, { waitUntil: "commit" });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const b = document.querySelector<HTMLElement>('button[data-view="mission"]');
    if (b) b.click();
  });
  await page.waitForTimeout(2500);
  const before = await page.evaluate(() => ({
    bus: (document.getElementById("busPill")?.textContent || "").trim(),
    clock: (document.getElementById("missionUpdated")?.textContent || "").trim(),
    hidden: document.hidden,
    lastPoll: (document.getElementById("lastPill")?.textContent || "").trim(),
  }));
  console.log("before:", JSON.stringify(before));

  const marker = `drill-${Date.now()}`;
  // Fire and forget: the turn's task_created frame must repaint the view while
  // the turn is still running, so waiting for the answer would prove nothing.
  const mode = process.argv[2] || "fetch";
  const openPanel = async (): Promise<void> => {
    for (let i = 0; i < 3; i += 1) {
      const open = await page.evaluate(() => {
        const p = document.getElementById("chatPanel");
        return !!p && !p.hidden && p.getBoundingClientRect().width > 0;
      });
      if (open) return;
      await page.evaluate(() => (document.getElementById("chatToggle") as HTMLElement | null)?.click());
      await page.waitForTimeout(500);
    }
  };
  if (mode === "detail") {
    /* Render the detail overlay for the first rows and scan the produced HTML
       for junk ("undefined", "null", "NaN") — a template hole shows up there
       before it shows up as a complaint. */
    await page.waitForTimeout(1500);
    const rows = await page.evaluate(() => document.querySelectorAll("#view-mission .msRow").length);
    const found: string[] = [];
    for (let i = 0; i < rows; i += 1) {
      await page.evaluate((n: number) => {
        const b = document.querySelectorAll<HTMLElement>("#view-mission [data-mission-open]")[n];
        if (b) b.click();
      }, i);
      await page.waitForTimeout(400);
      const html = await page.evaluate(() => {
        const bg = document.getElementById("missionBg");
        return bg ? bg.innerHTML : "";
      });
      const junk = ["undefined", "null", "NaN", "[object Object]"].filter((j) => html.includes(j));
      if (junk.length) found.push(`row ${i}: ${junk.join(",")}`);
      await page.evaluate(() => {
        const b = document.querySelector<HTMLElement>("[data-mission-close]");
        if (b) b.click();
      });
      await page.waitForTimeout(200);
    }
    console.log(`rows=${rows} detail overlays scanned=${rows}`);
    console.log(found.length ? `JUNK: ${found.join(" | ")}` : "no junk in the detail overlays");
    await browser.close();
    return;
  }
  if (mode === "switch") {
    /* The sequence the drill runs: send a turn, switch agent, switch back,
       close the panel with Esc, reopen it — then try to send again. */
    await openPanel();
    await page.fill(".chatInput", `probe first turn [${marker}]`);
    await page.press(".chatInput", "Enter");
    await page.waitForTimeout(1500);
    const clickTab = async (name: string): Promise<void> => {
      await page.evaluate((n: string) => {
        const tabs = Array.from(document.querySelectorAll('.chatTabs [role="tab"]'));
        const t = tabs.find((x) => (x.textContent || "").includes(n));
        if (t) (t as HTMLElement).click();
      }, name);
      await page.waitForTimeout(1200);
    };
    await clickTab("Michelle");
    await clickTab("Mia");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await openPanel();
    const beforeSend = await page.evaluate(() => {
      const inp = document.querySelector<HTMLTextAreaElement>(".chatInput");
      const btn = document.querySelector<HTMLButtonElement>(".chatSend");
      return {
        sendDisabled: btn ? btn.disabled : null,
        panelText: (document.querySelector(".chatInner")?.textContent || "").trim().slice(-120),
        value: inp ? inp.value.slice(0, 30) : null,
      };
    });
    console.log("before the second send:", JSON.stringify(beforeSend));
    await page.fill(".chatInput", `probe second turn [${marker}]`);
    await page.press(".chatInput", "Enter");
    await page.waitForTimeout(6000);
    const afterSend = await page.evaluate((m) => {
      const bubbles = Array.from(document.querySelectorAll("#chatLog .msg.user .msgBody"));
      return {
        sent: bubbles.some((b) => (b.textContent || "").includes(m)),
        panelText: (document.querySelector(".chatInner")?.textContent || "").trim().slice(-160),
        sendDisabled: (document.querySelector<HTMLButtonElement>(".chatSend") || { disabled: null }).disabled,
      };
    }, marker);
    console.log("after the second send:", JSON.stringify(afterSend));
    await browser.close();
    return;
  }
  if (mode === "composer") {
    // The path the owner really uses: open the chat drawer (only if closed)
    // and press Enter.
    await openPanel();
    await page.fill(".chatInput", `bus probe [${marker}]`);
    await page.press(".chatInput", "Enter");
  } else {
    await page.evaluate((m) => {
      const tok = localStorage.getItem("mia_token") || "";
      fetch("/api/office/chat?agent=mia&token=" + encodeURIComponent(tok), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: "mia", messages: [{ role: "user", content: "bus probe [" + m + "]" }] }),
      }).catch(() => undefined);
    }, marker);
  }

  let moved = false;
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(400);
    const s = await page.evaluate(() => ({
      bus: (document.getElementById("busPill")?.textContent || "").trim(),
      clock: (document.getElementById("missionUpdated")?.textContent || "").trim(),
      lastPoll: (document.getElementById("lastPill")?.textContent || "").trim(),
      dbg: (window as unknown as { __miaDbg?: unknown }).__miaDbg ?? null,
    }));
    console.log(i, JSON.stringify(s));
    if (s.clock !== before.clock) {
      console.log(`CLOCK MOVED after ${(i + 1) * 400}ms`);
      moved = true;
      break;
    }
  }
  if (!moved) console.log("CLOCK DID NOT MOVE within 10s");
  console.log("page errors:", errs.slice(0, 3));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
