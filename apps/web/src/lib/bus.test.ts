/** Event Bus Fase 1 — unit tests (envelope, buffer, cursor, context). */
import { describe, expect, it } from "vitest";
import {
  busCursor,
  busEventsSince,
  busTail,
  busTurnContext,
  emitBusEvent,
  fileEventFor,
  newBusTurn,
  subscribeBus,
  withBusTurn,
} from "./bus";

describe("bus envelope", () => {
  it("fills defaults honestly (no fake linkage outside a turn)", () => {
    const e = emitBusEvent({ user: "verify_bus1", type: "task_started", summary: "mengerjakan" });
    expect(e.id).toMatch(/^evt_\d+$/);
    expect(new Date(e.ts).getTime()).not.toBeNaN();
    expect(e.turn).toBe("turn_external");
    expect(e.task_id).toBe("task_ext");
    expect(e.actor).toBe("mia");
    expect(e.user).toBe("verify_bus1");
  });

  it("numbers tasks per user, zero-padded", () => {
    const a = newBusTurn("verify_bus2");
    const b = newBusTurn("verify_bus2");
    const c = newBusTurn("verify_bus3");
    expect(a.taskId).toBe("task_0001");
    expect(b.taskId).toBe("task_0002");
    expect(c.taskId).toBe("task_0001");
    expect(a.turnId).toMatch(/^turn_[a-z0-9]+$/);
    expect(a.userKey).toBe("verify_bus2");
  });

  it("falls back to shared on bad user, never throws", () => {
    const ctx = newBusTurn("not a valid key!!!");
    expect(ctx.userKey).toBe("shared");
  });
});

describe("bus buffer + cursor", () => {
  it("caps at 200 (drop-oldest) and resyncs by cursor", () => {
    const before = busCursor();
    for (let i = 0; i < 205; i++) {
      emitBusEvent({ user: "verify_buscap", type: "tool_called", summary: `t${i}` });
    }
    const { events, cursor } = busEventsSince(before, "verify_buscap");
    expect(events.length).toBeLessThanOrEqual(200);
    expect(cursor).toBeGreaterThan(before);
    // The 5 oldest were dropped: first surviving summary is t5.
    expect(events[0].summary).toBe("t5");
    const tail = busTail(3, "verify_buscap");
    expect(tail.map((e) => e.summary)).toEqual(["t202", "t203", "t204"]);
  });

  it("filters by user", () => {
    const before = busCursor();
    emitBusEvent({ user: "verify_busA", type: "task_done", summary: "a" });
    emitBusEvent({ user: "verify_busB", type: "task_done", summary: "b" });
    const a = busEventsSince(before, "verify_busA");
    expect(a.events.map((e) => e.summary)).toEqual(["a"]);
  });
});

describe("bus subscribe + context", () => {
  it("delivers to subscribers and unsubscribes cleanly", () => {
    const seen: string[] = [];
    const unsub = subscribeBus((e) => {
      seen.push(e.summary);
    });
    emitBusEvent({ user: "verify_bussub", type: "task_done", summary: "hi" });
    unsub();
    emitBusEvent({ user: "verify_bussub", type: "task_done", summary: "after" });
    expect(seen).toEqual(["hi"]);
  });

  it("a throwing listener never breaks emit", () => {
    const unsub = subscribeBus(() => {
      throw new Error("boom");
    });
    const e = emitBusEvent({ user: "verify_busthrow", type: "task_done", summary: "ok" });
    unsub();
    expect(e.summary).toBe("ok");
  });

  it("withBusTurn propagates context through awaits", async () => {
    const ctx = newBusTurn("verify_busctx");
    const seen = await withBusTurn(ctx, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return busTurnContext();
    });
    expect(seen?.taskId).toBe(ctx.taskId);
    expect(busTurnContext()).toBeNull();
  });
});

describe("bus file events (fase 2)", () => {
  it("maps successful file tools to file_read/file_written", () => {
    expect(fileEventFor("file_read", true)).toBe("file_read");
    expect(fileEventFor("write_file", true)).toBe("file_written");
    expect(fileEventFor("edit_file", true)).toBe("file_written");
  });

  it("never maps failures or other tools (covered by tool_called/task_failed)", () => {
    expect(fileEventFor("file_read", false)).toBeNull();
    expect(fileEventFor("write_file", false)).toBeNull();
    expect(fileEventFor("calculate", true)).toBeNull();
    expect(fileEventFor("web_search", false)).toBeNull();
  });
});
