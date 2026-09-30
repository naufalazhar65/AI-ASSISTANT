/**
 * Tests for the spoken-confirmation state machine (`liveConfirm.ts`).
 *
 * The safety property under test: a write tool NEVER executes on first sight.
 * Execution requires the conjunction of (a) a re-call carrying
 * `confirmed: true` AND (b) user speech after the ask. Either half alone —
 * a faked flag with no intervening speech, or speech with no explicit
 * confirmation — routes back to the spoken question, never to execution.
 */

import { describe, expect, it } from "vitest";

import {
  LIVE_WRITE_TOOLS,
  askFirstInstruction,
  decideLiveToolCalls,
  emptyConfirmState,
  markUserSpoke,
} from "./liveConfirm";

const remind = (args: Record<string, unknown>, id = "c1") => ({ id, name: "remind_me", args });
const note = (args: Record<string, unknown>, id = "c2") => ({ id, name: "save_note", args });

describe("decideLiveToolCalls — reads always execute", () => {
  it("executes read tools without any confirmation dance", () => {
    const st = emptyConfirmState();
    const d = decideLiveToolCalls(st, [{ id: "r1", name: "spotify_play", args: { query: "M2M" } }], 0);
    expect(d.execute.map((c) => c.name)).toEqual(["spotify_play"]);
    expect(d.ask).toEqual([]);
  });
});

describe("decideLiveToolCalls — first sighting always asks", () => {
  it("asks on a fresh remind_me call, even one already carrying confirmed:true", () => {
    const st = emptyConfirmState();
    const d = decideLiveToolCalls(
      st,
      [remind({ text: "minum", when: "jam 7", confirmed: true })],
      0
    );
    expect(d.execute).toEqual([]);
    expect(d.ask.map((c) => c.name)).toEqual(["remind_me"]);
  });

  it("asks on a fresh save_note call", () => {
    const st = emptyConfirmState();
    const d = decideLiveToolCalls(st, [note({ content: "ide bagus" })], 0);
    expect(d.execute).toEqual([]);
    expect(d.ask).toHaveLength(1);
  });
});

describe("decideLiveToolCalls — the full loop", () => {
  it("executes only after ask, then user speech, then a confirmed re-call", () => {
    let st = emptyConfirmState();
    const first = decideLiveToolCalls(st, [remind({ text: "minum", when: "jam 7" })], 0);
    expect(first.ask).toHaveLength(1);
    st = first.state;

    // Model repeats with confirmed:true but the user said nothing: still ask.
    const faked = decideLiveToolCalls(st, [remind({ text: "minum", when: "jam 7", confirmed: true })], 1_000);
    expect(faked.execute).toEqual([]);
    expect(faked.ask).toHaveLength(1);
    st = faked.state;

    // The user speaks (anything — the model judges relevance, the gate
    // judges only that speech happened after the ask)...
    st = markUserSpoke(st, 2_000);

    // ...but speech alone without an explicit re-confirmation still asks.
    const speechOnly = decideLiveToolCalls(st, [remind({ text: "minum", when: "jam 7" })], 3_000);
    expect(speechOnly.execute).toEqual([]);
    st = speechOnly.state;

    st = markUserSpoke(st, 4_000);
    const confirmed = decideLiveToolCalls(
      st,
      [remind({ text: "minum", when: "jam 7", confirmed: true })],
      5_000
    );
    expect(confirmed.execute.map((c) => c.name)).toEqual(["remind_me"]);
    expect(confirmed.ask).toEqual([]);
  });

  it("a different request is a different pending entry", () => {
    let st = emptyConfirmState();
    st = decideLiveToolCalls(st, [remind({ text: "a", when: "jam 7" })], 0).state;
    const d = decideLiveToolCalls(st, [remind({ text: "b", when: "jam 8", confirmed: true })], 1_000);
    expect(d.execute).toEqual([]);
    expect(d.ask.map((c) => c.args)).toEqual([{ text: "b", when: "jam 8", confirmed: true }]);
  });

  it("expired pending entries ask again instead of executing", () => {
    let st = emptyConfirmState();
    st = decideLiveToolCalls(st, [note({ content: "x" })], 0).state;
    st = markUserSpoke(st, 1_000);
    const d = decideLiveToolCalls(st, [note({ content: "x", confirmed: true })], 10 * 60_000);
    expect(d.execute).toEqual([]);
    expect(d.ask).toHaveLength(1);
  });
});

describe("askFirstInstruction — the spoken question", () => {
  it("names the concrete reminder (text + when)", () => {
    const q = askFirstInstruction({ id: "t1", name: "remind_me", args: { text: "minum obat", when: "jam 7" } });
    expect(q).toContain("minum obat");
    expect(q).toContain("jam 7");
    expect(q).toMatch(/jawab ya/i);
  });

  it("names the note content (truncated)", () => {
    const q = askFirstInstruction({ id: "t2", name: "save_note", args: { content: "ide: kopi susu aren" } });
    expect(q).toContain("kopi susu aren");
  });

  it("falls back to a generic spoken question for empty args (never leaks internal tool names into speech)", () => {
    const text = askFirstInstruction({ id: "t3", name: "remind_me", args: {} });
    expect(text).toContain("Mau aku");
    expect(text).not.toContain("remind_me");
  });

  it("LIVE_WRITE_TOOLS is exactly the two FR-014 write tools", () => {
    expect([...LIVE_WRITE_TOOLS]).toEqual(["remind_me", "save_note"]);
  });
});
