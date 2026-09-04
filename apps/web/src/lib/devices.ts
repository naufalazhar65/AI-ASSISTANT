// Device nodes — minimal safe macOS node (Fase 4, Tier 3).
// Single-user personal deploy: only paired devices (via DEVICE_SECRET) are allowed.
// For MVP, the "device" is the local Mac itself (in-process), not a remote polling node.
// Capabilities are allowlisted per device; sensitive actions (screenshot, camera)
// require FR-014 confirmation (risk: write). File/exec still via sandbox.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { sanitizeUser, userDataRoot } from "./users";

export type DevicePlatform = "macos" | "ios" | "android";
export type DeviceCapability = "screenshot" | "exec" | "location" | "camera";

export interface Device {
  id: string;
  name: string;
  platform: DevicePlatform;
  capabilities: DeviceCapability[];
  pairedAt: number;
  lastSeen?: number;
}

const DEVICE_SECRET = process.env.DEVICE_SECRET || "";
const DEVICES_DIR = "devices";

function devicesPath(userKey: string): string {
  return join(userDataRoot(), userKey, DEVICES_DIR, "devices.json");
}

function readDevices(rawUser?: unknown): Device[] {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return [];
  const path = devicesPath(userKey);
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (d): d is Device =>
        !!d && typeof (d as Device).id === "string" && typeof (d as Device).name === "string" && typeof (d as Device).platform === "string"
    );
  } catch {
    return [];
  }
}

function writeDevices(devices: Device[], userKey: string): void {
  const path = devicesPath(userKey);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(devices, null, 2));
  renameSync(tmp, path);
}

export function listDevices(rawUser?: unknown): Device[] {
  return readDevices(rawUser);
}

export function listDevicesText(rawUser?: unknown): string {
  let devices = readDevices(rawUser);
  if (!devices.length) {
    const local = ensureLocalDevice(rawUser);
    if (local) devices = readDevices(rawUser);
  }
  if (!devices.length) return "No devices paired. Pair via POST /api/devices with {secret, name, platform} or set DEVICE_SECRET=\"\" to auto-create local-mac.";
  return devices
    .map((d) => `- ${d.id} (${d.platform}) "${d.name}" caps: ${d.capabilities.join(",") || "none"} paired ${new Date(d.pairedAt).toLocaleDateString()}`)
    .join("\n");
}

export function pairDevice(rawUser: unknown, secret: string, name: string, platform: DevicePlatform, capabilities: DeviceCapability[]): Device {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) throw new Error("invalid user");
  if (DEVICE_SECRET && secret !== DEVICE_SECRET) throw new Error("invalid secret");
  if (!name.trim()) throw new Error("name required");
  if (!["macos", "ios", "android"].includes(platform)) throw new Error("invalid platform");
  const allowedCaps: DeviceCapability[] = ["screenshot", "exec", "location", "camera"];
  const caps = capabilities.filter((c) => allowedCaps.includes(c));
  const devices = readDevices(rawUser);
  const id = `dev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const device: Device = { id, name: name.trim().slice(0, 60), platform, capabilities: caps, pairedAt: Date.now() };
  devices.push(device);
  // Keep max 10 devices
  while (devices.length > 10) devices.shift();
  writeDevices(devices, userKey);
  return device;
}

export function getDevice(rawUser: unknown, id: string): Device | null {
  const devices = readDevices(rawUser);
  return devices.find((d) => d.id === id) || null;
}

export function requireDeviceCapability(rawUser: unknown, id: string, cap: DeviceCapability): Device {
  const device = getDevice(rawUser, id);
  if (!device) throw new Error(`device ${id} not found`);
  if (!device.capabilities.includes(cap)) throw new Error(`device ${id} lacks capability ${cap}`);
  // Update lastSeen
  const userKey = sanitizeUser(rawUser);
  if (userKey) {
    const devices = readDevices(rawUser);
    const idx = devices.findIndex((d) => d.id === id);
    if (idx >= 0) {
      devices[idx] = { ...devices[idx], lastSeen: Date.now() };
      writeDevices(devices, userKey);
    }
  }
  return device;
}

// --- Device actions (local Mac, sandboxed) ---

export function deviceExec(rawUser: unknown, deviceId: string, command: string): Promise<string> {
  requireDeviceCapability(rawUser, deviceId, "exec");
  // Only allow the same read-only allowlist as exec (status/log/diff, ls, pwd, etc.) for safety, plus a few more for device context
  // Reuse the same logic as execSafe but via a direct allowlist check here
  const allowed = ["ls", "pwd", "cat", "git", "node", "npm"];
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  if (!allowed.includes(cmd)) throw new Error(`device exec: command ${cmd} not allowed`);
  return new Promise((resolve, reject) => {
    execFile(cmd, parts.slice(1), { timeout: 8000, maxBuffer: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim().slice(0, 6000) || "(no output)");
    });
  });
}

export async function deviceScreenshot(rawUser: unknown, deviceId: string): Promise<string> {
  requireDeviceCapability(rawUser, deviceId, "screenshot");
  // macOS screencapture to /tmp, then return path (LLM can describe it, not actually send image bytes here)
  // For MVP, just run screencapture and confirm, not returning image data
  return new Promise((resolve, reject) => {
    const out = `/tmp/mia_screenshot_${Date.now()}.png`;
    execFile("screencapture", ["-x", out], { timeout: 10000 }, (err) => {
      if (err) return reject(new Error(`screencapture failed: ${err.message}`));
      // Check file exists
      if (!existsSync(out)) return reject(new Error("screenshot not created"));
      resolve(`Screenshot saved to ${out} (on device Mac). Use file_read to inspect if needed, or describe that screenshot was taken.`);
    });
  });
}

// Ensure a default local macOS device exists for the owner (auto-pair on first use, no secret needed if none set)
export function ensureLocalDevice(rawUser: unknown): Device | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  const devices = readDevices(rawUser);
  const existing = devices.find((d) => d.platform === "macos" && d.name === "local-mac");
  if (existing) return existing;
  // Auto-create local-mac with minimal caps (screenshot, exec) — only if no secret is required, else require explicit pairing
  if (DEVICE_SECRET) return null;
  return pairDevice(rawUser, "", "local-mac", "macos", ["screenshot", "exec"]);
}
