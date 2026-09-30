/**
 * Tests for the client-side reminder helpers (`reminderClient.ts`).
 *
 * The contract under test: dismissing a fired receipt ("Udah bunyi: ...")
 * sticks across reloads (the server replays recent receipts on every SSE
 * connect), while live due-reminders are never suppressed client-side
 * (replay-while-due is correct; a same-id daily must not be silenced).
 */

import { describe, expect, it } from "vitest";

import {
  isDismissedReceipt,
  isFiredReceiptText,
  loadDismissedReceipts,
  saveDismissedReceipt,
  type StringStore,
} from "./reminderClient";

function fakeStore(seed?: Record<string, string>): StringStore & { data: Record<string, string> } {
  const data: Record<string, string> = { ...(seed ?? {}) };
  return {
    data,
    getItem: (k: string) => (k in data ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = v;
    },
  };
}

describe("isFiredReceiptText — only history is ever suppressible", () => {
  it("matches seeded receipt lines", () => {
    expect(isFiredReceiptText("Udah bunyi: makan malam · jam 20:10")).toBe(true);
  });

  it("never matches live due-reminder text", () => {
    expect(isFiredReceiptText("Waktunya makan malam")).toBe(false);
    expect(isFiredReceiptText("")).toBe(false);
    expect(isFiredReceiptText("udah bunyi: lowercase")).toBe(false);
  });
});

describe("dismissed-receipt persistence", () => {
  it("round-trips through a store (survives a reload)", () => {
    const store = fakeStore();
    saveDismissedReceipt("Udah bunyi: makan malam · jam 20:10", store, 1000);
    expect(loadDismissedReceipts(store)).toEqual([{ text: "Udah bunyi: makan malam · jam 20:10", at: 1000 }]);
  });

  it("caps at 50, evicting the oldest first", () => {
    const store = fakeStore();
    for (let i = 0; i < 55; i += 1) saveDismissedReceipt(`Udah bunyi: item ${i}`, store, i);
    const loaded = loadDismissedReceipts(store);
    expect(loaded).toHaveLength(50);
    expect(loaded.some((d) => d.text === "Udah bunyi: item 0")).toBe(false);
    expect(loaded.some((d) => d.text === "Udah bunyi: item 54")).toBe(true);
  });

  it("returns empty on corrupt JSON or missing storage instead of throwing", () => {
    expect(loadDismissedReceipts(fakeStore({ "mia-dismissed-receipts": "not-json{{{" }))).toEqual([]);
    expect(loadDismissedReceipts(null)).toEqual([]);
    expect(() => saveDismissedReceipt("Udah bunyi: x", null)).not.toThrow();
  });

  it("normalizes legacy plain-string entries (exact receipt texts)", () => {
    const store = fakeStore({ "mia-dismissed-receipts": JSON.stringify(["Udah bunyi: lama · jam 07:00"]) });
    expect(loadDismissedReceipts(store)).toEqual([
      { text: "Udah bunyi: lama · jam 07:00", at: Number.POSITIVE_INFINITY },
    ]);
  });
});

describe("isDismissedReceipt — the twin rule", () => {
  const RECEIPT = "Udah bunyi: Waktunya makan malam · jam 20:10";
  const FIRED_ID = "fired-1720000000000";

  it("suppresses the receipt twin of a dismissed live banner on next refresh", () => {
    // User dismissed the live banner at t+1; the seeded receipt (fired at t)
    // must not resurrect: the exact double-refresh cycle from 2026-09-30.
    const dismissed = [{ text: "Waktunya makan malam", at: 1720000000001 }];
    expect(isDismissedReceipt(FIRED_ID, RECEIPT, dismissed)).toBe(true);
  });

  it("still shows a later firing of the same text (tomorrow's daily is safe)", () => {
    const dismissed = [{ text: "Waktunya makan malam", at: 1720000000000 }];
    expect(isDismissedReceipt("fired-1720086400000", RECEIPT, dismissed)).toBe(false);
  });

  it("suppresses a dismissed receipt verbatim (legacy + current entries)", () => {
    expect(isDismissedReceipt(FIRED_ID, RECEIPT, [{ text: RECEIPT, at: Number.POSITIVE_INFINITY }])).toBe(true);
    expect(isDismissedReceipt(FIRED_ID, RECEIPT, [{ text: RECEIPT, at: 1720000000000 }])).toBe(true);
  });

  it("never suppresses live due-frames, even dismissed ones", () => {
    const dismissed = [{ text: "Waktunya makan malam", at: 1720000000001 }];
    expect(isDismissedReceipt("r-abc123", "Waktunya makan malam", dismissed)).toBe(false);
    expect(isDismissedReceipt(undefined, "Waktunya makan malam", dismissed)).toBe(false);
  });

  it("falls back to exact-text match on an unparseable frame id", () => {
    expect(isDismissedReceipt("garbage", RECEIPT, [{ text: RECEIPT, at: 1 }])).toBe(true);
    expect(isDismissedReceipt("garbage", RECEIPT, [{ text: "Waktunya makan malam", at: 999 }])).toBe(false);
  });

  it("is silent with no dismissals", () => {
    expect(isDismissedReceipt(FIRED_ID, RECEIPT, [])).toBe(false);
  });
});
