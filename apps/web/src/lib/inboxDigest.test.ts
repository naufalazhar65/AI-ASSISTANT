// Locks for the inbox duplication fix (live 2026-10-22, owner: "cek email"
// showed the inbox twice: once as the tool card, once in Mia's reply).
//
// Two independent seams are locked here:
//   1. the digest gate — a card-rendering surface must NEVER get the
//      deterministic list pasted into its reply;
//   2. stripInboxBlock — a list the MODEL pasted into the reply is removed
//      whole (header + items) when the card already shows it.

import { describe, expect, it } from "vitest";
import { inboxDigestGate } from "./agent";
import { stripInboxBlock } from "./inboxText";

describe("inboxDigestGate", () => {
  it("never pastes the list when the caller renders tool cards", () => {
    expect(
      inboxDigestGate({ renderToolCards: true, pendingApproval: 0, gmailRan: true, coveredSubjects: 0 })
    ).toBe(false);
  });

  it("pastes the list on a plain channel when the prose does not carry it", () => {
    expect(inboxDigestGate({ gmailRan: true, coveredSubjects: 0 })).toBe(true);
  });

  it("skips the digest when the prose already lists the subjects", () => {
    expect(inboxDigestGate({ gmailRan: true, coveredSubjects: 3 })).toBe(false);
  });

  it("skips the digest while a confirmation is pending", () => {
    expect(inboxDigestGate({ pendingApproval: 1, gmailRan: true, coveredSubjects: 0 })).toBe(false);
  });

  it("skips the digest when no gmail tool ran", () => {
    expect(inboxDigestGate({ gmailRan: false, coveredSubjects: 0 })).toBe(false);
  });
});

describe("stripInboxBlock", () => {
  const block = [
    "Ada beberapa email baru Mas Naufal 🌸",
    "",
    "📬 Ringkasan Inbox — 5 email terbaru · 22 Okt 2026, 03.19 – 22 Okt 2026, 11.24 WIB",
    "1. [1a161dac42c18740] Notifikasi lowongan Anda · Software Quality Assurance · Jawa Barat | trabajos trabajo.org | 22 Okt 2026, 11.24 WIB | TELUS Digital AI Data Solutions",
    "2. [1a161c477a208cb6] Produk Paling Dicari, Wajib Intip! 👀 | INFORMA Online | 22 Okt 2026, 10.18 WIB | HEMAT sd 60%",
  ].join("\n");

  it("drops the header AND the items, keeping the model's own words", () => {
    const out = stripInboxBlock(block);
    expect(out).toBe("Ada beberapa email baru Mas Naufal 🌸");
    expect(out).not.toContain("Ringkasan Inbox");
    expect(out).not.toContain("Notifikasi lowongan");
  });

  it("keeps a sentence that follows the list", () => {
    const out = stripInboxBlock(`${block}\n\nBilang ya kalau mau kubaca yang satu.`);
    expect(out).toContain("Bilang ya kalau mau kubaca yang satu.");
    expect(out).not.toContain("Ringkasan Inbox");
  });

  it("leaves text without an inbox block untouched", () => {
    const text = "Nih beb — 3 tugas hari ini.";
    expect(stripInboxBlock(text)).toBe(text);
  });
});
