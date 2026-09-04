// Browser automation (Fase 4, gap OpenClaw Tier 2) — Playwright headless.
// Single browser + page per process (personal single-user deploy). Tools are
// read/write via exec-style allowlist: open/snapshot are read, click/type are write.

import { chromium, Browser, Page } from "playwright";

let browser: Browser | null = null;
let page: Page | null = null;

async function ensurePage(): Promise<Page> {
  if (page && !page.isClosed()) return page;
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
  }
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36",
  });
  page = await ctx.newPage();
  // Note: resource blocking disabled for now — can hang on some sites
  // await page.route("**/*", (route) => {
  //   const type = route.request().resourceType();
  //   if (["image", "media", "font"].includes(type)) return route.abort();
  //   return route.continue();
  // });
  return page;
}

export async function browserOpen(url: string): Promise<string> {
  const u = url.trim();
  if (!u) throw new Error("empty url");
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    throw new Error("invalid url");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("only http(s) allowed");
  // SSRF guard: block private/localhost
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local") || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    throw new Error("private/local urls blocked");
  }
  const p = await ensurePage();
  await p.goto(u, { waitUntil: "domcontentloaded", timeout: 15000 });
  // Let SPA settle a bit
  await p.waitForTimeout(800);
  const title = await p.title().catch(() => "");
  const content = await p.content().catch(() => "");
  // Extract visible text (simple, truncate)
  const text = await p.evaluate(() => document.body.innerText.slice(0, 8000)).catch(() => "");
  return `Opened ${u}\nTitle: ${title}\nURL: ${p.url()}\n\n${text.slice(0, 6000) || content.slice(0, 4000)}`;
}

export async function browserSnapshot(): Promise<string> {
  const p = await ensurePage();
  if (p.url() === "about:blank") return "No page open — use browser_open first";
  // ARIA snapshot via Playwright's snapshot (accessibility tree) — concise and LLM-friendly
  const snap = await p.locator("body").evaluate((body) => {
    function walk(el: Element, depth: number): string {
      if (depth > 6) return "";
      const role = el.getAttribute("role") || el.tagName.toLowerCase();
      const name = (el as HTMLElement).innerText?.split("\n")[0]?.trim().slice(0, 80) || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
      const id = el.getAttribute("id") ? `#${el.getAttribute("id")}` : "";
      const tag = el.tagName.toLowerCase();
      let line = "";
      if (["a", "button", "input", "select", "textarea"].includes(tag) || role === "button" || role === "link") {
        line = `${"  ".repeat(depth)}- ${tag}${id} [${role}] "${name}"`;
      } else if (name && depth < 3) {
        line = `${"  ".repeat(depth)}- ${tag}: "${name.slice(0, 60)}"`;
      }
      let out = line ? line + "\n" : "";
      for (const child of Array.from(el.children).slice(0, 30)) {
        out += walk(child as Element, depth + 1);
      }
      return out;
    }
    return walk(body, 0).slice(0, 8000);
  }).catch(() => "");
  const url = p.url();
  const title = await p.title().catch(() => "");
  return `Snapshot ${url} — ${title}\n${snap || "(no snapshot)"}`.slice(0, 8000);
}

export async function browserClick(selector: string): Promise<string> {
  const sel = selector.trim();
  if (!sel) throw new Error("empty selector");
  const p = await ensurePage();
  if (p.url() === "about:blank") throw new Error("no page open");
  // Try selector as CSS, then as text
  const target = p.locator(sel).first();
  const count = await target.count();
  if (count === 0) {
    // Fallback: try text selector
    const byText = p.getByText(sel, { exact: false }).first();
    if ((await byText.count()) === 0) throw new Error(`no element for "${sel}"`);
    await byText.click({ timeout: 5000 });
  } else {
    await target.click({ timeout: 5000 });
  }
  await p.waitForTimeout(600);
  return `Clicked "${sel}" — now at ${p.url()}`;
}

export async function browserType(selector: string, text: string): Promise<string> {
  const sel = selector.trim();
  if (!sel) throw new Error("empty selector");
  const p = await ensurePage();
  if (p.url() === "about:blank") throw new Error("no page open");
  const target = p.locator(sel).first();
  if ((await target.count()) === 0) throw new Error(`no input for "${sel}"`);
  await target.fill(text, { timeout: 5000 });
  await p.waitForTimeout(300);
  return `Typed into "${sel}"`;
}

export async function browserNavigate(action: string): Promise<string> {
  const p = await ensurePage();
  if (p.url() === "about:blank") throw new Error("no page open");
  if (action === "back") await p.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  else if (action === "forward") await p.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
  else if (action === "reload") await p.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  else throw new Error('action must be "back", "forward", or "reload"');
  await p.waitForTimeout(600);
  return `Navigated ${action} — now at ${p.url()}`;
}

export async function browserClose(): Promise<string> {
  try {
    if (page) await page.close().catch(() => {});
  } finally {
    page = null;
  }
  return "Browser closed";
}
