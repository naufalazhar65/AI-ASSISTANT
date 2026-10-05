/**
 * Formal Event Bus — PRD Pixel Office §7 Fase 1 (trio Mia/Agnes/Michelle).
 *
 * Satu envelope bernama untuk semua aktivitas agent yang nyata
 * (turn mulai/selesai, tool dipanggil, konfirmasi menunggu, gagal).
 * Pixel Office / Discord trio / debug berlangganan ke stream SSE
 * (`GET /api/bus/stream`); audit log tetap menjadi history durable,
 * bus adalah feed visual live. Keduanya dibaca dari sumber yang sama
 * (eksekusi nyata) sehingga avatar tidak pernah bergerak tanpa kerja.
 *
 * Desain:
 * - Buffer in-memory terbatas (drop-oldest) + cursor seq untuk resync —
 *   pola yang sama dengan reminders (globalThis agar tahan HMR).
 * - Konteks turn berjalan via AsyncLocalStorage (juga di globalThis):
 *   `runAssistantTurn` memasang {turnId, taskId, userKey, actor};
 *   `executeTool` membacanya sehingga setiap tool_called terikat ke
 *   turn yang benar walau Telegram + Discord jalan bersamaan.
 *   Panggilan di luar turn (Live route, drill) memakai label jujur
 *   turn_external/task_ext — tidak pernah mengarang kaitan.
 * - task_id: `task_NNNN` (counter per user, zero-padded 4) per PRD §9.
 * - Semua emit best-effort: tidak pernah throw, tidak pernah mengubah hasil.
 *
 * Fase 1 meng-wire: task_created, task_started, tool_called, waiting_input,
 * task_done, task_failed. Fase 2 meng-wire sisanya: file_read/file_written
 * (baca/tulis file yang SUKSES, via fileEventFor di executeTool), task_failed
 * per-kegagalan-tool (bukan cuma gagal-turn), task_cancelled (penolakan
 * eksplisit user di jalur konfirmasi — "Not selected" TIDAK ikut: itu
 * penundaan, model boleh mengusulkan lagi). agent_delegated/task_assigned
 * diekspos lewat emitBusEvent untuk fase trio (belum ada pemanggil —
 * sengaja, prinsip no-fake-work: tidak ada event tanpa eksekusi).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { sanitizeUser } from "./users";

export type BusEventType =
  | "task_created"
  | "agent_delegated"
  | "task_assigned"
  | "task_started"
  | "tool_called"
  | "file_read"
  | "file_written"
  | "waiting_input"
  | "task_done"
  | "task_failed"
  | "task_cancelled";

export interface BusEvent {
  /** Unik, monoton: `evt_0001`, `evt_0002`, … (juga cursor resync). */
  id: string;
  /** ISO timestamp saat emit. */
  ts: string;
  /** Kunci user tersanitasi (invariant 5). */
  user: string;
  /** Turn percakapan pemilik kerja, atau `turn_external` di luar turn. */
  turn: string;
  /** `task_NNNN` per user (PRD §9), atau `task_ext` di luar turn. */
  task_id: string;
  /** Task induk bila hasil delegasi (fase trio). */
  parent_task_id?: string | null;
  type: BusEventType;
  /** Pelaku: `mia` (trio: `agnes`/`michelle`). */
  actor: string;
  /** Target delegasi/assignment (fase trio). */
  agent?: string;
  /** Workstation pixel-office (fase trio, mis. `pc-2`). */
  station?: string;
  /** Satu baris aman untuk UI (tanpa rahasia — argumen tidak ikut). */
  summary: string;
  /** Payload kecil tersanitasi (nama tool + status, tanpa argumen). */
  data?: Record<string, unknown>;
}

export interface BusTurnContext {
  turnId: string;
  taskId: string;
  userKey: string;
  actor: string;
}

interface BusCarrier {
  __busSeq?: number;
  __busTasks?: Record<string, number>;
  __busBuffer?: Array<{ seq: number; event: BusEvent }>;
  __busListeners?: Set<(e: BusEvent) => void>;
  __busAls?: AsyncLocalStorage<BusTurnContext | null>;
}

const BUS_CAP = 200;
/** Jumlah event ekor yang dikirim saat klien connect tanpa cursor. */
const BUS_REPLAY_TAIL = 20;

function carrier(): BusCarrier {
  return globalThis as unknown as BusCarrier;
}

function als(): AsyncLocalStorage<BusTurnContext | null> {
  const c = carrier();
  if (!c.__busAls) c.__busAls = new AsyncLocalStorage<BusTurnContext | null>();
  return c.__busAls;
}

/** Konteks turn yang sedang berjalan (null di luar turn). */
export function busTurnContext(): BusTurnContext | null {
  try {
    return als().getStore() ?? null;
  } catch {
    return null;
  }
}

/** Menjalankan fn di dalam konteks turn bus (dipakai runAssistantTurn). */
export async function withBusTurn<T>(ctx: BusTurnContext, fn: () => Promise<T>): Promise<T> {
  return als().run(ctx, fn);
}

/** Turn + task id baru untuk user (task counter per user, PRD §9). */
export function newBusTurn(rawUser: unknown, actor = "mia"): BusTurnContext {
  const userKey = sanitizeUser(rawUser) || "shared";
  const c = carrier();
  const n = (c.__busTasks?.[userKey] ?? 0) + 1;
  c.__busTasks = { ...c.__busTasks, [userKey]: n };
  const rand = Math.floor(Math.random() * 46656)
    .toString(36)
    .padStart(3, "0");
  return {
    turnId: `turn_${Date.now().toString(36)}${rand}`,
    taskId: `task_${String(n).padStart(4, "0")}`,
    userKey,
    actor,
  };
}

/** Emit satu event (tak pernah throw; listener yang gagal diabaikan). */
export function emitBusEvent(input: {
  user: string;
  turn?: string;
  task_id?: string;
  parent_task_id?: string | null;
  type: BusEventType;
  actor?: string;
  agent?: string;
  station?: string;
  summary: string;
  data?: Record<string, unknown>;
}): BusEvent {
  const c = carrier();
  const seq = (c.__busSeq ?? 0) + 1;
  c.__busSeq = seq;
  const event: BusEvent = {
    id: `evt_${String(seq).padStart(4, "0")}`,
    ts: new Date().toISOString(),
    user: input.user,
    turn: input.turn ?? "turn_external",
    task_id: input.task_id ?? "task_ext",
    parent_task_id: input.parent_task_id ?? null,
    type: input.type,
    actor: input.actor ?? "mia",
    agent: input.agent,
    station: input.station,
    summary: input.summary.slice(0, 200),
    data: input.data,
  };
  const buf = c.__busBuffer ?? [];
  buf.push({ seq, event });
  if (buf.length > BUS_CAP) buf.splice(0, buf.length - BUS_CAP);
  c.__busBuffer = buf;
  for (const fn of c.__busListeners ?? []) {
    try {
      fn(event);
    } catch {
      /* listener gagal — event tetap tersimpan */
    }
  }
  return event;
}

/** Semua event milik user dengan seq > cursor (untuk resync ?since=). */
export function busEventsSince(
  cursor: number,
  user?: string
): { events: BusEvent[]; cursor: number } {
  const buf = carrier().__busBuffer ?? [];
  const events = buf
    .filter((r) => r.seq > cursor && (!user || r.event.user === user))
    .map((r) => r.event);
  const next = buf.length > 0 ? buf[buf.length - 1].seq : cursor;
  return { events, cursor: next };
}

/** Ekor buffer untuk connect baru tanpa cursor (konteks visual langsung). */
export function busTail(n: number = BUS_REPLAY_TAIL, user?: string): BusEvent[] {
  const buf = carrier().__busBuffer ?? [];
  const list = user ? buf.filter((r) => r.event.user === user) : buf;
  return list.slice(-n).map((r) => r.event);
}

/** Cursor terbaru (klien simpan untuk ?since= berikutnya). */
export function busCursor(): number {
  const buf = carrier().__busBuffer ?? [];
  return buf.length > 0 ? buf[buf.length - 1].seq : 0;
}

/**
 * Event Bus Fase 2: tool file → event khusus, HANYA bila eksekusi SUKSES.
 * BACA/tulis yang gagal tetap tercatat sebagai tool_called ok:false +
 * task_failed (di executeTool) — bukan file_read/file_written, karena
 * tidak ada file yang benar-benar dibaca/ditulis. Pure — unit-tested.
 */
export function fileEventFor(toolName: string, ok: boolean): "file_read" | "file_written" | null {
  if (!ok) return null;
  if (toolName === "file_read") return "file_read";
  if (toolName === "write_file" || toolName === "edit_file") return "file_written";
  return null;
}

export function subscribeBus(fn: (e: BusEvent) => void): () => void {
  const c = carrier();
  if (!c.__busListeners) c.__busListeners = new Set();
  c.__busListeners.add(fn);
  return () => {
    c.__busListeners?.delete(fn);
  };
}
