/**
 * Why this exists (measured 2026-10-07, Mia on Discord).
 *
 * discord.js 14.27 `Client.login()` looks like this:
 *
 *   async login(token) {
 *     this.rest.setToken(token);
 *     try { await this.ws.connect(); return this.token; }
 *     catch (error) { await this.destroy(); throw error; }
 *   }
 *   async destroy() { ...; this.token = null; this.rest.setToken(null); }
 *
 * So when `ws.connect()` fails -- we saw a single Cloudflare
 * "Unexpected server response: 522" -- login() rejects AND `destroy()` wipes the
 * REST token. The WebSocketManager then reconnects on its own and reaches Ready,
 * so the client ends up half-alive: the gateway is up (messages arrive, turns
 * run, slash commands even register) but every send throws
 * "Expected token to be set for this request, but none was present".
 *
 * Live evidence that night: Mia logged in with 522, reached Ready ~10s later,
 * then completed 7 turns and failed to deliver 6 of them. Nothing in the log
 * said "I am mute" -- turns reported success, so it read as "Mia ignoring me".
 * Two facts pinned it down rather than guessing:
 *   - `ClientReady` slash registration still worked, because that code builds its
 *     own `new REST({version:"10"}).setToken(token)` instead of using client.rest;
 *   - one REST call reproduces the exact production error string, while a client
 *     that logged in cleanly gets a real HTTP answer from Discord instead.
 *
 * The fix is to re-assert the token on Ready. It is idempotent (same token), so
 * it is a no-op after a clean login and the only correction after the wipe, and
 * it runs on every Ready because a gateway reconnect can repeat the cycle.
 *
 * Deliberately NOT a `login()` retry: a second login() may open a second gateway
 * session, which is how this repo ends up with 409 conflicts on restart.
 */

export type RestHealLogger = (msg: string) => void;

/**
 * Re-assert `token` on a discord.js client's REST manager.
 *
 * `setToken` is what discord.js itself calls, so this restores the exact state a
 * clean `login()` would have left. Kept dependency-free (takes the client
 * structurally) so it can be unit-tested without importing the channel module.
 */
export function discordRestTokenHeal(
  client: { rest: { setToken: (token: string) => void } },
  token: string,
  label: string,
  log?: RestHealLogger,
): void {
  client.rest.setToken(token);
  log?.(`[discord] ${label}: REST token re-asserted on ready (gateway had connected without it; sends were dead until now)`);
}
