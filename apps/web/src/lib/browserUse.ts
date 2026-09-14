// browserUse.ts — mandiri wrapper for browser-use CLI (browser-harness daemon, Python helpers)
// No .openclaw, local daemon via `browser-use <<'PY'` (not old open/state), 9router companion
// Daemon auto-starts on first `ensure_real_tab()` / `new_tab()`, CDP via local Chrome
// Guard: SSRF, dash-guard, output cap 12k, timeout 20-30s per call

import { exec } from "node:child_process";
import { assertPublicUrl } from "./netGuard";

const MAX_OUT = 12000;
const TIMEOUT = 25000;

function truncate(s: string): string {
  const t = s.trim();
  if (t.length <= MAX_OUT) return t;
  return t.slice(0, MAX_OUT) + "\n…(truncated)";
}

function execPy(code: string, timeoutMs = TIMEOUT): Promise<string> {
  return new Promise((resolve) => {
    // Use bash heredoc: browser-use <<'PY' \n code \n PY
    // Escape single quotes in code already handled by heredoc delimiter 'PY'
    const cmd = `browser-use <<'PY'\n${code}\nPY`;
    exec(cmd, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 2, env: process.env }, (err, stdout, stderr) => {
      const out = (stdout || "") + (stderr ? `\n${stderr}` : "");
      if (err) {
        const c = (err as unknown as { code?: string }).code;
        if (c === "ETIMEDOUT" || err.message.includes("ETIMEDOUT")) return resolve(`Error: browser-use timeout ${timeoutMs}ms\n${truncate(out)}`);
        if (out.trim()) return resolve(truncate(out + `\n[exit ${err.message}]`));
        return resolve(`Error: browser-use failed: ${err.message}`);
      }
      if (!out.trim()) return resolve("(no output)");
      return resolve(truncate(out));
    });
  });
}

export async function buDoctor(): Promise<string> {
  return execPy(`import subprocess, textwrap, json, sys
print("doctor via harness")
`, 12000).then(() => new Promise<string>((r) => exec(`browser-use --doctor 2>&1`, { timeout: 12000 }, (e, so, se) => r(truncate((so || "") + (se || ""))))));
}

export async function buOpen(url: string): Promise<string> {
  const u = url.trim();
  if (!u) return "Error: url required";
  if (u.startsWith("-")) return "Error: url must not start with '-'";
  try {
    assertPublicUrl(u);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : "invalid url"}`;
  }
  // First navigation is new_tab, daemon preserves tab
  return execPy(`ensure_real_tab()\nnew_tab(${JSON.stringify(u)})\nwait_for_load()\nprint(page_info())`);
}

export async function buState(): Promise<string> {
  return execPy(`ensure_real_tab()\nprint(page_info())\n# AX tree hint\ntry:\n    nodes=cdp("Accessibility.getFullAXTree")["nodes"][:25]\n    for n in nodes:\n        print(n.get("role"), n.get("name"), n.get("backendDOMNodeId"))\nexcept Exception as e:\n    print("AX error:", e)`);
}

export async function buClick(indexOrXy: string): Promise<string> {
  const v = indexOrXy.trim();
  if (!v) return "Error: index or x y required";
  if (/^-?\d+\s+-?\d+$/.test(v)) {
    const [x, y] = v.split(/\s+/).map(Number);
    return execPy(`click_at_xy(${x}, ${y})\nprint(page_info())`);
  }
  const idx = Number(v);
  if (!Number.isFinite(idx) || idx < 0 || idx > 1000) return "Error: invalid index";
  // Index -> AX node -> box center -> click
  return execPy(`idx=${idx}\ntry:\n    n=cdp("Accessibility.getFullAXTree")["nodes"][idx]\n    bid=n.get("backendDOMNodeId")\n    m=cdp("DOM.getBoxModel", backendNodeId=bid)["model"]["content"]\n    x=sum(m[0::2])/4; y=sum(m[1::2])/4\n    click_at_xy(int(x), int(y))\n    print(f"clicked {idx} at {int(x)},{int(y)}")\n    print(page_info())\nexcept Exception as e:\n    print("click error:", e)`);
}

export async function buInput(index: string, text: string): Promise<string> {
  const idx = Number(index.trim());
  if (!Number.isFinite(idx) || idx < 0 || idx > 1000) return "Error: invalid index";
  if (text.length > 2000) return "Error: text too long (max 2000)";
  if (text.startsWith("-")) return "Error: text must not start with '-'";
  const t = JSON.stringify(text);
  return execPy(`idx=${idx}\ntext=${t}\ntry:\n    n=cdp("Accessibility.getFullAXTree")["nodes"][idx]\n    bid=n.get("backendDOMNodeId")\n    m=cdp("DOM.getBoxModel", backendNodeId=bid)["model"]["content"]\n    x=sum(m[0::2])/4; y=sum(m[1::2])/4\n    click_at_xy(int(x), int(y))\n    # type via js input event for speed\n    js(f\"\"\"document.elementFromPoint({int(x)}, {int(y)})?.focus(); document.execCommand('selectAll', false); document.execCommand('insertText', false, {t});\"\"\")\n    print(f"input {idx}")\nexcept Exception as e:\n    print("input error:", e)`);
}

export async function buType(text: string): Promise<string> {
  const t = text.trim();
  if (!t) return "Error: text required";
  if (t.length > 2000) return "Error: text too long";
  if (t.startsWith("-")) return "Error: text must not start with '-'";
  return execPy(`js(${JSON.stringify(`document.activeElement && document.execCommand('insertText', false, ${JSON.stringify(t)})`)})\nprint("typed")`);
}

export async function buKeys(keys: string): Promise<string> {
  const k = keys.trim();
  if (!k) return "Error: keys required";
  if (k.length > 100) return "Error: keys too long";
  // Use js to dispatch keyboard event
  return execPy(`js(${JSON.stringify(`document.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(k)}, bubbles:true}))`)})\nprint("keys ${k}")`);
}

export async function buScreenshot(): Promise<string> {
  return execPy(`import base64\ntry:\n    data=cdp("Page.captureScreenshot")["data"]\n    print(f"screenshot {len(data)} base64")\n    print(data[:200])\nexcept Exception as e:\n    print("screenshot error:", e)`);
}

export async function buGet(what: string, index?: string, selector?: string): Promise<string> {
  const w = what.trim().toLowerCase();
  if (w === "title") return execPy(`print(js("document.title"))`);
  if (w === "html") {
    const sel = selector ? JSON.stringify(selector) : '""';
    return execPy(`print(js(${JSON.stringify(`document.querySelector(${sel})?.outerHTML?.slice(0,4000) || document.documentElement.outerHTML.slice(0,4000)`)}))`);
  }
  if (w === "text" && index) {
    const idx = Number(index);
    if (!Number.isFinite(idx)) return "Error: invalid index";
    return execPy(`idx=${idx}\ntry:\n    n=cdp("Accessibility.getFullAXTree")["nodes"][idx]\n    print(n.get("name") or js(f\"document.elementFromPoint({0},{0})?.innerText\"))\nexcept Exception as e:\n    print(e)`);
  }
  if (w === "value" && index) {
    const idx = Number(index);
    return execPy(`idx=${idx}\nprint(js(f\"document.elementFromPoint(0,0)?.value\"))`);
  }
  return "Error: unknown get (title/html/text/value)";
}

export async function buEval(jsCode: string): Promise<string> {
  const c = jsCode.trim();
  if (!c) return "Error: js required";
  if (c.length > 4000) return "Error: js too long";
  return execPy(`print(js(${JSON.stringify(c)}))`);
}

export async function buScroll(dir: string, amount?: number): Promise<string> {
  const d = dir.trim().toLowerCase();
  if (!["up", "down"].includes(d)) return "Error: dir must be up/down";
  const amt = amount && Number.isFinite(amount) ? Math.max(100, Math.min(5000, Math.floor(amount))) : 800;
  const delta = d === "down" ? amt : -amt;
  return execPy(`js(${JSON.stringify(`window.scrollBy(0, ${delta}); window.scrollY`)})\nprint("scrolled ${d} ${amt}")`);
}

export async function buTab(action: string, arg?: string): Promise<string> {
  const a = action.trim().toLowerCase();
  if (a === "list") return execPy(`print(list_tabs())`);
  if (a === "new") {
    if (arg) {
      try {
        assertPublicUrl(arg.trim());
      } catch (e) {
        return `Error: ${e instanceof Error ? e.message : "invalid url"}`;
      }
      return execPy(`new_tab(${JSON.stringify(arg.trim())})\nprint(page_info())`);
    }
    return execPy(`new_tab("about:blank")\nprint(page_info())`);
  }
  if (a === "switch" && arg) {
    const idx = Number(arg);
    if (!Number.isFinite(idx)) return "Error: invalid tab index";
    return execPy(`switch_tab(${idx})\nprint(page_info())`);
  }
  if (a === "close" && arg) {
    const idx = Number(arg);
    if (!Number.isFinite(idx)) return "Error: invalid tab index";
    return execPy(`close_tab(${idx})\nprint("closed")`);
  }
  return "Error: tab action must be list/new/switch/close";
}

export async function buWait(where: string, value: string): Promise<string> {
  const w = where.trim().toLowerCase();
  const v = value.trim();
  if (!v) return "Error: value required";
  if (w === "selector") return execPy(`import time\nfor i in range(20):\n    if js(${JSON.stringify(`document.querySelector(${JSON.stringify(v)}) != null`)})!="false":\n        print("found"); break\n    time.sleep(0.5)\nelse: print("timeout")`, 15000);
  if (w === "text") return execPy(`import time\nfor i in range(20):\n    if ${JSON.stringify(v)} in js("document.body.innerText"):\n        print("found text"); break\n    time.sleep(0.5)\nelse: print("timeout")`, 15000);
  return "Error: wait where must be selector/text";
}

export async function buClose(): Promise<string> {
  return new Promise<string>((r) => exec(`browser-use --reload 2>&1`, { timeout: 10000 }, (e, so, se) => r(truncate((so || "") + (se || "")))));
}
