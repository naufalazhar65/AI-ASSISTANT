/**
 * Bundles Mia's browser-side Live client for the dashboard.
 *
 * The dashboard has no build step (plain node server + plain <script> tags),
 * so the one thing it cannot do is resolve TypeScript or the `@/` alias. This
 * script does that once, ahead of time, and writes a committed bundle next to
 * the already-committed `vendor/three.min.js`.
 *
 *   node apps/office-dashboard/build-live.mjs
 *
 * Run it after changing anything under apps/web/src/lib/geminiLive.ts,
 * liveClient.ts, pcm.ts, liveConfirm.ts or apps/web/src/audio/*.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");

const entry = join(repoRoot, "apps", "web", "src", "lib", "liveBrowserEntry.ts");
const outfile = join(here, "vendor", "live.bundle.js");

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "iife",
  globalName: "MiaLive",
  platform: "browser",
  target: ["es2020"],
  // The dashboard is served as plain files; the @/ alias must resolve.
  tsconfig: join(repoRoot, "apps", "web", "tsconfig.json"),
  // No minify: the bundle is committed, and readable output is worth more
  // than a few kilobytes when something misbehaves in the browser.
  minify: false,
  sourcemap: false,
  logLevel: "info",
});

console.log(`wrote ${outfile}`);
