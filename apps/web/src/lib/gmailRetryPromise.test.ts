// Two-direction contract for the Gmail guards.
//
// FIRE side uses the real 22:53–22:54 WIB replies from Discord; SILENT side is
// just as important — a guard that fires on an honest refusal or a live-account
// hiccup is its own failure mode (false accusation of a fabricated promise).

import { describe, expect, it } from "vitest";
import {
  gmailRetryPromiseNote,
  gmailTerminalFailureThisTurn,
  retryPromiseClause,
} from "./gmailRetryPromise";
import { isRevokedRefreshError, revokedMessage, GMAIL_TOKEN_REVOKED } from "./email";

const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=x";

/** The exact tool result shape the live turn produced (revoked branch). */
const revokedResult = {
  role: "tool",
  content: revokedMessage(url),
};

describe("isRevokedRefreshError", () => {
  it("treats Google's terminal responses as dead tokens", () => {
    for (const d of [
      "Token has been expired or revoked.",
      "invalid_grant",
      "invalid_grant: Bad Request",
      "unauthorized_client",
    ]) {
      expect(isRevokedRefreshError(d)).toBe(true);
    }
  });

  it("leaves transient failures retryable", () => {
    // "Bad Request" is deliberately absent from the terminal list: Google returns
    // it both for a revoked refresh token and for transient failures, so stamping
    // the token dead on it would refuse a connection that may still work. The
    // reliable signal is the `error`/`error_description` pair (`invalid_grant`,
    // "expired or revoked"), which is what a live revoked token returns.
    for (const d of ["", "Bad Request", "Internal Server Error", "503 Service Unavailable", "fetch failed"]) {
      expect(isRevokedRefreshError(d)).toBe(false);
    }
  });
});

describe("revokedMessage", () => {
  it("carries the marker, the link, and an explicit no-retry warning", () => {
    const m = revokedMessage(url);
    expect(m).toContain(GMAIL_TOKEN_REVOKED);
    expect(m).toContain(url);
    expect(m).toMatch(/TIDAK akan berhasil/);
  });
});

describe("gmailTerminalFailureThisTurn", () => {
  it("reads a tool result", () => {
    expect(gmailTerminalFailureThisTurn([revokedResult])).toBe(true);
  });

  it("ignores unrelated turns and non-tool messages", () => {
    expect(gmailTerminalFailureThisTurn([])).toBe(false);
    expect(gmailTerminalFailureThisTurn([{ role: "user", content: "invalid_grant" }])).toBe(false);
    expect(
      gmailTerminalFailureThisTurn([{ role: "tool", content: "Gmail belum terhubung — hubungkan lewat link" }])
    ).toBe(false);
  });

  it("tolerates array-shaped content parts", () => {
    expect(
      gmailTerminalFailureThisTurn([{ role: "tool", content: [{ text: `x ${GMAIL_TOKEN_REVOKED}` }] }])
    ).toBe(true);
  });
});

describe("retryPromiseClause", () => {
  it("detects the live promise shapes", () => {
    expect(retryPromiseClause("Nanti aku coba lagi ya biar bisa bacain update terbaru.")).toContain("coba");
    expect(retryPromiseClause("Tenang aja, nanti pas udah normal langsung aku kabari ya.")).toContain("kabari");
  });

  it("stays quiet on an honest refusal", () => {
    expect(retryPromiseClause("Aksesnya dicabut Google, Mas. Buka link relink ya.")).toBe("");
  });
});

describe("gmailRetryPromiseNote", () => {
  it("FIRES: live 22:53 promise after a revoked token", () => {
    const note = gmailRetryPromiseNote(
      [revokedResult],
      "Waduh Mas Naufal, aksesnya lagi bermasalah. Nanti aku coba lagi ya biar bisa bacain update terbarunya."
    );
    expect(note).toContain("Catatan jujur");
    expect(note).toContain("dicabut Google");
  });

  it("SILENT: reply already points at the relink link", () => {
    expect(
      gmailRetryPromiseNote(
        [revokedResult],
        `Aksesnya dicabut Google. Buka ${url} lalu bilang cek email lagi ya.`
      )
    ).toBe("");
  });

  it("SILENT: no terminal failure in the turn", () => {
    expect(gmailRetryPromiseNote([{ role: "tool", content: "Gmail error 500" }], "Nanti aku coba lagi ya.")).toBe("");
  });

  it("SILENT: no retry promise in the reply", () => {
    expect(gmailRetryPromiseNote([revokedResult], "Aksesnya dicabut Google, Mas.")).toBe("");
  });
});
