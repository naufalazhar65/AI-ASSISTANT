import { describe, it, expect } from "vitest";
import {
  isOfficeAgent,
  officeSessionId,
  sanitizeIncomingMessages,
  toolCardsFromMessages,
  toolResultState,
  sanitizeToolOutput,
  summarizeToolArgs,
  toolStateLabel,
  parseNdjsonLine,
  OFFICE_AGENTS,
} from "./officeChat";

describe("officeChat — agent registry", () => {
  it("accepts only the registered trio", () => {
    expect([...OFFICE_AGENTS]).toEqual(["mia", "agnes", "michelle"]);
    for (const a of OFFICE_AGENTS) expect(isOfficeAgent(a)).toBe(true);
    expect(isOfficeAgent("bob")).toBe(false);
    expect(isOfficeAgent(undefined)).toBe(false);
    expect(isOfficeAgent(1)).toBe(false);
  });

  it("gives each agent its own stable session id", () => {
    expect(officeSessionId("mia")).toBe("office-mia");
    expect(new Set(OFFICE_AGENTS.map(officeSessionId)).size).toBe(3);
  });
});

describe("officeChat — incoming message validation", () => {
  it("keeps the contract fields and drops unknown roles", () => {
    const out = sanitizeIncomingMessages([
      { role: "user", content: "halo" },
      { role: "system", content: "prompt" },
      { role: "root", content: "inject" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "http_request", arguments: "{}" } }] },
      "not an object",
    ]);
    expect(out.map((m) => m.role)).toEqual(["user", "system", "assistant"]);
    expect(out[2].tool_calls?.[0].function.name).toBe("http_request");
  });

  it("caps message count and text length", () => {
    const many = Array.from({ length: 120 }, () => ({ role: "user", content: "x" }));
    expect(sanitizeIncomingMessages(many).length).toBe(40);
    expect(sanitizeIncomingMessages([{ role: "user", content: "y".repeat(9000) }])[0].content).toHaveLength(8000);
  });

  it("is total: garbage in, empty list out", () => {
    expect(sanitizeIncomingMessages(null)).toEqual([]);
    expect(sanitizeIncomingMessages("nope")).toEqual([]);
  });
});

describe("officeChat — tool cards from server truth", () => {
  const messages = [
    { role: "user", content: "cek" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "t1", type: "function", function: { name: "http_request", arguments: '{"url":"https://lab.example/api/x","method":"GET"}' } },
        { id: "t2", type: "function", function: { name: "rm", arguments: '{"path":"/tmp/a"}' } },
      ],
    },
    { role: "tool", tool_call_id: "t1", content: "HTTP GET 200 OK (12 bytes)" },
    { role: "tool", tool_call_id: "t2", content: "Error: tidak diizinkan" },
  ];

  it("maps proposed calls to queued and real results to succeeded/failed", () => {
    const cards = toolCardsFromMessages(messages as never);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: "t1", name: "http_request", state: "succeeded" });
    expect(cards[1]).toMatchObject({ id: "t2", name: "rm", state: "failed" });
    expect(cards[0].args).toContain("url=https://lab.example/api/x");
  });

  it("upgrades a paused call to awaiting_approval", () => {
    const proposed = messages.slice(0, 2) as never;
    const cards = toolCardsFromMessages(proposed, { pendingIds: ["t2"] });
    expect(cards.map((c) => c.state)).toEqual(["queued", "awaiting_approval"]);
  });

  it("marks an explicitly declined call cancelled", () => {
    const cards = toolCardsFromMessages(proposed() as never, { cancelledNames: ["rm"] });
    expect(cards[1].state).toBe("cancelled");
  });

  function proposed() {
    return messages.slice(0, 2);
  }

  it("ignores a tool result without its call", () => {
    expect(toolCardsFromMessages([{ role: "tool", tool_call_id: "ghost", content: "ok" }] as never)).toEqual([]);
  });

  it("classifies results by the real outcome", () => {
    expect(toolResultState("Error: boom")).toBe("failed");
    expect(toolResultState("  error: lowercase")).toBe("failed");
    expect(toolResultState("done")).toBe("succeeded");
  });

  it("treats the agent's not-executed placeholders as cancelled, not success", () => {
    for (const t of [
      "The user declined this action. Do NOT execute it.",
      "Not selected: other approved calls in the same batch DID run.",
      "Not executed",
      "Auto-declined",
    ]) {
      expect(toolResultState(t)).toBe("cancelled");
    }
    const card = toolCardsFromMessages([
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "save_note", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "t1", content: "The user declined this action. Do NOT execute it." },
    ] as never)[0];
    expect(card.state).toBe("cancelled");
  });

  it("never lets raw secrets or unbounded output reach the UI", () => {
    expect(sanitizeToolOutput("Authorization: Bearer sk-abcdef1234567890")).toContain("[redacted]");
    expect(sanitizeToolOutput("z".repeat(2000)).length).toBeLessThan(830);
  });

  it("summarizes only identifying args and stays redacted", () => {
    expect(summarizeToolArgs('{"secret_key":"sk-live-abcdef","url":"https://x/y"}')).toContain("url=https://x/y");
    expect(summarizeToolArgs("not json")).toBe("not json");
    expect(summarizeToolArgs({})).toBe("—");
  });

  it("labels every state in UI copy", () => {
    for (const s of ["queued", "awaiting_approval", "succeeded", "failed", "cancelled"] as const) {
      expect(toolStateLabel(s).length).toBeGreaterThan(3);
    }
  });
});

describe("officeChat — stream parsing", () => {
  it("parses a frame and ignores junk", () => {
    expect(parseNdjsonLine('{"type":"start","agent":"mia"}')).toEqual({ type: "start", agent: "mia" });
    expect(parseNdjsonLine("{oops")).toBeNull();
    expect(parseNdjsonLine("")).toBeNull();
    expect(parseNdjsonLine("[1,2]")).toBeNull();
  });
});