import { describe, expect, it } from "vitest";
import { roleGateRefusal, toolDomain, agentDomains, classifiedToolNames } from "./roleGate";
import { getTOOLS } from "./tools";

const NOT_YOURS = /Not your tool/;

describe("role gate — a tool belongs to one agent", () => {
  it("lets Agnes run research tools", () => {
    for (const t of ["web_search", "google_news", "research", "places_search", "hotel_search"]) {
      expect(roleGateRefusal("agnes", t), t).toBeNull();
    }
  });

  it("refuses Agnes a coder tool and names the owner", () => {
    const r = roleGateRefusal("agnes", "exec");
    expect(r).toMatch(NOT_YOURS);
    expect(r).toContain("Michelle");
    expect(r).toContain("NOT run");
  });

  it("refuses Agnes a security tool", () => {
    const r = roleGateRefusal("agnes", "http_request");
    expect(r).toMatch(NOT_YOURS);
    expect(r).toContain("Michelle");
  });

  it("lets Michelle run code and security tools", () => {
    for (const t of ["exec", "exec_write", "write_file", "file_read", "codebase_search", "http_request", "poc_verify", "finding_add"]) {
      expect(roleGateRefusal("michelle", t), t).toBeNull();
    }
  });

  it("refuses Michelle a research tool and names Agnes", () => {
    const r = roleGateRefusal("michelle", "google_news");
    expect(r).toMatch(NOT_YOURS);
    expect(r).toContain("Agnes");
  });

  it("refuses both of them the owner's personal-assistant tools", () => {
    for (const agent of ["agnes", "michelle"]) {
      const r = roleGateRefusal(agent, "remind_me");
      expect(r, agent).toMatch(NOT_YOURS);
      expect(r).toContain("Mia");
    }
  });
});

describe("role gate — fails open", () => {
  // This is the property that keeps verify.ts, every drill/probe, the Live
  // route and the whole web/Telegram/automation surface working untouched.
  it("allows everything when no agent label is supplied", () => {
    for (const t of ["exec", "write_file", "remind_me", "http_request", "google_news", "delete_note"]) {
      expect(roleGateRefusal(undefined, t), t).toBeNull();
    }
  });

  it("never gates Mia", () => {
    for (const t of ["exec", "write_file", "remind_me", "http_request", "google_news", "delete_note"]) {
      expect(roleGateRefusal("mia", t), t).toBeNull();
    }
  });

  it("ignores a garbage or empty label instead of blocking everything", () => {
    for (const bad of ["", "root", "AGNES", "Michelle ", "toString", "__proto__", "constructor"]) {
      expect(roleGateRefusal(bad, "exec"), bad).toBeNull();
    }
  });

  it("allows an unclassified tool for everyone (a new tool keeps working)", () => {
    expect(roleGateRefusal("agnes", "some_tool_added_next_month")).toBeNull();
    expect(roleGateRefusal("michelle", "some_tool_added_next_month")).toBeNull();
  });
});

describe("role gate — classification integrity", () => {
  it("only maps real domains", () => {
    for (const name of classifiedToolNames()) {
      expect(["research", "code", "security", "assistant"], name).toContain(toolDomain(name));
    }
  });

  // A typo in the table is silently inert (fail open), so this is the only
  // thing that catches a name that does not exist in the registry.
  it("only classifies tools that actually exist in the registry", () => {
    const real = new Set(getTOOLS().map((t) => t.function.name));
    const ghosts = classifiedToolNames().filter((n) => !real.has(n));
    expect(ghosts).toEqual([]);
  });

  it("agrees on who owns which domain", () => {
    expect(agentDomains("agnes")).toEqual(["research"]);
    expect(agentDomains("michelle")).toEqual(["code", "security"]);
    expect(agentDomains("mia")).toBeUndefined();
    expect(agentDomains(undefined)).toBeUndefined();
  });
});