const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo: tell Next which root to use for lockfile/tracing detection.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // discord.js is a heavy server-only gateway client with native optional deps
  // (zlib-sync/zstd) that webpack can't statically resolve from the instrumentation
  // entry. Keep it external so Next `require`s it at runtime instead of bundling.
  // `@discordjs/voice` must join that list (owner 2026-10-06: voice channel):
  // webpack follows the dynamic `import("@discordjs/voice")` literal and tries
  // to bundle its native chain (opus `.node` binary), which fails the whole
  // server with `ModuleParseError: Unexpected character` — including /api/health.
  serverExternalPackages: ["discord.js", "@discordjs/voice", "sodium"],
};

module.exports = nextConfig;