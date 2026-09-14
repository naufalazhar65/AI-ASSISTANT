// cua-driver wrapper — drive native GUI apps (macOS) via CLI
// Requires: cua-driver 0.22+ (binary at ~/.local/bin/cua-driver), daemon `cua-driver serve` handles policy
// Docs: https://cua.ai/docs/cua-driver — snapshot invariant (get_window_state before click) is mandatory

import { execFile, spawn } from "node:child_process";

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
  // Check if daemon already running
  const running = await new Promise<boolean>((res) => {
    execFile("cua-driver", ["status"], { timeout: 3000 }, (err, stdout) => {
      if (!err && stdout && stdout.toLowerCase().includes("running")) res(true);
      else res(false);
    });
  });
  if (running) return;
  // Start daemon detached (no timeout kill)
  try {
    const child = spawn("cua-driver", ["serve"], { detached: true, stdio: "ignore" });
    child.unref();
  } catch {}
  // macOS LaunchServices form (recommended for TCC)
  try {
    spawn("open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], { detached: true, stdio: "ignore" }).unref();
  } catch {}
  await new Promise((r) => setTimeout(r, 1500));
}

export async function cuaListApps(): Promise<string> {
  await ensureServe();
  return run("list_apps", {});
}

export async function cuaLaunch(bundleId: string, urls?: string[]): Promise<string> {
  await ensureServe();
  const args: Record<string, unknown> = { bundle_id: bundleId };
  if (urls && urls.length) args.urls = urls;
  return run("launch_app", args);
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

// ── Keyboard / mouse / screen / clipboard extras (cua-driver native tools) ──
export type CuaInputOpts = { pid?: number; windowId?: number; deliveryMode?: "background" | "foreground" };

export async function cuaHotkey(keys: string[], opts: CuaInputOpts = {}): Promise<string> {
  await ensureServe();
  const args: Record<string, unknown> = { keys };
  if (opts.pid) args.pid = opts.pid;
  if (opts.windowId) args.window_id = opts.windowId;
  if (opts.deliveryMode) args.delivery_mode = opts.deliveryMode;
  return run("hotkey", args);
}

export async function cuaPressKey(key: string, modifiers: string[] | undefined, opts: CuaInputOpts = {}): Promise<string> {
  await ensureServe();
  const args: Record<string, unknown> = { key };
  if (modifiers?.length) args.modifiers = modifiers;
  if (opts.pid) args.pid = opts.pid;
  if (opts.windowId) args.window_id = opts.windowId;
  if (opts.deliveryMode) args.delivery_mode = opts.deliveryMode;
  return run("press_key", args);
}

export async function cuaScroll(args: { pid?: number; windowId?: number; direction: "up" | "down" | "left" | "right"; amount?: number; by?: "line" | "page" }): Promise<string> {
  await ensureServe();
  const a: Record<string, unknown> = { direction: args.direction };
  if (args.pid) a.pid = args.pid;
  if (args.windowId) a.window_id = args.windowId;
  if (args.amount) a.amount = args.amount;
  if (args.by) a.by = args.by;
  return run("scroll", a);
}

export async function cuaRightClick(args: { pid: number; windowId?: number; elementIndex?: number; x?: number; y?: number }): Promise<string> {
  await ensureServe();
  const a: Record<string, unknown> = { pid: args.pid };
  if (args.elementIndex !== undefined) {
    a.element_index = args.elementIndex;
    if (args.windowId) a.window_id = args.windowId;
  } else {
    a.x = args.x;
    a.y = args.y;
  }
  return run("right_click", a);
}

export async function cuaDoubleClick(args: { pid?: number; windowId?: number; elementIndex?: number; x?: number; y?: number }): Promise<string> {
  await ensureServe();
  const a: Record<string, unknown> = {};
  if (args.pid) a.pid = args.pid;
  if (args.elementIndex !== undefined) {
    a.element_index = args.elementIndex;
    if (args.windowId) a.window_id = args.windowId;
  } else {
    a.x = args.x;
    a.y = args.y;
  }
  return run("double_click", a);
}

export async function cuaDrag(args: { fromX: number; fromY: number; toX: number; toY: number; pid?: number; windowId?: number; durationMs?: number; steps?: number; button?: "left" | "right" | "middle" }): Promise<string> {
  await ensureServe();
  const a: Record<string, unknown> = { from_x: args.fromX, from_y: args.fromY, to_x: args.toX, to_y: args.toY };
  if (args.pid) a.pid = args.pid;
  if (args.windowId) a.window_id = args.windowId;
  if (args.durationMs) a.duration_ms = args.durationMs;
  if (args.steps) a.steps = args.steps;
  if (args.button) a.button = args.button;
  return run("drag", a);
}

export async function cuaCursorPosition(): Promise<string> {
  await ensureServe();
  return run("get_cursor_position", {});
}

export async function cuaScreenSize(): Promise<string> {
  await ensureServe();
  return run("get_screen_size", {});
}

export async function clipboardReadText(): Promise<string> {
  await ensureServe();
  return run("clipboard_read", { include_text: true });
}

export async function clipboardWriteText(text: string): Promise<string> {
  await ensureServe();
  return run("clipboard_write", { text });
}

/** Lightweight desktop snapshot: running apps + on-screen windows (bounds, z-order, pid). No TCC needed. */
export async function cuaAccessibilityTree(): Promise<string> {
  await ensureServe();
  return run("get_accessibility_tree", {});
}

/** Full-display capture in true screen pixels. Pass `outFile` to write a PNG instead of base64. */
export async function cuaDesktopState(outFile?: string): Promise<string> {
  await ensureServe();
  const a: Record<string, unknown> = {};
  if (outFile) a.screenshot_out_file = outFile;
  return run("get_desktop_state", a);
}

/** Cropped JPEG of a window region (x1,y1)-(x2,y2) in screenshot pixels. */
export async function cuaZoom(args: { windowId: number; x1: number; y1: number; x2: number; y2: number; pid?: number }): Promise<string> {
  await ensureServe();
  const a: Record<string, unknown> = { window_id: args.windowId, x1: args.x1, y1: args.y1, x2: args.x2, y2: args.y2 };
  if (args.pid) a.pid = args.pid;
  return run("zoom", a);
}
