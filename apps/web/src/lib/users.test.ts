import { describe, it, expect } from "vitest";
import { userDataRoot } from "./users";

// Regression for the 2026-09-26 wipe: a caller used the OLD 1-arg pattern
// `rmSync(userDataRoot(user), …)` — userDataRoot ignores its argument, so the
// rmSync deleted the WHOLE users/ tree while tsx never typechecked the call.
// The runtime guard must turn that silent catastrophe into a loud error.
describe("userDataRoot arg guard", () => {
  it("rejects any argument (the old 1-arg wipe pattern)", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (userDataRoot as any)("naufalazhar652952"),
    ).toThrow(/takes no arguments|SHARED users root/);
  });

  it("succeeds with no arguments", () => {
    expect(userDataRoot()).toContain("users");
  });
});
