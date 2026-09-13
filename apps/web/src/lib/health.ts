// Health Tracker — water + sleep per-user JSON (no DB, atomic write)
// File: .data/users/<user>/health.json  { water: [{time,cups}], sleep: [{time,action}] }

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sanitizeUser, userDataRoot } from "./users";

type WaterEntry = { time: string; cups: number };
type SleepEntry = { time: string; action: "sleep" | "wake" };
type HealthData = { water: WaterEntry[]; sleep: SleepEntry[] };

function pathFor(rawUser: unknown): string | null {
  const k = sanitizeUser(rawUser);
  if (!k) return null;
  return join(userDataRoot(), k, "health.json");
}

function readData(rawUser: unknown): HealthData {
  const p = pathFor(rawUser);
  if (!p) return { water: [], sleep: [] };
  try {
    const raw = readFileSync(p, "utf8");
    const d = JSON.parse(raw) as HealthData;
    return { water: Array.isArray(d.water) ? d.water : [], sleep: Array.isArray(d.sleep) ? d.sleep : [] };
  } catch { return { water: [], sleep: [] }; }
}

function writeData(rawUser: unknown, data: HealthData): void {
  const p = pathFor(rawUser);
  if (!p) return;
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, p);
}

export function addWater(cups: number, rawUser: unknown): string {
  if (!Number.isFinite(cups) || cups <= 0 || cups > 20) return "Error: cups harus 1–20";
  const d = readData(rawUser);
  d.water.push({ time: new Date().toISOString(), cups: Math.floor(cups) });
  // cap 500 entries
  if (d.water.length > 500) d.water.splice(0, d.water.length - 500);
  writeData(rawUser, d);
  const today = d.water.filter((w) => new Date(w.time).toDateString() === new Date().toDateString()).reduce((s, w) => s + w.cups, 0);
  return `Tercatat ${Math.floor(cups)} gelas 💧 — hari ini ${today} gelas.`;
}

export function addSleep(rawUser: unknown): string {
  const d = readData(rawUser);
  d.sleep.push({ time: new Date().toISOString(), action: "sleep" });
  if (d.sleep.length > 500) d.sleep.splice(0, d.sleep.length - 500);
  writeData(rawUser, d);
  return "Tercatat tidur 😴 — semoga nyenyak beb, nanti kabari pas bangun ya.";
}

export function addWake(rawUser: unknown): string {
  const d = readData(rawUser);
  const last = [...d.sleep].reverse().find((s) => s.action === "sleep");
  d.sleep.push({ time: new Date().toISOString(), action: "wake" });
  if (d.sleep.length > 500) d.sleep.splice(0, d.sleep.length - 500);
  writeData(rawUser, d);
  if (last) {
    const h = ((Date.now() - new Date(last.time).getTime()) / 3600000).toFixed(1);
    return `Tercatat bangun ☀️ — tidur ${h} jam. Semangat harinya beb!`;
  }
  return "Tercatat bangun ☀️";
}

export function healthStats(rawUser: unknown): string {
  const d = readData(rawUser);
  const todayStr = new Date().toDateString();
  const todayWater = d.water.filter((w) => new Date(w.time).toDateString() === todayStr);
  const todayCups = todayWater.reduce((s, w) => s + w.cups, 0);
  const totalWater = d.water.length;
  const totalSleep = d.sleep.length;
  // last sleep duration if last action is wake
  let lastDur = "";
  if (d.sleep.length >= 2) {
    const last = d.sleep[d.sleep.length - 1];
    const prev = d.sleep[d.sleep.length - 2];
    if (last.action === "wake" && prev.action === "sleep") {
      const h = ((new Date(last.time).getTime() - new Date(prev.time).getTime()) / 3600000).toFixed(1);
      lastDur = ` — terakhir ${h} jam`;
    }
  }
  return `Hari ini: ${todayCups} gelas ( ${todayWater.length} catatan ) · Total: ${totalWater} water / ${totalSleep} sleep${lastDur}`;
}

export function healthUpdateLast(cups: number, rawUser: unknown): string {
  const d = readData(rawUser);
  if (!d.water.length) return "Error: belum ada catatan water";
  if (!Number.isFinite(cups) || cups <= 0) return "Error: cups harus >0";
  d.water[d.water.length - 1].cups = Math.floor(cups);
  writeData(rawUser, d);
  return `Diupdate jadi ${Math.floor(cups)} gelas.`;
}

export function healthDeleteLast(rawUser: unknown): string {
  const d = readData(rawUser);
  if (!d.water.length) return "Error: belum ada catatan water";
  d.water.pop();
  writeData(rawUser, d);
  return "Catatan terakhir dihapus.";
}
