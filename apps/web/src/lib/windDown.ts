import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { appRoot, isTestUserKey, userDataRoot } from "./users";
import { pushToOwner } from "../channels/pushTarget";
import { logInfo, logError } from "./appLogger";

function windDownHour(): number {
  const v = Number(process.env.WIND_DOWN_HOUR);
  return Number.isFinite(v) ? Math.max(0, Math.min(23, Math.round(v))) : 22;
}

function jakartaDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function jakartaHour(d: Date): number {
  try { return Number(new Intl.DateTimeFormat("en-US", { hour12: false, hour: "2-digit", timeZone: "Asia/Jakarta" }).format(d)); } catch { return NaN; }
}
function sleepPath(userKey: string): string { return join(userDataRoot(), userKey, "sleep.json"); }

export function logSleep(rawUser: unknown, at = Date.now()): void {
  const key = String(rawUser || "").trim();
  if (!key || isTestUserKey(key)) return;
  const userKey = key.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
  if (!userKey) return;
  const file = sleepPath(userKey);
  try {
    mkdirSync(dirname(file), { recursive: true });
    const arr: Array<{ date: string; at: number }> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
    const day = jakartaDay(new Date(at));
    if (arr.some((e) => e.date === day)) return;
    arr.push({ date: day, at });
    while (arr.length > 90) arr.shift();
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(arr, null, 2));
    renameSync(tmp, file);
  } catch { /* silent */ }
}

function stateFile(): string { return join(appRoot(), ".data", "winddown-state.json"); }
function readLast(): string { try { return JSON.parse(readFileSync(stateFile(), "utf8")).lastFiredDate || ""; } catch { return ""; } }
function saveLast(d: string): void { try { mkdirSync(dirname(stateFile()), { recursive: true }); const t=`${stateFile()}.tmp`; writeFileSync(t, JSON.stringify({ lastFiredDate: d })); renameSync(t, stateFile()); } catch {} }

let lastFired = readLast();
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

async function tick(): Promise<void> {
  const now = new Date();
  if (windDownHour() === 0) return;
  if (jakartaHour(now) !== windDownHour()) return;
  const day = jakartaDay(now);
  if (lastFired === day) return;
  lastFired = day;
  saveLast(day);
  const root = userDataRoot();
  if (!existsSync(root)) return;
  for (const n of readdirSync(root, { withFileTypes: true }).filter((d)=>d.isDirectory()).map((d)=>d.name).filter((n)=>/^[A-Za-z0-9._-]+$/.test(n) && !isTestUserKey(n))) {
    try {
      const msg = `🌙 Waktunya wind-down, beb — siapin tidur yuk. Matikan layar, tarik napas pelan. Bilang "mau tidur" kalau sudah rebahan, nanti aku catat jam tidurmu 🌸`;
      const ok = await pushToOwner(msg);
      if (ok) logInfo("winddown", `pushed for ${n}`);
    } catch (e) { logError("winddown", String(e)); }
  }
}

export function startWindDownRunner(): void {
  if (started) return;
  started = true;
  if (!windDownHour()) { logInfo("winddown", "disabled"); return; }
  logInfo("winddown", `starting — daily at ${String(windDownHour()).padStart(2, "0")}:00`);
  setTimeout(() => void tick(), 45000);
  timer = setInterval(() => void tick(), 60 * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
}
export function stopWindDownRunner(): void { if (timer) clearInterval(timer); timer = null; started = false; }
export async function runWindDownTick(): Promise<void> { await tick(); }
