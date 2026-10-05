import { describe, expect, it } from "vitest";
import { emoteFor, fmtTaskLine, taskTitleFor, fmtEventLine, isBusFrame, assignCommand } from "./panels";

describe("emoteFor", () => {
  it("maps statuses to emote bubbles", () => {
    expect(emoteFor("typing")).toBe("💻");
    expect(emoteFor("reading")).toBe("📖");
    expect(emoteFor("thinking")).toBe("💭");
    expect(emoteFor("walking")).toBe("🚶");
    expect(emoteFor("working")).toBe("🔧");
    expect(emoteFor("waiting")).toBe("⏳");
    expect(emoteFor("success")).toBe("😌");
    expect(emoteFor("error")).toBe("⚠️");
  });
  it("falls back to speech for idle and unknown", () => {
    expect(emoteFor("idle")).toBe("💬");
    expect(emoteFor("")).toBe("💬");
    expect(emoteFor("dancing")).toBe("💬");
  });
});

describe("fmtTaskLine", () => {
  it("renders emote, id, title, actor, station, and state", () => {
    expect(
      fmtTaskLine({ id: "task_0007", title: "Cek test login", actor: "michelle", station: "pc-2", state: "working" })
    ).toBe("🔧 [task_0007] Cek test login — michelle @pc-2 · working");
  });
  it("omits station when absent", () => {
    expect(
      fmtTaskLine({ id: "task_0001", title: "Riset", actor: "agnes", station: null, state: "thinking" })
    ).toBe("💭 [task_0001] Riset — agnes · thinking");
  });
});

describe("taskTitleFor", () => {
  it("prefers an explicit title, else the id", () => {
    expect(taskTitleFor("task_1", "Jalankan test")).toBe("Jalankan test");
    expect(taskTitleFor("task_1", "")).toBe("task_1");
    expect(taskTitleFor("task_1")).toBe("task_1");
    expect(taskTitleFor("task_1", "   ")).toBe("task_1");
  });
});

describe("fmtEventLine", () => {
  it("renders actor, type, and summary", () => {
    expect(fmtEventLine({ type: "tool_called", actor: "michelle", summary: "calculate 2+2" })).toBe(
      "michelle tool_called: calculate 2+2"
    );
  });
  it("falls back to type when summary is missing", () => {
    expect(fmtEventLine({ type: "task_done" })).toBe("task_done: task_done");
  });
  it("caps at 200 chars and never throws on unknown shapes", () => {
    expect(fmtEventLine({ type: "x", summary: "y".repeat(500) }).length).toBeLessThanOrEqual(200);
    expect(fmtEventLine({} as { type: string })).toBe("event: event");
  });
});

describe("isBusFrame", () => {
  it("accepts well-formed frames and rejects junk", () => {
    expect(isBusFrame({ type: "tool_called", actor: "mia", data: { name: "x", ok: true } })).toBe(true);
    expect(isBusFrame({ type: "task_done" })).toBe(true);
    expect(isBusFrame(null)).toBe(false);
    expect(isBusFrame("tool_called")).toBe(false);
    expect(isBusFrame({})).toBe(false);
    expect(isBusFrame({ type: "x", actor: 42 })).toBe(false);
    expect(isBusFrame({ type: "x", station: 7 })).toBe(false);
  });
});

describe("assignCommand", () => {
  it("builds explicit delegation commands for both agents", () => {
    expect(assignCommand("michelle", "buatkan unit test untuk login")).toBe(
      "suruh michelle buatkan unit test untuk login"
    );
    expect(assignCommand("agnes", "rangkum hasil riset kopi")).toBe(
      "suruh agnes rangkum hasil riset kopi"
    );
  });
});
