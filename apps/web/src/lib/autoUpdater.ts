// autoUpdater.ts — mandiri auto-updater for Mia (no ~/.openclaw, no Clawdbot/clawdhub).
// Daily self-update: git pull (--ff-only) → npm install → gates (typecheck/test/verify)
// → summary push to owner. Storage: <appRoot>/.data/auto-updater/state.json (atomic, capped
// history, run lock). Companion to ByteRover/Summarize/Humanizer/FreeRide ports.
//
// Knobs (.env.local or .data/config.json — env wins):
//   AUTO_UPDATE_ENABLED     (1)      on/off the whole feature
//   AUTO_UPDATE_HOUR        (4)      run time wall-clock hour, Asia/Jakarta
//   AUTO_UPDATE_GRACE_MIN   (120)    how long after the hour we may still run it once/day
//   AUTO_UPDATE_TICK_MIN    (5)      scheduler check interval (0 = no scheduler, manual/tool only)
//   AUTO_UPDATE_REMOTE      (origin)
//   AUTO_UPDATE_BRANCH      (main)
//   AUTO_UPDATE_NPM         (1)      run npm install when new commits came in
//   AUTO_UPDATE_VERIFY      (1)      also run npx tsx apps/web/verify.ts among the gates
//   AUTO_UPDATE_RESTART     (1)      respawn the dev server after a successful update
//   AUTO_UPDATE_DELIVER     (1)      push the summary via pushToOwner (Telegram/Discord)
//   AUTO_UPDATE_TIMEOUT_MS  (600000) per-command timeout

import { execFile, spawn } from "node:child_process";
import { mkdirSync, readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { appRoot, repoRoot } from "./users";
import { pushToOwner } from "../channels/pushTarget";
import { logInfo, logError } from "./appLogger";
import {
  autoUpdateEnabled,
  autoUpdateHour,
  autoUpdateGraceMin,
  autoUpdateTickMinutes,
  autoUpdateRemote,
  autoUpdateBranch,
  autoUpdateNpm,
  autoUpdateVerify,
  autoUpdateRestart,
  autoUpdateDeliver,
  autoUpdateTimeoutMs,
} from "./config";
import { alreadyStarted, resetStarted } from "./once";

const DIR = join(appRoot(), ".data", "auto-updater");
const STATE_FILE = join(DIR, "state.json");

type GateResult = { name: string; ok: boolean; note: string };
type RunEntry = {
  at: string;
  ok: boolean;
  skippedReason?: string;
  commits?: { before: string; after: string; count: number; list: string[] };
  depsChanged?: boolean;
  gates?: GateResult[];
  error?: string;
  restarted?: boolean;
};
type State = {
  lastRunAt?: string;
  lastRunDate?: string;
  lastOk?: boolean;
  history: RunEntry[];
};

function ensureDir(): void {
  mkdirSync(DIR, { recursive: true });
}
function atomicWrite(file: string, data: unknown): void {
  ensureDir();
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}
function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function loadState(): State {
  return readJson<State>(STATE_FILE, { history: [] });
}
function saveState(s: State): void {
  if (s.history.length > 10) s.history = s.history.slice(-10);
  atomicWrite(STATE_FILE, s);
}

// ── Asia/Jakarta civil time helpers (schedule & dedup operate on wall clock) ──
function jakartaFields(d: Date): { y: number; m: number; day: number; h: number; min: number } {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return { y: get("year"), m: get("month"), day: get("day"), h: get("hour") % 24, min: get("minute") };
}
function todayJakarta(): string {
  const { y, m, day } = jakartaFields(new Date());
  return `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function jakartaHour(): number {
  return jakartaFields(new Date()).h;
}

// ── Process helpers ──
type CmdResult = { code: number; stdout: string; stderr: string };
function runCmd(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<CmdResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? autoUpdateTimeoutMs(), maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number" ? (err as NodeJS.ErrnoException & { code: number }).code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}
function tail(s: string, n = 350): string {
  const t = s.trim();
  return t.length <= n ? t : "…" + t.slice(-n);
}

// ── Concurrency lock (in-memory flag + on-disk pid marker) ──
const running = { value: false };
function acquireLock(): boolean {
  if (running.value) return false;
  running.value = true;
  try {
    atomicWrite(join(DIR, "lock.json"), { pid: process.pid, at: new Date().toISOString() });
  } catch { /* best effort */ }
  return true;
}
function releaseLock(): void {
  running.value = false;
  try {
    const f = join(DIR, "lock.json");
    if (existsSync(f)) unlinkSync(f);
  } catch { /* best effort */ }
}

function isUnderTest(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.argv.some((a) => /verify\.ts$|\.test\.(ts|tsx|js)$/.test(a)) ||
    process.env.MIA_RESTART_DISABLED === "1"
  );
}

// ── Restart: reincarnate the dev server after a successful update ──
// Detached + delayed so the summary push ships first. Only for the running
// next dev / next start process, never under tests/verify (isUnderTest).
function scheduleRestart(): void {
  if (!autoUpdateRestart() || isUnderTest()) return;
  try {
    const root = repoRoot();
    // Fixed command (all paths constant, no user input) — safe to run through bash.
    const script = [
      "sleep 8",
      'pkill -f "next dev" || true',
      "sleep 2",
      `rm -rf '${appRoot}/.next'`,
      `cd '${root}' && nohup npm run dev -w @voice/web >> /tmp/mia-dev.log 2>&1 &`,
    ].join("; ");
    const child = spawn("bash", ["-c", script], { detached: true, stdio: "ignore" });
    child.unref();
    logInfo("auto-update", "scheduled server restart in ~10s");
  } catch (e) {
    logError("auto-update", `restart spawn failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ── Core: one update run ──
/**
 * Run one self-update cycle. `force` bypasses nothing (callers decide), but
 * respects AUTO_UPDATE_ENABLED=0. `deliver` controls the owner summary push.
 */
export async function runAutoUpdate(opts: { force?: boolean; deliver?: boolean } = {}): Promise<string> {
  if (!autoUpdateEnabled()) return "Auto-Update disabled (AUTO_UPDATE_ENABLED=0) 🌸";
  if (!acquireLock()) return "Auto-Update masih jalan — tunggu selesai dulu ya 🌸";
  const deliver = opts.deliver ?? autoUpdateDeliver();
  const entry: RunEntry = { at: new Date().toISOString(), ok: true };
  let summary = "";
  try {
    const root = repoRoot();
    const remote = autoUpdateRemote();
    const branch = autoUpdateBranch();

    // 1) Snapshot + dirty check.
    let before = "";
    {
      const r = await runCmd("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeoutMs: 60000 });
      before = r.stdout.trim() || "???";
    }
    const dirty = await runCmd("git", ["status", "--porcelain"], { cwd: root, timeoutMs: 60000 });
    if (dirty.stdout.trim() !== "") {
      entry.ok = false;
      entry.skippedReason = `working tree dirty (${dirty.stdout.trim().split("\n").length} file) — commit/stash dulu, pull di-skip`;
      saveState({ ...loadState(), lastRunAt: entry.at, lastRunDate: todayJakarta(), lastOk: false, history: [entry, ...loadState().history] });
      summary = `🔄 *Auto-Update Mia — di-skip*\n\n${entry.skippedReason}\n\nCommit lokal belum rapi, jadi nggak aku sentuh biar aman. ` +
        `Kalau mau update sekarang: beresin dulu (commit/stash), terus minta 'update Mia' ya 🌸`;
      logInfo("auto-update", "skipped: " + entry.skippedReason);
      return summary;
    }

    // 2) Fast-forward pull.
    const pull = await runCmd("git", ["pull", "--ff-only", remote, branch], { cwd: root, timeoutMs: 120000 });
    if (pull.code !== 0) {
      entry.ok = false;
      entry.error = `git pull gagal: ${tail(pull.stderr)}`;
      saveState({ ...loadState(), lastRunAt: entry.at, lastRunDate: todayJakarta(), lastOk: false, history: [entry, ...loadState().history] });
      summary = `🔄 *Auto-Update Mia — gagal*\n\n${entry.error}\n\nCek koneksi/credential git (` +
        `'git pull' manual buat lihat detail).`;
      logError("auto-update", entry.error);
      return summary;
    }

    // 3) New commits?
    const after = await runCmd("git", ["rev-parse", "--short", "HEAD"], { cwd: root, timeoutMs: 60000 });
    const a = after.stdout.trim() || "???";
    if (a === before) {
      entry.ok = true;
      entry.commits = { before, after: a, count: 0, list: [] };
      saveState({ ...loadState(), lastRunAt: entry.at, lastRunDate: todayJakarta(), lastOk: true, history: [entry, ...loadState().history] });
      if (deliver) {
        summary = `🔄 *Auto-Update Mia*\n\nUdah up to date (${branch} @ ${a}) — nggak ada commit baru 🌸`;
        const sent = await pushToOwner(summary);
        if (sent) logInfo("auto-update", `up-to-date summary pushed (${branch} ${a})`);
      }
      return summary || `Auto-Update: up to date @ ${a}`;
    }

    const log = await runCmd("git", ["log", "--oneline", `${before}..${a}`], { cwd: root, timeoutMs: 60000 });
    const list = log.stdout.trim().split("\n").filter(Boolean).slice(0, 8);
    entry.commits = { before, after: a, count: list.length, list };
    logInfo("auto-update", `pulled ${list.length} commit(s): ${before}..${a}`);

    // 4) Deps.
    entry.depsChanged = a !== before;
    if (autoUpdateNpm()) {
      const ni = await runCmd("npm", ["install"], { cwd: root, timeoutMs: 600000 });
      if (ni.code !== 0) {
        entry.depsChanged = true;
        // npm install failure is not fatal-fatal: still report gates below, but flag it.
        logError("auto-update", `npm install issue (code ${ni.code}): ${tail(ni.stderr)}`);
      }
    }

    // 5) Gates.
    const gates: GateResult[] = [];
    {
      const g = await runCmd("npm", ["run", "typecheck"], { cwd: root, timeoutMs: 300000 });
      gates.push({ name: "typecheck", ok: g.code === 0, note: g.code === 0 ? "ok" : tail(g.stderr || g.stdout) });
      logInfo("auto-update", `gate typecheck: ${g.code === 0 ? "ok" : "FAIL"}`);
    }
    {
      const g = await runCmd("npm", ["test"], { cwd: root, timeoutMs: 300000 });
      gates.push({ name: "test", ok: g.code === 0, note: g.code === 0 ? "ok" : tail(g.stderr || g.stdout) });
      logInfo("auto-update", `gate test: ${g.code === 0 ? "ok" : "FAIL"}`);
    }
    if (autoUpdateVerify()) {
      const g = await runCmd("npx", ["tsx", "apps/web/verify.ts"], { cwd: root, timeoutMs: 300000 });
      gates.push({ name: "verify", ok: g.code === 0, note: g.code === 0 ? "ok" : tail(g.stderr || g.stdout) });
      logInfo("auto-update", `gate verify: ${g.code === 0 ? "ok" : "FAIL"}`);
    }
    entry.gates = gates;

    const allOk = gates.every((g) => g.ok);
    entry.ok = allOk;
    const state = loadState();
    state.lastRunAt = entry.at;
    state.lastRunDate = todayJakarta();
    state.lastOk = allOk;
    state.history = [entry, ...state.history];
    saveState(state);

    // 6) Restart on success (new code is live only after a fresh boot for env/deps).
    if (allOk) {
      scheduleRestart();
      entry.restarted = autoUpdateRestart() && !isUnderTest();
    }

    // 7) Summary.
    const lines: string[] = [];
    const header = allOk ? "🔄 *Auto-Update Mia — sukses*" : "🔄 *Auto-Update Mia — gate ada yang merah*";
    lines.push(header, "");
    lines.push(`Commit: \`${before}\` → \`${a}\` (${list.length})`);
    for (const c of list) lines.push(`• \`${c}\``);
    if (entry.depsChanged) lines.push("", "Dependencies: npm install selesai");
    const bad = gates.filter((g) => !g.ok);
    if (bad.length) {
      lines.push("", `Gate gagal (${bad.length}/${gates.length}):`);
      for (const g of bad) lines.push(`• ❌ ${g.name} — ${g.note}`);
    } else {
      lines.push("", `Gate: ${gates.map((g) => `✅ ${g.name}`).join(" · ")}`);
    }
    if (allOk && entry.restarted) lines.push("", "Server lagi restart otomatis biar kode baru aktif 🌸");
    if (!allOk) lines.push("", `Kalau mau balik: \`git reset --hard ${before}\``);
    summary = lines.join("\n");

    if (deliver) {
      const sent = await pushToOwner(summary);
      if (sent) logInfo("auto-update", `summary pushed (${allOk ? "ok" : "failed"})`);
    }
    return summary;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    entry.ok = false;
    entry.error = msg;
    const state = loadState();
    state.lastRunAt = entry.at;
    state.lastRunDate = todayJakarta();
    state.lastOk = false;
    state.history = [entry, ...state.history];
    saveState(state);
    summary = `🔄 *Auto-Update Mia — error*\n\n${tail(msg)}\n\nCek log buat detail.`;
    logError("auto-update", msg);
    if (deliver) await pushToOwner(summary).catch(() => {});
    return summary;
  } finally {
    releaseLock();
  }
}

// ── Status (read, no side effects) ──
export function autoUpdateStatus(): string {
  const s = loadState();
  const h = autoUpdateHour();
  const last = s.history[0];
  const gateTxt = (g?: GateResult[]) => (g && g.length ? g.map((x) => `${x.ok ? "✅" : "❌"} ${x.name}`).join(" ") : "—");
  const lines = [
    "🔄 Auto-Update Mia",
    "━━━━━━━━━━━━━━━━━━",
    `Status: ${autoUpdateEnabled() ? "aktif" : "mati (AUTO_UPDATE_ENABLED=0)"}`,
    `Jadwal: tiap hari ${String(h).padStart(2, "0")}:00 (Asia/Jakarta)${autoUpdateTickMinutes() > 0 ? `, cek tiap ${autoUpdateTickMinutes()}m` : ", scheduler off (manual/tool only)"}`,
    `Pull: ${autoUpdateRemote()}/${autoUpdateBranch()}`,
    `Gate: typecheck · test${autoUpdateVerify() ? " · verify" : ""}${autoUpdateNpm() ? " · npm install" : ""}`,
    `Restart otomatis: ${autoUpdateRestart() ? "on" : "off"} · Ringkasan push: ${autoUpdateDeliver() ? "on" : "off"}`,
    "",
    `Last run: ${s.lastRunAt ? new Date(s.lastRunAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" }) : "belum pernah"}`,
    ...(last
      ? [
          last.ok ? "Hasil: OK" : `Hasil: ${last.skippedReason ? "di-skip" : "gagal"}`,
          last.skippedReason ? `  ${last.skippedReason}` : "",
          last.commits && last.commits.count ? `  Commit: ${last.commits.before} → ${last.commits.after} (${last.commits.count})` : "",
          last.error ? `  ${tail(last.error, 160)}` : "",
          last.gates ? `  Gates: ${gateTxt(last.gates)}` : "",
        ].filter(Boolean)
      : []),
    "",
    `Riwayat: ${s.history.length} run${s.history.length ? " (terakhir " + s.history.length + " disimpan)" : ""}`,
  ];
  return lines.join("\n");
}

// ── Scheduler ──
let timer: NodeJS.Timeout | null = null;

function dueNow(): boolean {
  if (todayJakarta() === loadState().lastRunDate) return false;
  const h = jakartaHour();
  const target = autoUpdateHour();
  const grace = Math.max(0, autoUpdateGraceMin());
  const nowMin = h * 60;
  const targetMin = target * 60;
  return nowMin >= targetMin && nowMin <= targetMin + grace;
}

async function checkAndRun(): Promise<void> {
  try {
    if (dueNow()) {
      logInfo("auto-update", `scheduled run at ${todayJakarta()} ${String(jakartaHour()).padStart(2, "0")}:00 window`);
      await runAutoUpdate({ deliver: true });
    }
  } catch (e) {
    logError("auto-update", `scheduler tick failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Start the daily self-update scheduler. Idempotent (Next may call twice). */
export function startAutoUpdater(): void {
  // globalThis guard (see lib/once.ts): HMR must not add a second timer.
  if (alreadyStarted("auto-updater")) return;
  const tickMin = autoUpdateTickMinutes();
  if (tickMin <= 0) {
    logInfo("auto-update", "scheduler off (AUTO_UPDATE_TICK_MIN=0)");
    return;
  }

  logInfo("auto-update", `starting — daily @ ${String(autoUpdateHour()).padStart(2, "0")}:00 (Asia/Jakarta), tick ${tickMin}m`);
  // Give bots a moment to register push targets, then check once (handles a
  // server that boots inside the grace window), then on interval.
  setTimeout(() => void checkAndRun(), 90 * 1000);
  timer = setInterval(() => void checkAndRun(), tickMin * 60 * 1000);
  if (timer && typeof timer.unref === "function") timer.unref();
}

/** For tests: one scheduler pass immediately. */
export async function runAutoUpdaterTick(): Promise<void> {
  await checkAndRun();
}

export function stopAutoUpdater(): void {
  if (timer) clearInterval(timer);
  timer = null;
  resetStarted("auto-updater");
}