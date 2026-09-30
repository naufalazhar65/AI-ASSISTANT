import { describe, it, expect } from "vitest";
import {
  canonicalUserKey,
  resolveBrowserUserKey,
  validateUserKey,
  OWNER_KEY,
  OWNER_LABEL,
} from "./identity";
import { sanitizeUser } from "./users";

/**
 * Regression suite for the 2026-09-30 split-identity incident.
 *
 * The browser sign-in was a free-text name box. The owner typed one letter,
 * `s`, and a whole session went to a Mia with her own private store: 4 persona
 * facts instead of 22, a wrong `city: Jakarta`, and a hallucinated
 * `plan: free`. Three directories for one human, because each adapter derived
 * its own key and the alias table was never consulted.
 *
 * The two locks below are the two halves of the fix:
 *   - the fold (every store path resolves to one key), and
 *   - the refusal to ever ask again (nothing in the app may derive a key that
 *     the alias table cannot fold).
 */
describe("canonicalUserKey — one human, one memory", () => {
  it("folds every known channel alias onto the owner key", () => {
    // Zigen = the owner's Discord display name; naufalazhar65 = TELEGRAM_USER;
    // naufal = DISCORD_USER *and* the hard-coded fallback in discord.ts.
    expect(canonicalUserKey("Zigen")).toBe(OWNER_KEY);
    expect(canonicalUserKey("naufalazhar65")).toBe(OWNER_KEY);
    expect(canonicalUserKey("naufal")).toBe(OWNER_KEY);
    expect(canonicalUserKey(OWNER_KEY)).toBe(OWNER_KEY);
  });

  it("folds the exact strings discord.ts can produce for the owner", () => {
    // Replays discord.ts:267 — the slug, then DISCORD_USER, then the literal.
    const slug = (username: string) => username.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60);
    for (const username of ["Zigen", "naufal", "naufalazhar652952"]) {
      expect(canonicalUserKey(slug(username))).toBe(OWNER_KEY);
    }
    expect(canonicalUserKey(process.env.DISCORD_USER || "naufal")).toBe(OWNER_KEY);
  });

  it("trims before folding, so a pasted alias with whitespace still lands", () => {
    expect(canonicalUserKey("  naufalazhar65  ")).toBe(OWNER_KEY);
  });

  it("leaves an already-canonical key untouched (idempotent)", () => {
    const once = canonicalUserKey("naufalazhar65");
    expect(once).toBe(OWNER_KEY);
    // Folding again must not drift, or a second pass over the same key would
    // move the store out from under the caller.
    expect(canonicalUserKey(once)).toBe(once);
  });
});

describe("the fold is not a path-traversal hole (invariant 5)", () => {
  it("still rejects traversal, traversal-with-alias-lookalike, and non-strings", () => {
    for (const bad of [
      "../evil",
      "..",
      ".",
      "a/b",
      "a\\b",
      "Zigen/../evil",
      "naufalazhar65/../../etc",
      "",
      "   ",
      "x".repeat(61),
      null,
      undefined,
      42,
      {},
      [],
    ]) {
      expect(canonicalUserKey(bad)).toBeNull();
    }
  });

  it("an alias is substituted only for a key that already validated", () => {
    // The alias table is a set of hard-coded literals that pass validation
    // themselves; nothing user-supplied can become a table key.
    expect(validateUserKey("Zigen")).toBe("Zigen");
    // Whitespace is trimmed BEFORE validation, so a pasted alias with either a
    // leading or trailing space still resolves to the bare table key.
    expect(validateUserKey("Zigen ")).toBe("Zigen");
    expect(validateUserKey(" Zigen")).toBe("Zigen");
    // A near-miss is NOT folded: only the exact literal is a table key.
    expect(canonicalUserKey("Zigen2")).toBe("Zigen2");
    expect(canonicalUserKey("zigen")).toBe("zigen"); // case is NOT normalised
  });
});

describe("validateUserKey — the un-folded escape hatch", () => {
  it("returns the literal key the caller was handed", () => {
    expect(validateUserKey("naufalazhar65")).toBe("naufalazhar65");
    expect(validateUserKey("s")).toBe("s");
  });
});

describe("sanitizeUser is the fold, under a legacy name", () => {
  it("~100 store modules call this; it must resolve to ONE key", () => {
    // If someone re-points sanitizeUser back at validateUserKey, the split
    // returns silently and every store writes to its own directory again.
    expect(sanitizeUser).toBe(canonicalUserKey);
    expect(sanitizeUser("naufalazhar65")).toBe(OWNER_KEY);
  });
});

describe("the display label is never a store key", () => {
  it("OWNER_LABEL is for the UI only and does not leak into a path", () => {
    expect(OWNER_LABEL).not.toBe(OWNER_KEY);
    expect(validateUserKey(OWNER_LABEL)).toBe(OWNER_LABEL); // it IS a valid key...
    expect(canonicalUserKey(OWNER_LABEL)).toBe(OWNER_LABEL); // ...but not an alias
  });
});

/**
 * The regression that shipped and had to be pulled.
 *
 * The first fix folded the browser key through `canonicalUserKey`. A fold maps
 * only the keys it already knows, and the stale value was `s` — VALID, and simply
 * absent from the table. So the fold was a no-op, `?? OWNER_KEY` could never
 * fire, and the owner still got "you live in Jakarta" and a Mia who had never
 * heard of his cat. The JSDoc on the module already explained why an alias
 * list cannot enumerate every name a human may type — and then shipped a fix
 * that only handled names in the list.
 */
describe("resolveBrowserUserKey — override, not fold (live 2026-09-30 failure)", () => {
  it("resolves the key that BROKE the fold: a valid key absent from the table", () => {
    // This is the exact case that shipped broken. `s` is a valid user key, so
    // canonicalUserKey leaves it alone — which is why folding could not fix it.
    expect(canonicalUserKey("s")).toBe("s");
    expect(resolveBrowserUserKey("s")).toBe(OWNER_KEY);
  });

  it("overrides anything at all, including junk, aliases and traversal strings", () => {
    for (const stored of [
      "s",
      "S",
      "Zigen2",
      "zigen",
      "typo-name",
      OWNER_LABEL,
      "",
      "   ",
      null,
      undefined,
      42,
      {},
      "../evil",
      "Zigen/../evil",
    ]) {
      expect(resolveBrowserUserKey(stored)).toBe(OWNER_KEY);
    }
  });

  it("is idempotent, so a second pass cannot move the store out from under a caller", () => {
    const once = resolveBrowserUserKey("s");
    expect(resolveBrowserUserKey(once)).toBe(once);
  });

  it("still returns a key the SERVER fold agrees with", () => {
    // The browser overrides; the server folds. If these two ever disagree, the
    // browser would write a key the store layer then rewrites to another one.
    expect(canonicalUserKey(resolveBrowserUserKey("s"))).toBe(OWNER_KEY);
    expect(sanitizeUser(resolveBrowserUserKey("s"))).toBe(OWNER_KEY);
  });

  it("leaves the server-side fold's traversal rejection intact", () => {
    // Overriding is safe precisely because it never becomes a path: the value
    // is a module constant that passes validation on its own.
    expect(canonicalUserKey("../evil")).toBeNull();
    expect(resolveBrowserUserKey("../evil")).toBe(OWNER_KEY);
  });
});
