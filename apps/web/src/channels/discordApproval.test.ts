import { describe, expect, it } from "vitest";
import {
  APPROVAL_TTL_MS,
  approvalCustomId,
  approvalMessage,
  approvalRiskOf,
  approvalStatusEmbed,
  approvalTargetOf,
  createApprovalRequest,
  decideApproval,
  disabledApprovalRow,
  getApproval,
  isApprovalAuthorized,
  markApproval,
  parseApprovalCustomId,
  type ApprovalStore,
} from "./discordApproval";

const CALLS = [
  { id: "t1", name: "pentest_scan", arguments: JSON.stringify({ target: "https://lab.example/x", tool: "whatweb" }) },
];

function req(store?: ApprovalStore, calls = CALLS) {
  return createApprovalRequest({
    agentLabel: "mia",
    agentDisplay: "Mia | PM",
    userKey: "naufal",
    provider: "9router",
    messages: [],
    calls: calls as never,
    store,
  });
}

describe("customId is opaque and round-trips", () => {
  it("carries only the request id, never args or targets", () => {
    const id = req(new Map()).id;
    expect(approvalCustomId("ap", id)).toBe(`mia-ap:${id}`);
    expect(approvalCustomId("rj", id)).not.toContain("lab.example");
    expect(parseApprovalCustomId(`mia-ap:${id}`)).toEqual({ action: "ap", id });
    expect(parseApprovalCustomId(`mia-rj:${id}`)).toEqual({ action: "rj", id });
    expect(parseApprovalCustomId("mia-ap:")).toBeNull();
    expect(parseApprovalCustomId("other:prefix")).toBeNull();
    expect(parseApprovalCustomId(`mia-ap:${id};DROP`)).toBeNull();
  });
});

describe("decideApproval is one-shot (no double execution)", () => {
  it("first click wins; every later click sees decided", () => {
    const store = new Map();
    const r = req(store);
    expect(decideApproval(r.id, "u1", true, store).ok).toBe(true);
    const again = decideApproval(r.id, "u2", true, store);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.reason).toBe("decided");
    const deny = decideApproval(r.id, "u1", false, store);
    expect(deny.ok).toBe(false);
  });

  it("missing id and cross-request isolation", () => {
    const store = new Map();
    const a = req(store);
    const b = req(store);
    expect(a.id).not.toBe(b.id);
    expect(decideApproval("ap_nonexistent", "u1", true, store)).toEqual({ ok: false, reason: "missing" });
    expect(decideApproval(a.id, "u1", true, store).ok).toBe(true);
    expect(getApproval(b.id, store)?.status).toBe("PENDING");
  });

  it("expired requests can never execute", () => {
    const store = new Map();
    const r = createApprovalRequest({
      agentLabel: "mia",
      agentDisplay: "Mia",
      userKey: "u",
      provider: "p",
      messages: [],
      calls: CALLS as never,
      store,
      ttlMs: -1,
    });
    expect(getApproval(r.id, store)?.status).toBe("EXPIRED");
    const d = decideApproval(r.id, "u1", true, store);
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toBe("expired");
  });

  it("terminal states stick (FAILED never returns to PENDING)", () => {
    const store = new Map();
    const r = req(store);
    expect(decideApproval(r.id, "u1", true, store).ok).toBe(true);
    markApproval(r.id, "EXECUTING", store);
    markApproval(r.id, "FAILED", store);
    expect(getApproval(r.id, store)?.status).toBe("FAILED");
    markApproval(r.id, "PENDING", store);
    expect(getApproval(r.id, store)?.status).toBe("FAILED");
  });
});

describe("authorization", () => {
  it("empty allow-list is open; otherwise member-only", () => {
    expect(isApprovalAuthorized([], "anyone")).toBe(true);
    expect(isApprovalAuthorized(["u1"], "u1")).toBe(true);
    expect(isApprovalAuthorized(["u1"], "u2")).toBe(false);
  });
});

describe("embed redacts secrets and shows by-design targets", () => {
  it("never leaks credential args", () => {
    const store = new Map();
    const r = req(store, [
      { id: "t9", name: "rapyd_request", arguments: JSON.stringify({ secret_key: "rsk_superrahasia123", path: "/v1/x" }) },
    ]);
    const { embeds } = approvalMessage(r);
    const text = JSON.stringify(embeds);
    expect(text).not.toContain("rsk_superrahasia123");
    expect(text).toContain("rapyd_request");
  });

  it("target comes from by-design fields, never free text", () => {
    expect(approvalTargetOf({ id: "t", name: "x", arguments: JSON.stringify({ target: "https://lab.example/x" }) })).toBe(
      "https://lab.example/x"
    );
    expect(approvalTargetOf({ id: "t", name: "x", arguments: JSON.stringify({ references: "see https://evil.example" }) })).toBe("");
    expect(approvalTargetOf({ id: "t", name: "x", arguments: "not-json{{{" })).toBe("");
  });

  it("risk labels come from the tool registry", () => {
    expect(approvalRiskOf("http_request")).toMatch(/Sedang|menengah/i);
    expect(approvalRiskOf("no_such_tool_xyz")).toBe("Tidak diketahui");
  });
});

describe("message builders", () => {
  it("approval message has embed + two buttons with opaque ids", () => {
    const store = new Map();
    const r = req(store);
    const { embeds, components } = approvalMessage(r);
    expect(embeds).toHaveLength(1);
    expect(JSON.stringify(embeds[0])).toContain("Persetujuan Diperlukan");
    expect(components).toHaveLength(1);
    const row = components[0].toJSON();
    expect(row.components).toHaveLength(2);
    expect((row.components[0] as { custom_id?: string }).custom_id).toBe(`mia-ap:${r.id}`);
    expect((row.components[1] as { custom_id?: string }).custom_id).toBe(`mia-rj:${r.id}`);
  });

  it("disabled row keeps customIds (Discord needs them to match)", () => {
    const row = disabledApprovalRow({ approve: "mia-ap:x", reject: "mia-rj:x" }).toJSON();
    expect(row.components.every((c) => c.disabled)).toBe(true);
    expect((row.components[0] as { custom_id?: string }).custom_id).toBe("mia-ap:x");
  });

  it("status embeds name the decision without secret values", () => {
    const store = new Map();
    const r = req(store, [
      { id: "t9", name: "rapyd_request", arguments: JSON.stringify({ secret_key: "rsk_superrahasia123" }) },
    ]);
    r.decidedBy = "u1";
    for (const k of ["approved", "rejected", "expired", "completed", "failed"] as const) {
      const text = JSON.stringify(approvalStatusEmbed(r, k).toJSON());
      expect(text).toContain(r.id);
      expect(text).not.toContain("rsk_superrahasia123");
    }
  });

  it(`TTL is ${APPROVAL_TTL_MS / 60000} minutes and stored per request`, () => {
    const store = new Map();
    const r = req(store);
    expect(r.expiresAt - r.createdAt).toBe(APPROVAL_TTL_MS);
  });
});

describe("restart and persistence contract", () => {
  it("a restart drops pending requests fail-closed (missing, never phantom-approved)", () => {
    const before = new Map();
    const r = req(before);
    // Simulate a restart: a fresh empty registry.
    const afterRestart = new Map();
    expect(getApproval(r.id, afterRestart)).toBeUndefined();
    expect(decideApproval(r.id, "u1", true, afterRestart)).toEqual({ ok: false, reason: "missing" });
  });

  it("expiry is validated on read, not by timers", () => {
    const store = new Map();
    const r = req(store);
    expect(getApproval(r.id, store)?.status).toBe("PENDING");
    r.expiresAt = Date.now() - 1000;
    expect(getApproval(r.id, store)?.status).toBe("EXPIRED");
  });
});

describe("live polish (2026-10-15 16:12 screenshot)", () => {
  it("target-only args are not reprinted as JSON next to the target line", () => {
    const store = new Map();
    const r = req(store);
    const text = JSON.stringify(approvalMessage(r).embeds[0]);
    expect(text).toContain("pentest_scan");
    expect(text).toContain("https://lab.example/x");
    expect(text).not.toContain("%22target%22");
    expect(text).not.toContain('"tool":"whatweb"');
  });

  it("extra non-target args still show (redacted when secret)", () => {
    const store = new Map();
    const r = req(store, [
      { id: "t1", name: "http_request", arguments: JSON.stringify({ url: "https://h.example/p", method: "POST" }) },
    ]);
    const text = JSON.stringify(approvalMessage(r).embeds[0]);
    expect(text).toContain("POST");
  });

  it("expiry reads as a WIB clock, never a client-locale relative time", () => {
    const store = new Map();
    const r = req(store);
    const text = JSON.stringify(approvalMessage(r).embeds[0]);
    expect(text).toMatch(/berlaku sampai \d{2}:\d{2} WIB/);
    expect(text).not.toContain("<t:");
  });
});
