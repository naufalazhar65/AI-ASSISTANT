const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo: tell Next which root to use for lockfile/tracing detection.
  outputFileTracingRoot: path.join(__dirname, "../../"),
  // discord.js is a heavy server-only gateway client with native optional deps
  // (zlib-sync/zstd) that webpack can't statically resolve from the instrumentation
  // entry. Keep it external so Next `require`s it at runtime instead of bundling.
  serverExternalPackages: ["discord.js"],
};

module.exports = nextConfig;