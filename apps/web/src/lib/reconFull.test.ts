// Unit tests for reconFull guards (no network — invalid inputs short-circuit).
import { describe, expect, it } from "vitest";
import { reconFull } from "./reconFull";

describe("reconFull guards", () => {
  it("rejects non-http, invalid, and out-of-scope targets", async () => {
    expect(await reconFull("u", { target: "ftp://x" })).toMatch(/^Error:/);
    expect(await reconFull("u", {})).toMatch(/^Error:/);
    expect(await reconFull("u", { target: "https://example.com/" })).toMatch(/SCOPE/);
  });
});
