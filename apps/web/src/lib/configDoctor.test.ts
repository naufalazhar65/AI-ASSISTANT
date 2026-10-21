import { describe, it, expect } from "vitest";
import { CONFIG_FEATURES, diagnoseConfig, isPresent, renderConfigReport } from "./configDoctor";

describe("configDoctor", () => {
  it("treats an empty or blank value as absent", () => {
    expect(isPresent({ A: "x" }, "A")).toBe(true);
    expect(isPresent({ A: "" }, "A")).toBe(false);
    expect(isPresent({ A: "   " }, "A")).toBe(false);
    expect(isPresent({}, "A")).toBe(false);
  });

  it("marks a feature on when one alternative group is fully present", () => {
    const env = { GROQ_API_KEY: "gsk_x" };
    const reports = diagnoseConfig(env);
    const llm = reports.find((r) => r.id === "llm");
    expect(llm?.on).toBe(true);
    expect(llm?.missing).toEqual([]);
  });

  it("marks a feature on through ANY of its alternative groups", () => {
    const env = {
      LLM_API_BASE: "http://x/v1",
      LLM_API_KEY: "k",
      LLM_MODEL: "m",
    };
    expect(diagnoseConfig(env).find((r) => r.id === "llm")?.on).toBe(true);
  });

  it("reports the closest group's missing keys, not every alternative", () => {
    // Telegram: the bot token alone is not enough (the bot refuses to answer
    // without an owner allow-list). The report must name ONE allow-list key.
    const env = { TELEGRAM_BOT_TOKEN: "t" };
    const report = diagnoseConfig(env).find((r) => r.id === "telegram");
    expect(report?.on).toBe(false);
    expect(report?.missing).toHaveLength(1);
    expect(report?.missing[0]).toMatch(/^TELEGRAM_ALLOWED_USERNAME$|^TELEGRAM_ALLOWED_USER_ID$|^TELEGRAM_USER$/);
  });

  it("never leaks a value — only key names leave the report", () => {
    const env = { GROQ_API_KEY: "super-secret-value" };
    const text = renderConfigReport(diagnoseConfig(env));
    expect(text).not.toContain("super-secret-value");
    expect(text).toContain("GROQ_API_KEY");
  });

  it("counts features honestly in the summary line", () => {
    const env = { GROQ_API_KEY: "gsk_x" };
    const text = renderConfigReport(diagnoseConfig(env));
    expect(text).toMatch(/\d+ fitur aktif, \d+ fitur belum aktif\./);
  });

  it("every feature group is non-empty and every key is uppercase", () => {
    for (const feature of CONFIG_FEATURES) {
      expect(feature.groups.length).toBeGreaterThan(0);
      for (const group of feature.groups) {
        expect(group.length).toBeGreaterThan(0);
        for (const key of group) expect(key).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});
