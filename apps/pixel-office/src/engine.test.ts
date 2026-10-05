import { describe, expect, it } from "vitest";
import {
  applyEvent,
  findPath,
  initialState,
  isWalkable,
  parseMap,
  stepOffice,
  type MapData,
  type Vec,
} from "./engine";
import mapJson from "./map.json";

const map: MapData = parseMap(mapJson);

function v(x: number, y: number): Vec {
  return { x, y };
}

describe("parseMap", () => {
  it("accepts the shipped map", () => {
    expect(map.width).toBe(20);
    expect(map.height).toBe(12);
    expect(map.pcs.map((p) => p.id)).toEqual(["pc-1", "pc-2", "pc-3"]);
  });
  it("rejects ragged tiles", () => {
    expect(() =>
      parseMap({ width: 2, height: 1, tiles: ["..."], pcs: [], spawns: {} }),
    ).toThrow();
  });
});

describe("collision", () => {
  it("border walls are blocked, floor is open", () => {
    expect(isWalkable(map, 0, 0)).toBe(false);
    expect(isWalkable(map, 2, 10)).toBe(true);
  });
  it("table block cells are blocked but stops stay walkable", () => {
    expect(isWalkable(map, 8, 6)).toBe(false);
    for (const pc of map.pcs) {
      expect(isWalkable(map, pc.stop.x, pc.stop.y)).toBe(true);
    }
  });
  it("out of bounds is blocked", () => {
    expect(isWalkable(map, -1, 0)).toBe(false);
    expect(isWalkable(map, 20, 0)).toBe(false);
  });
});

describe("findPath (A*)", () => {
  it("walks open floor", () => {
    const path = findPath(map, v(2, 10), v(4, 10));
    expect(path).toEqual([v(3, 10), v(4, 10)]);
  });
  it("detours around the table block", () => {
    // Table block occupies rows 6-7, cols 8-11: straight column 9 is shut.
    const path = findPath(map, v(9, 5), v(9, 8));
    expect(path).not.toBeNull();
    for (const cell of path!) {
      expect(isWalkable(map, cell.x, cell.y)).toBe(true);
    }
    // Any detour must leave column 9 ((9,6) and (9,7) are blocked).
    expect(path!.some((c) => c.x !== 9)).toBe(true);
  });
  it("returns null when the goal is enclosed by walls", () => {
    const closed: MapData = {
      name: "closed",
      width: 3,
      height: 3,
      tiles: ["###", "#.#", "###"],
      pcs: [],
      spawns: {},
    };
    expect(findPath(closed, v(1, 1), v(0, 0))).toBeNull();
  });
  it("is deterministic across calls", () => {
    const a = findPath(map, v(2, 10), v(15, 3));
    const b = findPath(map, v(2, 10), v(15, 3));
    expect(a).toEqual(b);
  });
});

describe("applyEvent (FSM)", () => {
  it("task_assigned walks michelle to pc-2 then works", () => {
    const st = initialState(map);
    applyEvent(st, map, { type: "task_assigned", actor: "michelle", station: "pc-2" });
    const m = st.avatars.michelle;
    expect(m.status).toBe("walking");
    expect(m.path.length).toBeGreaterThan(0);
    const stop = map.pcs[1].stop;
    expect(m.path[m.path.length - 1]).toEqual(stop);
    for (let i = 0; i < 200 && m.status === "walking"; i++) stepOffice(st, map);
    expect(m.pos).toEqual(stop);
    expect(m.status).toBe("working");
  });
  it("unknown station works in place", () => {
    const st = initialState(map);
    const before = { ...st.avatars.mia.pos };
    applyEvent(st, map, { type: "task_assigned", actor: "mia", station: "pc-9" });
    expect(st.avatars.mia.status).toBe("working");
    expect(st.avatars.mia.pos).toEqual(before);
  });
  it("tool_called types on file tools, works otherwise", () => {
    const st = initialState(map);
    applyEvent(st, map, { type: "tool_called", actor: "michelle", data: { name: "read_file" } });
    expect(st.avatars.michelle.status).toBe("typing");
    applyEvent(st, map, { type: "tool_called", actor: "michelle", data: { name: "calculate" } });
    expect(st.avatars.michelle.status).toBe("working");
  });
  it("file_read reads, waiting_input waits", () => {
    const st = initialState(map);
    applyEvent(st, map, { type: "file_read", actor: "agnes" });
    expect(st.avatars.agnes.status).toBe("reading");
    applyEvent(st, map, { type: "waiting_input", actor: "agnes" });
    expect(st.avatars.agnes.status).toBe("waiting");
  });
  it("task_done sends home then idles", () => {
    const st = initialState(map);
    applyEvent(st, map, { type: "task_assigned", actor: "michelle", station: "pc-2" });
    for (let i = 0; i < 200 && st.avatars.michelle.status === "walking"; i++) {
      stepOffice(st, map);
    }
    applyEvent(st, map, { type: "task_done", actor: "michelle" });
    expect(st.avatars.michelle.status).toBe("success");
    for (let i = 0; i < 400 && st.avatars.michelle.status !== "idle"; i++) {
      stepOffice(st, map);
    }
    expect(st.avatars.michelle.status).toBe("idle");
    expect(st.avatars.michelle.pos).toEqual(map.spawns.michelle);
  });
  it("task_failed errors then returns home", () => {
    const st = initialState(map);
    // Walk out first: failing at spawn latches error (no walk home needed).
    applyEvent(st, map, { type: "task_assigned", actor: "agnes", station: "pc-3" });
    for (let i = 0; i < 200 && st.avatars.agnes.status === "walking"; i++) {
      stepOffice(st, map);
    }
    applyEvent(st, map, { type: "task_failed", actor: "agnes" });
    expect(st.avatars.agnes.status).toBe("error");
    for (let i = 0; i < 400 && st.avatars.agnes.status !== "idle"; i++) {
      stepOffice(st, map);
    }
    expect(st.avatars.agnes.status).toBe("idle");
    expect(st.avatars.agnes.pos).toEqual(map.spawns.agnes);
  });
  it("ignores events without actor", () => {
    const st = initialState(map);
    applyEvent(st, map, { type: "tool_called" });
    expect(Object.keys(st.avatars)).toHaveLength(3);
  });
});
