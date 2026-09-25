// otpHunt.test.ts — pure helpers of the otp_hunt prover.
import { describe, it, expect } from "vitest";
import {
  buildOtpRequest,
  findOtpLeak,
  otpVerifySuccess,
  WRONG_CODES,
} from "./otpHunt";
import type { OtpProbe } from "./otpHunt";

describe("buildOtpRequest", () => {
  const base = new URL("http://127.0.0.1:4010/api/verify");
  const fields = [
    { name: "username", value: "u1" },
    { name: "code", value: "123456" },
  ];

  it("GET always places fields in the query", () => {
    const r = buildOtpRequest(base, { method: "GET", placement: "form", fields });
    expect(r.url).toContain("username=u1");
    expect(r.url).toContain("code=123456");
    expect(r.body).toBeUndefined();
  });

  it("POST form urlencodes the body", () => {
    const r = buildOtpRequest(base, { method: "POST", placement: "form", fields });
    expect(r.body).toBe("username=u1&code=123456");
    expect(r.contentType).toBe("application/x-www-form-urlencoded");
  });

  it("POST json stringifies the body", () => {
    const r = buildOtpRequest(base, { method: "POST", placement: "json", fields });
    expect(r.body).toBe('{"username":"u1","code":"123456"}');
    expect(r.contentType).toBe("application/json");
  });

  it("POST query placement keeps the fields in the URL", () => {
    const r = buildOtpRequest(base, { method: "POST", placement: "query", fields });
    expect(r.url).toContain("code=123456");
    expect(r.body).toBeUndefined();
  });
});

describe("findOtpLeak", () => {
  it("flags a code under an unexpected JSON key", () => {
    const hit = findOtpLeak('{"ok":true,"otp":"123456"}', "123456", ["code"]);
    expect(hit).not.toBeNull();
    expect(hit?.where).toBe("json");
    expect(hit?.jsonKey).toBe("otp");
  });

  it("ignores the code echoed in its own input field", () => {
    expect(findOtpLeak('<input name="code" value="123456">', "123456", ["code"])).toBeNull();
  });

  it("ignores a code echoed under the expected key", () => {
    expect(findOtpLeak('{"code":"123456"}', "123456", ["code"])).toBeNull();
  });

  it("flags a header-style line outside the input echo", () => {
    const hit = findOtpLeak("HTTP/1.1 200 OK\nx-challenge: 654321\n\nbody", "654321", ["code"]);
    expect(hit).not.toBeNull();
    expect(hit?.where).toBe("header");
  });

  it("flags a bare body mention (input echoes stripped first)", () => {
    const body = '<input name="code" value="444222"> leaked 444222 elsewhere';
    const hit = findOtpLeak(body, "444222", ["code"]);
    expect(hit?.where).toBe("body");
  });

  it("stays null when the only occurrence is the input echo", () => {
    expect(findOtpLeak('sentinel <input name="code" value="444222">', "444222", ["code"])).toBeNull();
  });
});

describe("otpVerifySuccess", () => {
  const deny: OtpProbe = { status: 401, body: '{"error":"invalid code"}', ms: 5 };

  it("is false for non-2xx", () => {
    expect(otpVerifySuccess(deny.body, 401, deny)).toBe(false);
  });

  it("is true when a success marker appears that the baseline lacks", () => {
    expect(otpVerifySuccess('{"ok":true,"verified":true}', 200, deny)).toBe(true);
  });

  it("is false when the body carries a failure word absent from baseline", () => {
    expect(otpVerifySuccess('{"error":"code expired"}', 200, deny)).toBe(false);
  });

  it("is true on a materially different 2xx shape (token payload)", () => {
    const token = JSON.stringify({ token: "x".repeat(120) });
    expect(otpVerifySuccess(token, 200, deny)).toBe(true);
  });
});

describe("WRONG_CODES", () => {
  it("are distinct fixed sentinels (no brute force)", () => {
    expect(new Set(WRONG_CODES).size).toBe(WRONG_CODES.length);
    for (const c of WRONG_CODES) expect(c).toMatch(/^[0-9]{6}$/);
  });
});
