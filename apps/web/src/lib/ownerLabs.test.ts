// ownerLabs.test.ts — the owner's persistent lab registry.
//
// Live 2026-09-27 (twice): the owner named a NEW host as his own and the only
// authorization channels were the PENTEST_LAB_TARGETS env (not tool-writable)
// or an engagement the capped-provider model rarely creates — so the turn
// refused its own tool activity. The registry is the writable channel; these
// tests lock the authorization graph: declare once, honored by every gate,
// subdomains included, non-owner hosts still denied.
import { describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { addOwnerLab, forgetOwnerLab, isOwnerLabHost, isOwnerLabHostForOwner, listOwnerLabs } from "./ownerLabs";
import { isOwnLabTarget, targetAllowed } from "./security";
import { userDataRoot } from "./users";

// NOTE: the registry is intentionally SINGLE + owner-scoped (see ownerLabs.ts
// resolveKey). Tests must not pollute the owner's real registry: they use
// throwaway hosts and remove them in a finally — add/forget is symmetric.
const LAB1 = "https://brandnew-owner-lab-a.vercel.app/";
const HOST1 = "brandnew-owner-lab-a.vercel.app";
const LAB2 = "brandnew-owner-lab-b.example.com";

describe("ownerLabs — declare-once authorization", () => {
  it("registers a host the owner declared (alias key lands on the single registry)", () => {
    try {
      const row = addOwnerLab("Zigen", LAB1, "ini lab-ku");
      expect(row.host).toBe(HOST1);
      expect(listOwnerLabs("Zigen").some((l) => l.host === HOST1)).toBe(true);
      expect(listOwnerLabs("naufalazhar652952").some((l) => l.host === HOST1)).toBe(true);
    } finally {
      forgetOwnerLab("Zigen", HOST1);
    }
  });

  it("honors the declared host in every scope gate (same user, alias, canonical, no-user)", () => {
    try {
      addOwnerLab("Zigen", LAB1, "test");
      expect(isOwnerLabHost("Zigen", HOST1)).toBe(true);
      expect(isOwnerLabHost("naufalazhar652952", HOST1)).toBe(true);
      expect(isOwnerLabHostForOwner(HOST1)).toBe(true);
      expect(isOwnLabTarget(`https://${HOST1}/api/x`)).toBe(true);
      expect(targetAllowed(`https://${HOST1}/cek-nik?id=1`)).toBe(true);
    } finally {
      forgetOwnerLab("Zigen", HOST1);
    }
  });

  it("covers subdomains of the registered lab (recon finds api.<lab> and may probe it)", () => {
    try {
      addOwnerLab("Zigen", LAB2, "test");
      expect(isOwnerLabHostForOwner(`api.${LAB2}`)).toBe(true);
      expect(isOwnLabTarget(`https://api.${LAB2}/x`)).toBe(true);
    } finally {
      forgetOwnerLab("Zigen", LAB2);
    }
  });

  it("never authorizes non-owner hosts or suffix tricks", () => {
    expect(isOwnLabTarget("https://example.com/")).toBe(false);
    expect(isOwnerLabHostForOwner("example.com")).toBe(false);
    // Host is only a SUFFIX of the target host → not covered.
    expect(isOwnerLabHostForOwner(`${LAB2}.evil.com`)).toBe(false);
    // Cloud metadata endpoints stay refused even if someone registers junk.
    expect(isOwnLabTarget("169.254.169.254")).toBe(false);
  });

  it("is idempotent per host and forget is symmetric", () => {
    try {
      addOwnerLab("Zigen", LAB1, "first");
      const again = addOwnerLab("Zigen", LAB1, "second");
      expect(again.host).toBe(HOST1);
      const labs = listOwnerLabs("Zigen").filter((l) => l.host === HOST1);
      expect(labs.length).toBe(1);
      expect(forgetOwnerLab("Zigen", HOST1)).toBe(true);
      expect(forgetOwnerLab("Zigen", HOST1)).toBe(false);
      expect(isOwnerLabHostForOwner(HOST1)).toBe(false);
    } finally {
      forgetOwnerLab("Zigen", HOST1);
    }
  });

  it("rejects unusable hosts with a clear error", () => {
    expect(() => addOwnerLab("Zigen", "   ")).toThrow(/host tidak valid/);
    expect(() => addOwnerLab("Zigen", "localhost")).toThrow(/host tidak valid/);
    expect(() => addOwnerLab("Zigen", "has space.example.com")).toThrow(/host tidak valid/);
  });

  it("does not leak into other users' stores (registry is keyed, cleanup works)", () => {
    const user = `verify_ownerlab_${Date.now()}`;
    try {
      expect(listOwnerLabs(user)).toEqual(listOwnerLabs("Zigen"));
    } finally {
      rmSync(join(userDataRoot(), user), { recursive: true, force: true });
    }
  });
});
