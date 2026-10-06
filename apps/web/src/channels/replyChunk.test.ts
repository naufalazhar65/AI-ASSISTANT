import { describe, expect, it } from "vitest";
import { parseConfirmReply, stripMentions } from "./replyChunk";

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
