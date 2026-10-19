import { describe, expect, it } from "vitest";
import {
  agentOfUserKey,
  hasAuthorshipClaim,
  attributionNote,
  classifyAttributionClaim,
  eventTypeForTool,
  projectIdFor,
  projectLedger,
  workEventsFromAudit,
  workHistoryNote,
  type AuditLine,
} from "./attribution";

const DIR = "/Users/n/Documents/TEST_MICHELLE";
const MIA = "naufalazhar652952";
const MICHELLE = `${MIA}.michelle`;
const AGNES = `${MIA}.agnes`;

function line(ts: string, action: string, detail: unknown, user = MIA): AuditLine {
  return { ts, user, action, detail: typeof detail === "string" ? detail : JSON.stringify(detail) };
}
const write = (ts: string, path: string, user = MICHELLE) => line(ts, "tool:write_file", { path }, user);
const read = (ts: string, path: string, user = MICHELLE) => line(ts, "tool:file_read", { path }, user);
const claim = (text: string, artifact: string | null = null, agent = "michelle", events: ReturnType<typeof workEventsFromAudit> = []) =>
  classifyAttributionClaim(text, { events, agent, artifact });

describe("attribution — recorded operations only (owner task 2026-10-18)", () => {
  it("1. creation recorded for another agent never credits the speaker", () => {
    const ev = workEventsFromAudit([write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`)]);
    const r = claim("Aku yang bikin index.html itu", `${DIR}/index.html`, "michelle", ev);
    expect(r.claimed).toBe(true);
    expect(["PARTIALLY_SUPPORTED", "UNKNOWN", "HISTORICAL_UNVERIFIED"]).toContain(r.status);
    // The live incident: Michelle only READ nusa.html, and claimed it.
    // The live claim: "nusa.html itu project yang aku bikin" — but the only
    // record anywhere in that project is Michelle READING nusa.html.
    const readEv = workEventsFromAudit([write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`), read("2026-10-18T07:23:19.000Z", `${DIR}/nusa.html`)]);
    const readOnly = claim("nusa.html itu project yang aku bikin", `${DIR}/nusa.html`, "michelle", readEv);
    expect(readOnly.status).toBe("CONFIRMED_INSPECTION");
    expect(readOnly.note).toMatch(/bukan dibuat/);
  });

  it("2. inspect-only claims an inspection, never a creation", () => {
    const ev = workEventsFromAudit([read("2026-10-18T07:23:19.000Z", `${DIR}/nusa.html`)]);
    const r = claim("Apakah kamu yang bikin nusa.html?", `${DIR}/nusa.html`, "michelle", ev);
    expect(r.status).toBe("CONFIRMED_INSPECTION");
    expect(r.note).not.toMatch(/tujuan utama|berhasil bikin/);
  });

  it("3. a recorded write supports the contribution but never the origin", () => {
    const ev = workEventsFromAudit([write("2026-10-16T03:28:21.000Z", `${DIR}/product-detail.html`)]);
    const r = claim("Aku yang bikin product-detail.html", `${DIR}/product-detail.html`, "michelle", ev);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.note).toMatch(/asal-usulnya belum bisa dipastikan/);
  });

  it("4. modifying one file is not authoring the whole project", () => {
    const ev = workEventsFromAudit([write("2026-10-16T03:28:21.000Z", `${DIR}/product-detail.html`)]);
    const r = claim("Project ini aku buat dari nol", null, "michelle", ev);
    expect(r.status).not.toBe("CONFIRMED_CONTRIBUTION");
  });

  it("5. only mentioned in chat yields no confirmed status", () => {
    const ev = workEventsFromAudit([write("2026-10-16T03:28:21.000Z", `${DIR}/index.html`, AGNES)]);
    const r = claim("Aku yang bikin index.html", `${DIR}/index.html`, "michelle", ev);
    expect(r.status).not.toBe("CONFIRMED_CONTRIBUTION");
    expect(r.claimed).toBe(true);
  });

  it("6. a low-relevance memory hit is not evidence (no audit record at all)", () => {
    const r = claim("Aku yang bikin project itu", null, "michelle", []);
    expect(r.status).toBe("HISTORICAL_UNVERIFIED");
    expect(r.note).toMatch(/belum bisa dipastikan/);
  });

  it("7. a planned task that never executed stays unverified", () => {
    const ev = workEventsFromAudit([line("2026-10-17T02:00:00.000Z", "task_created", { task_id: "t1" })]);
    expect(claim("Aku yang bikin project itu", null, "michelle", ev).status).toBe("HISTORICAL_UNVERIFIED");
  });

  it("8. a failed tool call is not a write record", () => {
    // A tool that errored leaves no record, so there is nothing to attribute to.
    const err = line("2026-10-17T02:00:00.000Z", "task_failed", { error: "write_file failed" }, MICHELLE);
    expect(workEventsFromAudit([err])).toHaveLength(0);
    expect(claim("Aku yang bikin x.html", `${DIR}/x.html`, "michelle", []).status).toBe("HISTORICAL_UNVERIFIED");
  });

  it("9. timestamps are reported as recorded, in the ledger", () => {
    const ev = workEventsFromAudit([write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`)]);
    expect(ev[0]!.timestamp).toBe("2026-10-16T03:18:37.000Z");
    expect(workHistoryNote("michelle", `${DIR}/index.html`, ev)).toMatch(/2026-10-16/);
  });

  it("10. a user correction must not become evidence", () => {
    // Same text, but the record still says read-only: correction cannot upgrade it.
    const ev = workEventsFromAudit([read("2026-10-18T07:23:19.000Z", `${DIR}/nusa.html`)]);
    const before = claim("Aku yang bikin nusa.html", `${DIR}/nusa.html`, "michelle", ev).status;
    const after = claim("Betul, aku yang bikin nusa.html ya", `${DIR}/nusa.html`, "michelle", ev).status;
    expect(after).toBe(before);
    expect(after).not.toBe("CONFIRMED_CONTRIBUTION");
  });

  it("11. conflicting records (two agents wrote it) stay qualified", () => {
    const ev = workEventsFromAudit([
      write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`, MICHELLE),
      write("2026-10-17T03:18:37.000Z", `${DIR}/index.html`, AGNES),
    ]);
    expect(claim("Aku yang bikin index.html", `${DIR}/index.html`, "michelle", ev).status).toBe("PARTIALLY_SUPPORTED");
    expect(claim("Siapa yang bikin index.html?", `${DIR}/index.html`, "michelle", ev).note).toMatch(/asal-usulnya/);
  });

  it("12. missing timestamps never invent a date", () => {
    const ev = workEventsFromAudit([{ ts: "", user: MICHELLE, action: "tool:write_file", detail: JSON.stringify({ path: `${DIR}/a.html` }) }]);
    expect(ev[0]!.timestamp).toBe("");
    expect(ev[0]!.verification_status).toBe("PARTIALLY_SUPPORTED");
  });

  it("13. a file with no origin stays UNKNOWN in the ledger", () => {
    const led = projectLedger(workEventsFromAudit([read("2026-10-18T07:23:19.000Z", `${DIR}/nusa.html`)]));
    expect(led[0]!.project_origin).toBe("UNKNOWN");
    expect(led[0]!.ownership_status).not.toBe("CONFIRMED");
  });

  it("14. an imported external repo is never self-authored", () => {
    const ev = workEventsFromAudit([read("2026-10-18T07:23:19.000Z", `${DIR}/nusa.html`)]);
    const r = claim("Project ini project open-source yang aku buat dari nol", `${DIR}/nusa.html`, "michelle", ev);
    expect(r.claimed).toBe(true);
    expect(r.status).not.toBe("CONFIRMED_CONTRIBUTION");
  });

  it("15. an unregistered agent gets no invented history", () => {
    const ev = workEventsFromAudit([write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`)]);
    expect(claim("Aku yang bikin index.html", `${DIR}/index.html`, "agent-yang-tidak-terdaftar", ev).status)
      .toBe("HISTORICAL_UNVERIFIED");
  });

  it("16. ordinary answers keep working (no claim, no note)", () => {
    const ev = workEventsFromAudit([write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`)]);
    const r = claim("Halo Mas Naufal, apa kabar?", null, "michelle", ev);
    expect(r.claimed).toBe(false);
    expect(r.note).toBe("");
    expect(workHistoryNote("michelle", `${DIR}/tidak-ada.html`, ev)).toBe("");
  });
});

describe("attribution — plumbing", () => {
  it("maps tools to event types and ignores non-work tools", () => {
    expect(eventTypeForTool("write_file")).toBe("MODIFIED");
    expect(eventTypeForTool("file_read")).toBe("INSPECTED");
    expect(eventTypeForTool("codebase_search")).toBe("REVIEWED");
    expect(eventTypeForTool("calculate")).toBeNull();
  });
  it("resolves the project to a meaningful ancestor directory", () => {
    expect(projectIdFor(`${DIR}/nested/deep/x.html`).name).toBe("TEST_MICHELLE");
    expect(projectIdFor(`${DIR}/nusa.html`).name).toBe("TEST_MICHELLE");
  });
  it("resolves the agent from the user-key suffix", () => {
    expect(agentOfUserKey(`${MIA}.michelle`)).toBe("michelle");
    expect(agentOfUserKey(`${MIA}.agnes`)).toBe("agnes");
    expect(agentOfUserKey(MIA)).toBe("mia");
  });
  it("ignores non-tool audit lines", () => {
    const ev = workEventsFromAudit([line("2026-10-18T05:00:00.000Z", "orchestration_end", "x"), line("2026-10-18T05:00:00.000Z", "turn_provider", "9router")]);
    expect(ev).toHaveLength(0);
  });
  it("honours sinceIso so old work does not masquerade as recent", () => {
    const ev = workEventsFromAudit([write("2026-01-01T00:00:00.000Z", `${DIR}/index.html`)], { sinceIso: "2026-10-01T00:00:00.000Z" });
    expect(ev).toHaveLength(0);
  });
});

describe("attributionNote — the guard that reaches the user", () => {
  it("stays silent on an ordinary answer", () => {
    expect(attributionNote("Halo Mas Naufal, apa kabar?", { user: MIA, agent: "michelle" })).toBe("");
  });
  it("appends the record correction when the reply claims a creation with no write record", () => {
    const note = attributionNote("nusa.html itu project yang aku bikin", { user: "verify_attr_no_such_user", agent: "michelle" });
    expect(note).toMatch(/belum bisa dipastikan/);
  });
  it("reads records cross-agent: a sibling's write cannot confirm the speaker", () => {
    // No such user ⇒ no events at all ⇒ the claim can never be confirmed.
    const note = attributionNote("Aku yang bikin project ini", { user: "verify_attr_no_such_user", agent: "michelle" });
    expect(note).not.toMatch(/terbukti|berhasil|kamu benar/);
  });
});

describe("attribution — audit pass 2 (fail-closed edges)", () => {
  it("an undated audit line cannot slip into a since-window", () => {
    const undated: AuditLine = { ts: "", user: MICHELLE, action: "tool:write_file", detail: JSON.stringify({ path: `${DIR}/a.html` }) };
    expect(workEventsFromAudit([undated], { sinceIso: "2026-10-01T00:00:00.000Z" })).toHaveLength(0);
    // Without a window it is still usable — only the window check is affected.
    expect(workEventsFromAudit([undated])).toHaveLength(1);
  });
  it("the ledger lists the most recently touched project first, whatever the input order", () => {
    // Regression lock for ledger ordering (the original comparator is already
    // descending; an audit pass briefly fixed it to a<b, which is the SAME
    // predicate — the mutation proved nothing, so the code stayed as-is).
    const ev = workEventsFromAudit([
      read("2026-10-10T00:00:00.000Z", "/Users/n/Documents/OLD/a.html"),
      read("2026-10-14T00:00:00.000Z", "/Users/n/Documents/MID/c.html"),
      read("2026-10-18T00:00:00.000Z", "/Users/n/Documents/NEW/b.html"),
    ]).reverse(); // ascending by timestamp, so insertion order != recency order
    const led = projectLedger(ev);
    expect(led.map((p) => p.project_name)).toEqual(["NEW", "MID", "OLD"]);
  });
});

describe("attribution — audit pass 3 (passive claims + real day window)", () => {
  it("a passive authorship claim is still a claim", () => {
    const ev = workEventsFromAudit([read("2026-10-18T07:23:19.000Z", `${DIR}/nusa.html`)]);
    for (const text of [
      "nusa.html itu yang bikin dia",
      "nusa.html itu dibuat oleh Michelle",
      "itu hasil karya Michelle",
      "file itu ditulis oleh dia sendiri",
    ]) {
      const r = claim(text, `${DIR}/nusa.html`, "michelle", ev);
      expect(r.claimed, `not detected: ${text}`).toBe(true);
      expect(r.status, `wrong status: ${text}`).toBe("CONFIRMED_INSPECTION");
    }
  });

  it("still leaves an ordinary sentence alone", () => {
    const ev = workEventsFromAudit([read("2026-10-18T07:23:19.000Z", `${DIR}/nusa.html`)]);
    expect(claim("nusa.html itu halaman detail produk", `${DIR}/nusa.html`, "michelle", ev).claimed).toBe(false);
    expect(claim("file itu dibuat untuk testing lokal", `${DIR}/nusa.html`, "michelle", ev).claimed).toBe(false);
  });

  it("`days` is a real time window, not a file count", async () => {
    const { readWorkEvents } = await import("./attribution");
    const events = readWorkEvents(MIA, { days: 1 });
    const now = Date.now();
    // Everything inside the window must actually be inside a 1-day window.
    for (const e of events) {
      const at = new Date(e.timestamp).getTime();
      if (!Number.isNaN(at)) expect(at).toBeGreaterThanOrEqual(now - 86_400_000 - 60_000);
    }
  });
});

describe("attribution — audit pass 4 (subject, project scope, cheap gate)", () => {
  const ev = workEventsFromAudit([write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`)]);

  it("a project-level claim keeps the recorded writes (no file named)", () => {
    const r = claim("apakah kamu yang bikin project ini?", null, "michelle", ev);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.reason).not.toMatch(/tidak ada operasi tulis maupun baca/);
  });

  it("never contradicts its own history line", () => {
    const r = claim("apakah kamu yang bikin project ini?", null, "michelle", ev);
    const history = workHistoryNote("michelle", null, ev);
    expect(history).toMatch(/menulis 1 file/);
    expect(history).not.toMatch(/untuk unknown/);
    // The verdict and the history must not disagree about whether ops exist.
    expect(/(tidak ada operasi tulis)/.test(r.reason)).toBe(/(menulis \\d+ file)/.test(history));
  });

  it("a third-party question is judged on the SUBJECT's records", () => {
    const r = claim("apakah Michelle yang bikin index.html?", null, "mia", ev);
    expect(r.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("an ambiguous subject never guesses (two names = speaker scope)", () => {
    const twoAgents = workEventsFromAudit([
      write("2026-10-16T03:18:37.000Z", `${DIR}/index.html`, MICHELLE),
      write("2026-10-17T03:18:37.000Z", `${DIR}/index.html`, AGNES),
    ]);
    // Mia asked about both: the guard must not pick one, so it says unverified.
    expect(claim("apakah Michelle atau Agnes yang bikin index.html?", null, "mia", twoAgents).status)
      .toBe("HISTORICAL_UNVERIFIED");
  });

  it("an ordinary message is rejected by the cheap gate before any disk read", () => {
    expect(hasAuthorshipClaim("Halo Mas Naufal, apa kabar?")).toBe(false);
    expect(hasAuthorshipClaim("index.html itu halaman detail produk")).toBe(false);
    expect(hasAuthorshipClaim("apakah kamu yang bikin index.html?")).toBe(true);
  });
});

describe("attribution — task chain (owner task 2026-10-18: plan → task → tool)", () => {
  it("reads the task id tools.ts writes and refuses to invent one", () => {
    const tagged = workEventsFromAudit([
      line("2026-10-19T02:00:00.000Z", "tool:write_file", `{"path":"${DIR}/index.html"} ||task=ps_orch_abc_t1`, MICHELLE),
    ]);
    expect(tagged[0]!.task_id).toBe("ps_orch_abc_t1");
    const untagged = workEventsFromAudit([write("2026-10-19T02:00:00.000Z", `${DIR}/other.html`)]);
    expect(untagged[0]!.task_id).toBeNull();
  });

  it("a project ledger links the tasks its work ran under", () => {
    const led = projectLedger(workEventsFromAudit([
      line("2026-10-19T02:00:00.000Z", "tool:write_file", `{"path":"${DIR}/index.html"} ||task=t1`, MICHELLE),
      line("2026-10-19T02:05:00.000Z", "tool:file_read", `{"path":"${DIR}/nusa.html"} ||task=t2`, MICHELLE),
    ]));
    expect(led[0]!.related_task_ids).toEqual(["t1", "t2"]);
  });
});

describe("attribution — producer side: the audit line really carries the task (2026-10-18)", () => {
  // Fixture-only tests cannot catch a broken producer: they embed the
  // "||task=" suffix by hand. This runs the real executeTool inside a real
  // bus turn context and reads back what the audit log actually wrote.
  it("executeTool inside withBusTurn stamps the orchestrator task id", async () => {
    const { executeTool } = await import("./tools");
    const { withBusTurn, busTurnContext } = await import("./bus");
    const { readdirSync, readFileSync, rmSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { appRoot } = await import("./users");
    const user = `verify_tasktag_${Date.now().toString(36)}`;
    await withBusTurn({ turnId: "turn_tag", taskId: "ps_orch_tag_t1", userKey: user, actor: "michelle" }, async () => {
      expect(busTurnContext()?.taskId).toBe("ps_orch_tag_t1");
      const out = await executeTool({ id: "t", name: "file_read", arguments: JSON.stringify({ path: "README.md" }) }, user);
      expect(out).not.toMatch(/^Error:/);
    });
    const dir = join(appRoot(), ".data", "audit");
    const stamped = readdirSync(dir)
      .filter((f) => f.startsWith("AUDIT-") && f.endsWith(".log"))
      .flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n"))
      .filter((l) => l.includes(user) && l.includes("tool:file_read"))
      .find((l) => l.includes("||task=ps_orch_tag_t1"));
    expect(stamped, "audit line must carry the bus task id").toBeTruthy();
    const ev = workEventsFromAudit([JSON.parse(stamped!) as AuditLine]);
    expect(ev[0]!.task_id).toBe("ps_orch_tag_t1");
    rmSync(join(appRoot(), ".data", "users", user), { recursive: true, force: true });
  }, 30_000);
});
