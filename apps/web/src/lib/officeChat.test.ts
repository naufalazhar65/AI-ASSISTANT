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
  parseInboxSummary,
  OFFICE_AGENTS,
} from "./officeChat";
import type { ChatMessage } from "./agent";

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
    // A paused turn is not final: the call that is not approved yet has not
    // had its chance to run, so it is still queued, not "unknown".
    const cards = toolCardsFromMessages(proposed, { pendingIds: ["t2"], final: false });
    expect(cards.map((c) => c.state)).toEqual(["queued", "awaiting_approval"]);
  });

  it("marks an explicitly declined call cancelled", () => {
    const cards = toolCardsFromMessages(proposed() as never, { cancelledIds: ["t2"], final: false });
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
    // The OTHER placeholder — the one written when a call has NO outcome on
    // record — is unknown, never cancelled and never succeeded.
    expect(
      toolResultState("Not executed (no result recorded) — do NOT assume this action ran; propose it again if still needed."),
    ).toBe("unknown");
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
    for (const s of [
      "queued",
      "running",
      "awaiting_approval",
      "succeeded",
      "failed",
      "cancelled",
      "timed_out",
      "unknown",
    ] as const) {
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
/* ── execution integrity (2026-10-20) ──────────────────────────────────────
   A card must never show a state the backend did not report, and a card must
   never be rewritten by an event belonging to another turn. */
describe("officeChat — execution integrity", () => {
  const proposal = (calls: { id: string; name: string }[]): ChatMessage => ({
    role: "assistant",
    content: "",
    tool_calls: calls.map((c) => call(c.id, c.name)),
  });
  const result = (id: string, content: string): ChatMessage => ({
    role: "tool",
    content,
    tool_call_id: id,
  });
  const call = (id: string, name: string) => ({
    id,
    type: "function" as const,
    function: { name, arguments: "{}" },
  });
  const NO_RESULT =
    "Not executed (no result recorded) — do NOT assume this action ran; propose it again if still needed.";

  it("marks a call with no outcome as unknown — never succeeded, never 'will run'", () => {
    const cards = toolCardsFromMessages([proposal([{ id: "call_a", name: "gmail_list" }])]);
    expect(cards[0].state).toBe("unknown");
    expect(cards[0].summary).toBe(toolStateLabel("unknown"));
  });

  it("keeps the outcome of each call separate when two calls share a name", () => {
    const cards = toolCardsFromMessages([
      proposal([
        { id: "call_a", name: "gmail_list" },
        { id: "call_b", name: "gmail_list" },
      ]),
      result("call_a", "Error: boom"),
      result("call_b", "3 pesan"),
    ]);
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(byId.get("call_a")?.state).toBe("failed");
    expect(byId.get("call_b")?.state).toBe("succeeded");
  });

  it("cancels exactly the declined call id and leaves its sibling alone", () => {
    const cards = toolCardsFromMessages(
      [
        proposal([
          { id: "call_a", name: "gmail_list" },
          { id: "call_b", name: "gmail_list" },
        ]),
      ],
      { cancelledIds: ["call_b"], final: false },
    );
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(byId.get("call_a")?.state).toBe("queued");
    expect(byId.get("call_b")?.state).toBe("cancelled");
  });

  it("separates the user-facing summary from the raw diagnostics", () => {
    const cards = toolCardsFromMessages([
      proposal([{ id: "call_a", name: "gmail_list" }]),
      result("call_a", "3 pesan\nlubang: yok"),
    ]);
    expect(cards[0].summary).toBe("Selesai");
    expect(cards[0].result).toBe("3 pesan");
    expect(cards[0].detail).toContain("lubang: yok");
  });

  it("never puts the raw result text into the user-facing summary", () => {
    const cards = toolCardsFromMessages([
      proposal([{ id: "call_a", name: "gmail_list" }]),
      result("call_a", NO_RESULT),
    ]);
    expect(cards[0].summary).toBe(toolStateLabel("unknown"));
    expect(cards[0].summary).not.toContain("Not executed");
    expect(cards[0].result).toBeUndefined();
  });

  it("reads a timeout as timed_out, not a plain failure", () => {
    expect(toolResultState("Error: request timed out")).toBe("timed_out");
  });
});

/* ── inbox results (§3/§4/§7) — mocked fixtures, never a real inbox ────── */
const INBOX_TEXT = [
  "📬 Ringkasan Inbox — 2 email terbaru · 20 Okt 2026, 14.05 – 20 Okt 2026, 14.45 WIB",
  "1. [18f2a1b3c4d5e6f7] Cashback Rp15 Ribu! | Home Credit Indonesia | 20 Okt 2026, 14.45 WIB | Belanja Kebutuhan, cashback menanti kamu.",
  "2. [19a2b1c3c4d5e6f8]-security-notice | Example Security | 20 Okt 2026, 14.05 WIB | Login baru terdeteksi.",
].join("\n");

describe("parseInboxSummary", () => {
  it("parses the compact inbox output into a real list", () => {
    const inbox = parseInboxSummary(INBOX_TEXT);
    expect(inbox).not.toBeNull();
    expect(inbox!.count).toBe(2);
    expect(inbox!.range).toContain("14.05");
    expect(inbox!.emails).toHaveLength(2);
    expect(inbox!.emails[0].subject).toBe("Cashback Rp15 Ribu!");
    expect(inbox!.emails[0].from).toBe("Home Credit Indonesia");
    expect(inbox!.emails[0].at).toBe("20 Okt 2026, 14.45 WIB");
    expect(inbox!.emails[0].snippet).toContain("cashback");
  });

  it("returns null for anything that is not an inbox summary", () => {
    expect(parseInboxSummary("Error: boom")).toBeNull();
    expect(parseInboxSummary("")).toBeNull();
    expect(parseInboxSummary("📧 10 email terbaru:\n1. something")).toBeNull();
  });

  it("keeps an email whose provider date was unusable — the time is empty, never invented", () => {
    const inbox = parseInboxSummary(
      "📬 Ringkasan Inbox — 1 email terbaru\n1. [id] Subj | Sender |  | snippet",
    );
    expect(inbox!.emails[0].at).toBe("");
  });
});

describe("tool cards — the inbox result belongs to the call that produced it", () => {
  const proposal = (calls: { id: string; name: string }[]): ChatMessage => ({
    role: "assistant",
    content: "",
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: "function" as const,
      function: { name: c.name, arguments: "{}" },
    })),
  });
  const result = (id: string, content: string): ChatMessage => ({
    role: "tool",
    content,
    tool_call_id: id,
  });

  it("attaches the inbox list to a SUCCEEDED gmail_list", () => {
    const cards = toolCardsFromMessages([
      proposal([{ id: "call_a", name: "gmail_list" }]),
      result("call_a", INBOX_TEXT),
    ]);
    expect(cards[0].state).toBe("succeeded");
    expect(cards[0].inbox).toBeDefined();
    expect(cards[0].inbox!.emails).toHaveLength(2);
  });

  it("a CANCELLED call never shows an inbox list", () => {
    const cards = toolCardsFromMessages(
      [proposal([{ id: "call_a", name: "gmail_list" }])],
      { cancelledIds: ["call_a"], final: false },
    );
    expect(cards[0].state).toBe("cancelled");
    expect(cards[0].inbox).toBeUndefined();
  });

  it("a call with no result never shows an inbox list", () => {
    const cards = toolCardsFromMessages([proposal([{ id: "call_a", name: "gmail_list" }])]);
    expect(cards[0].state).toBe("unknown");
    expect(cards[0].inbox).toBeUndefined();
  });

  it("a FAILED call never shows an inbox list", () => {
    const cards = toolCardsFromMessages([
      proposal([{ id: "call_a", name: "gmail_list" }]),
      result("call_a", "Error: token dicabut"),
    ]);
    expect(cards[0].state).toBe("failed");
    expect(cards[0].inbox).toBeUndefined();
  });

  it("a non-inbox tool never gets an inbox list", () => {
    const cards = toolCardsFromMessages([
      proposal([{ id: "call_a", name: "web_search" }]),
      result("call_a", INBOX_TEXT),
    ]);
    expect(cards[0].inbox).toBeUndefined();
  });
});
