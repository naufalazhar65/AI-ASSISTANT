const path = require("path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Monorepo: tell Next which root to use for lockfile/tracing detection.
  outputFileTracingRoot: path.join(__dirname, "../../"),
};

module.exports = nextConfig;