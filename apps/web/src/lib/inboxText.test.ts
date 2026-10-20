import { describe, it, expect } from "vitest";
import { stripInboxList, hasInboxItems } from "./inboxText";

const TOOL_OUTPUT = [
  "📬 Ringkasan Inbox — 3 email terbaru · 20 Okt 2026, 09.00 – 20 Okt 2026, 15.05 WIB",
  "1. [a1] Welcome to Neon | Neon | 20 Okt 2026, 15.05 WIB | Neon Logo Welcome",
  "2. [b2] Cashback Promo | Home Credit Indonesia | 20 Okt 2026, 12.30 WIB | Info promo",
  "3. [c3] Notifikasi lowongan | QA Tester | 20 Okt 2026, 11.17 WIB | Rekrutmen",
].join("\n");

describe("stripInboxList", () => {
  it("removes the duplicated items and keeps the summary header", () => {
    const out = stripInboxList(TOOL_OUTPUT);
    expect(out).toContain("📬 Ringkasan Inbox — 3 email terbaru");
    expect(out).not.toContain("Welcome to Neon");
    expect(out).not.toContain("Cashback Promo");
    expect(out).not.toContain("Notifikasi lowongan");
  });

  it("keeps what the model wrote AFTER the list", () => {
    const out = stripInboxList(TOOL_OUTPUT + "\n\nYang perlu kamu tahu: promo cashback masih aktif.");
    expect(out).toContain("Yang perlu kamu tahu: promo cashback masih aktif.");
    expect(out).not.toContain("Cashback Promo |");
  });

  it("leaves a normal reply untouched", () => {
    const text = "Halo Mas Naufal! Inbox kamu aman, tidak ada yang perlu ditindak.";
    expect(stripInboxList(text)).toBe(text);
  });

  it("leaves an ordinary numbered list untouched (no inbox header)", () => {
    const text = "1. makan siang\n2. rapat tim\n3. jalan";
    expect(stripInboxList(text)).toBe(text);
  });

  it("hasInboxItems detects a pasted inbox list", () => {
    expect(hasInboxItems(TOOL_OUTPUT)).toBe(true);
    expect(hasInboxItems("📬 Ringkasan Inbox — 0 email")).toBe(false);
  });
});
