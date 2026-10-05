/**
 * Pixel-office engine core: grid collision, deterministic A* pathfinding,
 * and the avatar state machine. Pure logic, no DOM — the viewer (office.ts)
 * renders it and the tests drive it headlessly.
 *
 * No-fake-work contract: states only change on real bus events fed in via
 * applyEvent(); stepOffice() only advances walkers along computed paths.
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Pc {
  id: string;
  x: number;
  y: number;
  stop: Vec;
}

export interface MapData {
  name: string;
  width: number;
  height: number;
  /** One string per row; "#" is wall, anything else is floor. */
  tiles: string[];
  spawns: Record<string, Vec>;
  pcs: Pc[];
}

export type AvatarStatus =
  | "idle"
  | "thinking"
  | "walking"
  | "working"
  | "reading"
  | "typing"
  | "waiting"
  | "success"
  | "error";

export interface Avatar {
  /** Stable key, e.g. "mia". Unknown actors are tracked too (grey). */
  id: string;
  pos: Vec;
  status: AvatarStatus;
  /** Remaining cells to walk (goal included, start excluded). */
  path: Vec[];
  /** Station id from the last task_assigned, if any. */
  station: string | null;
  /** Owning task id, if any. */
  task: string | null;
  /** Status to adopt when the current path drains. */
  afterArrival: AvatarStatus | null;
}

export interface OfficeState {
  avatars: Record<string, Avatar>;
}

/** Avatar body colors by id; unknown actors render grey. */
export const AVATAR_COLORS: Record<string, string> = {
  mia: "#FF6D8D",
  agnes: "#6AA8FF",
  michelle: "#5BD68A",
};

export function avatarColor(id: string): string {
  return AVATAR_COLORS[id] ?? "#8A8F99";
}

/** Validate raw JSON into a MapData. Throws on malformed maps. */
export function parseMap(json: unknown): MapData {
  const m = json as Partial<MapData>;
  if (!m || typeof m.width !== "number" || typeof m.height !== "number" || !Array.isArray(m.tiles)) {
    throw new Error("map needs width/height/tiles");
  }
  if (m.tiles.length !== m.height || m.tiles.some((r) => typeof r !== "string" || r.length !== m.width)) {
    throw new Error(`tiles must be ${m.height} rows of ${m.width} chars`);
  }
  for (const [id, s] of Object.entries(m.spawns ?? {})) {
    if (!inBounds(m as MapData, s.x, s.y) || !isWalkable(m as MapData, s.x, s.y)) {
      throw new Error(`spawn ${id} is not on a walkable cell`);
    }
  }
  for (const pc of m.pcs ?? []) {
    if (!inBounds(m as MapData, pc.stop.x, pc.stop.y) || !isWalkable(m as MapData, pc.stop.x, pc.stop.y)) {
      throw new Error(`pc ${pc.id} stop cell is not walkable`);
    }
  }
  return m as MapData;
}

export function inBounds(map: MapData, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

export function isWalkable(map: MapData, x: number, y: number): boolean {
  return inBounds(map, x, y) && map.tiles[y][x] !== "#";
}

function key(v: Vec): string {
  return `${v.x},${v.y}`;
}

function manhattan(a: Vec, b: Vec): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * Deterministic A* on the 4-neighbourhood (cost 1). Neighbour order is
 * fixed (E, S, W, N) and ties break by lowest f, then lowest h, then
 * discovery order — the same query always returns the same path.
 * Returns cells from the first step to the goal (start excluded), or null
 * when unreachable. Start==goal returns [].
 */
export function findPath(map: MapData, from: Vec, to: Vec): Vec[] | null {
  if (!isWalkable(map, from.x, from.y) || !isWalkable(map, to.x, to.y)) return null;
  if (from.x === to.x && from.y === to.y) return [];
  const DIRS = [
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
    { x: 0, y: -1 },
  ];
  const open: Vec[] = [{ x: from.x, y: from.y }];
  const g = new Map<string, number>([[key(from), 0]]);
  const came = new Map<string, string>();
  const closed = new Set<string>();
  const fOf = (v: Vec): number => (g.get(key(v)) ?? Infinity) + manhattan(v, to);
  while (open.length > 0) {
    let bi = 0;
    for (let i = 1; i < open.length; i++) {
      const d = fOf(open[i]) - fOf(open[bi]);
      if (d < 0 || (d === 0 && manhattan(open[i], to) < manhattan(open[bi], to))) bi = i;
    }
    const cur = open.splice(bi, 1)[0];
    if (cur.x === to.x && cur.y === to.y) {
      const path: Vec[] = [];
      let k: string | undefined = key(cur);
      const start = key(from);
      while (k !== undefined && k !== start) {
        const [x, y] = k.split(",").map(Number);
        path.unshift({ x, y });
        k = came.get(k);
      }
      return path;
    }
    if (closed.has(key(cur))) continue;
    closed.add(key(cur));
    for (const d of DIRS) {
      const nx = cur.x + d.x;
      const ny = cur.y + d.y;
      if (!isWalkable(map, nx, ny)) continue;
      const nk = `${nx},${ny}`;
      if (closed.has(nk)) continue;
      const ng = (g.get(key(cur)) ?? Infinity) + 1;
      if (ng < (g.get(nk) ?? Infinity)) {
        g.set(nk, ng);
        came.set(nk, key(cur));
        if (!open.some((v) => v.x === nx && v.y === ny)) open.push({ x: nx, y: ny });
      }
    }
  }
  return null;
}

/** Fresh office: every known spawn idles on its spawn cell. */
export function initialState(map: MapData): OfficeState {
  const avatars: Record<string, Avatar> = {};
  for (const [id, s] of Object.entries(map.spawns)) {
    avatars[id] = { id, pos: { x: s.x, y: s.y }, status: "idle", path: [], station: null, task: null, afterArrival: null };
  }
  return { avatars };
}

function ensureAvatar(state: OfficeState, map: MapData, id: string): Avatar {
  let a = state.avatars[id];
  if (!a) {
    const s = map.spawns[id] ?? map.spawns.mia ?? { x: 1, y: 1 };
    a = { id, pos: { x: s.x, y: s.y }, status: "idle", path: [], station: null, task: null, afterArrival: null };
    state.avatars[id] = a;
  }
  return a;
}

export interface BusLikeEvent {
  type: string;
  actor?: string;
  agent?: string;
  station?: string;
  task_id?: string;
  data?: { name?: string; ok?: boolean };
}

/** Who the event belongs to: actor first, then agent, else null. */
function eventActor(ev: BusLikeEvent): string | null {
  return ev.actor ?? ev.agent ?? null;
}

/**
 * Apply one bus event. Mutates and returns the state. Unknown event types
 * and events without an actor are ignored (never fabricate motion).
 */
export function applyEvent(state: OfficeState, map: MapData, ev: BusLikeEvent): OfficeState {
  const id = eventActor(ev);
  if (!id) return state;
  const a = ensureAvatar(state, map, id);
  const toolName = ev.data?.name ?? "";
  switch (ev.type) {
    case "task_created":
    case "agent_delegated":
    case "task_started":
      if (ev.task_id) a.task = ev.task_id;
      if (a.status === "idle") a.status = "thinking";
      break;
    case "task_assigned": {
      if (ev.task_id) a.task = ev.task_id;
      const pc = map.pcs.find((p) => p.id === ev.station);
      if (!pc) {
        a.station = ev.station ?? null;
        a.status = "working";
        a.path = [];
        break;
      }
      a.station = pc.id;
      const path = findPath(map, a.pos, pc.stop);
      if (!path) {
        a.status = "working";
        a.path = [];
        break;
      }
      a.path = path;
      a.afterArrival = "working";
      a.status = "walking";
      break;
    }
    case "tool_called":
      a.status = /file|edit|write/i.test(toolName) ? "typing" : "working";
      break;
    case "file_read":
      a.status = "reading";
      break;
    case "file_written":
      a.status = "typing";
      break;
    case "waiting_input":
      a.status = "waiting";
      break;
    case "task_done":
      a.task = null;
      sendHome(state, map, a, "success");
      break;
    case "task_failed":
      a.task = null;
      sendHome(state, map, a, "error");
      break;
    case "task_cancelled":
      a.task = null;
      sendHome(state, map, a, "idle");
      break;
    default:
      break;
  }
  return state;
}

/** Walk back to spawn, adopting `then` on arrival. */
function sendHome(state: OfficeState, map: MapData, a: Avatar, then: AvatarStatus): void {
  const home = map.spawns[a.id];
  if (!home) {
    a.status = then;
    a.path = [];
    a.afterArrival = null;
    return;
  }
  const path = findPath(map, a.pos, home);
  if (!path || path.length === 0) {
    a.pos = { x: home.x, y: home.y };
    a.status = then;
    a.path = [];
    a.afterArrival = null;
    return;
  }
  a.path = path;
  a.afterArrival = "idle";
  a.status = then;
}

/** Advance every walker one cell; arrivals adopt afterArrival (or working). */
export function stepOffice(state: OfficeState, _map: MapData): void {
  for (const a of Object.values(state.avatars)) {
    if (a.path.length === 0) continue;
    const next = a.path.shift();
    if (!next) continue;
    a.pos = { x: next.x, y: next.y };
    if (a.path.length === 0) {
      a.status = a.afterArrival ?? "working";
      a.afterArrival = null;
    }
  }
}

/** Run steps until no avatar is walking (cap 1000). Returns step count. */
export function settleWalking(state: OfficeState, map: MapData, cap = 1000): number {
  let n = 0;
  while (Object.values(state.avatars).some((a) => a.path.length > 0) && n < cap) {
    stepOffice(state, map);
    n++;
  }
  return n;
}
