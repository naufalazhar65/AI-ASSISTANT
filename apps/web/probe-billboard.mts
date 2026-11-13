/* Billboard probe — proves the GTA VI board renders as a real object and that
   the countdown states are correct.
   Run: npx tsx apps/web/probe-billboard.mts
   Screenshots land in /tmp/office-billboard. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";

declare global {
  interface Window {
    __miaOffice?: any;
  }
}

const ROOT = join(import.meta.dirname, "..", "..");
const OUT = process.env.OFFICE_BILLBOARD_OUT || "/tmp/office-billboard";
const BASE = process.env.OFFICE_DASH_URL || "http://127.0.0.1:3001";
const TARGET = Date.parse("2026-11-19T00:00:00+07:00");

function token(): string {
  try {
    const env = readFileSync(join(ROOT, "apps/web/.env.local"), "utf8");
    const m = env.match(/^AUTH_TOKEN=(.*)$/m);
    return m ? m[1].trim().replace(/^["']|["']$/g, "") : "";
  } catch {
    return "";
  }
}

/* the board's face, in the board group's local space — read from the page so
   the probe cannot drift away from the panel it photographs */

async function main() {
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 3022, height: 1169 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(BASE + "/?token=" + encodeURIComponent(token()), { waitUntil: "load", timeout: 90000 });
  await page.waitForFunction(() => !!(window as any).__miaOffice?.ready, null, { timeout: 30000 });
  await page.waitForTimeout(20000); // the camera fits the scene, then drifts

  /* The office camera tweens after a room switch and then drifts slowly, so a
     crop measured too early lands on empty grass. Wait until the board has
     held still for three readings before measuring. */
  const stableRect = async () => {
    let prev = await boardRect();
    let hits = 0;
    for (let i = 0; i < 14; i++) {
      await page.waitForTimeout(400);
      const now = await boardRect();
      if (!now) return prev;
      if (prev && now && Math.abs(now.cx - prev.cx) < 3 && Math.abs(now.cy - prev.cy) < 3 && Math.abs(now.wpx - prev.wpx) < 3) {
        hits++;
        if (hits >= 2) return now;
      } else {
        hits = 0;
      }
      prev = now;
    }
    return prev;
  };
  const boardRect = async () => page.evaluate(() => {
    const o = (window as any).__miaOffice;
    const T = o.three;
    const face = o.billboard.face;
    const board = (o.placed || []).find((r: any) => r.name === "out:billboard-gta6");
    if (!board) return null;
    const g = board.group;
    g.updateWorldMatrix(true, false);
    const b = new T.Box3().setFromObject(g);
    const v = new T.Vector3(0, face.y, face.z).applyMatrix4(g.matrixWorld).project(o.cam);
    const a = new T.Vector3(-face.w / 2, face.y, face.z).applyMatrix4(g.matrixWorld).project(o.cam);
    const c = new T.Vector3(face.w / 2, face.y, face.z).applyMatrix4(g.matrixWorld).project(o.cam);
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    const r = canvas.getBoundingClientRect();
    return {
      min: { x: +b.min.x.toFixed(2), y: +b.min.y.toFixed(2), z: +b.min.z.toFixed(2) },
      max: { x: +b.max.x.toFixed(2), y: +b.max.y.toFixed(2), z: +b.max.z.toFixed(2) },
      cx: r.left + (v.x * 0.5 + 0.5) * r.width,
      cy: r.top + (-v.y * 0.5 + 0.5) * r.height,
      wpx: Math.abs(c.x - a.x) * 0.5 * r.width,
      faceW: face.w,
      faceH: face.h
    };
  });

  /* #themeBtn switches the 3D scene between day and night (the UI theme is
     #modeBtn — a different thing). */
  const theme = async () => {
    await page.evaluate(() => {
      const b = document.querySelector("#themeBtn") as HTMLElement | null;
      if (b) b.click();
    });
    await page.waitForTimeout(3500);
  };
  const shot = async (name: string) => {
    const geo = await stableRect();
    if (!geo) throw new Error("the board is not in the placed registry");
    const hpx = (geo.wpx * geo.faceH) / geo.faceW;
    const clip = {
      x: Math.max(0, geo.cx - geo.wpx / 2 - 24),
      y: Math.max(0, geo.cy - hpx / 2 - 24),
      width: geo.wpx + 48,
      height: hpx + 48
    };
    await page.screenshot({ path: join(OUT, name + ".png") });
    await page.screenshot({ path: join(OUT, name + "-board.png"), clip });
    console.log(name, "board px:", geo.wpx.toFixed(0) + "x" + hpx.toFixed(0), "clip:", JSON.stringify(clip));
  };

  await shot("01-default-day");

  await page.evaluate((t) => (window as any).__miaOffice.billboard.hold(t - 45000), TARGET);
  await page.waitForTimeout(900);
  await shot("02-under-a-minute");

  await page.evaluate((t) => (window as any).__miaOffice.billboard.hold(t), TARGET);
  await page.waitForTimeout(900);
  await shot("03-release-day");

  await page.evaluate(() => (window as any).__miaOffice.billboard.clear());
  await page.waitForTimeout(600);
  await theme();
  await shot("04-all-night");

  const fps = (await page.evaluate(
    `new Promise((res) => { let n = 0; const t0 = performance.now(); const step = () => { n++; const dt = performance.now() - t0; if (dt < 2000) requestAnimationFrame(step); else res(Math.round(n * 1000 / dt)); }; requestAnimationFrame(step); })`
  )) as number;
  const meshes = await page.evaluate(() => {
    const o = (window as any).__miaOffice;
    let n = 0;
    o.scene.traverse((c: any) => {
      if (c.isMesh) n++;
    });
    return n;
  });

  const geo0 = await boardRect();
  console.log("board world bounds:", JSON.stringify({ min: geo0?.min, max: geo0?.max }));
  console.log("fps:", fps, "meshes:", meshes, "page errors:", errors.length);
  if (errors.length) console.log(errors.slice(0, 5).join("\n"));
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
