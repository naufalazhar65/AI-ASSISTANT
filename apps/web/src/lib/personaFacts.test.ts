import { describe, expect, it } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { findHeaderLine, renderFactsBlock, splitFactFile } from "./personaFacts";
import { loadPersonaPrompt, upsertPersonaFact } from "./persona";
import { userDataRoot } from "./users";

/**
 * The persona fact/style blocks are what the prompt injects. Two bugs lived
 * here and both shipped into every prompt:
 *  - a plain substring search for the heading matched an INLINE mention
 *    ("lihat aturan per kanal di `## Style`"), so the split happened mid
 *    sentence and the injected block ran to EOF;
 *  - `renderFactsBlock` hardcoded "## Facts", so a SOUL write renamed the
 *    "## Style" section and emptied the style block from the prompt.
 */
describe("persona section headers are anchored at a line start", () => {
  it("finds a real heading and ignores an inline mention", () => {
    const body = "prelude\n- lihat aturan per kanal di `## Style`\n\n## Style\n- rule\n";
    const idx = findHeaderLine(body, "## Style");
    expect(idx).toBeGreaterThan(body.indexOf("`## Style`"));
    expect(body.slice(idx)).toContain("- rule");
  });

  it("returns -1 when the heading is absent", () => {
    expect(findHeaderLine("no heading here", "## Style")).toBe(-1);
    expect(findHeaderLine("inline `## Style` mention only", "## Style")).toBe(-1);
  });
});

describe("splitFactFile", () => {
  it("splits at the real heading, not at an inline mention", () => {
    const body = [
      "# SOUL.md",
      "- lihat aturan per kanal di `## Style`",
      "- tail of the preamble",
      "",
      "## Style",
      "",
      "- tone: kasual",
      "",
    ].join("\n");
    const { head, facts } = splitFactFile(body, "## Style");
    expect(head).toContain("- tail of the preamble");
    expect(facts).toEqual([{ key: "tone", value: "kasual" }]);
  });

  it("keeps the superseded history out of the live facts", () => {
    const body = ["## Facts", "", "- tone: kasual", "", "## Superseded", "", "- [superseded] tone: formal → kasual"].join("\n");
    const { facts, superseded } = splitFactFile(body);
    expect(facts.map((f) => f.key)).toEqual(["tone"]);
    expect(superseded).toHaveLength(1);
  });
});

describe("renderFactsBlock writes the section heading it is given", () => {
  it("uses ## Style for the SOUL file, not a hardcoded ## Facts", () => {
    const out = renderFactsBlock([{ key: "tone", value: "kasual" }], [], "## Style");
    expect(out.startsWith("## Style")).toBe(true);
    expect(out).not.toContain("## Facts");
  });

  it("defaults to ## Facts", () => {
    expect(renderFactsBlock([{ key: "tone", value: "kasual" }]).startsWith("## Facts")).toBe(true);
  });

  it("survives a write/read round trip with its own heading", () => {
    const file = ["# SOUL.md", "", "## Style", "", renderFactsBlock([{ key: "tone", value: "kasual" }], [], "## Style")].join("\n");
    const { head, facts } = splitFactFile(file, "## Style");
    expect(head).toContain("# SOUL.md");
    expect(facts).toEqual([{ key: "tone", value: "kasual" }]);
  });
});

/**
 * End to end on a throwaway user: the smoke gun of the bug was a real SOUL.md
 * on disk whose "## Style" heading had been renamed to "## Facts" by a soul
 * write — the prompt then injected nothing. Run-unique user + cleanup.
 */
describe("a soul write keeps the style block injectable", () => {
  it("keeps ## Style and still injects the style rules", () => {
    const user = `verify_personastyle_${Date.now()}`;
    const dir = join(userDataRoot(), user);
    try {
      upsertPersonaFact("SOUL", "tone", "kasual", user);
      const file = readFileSync(join(dir, "persona", "SOUL.md"), "utf8");
      expect(file).toContain("## Style");
      expect(file).not.toContain("## Facts");
      const injected = loadPersonaPrompt(user);
      expect(injected).toContain("Hangat itu keluar dari relevansi");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
