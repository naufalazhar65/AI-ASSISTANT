// cua-driver wrapper — drive native GUI apps (macOS) via CLI
// Requires: cua-driver 0.22+ (binary at ~/.local/bin/cua-driver), daemon `cua-driver serve` handles policy
// Docs: https://cua.ai/docs/cua-driver — snapshot invariant (get_window_state before click) is mandatory

import { execFile } from "node:child_process";

function run(tool: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const json = JSON.stringify(args);
    execFile("cua-driver", [tool, json], { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message).slice(0, 2000);
        reject(new Error(`${tool} failed: ${msg}`));
        return;
      }
      resolve(stdout.trim().slice(0, 8000) || "(no output)");
    });
  });
}

async function ensureServe(): Promise<void> {
  // fire-and-forget serve, ignore if already running
  try {
    await new Promise<void>((res) => {
      execFile("cua-driver", ["serve"], { timeout: 3000 }, () => res());
    });
  } catch {}
  await new Promise((r) => setTimeout(r, 500));
}

export async function cuaListApps(): Promise<string> {
  await ensureServe();
  return run("list_apps", {});
}

export async function cuaLaunch(bundleId: string): Promise<string> {
  await ensureServe();
  return run("launch_app", { bundle_id: bundleId });
}

export async function cuaListWindows(pid: number): Promise<string> {
  await ensureServe();
  return run("list_windows", { pid });
}

export async function cuaWindowState(pid: number, windowId: number, noScreenshot = false): Promise<string> {
  await ensureServe();
  return run("get_window_state", { pid, window_id: windowId, include_screenshot: !noScreenshot });
}

export async function cuaClick(pid: number, windowId: number, elementIndex: number): Promise<string> {
  await ensureServe();
  return run("click", { pid, window_id: windowId, element_index: elementIndex });
}

export async function cuaClickXY(pid: number, x: number, y: number, windowId?: number): Promise<string> {
  await ensureServe();
  const args: Record<string, unknown> = { pid, x, y };
  if (windowId) args.window_id = windowId;
  return run("click", args);
}

export async function cuaType(pid: number, windowId: number, text: string, elementIndex?: number, x?: number, y?: number): Promise<string> {
  await ensureServe();
  const args: Record<string, unknown> = { pid, window_id: windowId, text };
  if (elementIndex !== undefined) args.element_index = elementIndex;
  if (x !== undefined) args.x = x;
  if (y !== undefined) args.y = y;
  return run("type_text", args);
}

export async function cuaDoctor(): Promise<string> {
  return new Promise((resolve) => {
    execFile("cua-driver", ["doctor"], { timeout: 8000 }, (err, stdout, stderr) => {
      resolve((stdout || stderr || (err?.message ?? "")).slice(0, 3000));
    });
  });
}

// ── Browser typed route (BROWSER.md) — exact native window → tab → ref ──
export async function cuaStartSession(session: string, captureScope: "auto" | "window" | "desktop" = "auto"): Promise<string> {
  await ensureServe();
  return run("start_session", { session, capture_scope: captureScope });
}

export async function cuaGetBrowserState(args: Record<string, unknown>): Promise<string> {
  await ensureServe();
  return run("get_browser_state", args);
}

export async function cuaBrowserClick(args: Record<string, unknown>): Promise<string> {
  await ensureServe();
  return run("browser_click", args);
}

export async function cuaBrowserType(args: Record<string, unknown>): Promise<string> {
  await ensureServe();
  return run("browser_type", args);
}

export async function cuaBrowserNavigate(targetId: string, tabId: string, url: string, session: string): Promise<string> {
  await ensureServe();
  return run("browser_navigate", { target_id: targetId, tab_id: tabId, url, session });
}
