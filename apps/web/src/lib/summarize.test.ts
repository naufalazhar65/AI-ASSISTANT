// Rolling-summary boundary safety. Live bug: a long pentest turn (many tool
// rounds) got "Messages with role 'tool' must be a response to a preceding
// message with 'tool_calls'" because the summary cut fell between an assistant
// `tool_calls` message and its `tool` results.

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSummarizedMessages } from "./summarize";

type Msg = { role: string; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[]; tool_call_id?: string };

const tc = (id: string) => [{ id, type: "function" as const, function: { name: "http_request", arguments: "{}" } }];

function pairs(n: number): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ role: "assistant", content: null, tool_calls: tc(`call_${i}`) });
    out.push({ role: "tool", tool_call_id: `call_${i}`, content: `result ${i}` });
  }
  return out;
}

/** A `tool` message is only valid after an assistant message declaring its id. */
function orphans(messages: { role?: string; tool_call_id?: string }[]): string[] {
  const declared = new Set<string>();
  const bad: string[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      for (const id of ((m as unknown as { tool_calls?: { id: string }[] }).tool_calls ?? []).map((c) => c.id)) declared.add(id);
    }
    if (m.role === "tool" && !declared.has(m.tool_call_id ?? "")) bad.push(m.tool_call_id ?? "?");
  }
  return bad;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildSummarizedMessages", () => {
  it("keeps the declaring assistant message when the cut would land on a tool result", async () => {
    vi.stubEnv("ROLLING_SUMMARY_TRIGGER_CHARS", "10");
    vi.stubEnv("ROLLING_SUMMARY_KEEP_RECENT", "2");
    const messages: Msg[] = [
      { role: "user", content: "mulai pentest" },
      ...pairs(6),
      { role: "user", content: "gimana hasilnya" },
    ];
    const out = (await buildSummarizedMessages({
      messages: messages as never,
      user: "t_summary",
      provider: "mock",
      model: "m",
      force: true,
      summarize: async () => "ringkasan",
    })) as { role?: string; tool_call_id?: string }[];
    expect(out[0].role).toBe("user"); // the summary digest
    expect(out[1].role).not.toBe("tool"); // tail must not start with an orphan result
    expect(orphans(out)).toEqual([]);
  });

  it("keeps tool pairs valid for every keep-recent boundary", async () => {
    vi.stubEnv("ROLLING_SUMMARY_TRIGGER_CHARS", "10");
    for (let keep = 1; keep <= 6; keep++) {
      vi.stubEnv("ROLLING_SUMMARY_KEEP_RECENT", String(keep));
      const out = (await buildSummarizedMessages({
        messages: [{ role: "user", content: "x" }, ...pairs(6)] as never,
        user: "t_summary",
        provider: "mock",
        model: "m",
        force: true,
        summarize: async () => "ringkasan",
      })) as { role?: string; tool_call_id?: string }[];
      expect(orphans(out), `keep=${keep}`).toEqual([]);
    }
  });

  it("leaves a short conversation untouched", async () => {
    vi.stubEnv("ROLLING_SUMMARY_TRIGGER_CHARS", "100000");
    const messages: Msg[] = [{ role: "user", content: "halo" }, { role: "assistant", content: "hai" }];
    const out = (await buildSummarizedMessages({ messages: messages as never, user: "t_summary", provider: "mock", model: "m", force: true })) as Msg[];
    expect(out).toHaveLength(2);
  });
});
