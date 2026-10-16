import { homedir } from "node:os";
import { afterEach, describe, it, expect } from "vitest";
import { resolveInSandbox, resolveWritePath, userDataRoot } from "./users";

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

// Owner decision 2026-10-16: writes may land anywhere (registering every
// folder in ALLOWED_WORKSPACES was too much friction). Reads + exec stay
// sandboxed — only the WRITE resolver moves.
describe("resolveWritePath / WRITE_ANYWHERE", () => {
  const env = process.env.WRITE_ANYWHERE;
  afterEach(() => {
    if (env === undefined) delete process.env.WRITE_ANYWHERE;
    else process.env.WRITE_ANYWHERE = env;
  });

  it("stays sandboxed while the flag is off", () => {
    delete process.env.WRITE_ANYWHERE;
    expect(resolveWritePath("/definitely/outside/anywhere.txt")).toBeNull();
    expect(resolveWritePath("~/.ssh/id_rsa")).toBeNull();
  });

  it("allows ANY absolute path when the flag is on", () => {
    process.env.WRITE_ANYWHERE = "1";
    expect(resolveWritePath("/definitely/outside/anywhere.txt")).toBe("/definitely/outside/anywhere.txt");
  });

  it("expands ~ only when the flag is on", () => {
    process.env.WRITE_ANYWHERE = "yes";
    expect(resolveWritePath("~/Desktop/helo.html")).toBe(`${homedir()}/Desktop/helo.html`);
  });

  it("keeps relative paths anchored to the repo root (writesAreAnywhere has no free pass for traversal)", () => {
    process.env.WRITE_ANYWHERE = "1";
    expect(resolveWritePath("../somewhere")).toBeNull();
  });

  it("reads stay sandboxed even when writes are free", () => {
    process.env.WRITE_ANYWHERE = "1";
    expect(resolveInSandbox("/definitely/outside/anywhere.txt")).toBeNull();
  });
});
