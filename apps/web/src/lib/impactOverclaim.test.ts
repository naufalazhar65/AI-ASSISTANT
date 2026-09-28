import { describe, it, expect } from "vitest";
import { overclaimVerdict, evidenceIsSubstantive, SCOPE_CLAIMS } from "./impactOverclaim";

/** A SQLi dump: the evidence really does show many rows. */
const BACKUP_DUMP =
  "GET /api/cari-berita?q=' UNION SELECT username,password FROM users-- -> 200\n" +
  "rows returned: 42 (username | password)\n" +
  "sample: admin | hunter2";

describe("overclaimVerdict", () => {
  it("allows an impact that only claims what the evidence shows", () => {
    const v = overclaimVerdict("The 42 dumped rows expose every stored user password.", BACKUP_DUMP, "1. send the UNION payload");
    expect(v.allow).toBe(true);
  });

  it("refuses a whole-database claim with no proof of that breadth", () => {
    const v = overclaimVerdict("An attacker can read the ENTIRE database.", "GET /api/x -> 200 OK", "1. request the page");
    expect(v.allow).toBe(false);
    expect(v.reason).toMatch(/narrow|attach|proof/i);
  });

  it("refuses a full-source-code claim without a file-read or RCE proof", () => {
    const v = overclaimVerdict("This gives an attacker full source code access to the application.", "200 OK", "1. GET /api/x");
    expect(v.allow).toBe(false);
  });

  it("accepts a full-source-code claim when the proof IS in the evidence", () => {
    const v = overclaimVerdict(
      "This leaks the application source code.",
      "path_traversal: /etc/passwd marker read, plus GET /app/server.js returned the full file body",
      "1. traverse to the file"
    );
    expect(v.allow).toBe(true);
  });

  it("allows a hedged risk statement and reports that nobody checked it", () => {
    const v = overclaimVerdict("This could potentially expose the whole users table if the query is not filtered.", "200 OK", "1. GET /api/x");
    expect(v.allow).toBe(true);
    expect(v.hedged).toBe(true);
  });

  it("ignores a scope word that appears in a quoted/negated form", () => {
    // "does not give access to the entire database" is not a claim.
    const v = overclaimVerdict("This does not give access to the entire database; only one row leaks.", "200 OK with 1 row", "1. GET /api/x?id=1");
    expect(v.allow).toBe(true);
  });

  it("says nothing when the impact is ordinary", () => {
    const v = overclaimVerdict("A logged-in user can read another user's invoice.", "200 OK with the invoice", "1. GET /api/invoice/2");
    expect(v.allow).toBe(true);
    expect(v.claim).toBe("");
  });
});

describe("evidenceIsSubstantive", () => {
  it("accepts a real request/response", () => {
    expect(evidenceIsSubstantive(BACKUP_DUMP, "1. send the payload")).toBe(true);
  });

  it("rejects an empty or placeholder evidence", () => {
    expect(evidenceIsSubstantive("", "")).toBe(false);
    expect(evidenceIsSubstantive("n/a", "tbd")).toBe(false);
  });
});

describe("SCOPE_CLAIMS", () => {
  it("has no duplicate names", () => {
    const names = SCOPE_CLAIMS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
