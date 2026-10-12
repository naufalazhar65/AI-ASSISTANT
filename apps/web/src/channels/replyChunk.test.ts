import { describe, expect, it } from "vitest";
import { chunkText, parseConfirmReply, scrubToolMarkup, stripMentions, DISCORD_MAX } from "./replyChunk";

/**
 * Owner report 2026-10-06 13:14 (Discord): "@Mia | PM tolong hapus reminder
 * cek email" produced the pending prompt, then "@Mia | PM ya" re-sent the very
 * same prompt instead of approving. `message.content` still carries the raw
 * mention markup, and the approval parser only accepts a bare "ya".
 */
describe("stripMentions + confirm approval (live 2026-10-06 13:14)", () => {
  it("strips a bot mention so a mentioned approval parses", () => {
    expect(stripMentions("<@684621700000000000> ya")).toBe("ya");
    expect(parseConfirmReply(stripMentions("<@684621700000000000> ya"), 1)).toEqual([true]);
  });

  it("handles the legacy mention form with the ! separator", () => {
    expect(stripMentions("<@!684621700000000000> ya")).toBe("ya");
  });

  it("approves every call of a batch when the reply is a mentioned 'ya'", () => {
    expect(parseConfirmReply(stripMentions("<@123> ya"), 3)).toEqual([true, true, true]);
  });

  it("declines when the reply is a mentioned 'tidak'", () => {
    expect(parseConfirmReply(stripMentions("<@123> tidak"), 2)).toEqual([false, false]);
  });

  it("parses a mentioned subset selection", () => {
    expect(parseConfirmReply(stripMentions("<@123> ya 1,3"), 3)).toEqual([true, false, true]);
  });

  it("still reads a normal message with the mention in front", () => {
    expect(stripMentions("<@123> tolong hapus reminder cek email")).toBe("tolong hapus reminder cek email");
  });

  it("leaves plain text untouched", () => {
    expect(stripMentions("  halo  ")).toBe("halo");
    expect(stripMentions("")).toBe("");
  });

  it("does not touch non-mention angle brackets (no routing text is lost)", () => {
    expect(stripMentions("hapus <file> ya")).toBe("hapus <file> ya");
  });
});

/**
 * Long-report delivery (owner spec 2026-10-12).
 *
 * The owner's research contract requires a report that may run past Discord's
 * 2000-char body limit to be split "menjadi beberapa bagian yang terurut". This
 * locks the two properties that promise rests on: every part fits, and nothing
 * is dropped or reordered on the way.
 *
 * Both details below were learned by writing the assertion wrong first:
 *   - the comparison target is the SCRUBBED report, because chunkText scrubs
 *     before splitting and scrubToolMarkup drops one trailing newline;
 *   - parts must be rejoined WITH a separator. They are separate Discord
 *     messages, so the newline at a boundary belongs to neither part, and
 *     join("") silently eats it — which looks exactly like data loss.
 */
describe("chunkText — a multi-finding report survives the Discord limit", () => {
  const finding = (i: number) =>
    `### ${i}. Temuan\n\n**Ringkasan**\nFakta inti untuk temuan nomor ${i} dengan detail yang cukup panjang agar laporan realistis, bukan satu kalimat pendek.\n\n`
    + `**Kenapa penting**\nAlasan topik ini sedang ramai dibicarakan dan layak diperhatikan oleh pembaca laporan.\n\n`
    + `**Waktu**\n2026-10-12 09:00 WIB\n\n`
    + `**Sumber**\n- [Sumber Satu — judul artikel](https://contoh.id/artikel/${i})\n- [Sumber pendukung](https://contoh.id/pendukung/${i})\n\n`;

  const report =
    `## TOPIK VIRAL SAAT INI\n\n2026-10-12, WIB\n\n`
    + Array.from({ length: 5 }, (_, i) => finding(i + 1)).join("")
    + `## KESIMPULAN\n\nDua atau tiga poin tentang temuan terpenting.\n\n## STATUS RISET\n\n- Topik: 5\n- Sumber terverifikasi: 5\n`;

  it("actually exceeds the limit, so this fixture can fail", () => {
    // A 981-char version of this fixture split into ONE part and passed
    // vacuously. Pin the precondition so the fixture can never go quiet.
    expect(report.length).toBeGreaterThan(DISCORD_MAX);
  });

  it("splits into several parts, every one within the limit, none empty", () => {
    const parts = chunkText(report, DISCORD_MAX);
    expect(parts.length).toBeGreaterThan(1);
    for (const [i, part] of parts.entries()) {
      expect(part.length, `chunk ${i} exceeds the Discord limit`).toBeLessThanOrEqual(DISCORD_MAX);
      expect(part.trim(), `chunk ${i} is a blank Discord message`).not.toBe("");
    }
  });

  it("preserves every section, in order, and loses nothing", () => {
    const parts = chunkText(report, DISCORD_MAX);
    const squeezed = (s: string) => s.replace(/\s+/g, " ").trim();
    expect(squeezed(parts.join("\n"))).toBe(squeezed(scrubToolMarkup(report)));
  });

  it("delivers each finding once and in order, with the status section last", () => {
    const flat = chunkText(report, DISCORD_MAX).join("\n");
    let cursor = -1;
    for (let i = 1; i <= 5; i++) {
      const at = flat.indexOf(`${i}. Temuan`);
      expect(at, `finding ${i} missing after chunking`).toBeGreaterThan(cursor);
      cursor = at;
    }
    const parts = chunkText(report, DISCORD_MAX);
    expect(parts[parts.length - 1]).toContain("STATUS RISET");
  });

  it("still sends a short report as one message (no needless splitting)", () => {
    expect(chunkText("Jawaban singkat, dua kalimat.", DISCORD_MAX)).toHaveLength(1);
  });
});
