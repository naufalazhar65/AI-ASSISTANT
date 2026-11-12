/**
 * Layout audit for the office dashboard: every view, measured instead of
 * eyeballed.
 *
 *   npx tsx apps/web/probe-layout-audit.mts
 *
 * It opens the real dashboard, walks every nav destination and reports the
 * layout defects that a screenshot alone hides: horizontal overflow, elements
 * that stick out of the viewport, text clipped inside its own box, controls
 * that are too small to hit, and unreadably small type. A screenshot per view
 * lands in /tmp/office-layout so the eye can check what the numbers say.
 */
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = join(import.meta.dirname, "..", "..");
const DASH = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";
const OUT = "/tmp/office-layout";
const WIDTHS = (process.env.OFFICE_AUDIT_WIDTHS || "1440,1024,560").split(",").map((n) => Number(n.trim()));
const VIEWS = [
  "office",
  "mission",
  "agents",
  "board",
  "calendar",
  "usage",
  "activity",
  "logs",
  "findings",
  "memory",
  "files",
  "settings",
];

function token(): string {
  for (const line of readFileSync(join(ROOT, "apps/web/.env.local"), "utf8").split("\n")) {
    const m = /^AUTH_TOKEN=(.*)$/.exec(line.trim());
    if (m) return m[1].replace(/^"|"$/g, "");
  }
  throw new Error("AUTH_TOKEN missing from apps/web/.env.local");
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const auth = token();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(`${DASH}/?token=${encodeURIComponent(auth)}`, { waitUntil: "commit" });
  await page.evaluate((v) => localStorage.setItem("mia_token", v), auth);
  await page.goto(`${DASH}/?token=${encodeURIComponent(auth)}&_r=${Date.now()}`, { waitUntil: "commit" });
  await page.waitForTimeout(2500);

  for (const width of WIDTHS) {
  await page.setViewportSize({ width, height: width < 700 ? 844 : 900 });
  await page.waitForTimeout(400);
  for (const view of VIEWS) {
    await page.evaluate((v) => {
      const b = document.querySelector<HTMLElement>(`nav button[data-view="${v}"]`);
      if (b) b.click();
    }, view);
    await page.waitForTimeout(900);
    // The measurement lives INSIDE the evaluate: a named arrow function would
    // be renamed by esbuild and the page would throw "__name is not defined".
    const report = await page.evaluate((view: string) => {
      const vw = window.innerWidth;
      const root = document.getElementById("view-" + view);
      const out = {
        view,
        vw,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        offscreen: [] as string[],
        clipped: [] as string[],
        tiny: [] as string[],
        tinyType: [] as string[],
        cut: [] as string[],
      };
      if (!root) return out;
      // NOTE: no named function expressions in here — esbuild renames them and
      // the page throws "__name is not defined" (house rule).
      root.querySelectorAll("*").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return;
        const cls = (el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
        const elid = el.id ? "#" + el.id : "";
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34);
        const lab = `${el.tagName.toLowerCase()}${elid}${cls ? "." + cls : ""}${txt ? ` "${txt}"` : ""}`;
        if (r.right > vw + 1 || r.left < -1) {
          out.offscreen.push(`${lab} x=${Math.round(r.left)}..${Math.round(r.right)} (vw ${vw})`);
        }
        const isSr = cls.split(" ").includes("sr");
        if (!isSr && el.scrollWidth > el.clientWidth + 2 && /hidden|clip/.test(st.overflowX) && el.clientWidth > 0) {
          out.clipped.push(`${lab} ${el.clientWidth}px < ${el.scrollWidth}px`);
        }
        const fs = parseFloat(st.fontSize || "0");
        if (fs > 0 && fs < 10 && txt) out.tinyType.push(`${lab} ${fs}px`);
        // Text cut off by a clipping ancestor (a scrollable ancestor is fine —
        // the owner can reach it; a hidden one is a wall).
        let par = el.parentElement;
        while (par && par !== root) {
          const pst = getComputedStyle(par);
          if (/hidden|clip/.test(pst.overflowX) && par.clientWidth > 0 && el.scrollWidth > par.clientWidth + 2) {
            out.cut.push(`${lab} cut by ${par.tagName.toLowerCase()}.${(par.className || "").toString().split(/\s+/)[0]} (${par.clientWidth}px < ${el.scrollWidth}px)`);
            break;
          }
          par = par.parentElement;
        }
      });
      root.querySelectorAll("button,a,input,select,textarea,[role=button]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return;
        const st = getComputedStyle(el);
        if (st.visibility === "hidden" || st.display === "none" || Number(st.opacity) === 0) return;
        const cls = (el.className || "").toString().split(/\s+/).filter(Boolean).slice(0, 2).join(".");
        const elid = el.id ? "#" + el.id : "";
        const txt = (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 34);
        const lab = `${el.tagName.toLowerCase()}${elid}${cls ? "." + cls : ""}${txt ? ` "${txt}"` : ""}`;
        if (r.height < 24 || r.width < 24) out.tiny.push(`${lab} ${Math.round(r.width)}x${Math.round(r.height)}`);
      });
      out.offscreen = out.offscreen.slice(0, 6);
      out.clipped = out.clipped.slice(0, 6);
      out.tiny = out.tiny.slice(0, 6);
      out.tinyType = out.tinyType.slice(0, 4);
      out.cut = out.cut.slice(0, 6);
      return out;
    }, view);
    await page.screenshot({ path: join(OUT, `${width}-${view}.png`) });
    const problems: string[] = [];
    if (report.overflowX > 0) problems.push(`overflow-x=${report.overflowX}px`);
    if (report.offscreen.length) problems.push(`offscreen: ${report.offscreen.join(" | ")}`);
    if (report.clipped.length) problems.push(`clipped: ${report.clipped.join(" | ")}`);
    if (report.tiny.length) problems.push(`tiny-target: ${report.tiny.join(" | ")}`);
    if (report.tinyType.length) problems.push(`tiny-type: ${report.tinyType.join(" | ")}`);
    if (report.cut.length) problems.push(`cut: ${report.cut.join(" | ")}`);
    console.log(problems.length ? `${width} ${view}: ${problems.join("  //  ")}` : `${width} ${view}: clean`);
  }
  }
  console.log("page errors:", errs.slice(0, 3));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
