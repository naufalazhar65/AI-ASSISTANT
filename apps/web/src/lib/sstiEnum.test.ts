// sstiEnum.test.ts — pure helpers of the ssti_enum prover.
import { describe, it, expect } from "vitest";
import { sstiClassify, sstiFinalVerdict, nextStepFor, SSTI_LADDER } from "./sstiEnum";
import type { Probe } from "./sstiEnum";

const P = (body: string): Probe => ({ status: 200, body, ms: 5 });

describe("sstiClassify", () => {
  it("reads the Jinja teller (7777777)", () => {
    expect(sstiClassify("hasil: 7777777", "{{7*'7'}}")).toBe("jinja2-likely");
  });
  it("reads the Twig teller (49, no repeat)", () => {
    expect(sstiClassify("hasil: 49", "{{7*'7'}}")).toBe("twig-likely");
  });
  it("maps each arithmetic syntax to its family", () => {
    expect(sstiClassify("=49", "{{7*7}}")).toBe("jinja-twig-family");
    expect(sstiClassify("=49", "${7*7}")).toBe("freemarker-velocity-ejs-family");
    expect(sstiClassify("=49", "#{7*7}")).toBe("erb-thymeleaf-family");
    expect(sstiClassify("=49", "<%= 7*7 %>")).toBe("erb-ejs-family");
  });
  it("matches error shapes", () => {
    expect(sstiClassify('Unexpected token "punctuation"', "{{not.a.real.namespace}}")).toBe("twig-shape");
    expect(sstiClassify("freemarker.core.Expression syntax error", "${NotARealClass.static}")).toBe("freemarker-shape");
  });
  it("returns null on benign bodies", () => {
    expect(sstiClassify("<html>hello</html>", "{{7*7}}")).toBeNull();
  });
});

describe("sstiFinalVerdict", () => {
  it("confirms Jinja2 via teller + arithmetic", () => {
    const v = sstiFinalVerdict([
      { payload: "{{7*7}}", probe: P("49"), label: "jinja-twig-family" },
      { payload: "{{7*'7'}}", probe: P("7777777"), label: "jinja2-likely" },
    ]);
    expect(v.engine).toBe("Jinja2");
    expect(v.confidence).toBe("confirmed");
  });
  it("confirms Twig when the teller yields 49", () => {
    const v = sstiFinalVerdict([
      { payload: "{{7*7}}", probe: P("49"), label: "jinja-twig-family" },
      { payload: "{{7*'7'}}", probe: P("49"), label: "twig-likely" },
    ]);
    expect(v.engine).toBe("Twig");
    expect(v.confidence).toBe("confirmed");
  });
  it("stays likely on arithmetic-only", () => {
    const v = sstiFinalVerdict([{ payload: "${7*7}", probe: P("49"), label: "freemarker-velocity-ejs-family" }]);
    expect(v.confidence).toBe("likely");
  });
  it("drops to shape-only on error text", () => {
    const v = sstiFinalVerdict([{ payload: "{{not.a.real.namespace}}", probe: P("Unexpected token name"), label: "twig-shape" }]);
    expect(v.confidence).toBe("shape-only");
    expect(v.engine).toBe("twig");
  });
  it("is honest when nothing matched", () => {
    const v = sstiFinalVerdict([]);
    expect(v.confidence).toBe("none");
    expect(v.engine).toBe("unknown");
  });
});

describe("nextStepFor / ladder", () => {
  it("points every known engine at the playbook", () => {
    for (const e of ["Jinja2", "Twig", "velocity", "pebble", "erb"]) {
      expect(nextStepFor(e)).toContain("playbook ssti");
    }
    expect(nextStepFor("unknown")).not.toContain("RCE");
  });
  it("ladder stays within the request budget", () => {
    expect(SSTI_LADDER.length).toBeLessThanOrEqual(9);
  });
});
