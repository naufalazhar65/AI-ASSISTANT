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
  const allowed = ["ls", "pwd", "cat", "git", "node", "npm", "pmset", "system_profiler", "ioreg", "uptime", "whoami", "hostname", "df", "ps"];
  const parts = command.trim().split(/\s+/);
  const cmd = parts[0];
  if (!allowed.includes(cmd)) throw new Error(`device exec: command ${cmd} not allowed — try ls, pwd, cat, git status, pmset -g batt, etc.`);
  return new Promise((resolve, reject) => {
    execFile(cmd, parts.slice(1), { timeout: 8000, maxBuffer: 60000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim().slice(0, 6000) || "(no output)");
    });
  });
}

export async function deviceBattery(rawUser: unknown, deviceId: string): Promise<string> {
  const device = requireDeviceCapability(rawUser, deviceId, "exec");
  if (device.platform === "macos") {
    return new Promise((resolve) => {
      execFile("pmset", ["-g", "batt"], { timeout: 5000 }, (err, stdout) => {
        if (!err && stdout) {
          resolve(`Mac battery: ${stdout.trim().slice(0, 500)}`);
          return;
        }
        execFile("ioreg", ["-rc", "AppleSmartBattery"], { timeout: 5000 }, (err2, stdout2) => {
          if (!err2 && stdout2) {
            const cap = stdout2.match(/"Capacity"\s*=\s*(\d+)/);
            const cur = stdout2.match(/"CurrentCapacity"\s*=\s*(\d+)/);
            if (cap && cur) {
              const pct = Math.round((parseInt(cur[1]) / parseInt(cap[1])) * 100);
              resolve(`Mac battery: ${pct}% (CurrentCapacity ${cur[1]}/${cap[1]})`);
              return;
            }
          }
          resolve("Battery info unavailable — try device_exec with pmset or check System Settings");
        });
      });
    });
  }
  return `Battery request queued for ${device.name} (${device.platform}). The device will report when online.`;
}

export async function deviceScreenshot(rawUser: unknown, deviceId: string): Promise<string> {
  requireDeviceCapability(rawUser, deviceId, "screenshot");
  return new Promise((resolve, reject) => {
    const out = `/tmp/mia_screenshot_${Date.now()}.png`;
    execFile("screencapture", ["-x", out], { timeout: 10000 }, (err) => {
      if (err) return reject(new Error(`screencapture failed: ${err.message} — display locked/sleep or no Screen Recording permission`));
      if (!existsSync(out)) return reject(new Error("screenshot not created"));
      resolve(`Screenshot saved to ${out} (on device Mac). Use file_read to inspect if needed, or describe that screenshot was taken.`);
    });
  });
}

export async function deviceLocation(rawUser: unknown, deviceId: string): Promise<string> {
  requireDeviceCapability(rawUser, deviceId, "location");
  const device = getDevice(rawUser, deviceId)!;
  // For local-mac, try IP-based location (best-effort, no hardware GPS)
  if (device.platform === "macos") {
    return new Promise((resolve) => {
      execFile("curl", ["-s", "--max-time", "5", "https://ipinfo.io/json"], { timeout: 7000 }, (err, stdout) => {
        if (!err && stdout) {
          try {
            const j = JSON.parse(stdout) as { city?: string; region?: string; country?: string; loc?: string };
            const loc = j.loc || "unknown";
            const city = [j.city, j.region, j.country].filter(Boolean).join(", ");
            resolve(`Location (IP-based, approximate): ${city || "unknown"} (${loc}) — from ipinfo.io`);
            return;
          } catch { /* fallthrough */ }
        }
        resolve("Location unavailable (no GPS on Mac, IP lookup failed). Pair an iOS/Android device with location capability for precise GPS.");
      });
    });
  }
  // For iOS/Android, the device should have reported its location via pending command queue (see deviceCommands).
  // For now, return a pending state.
  return `Location request queued for ${device.name} (${device.platform}). The device will report its GPS when next online.`;
}

export async function deviceCamera(rawUser: unknown, deviceId: string): Promise<string> {
  requireDeviceCapability(rawUser, deviceId, "camera");
  const device = getDevice(rawUser, deviceId)!;
  if (device.platform === "macos") {
    // Try imagesnap (brew install imagesnap) or use screencapture as fallback for camera
    return new Promise((resolve, reject) => {
      const out = `/tmp/mia_camera_${Date.now()}.jpg`;
      execFile("imagesnap", [out], { timeout: 10000 }, (err) => {
        if (!err && existsSync(out)) {
          resolve(`Camera photo saved to ${out} (Mac FaceTime camera via imagesnap).`);
          return;
        }
        // Fallback: try screencapture of camera preview is not available, so just report
        reject(new Error("camera not available — install imagesnap (`brew install imagesnap`) or pair an iOS/Android device with camera capability"));
      });
    });
  }
  return `Camera request queued for ${device.name} (${device.platform}). The device will capture and upload when next online.`;
}

// Ensure a default local macOS device exists for the owner (auto-pair on first use, no secret needed if none set)
export function ensureLocalDevice(rawUser: unknown): Device | null {
  const userKey = sanitizeUser(rawUser);
  if (!userKey) return null;
  const devices = readDevices(rawUser);
  const existing = devices.find((d) => d.platform === "macos" && d.name === "local-mac");
  if (existing) {
    // Upgrade existing local-mac to include new caps if missing (for existing installs)
    const needed: DeviceCapability[] = ["screenshot", "exec", "location", "camera"];
    const missing = needed.filter((c) => !existing.capabilities.includes(c));
    if (missing.length) {
      const idx = devices.findIndex((d) => d.id === existing.id);
      devices[idx] = { ...existing, capabilities: [...existing.capabilities, ...missing] };
      writeDevices(devices, userKey);
      return devices[idx];
    }
    return existing;
  }
  if (DEVICE_SECRET) return null;
  return pairDevice(rawUser, "", "local-mac", "macos", ["screenshot", "exec", "location", "camera"]);
}
