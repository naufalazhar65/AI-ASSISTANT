/**
 * Browser entry for the dashboard's Gemini Live client.
 *
 * The dashboard (`apps/office-dashboard`) has no build step and no framework:
 * it loads plain scripts from disk. This file is the seam — esbuild bundles it
 * into `apps/office-dashboard/vendor/live.bundle.js` (global `MiaLive`), which
 * the dashboard page loads with a plain <script> tag, exactly like the
 * already-committed `vendor/three.min.js`.
 *
 * Everything exported here must be browser-safe: no node builtins, no
 * server-only modules. `LiveClient` pulls in the WebSocket client, the mic
 * capture, the player and the confirmation logic — all browser code.
 */
export { LiveClient, browserUserHeader } from "./liveClient";
export type {
  LiveClientOptions,
  LiveClientState,
  LiveClientListener,
  LiveSessionLike,
  LiveCaptureLike,
  LivePlayerLike,
} from "./liveClient";
export type { GeminiLiveOptions, GeminiLiveStatus } from "./geminiLive";
