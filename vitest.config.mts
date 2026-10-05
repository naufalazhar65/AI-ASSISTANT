import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  // The app tsconfig uses `jsx: "preserve"` so Next's own compiler handles JSX.
  // Vite 8 transforms with oxc and reads that same tsconfig, so a test that
  // imports a `.tsx` module would otherwise receive raw JSX and fail to parse.
  // Tell the transformer to compile JSX itself instead.
  oxc: {
    jsx: "react-jsx",
  },
  // Mirror the `@/*` alias from apps/web/tsconfig.json, otherwise any module
  // under test that imports through it cannot be resolved.
  resolve: {
    alias: {
      "@": `${repoRoot}apps/web/src`,
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/web/src/**/*.test.ts",
      "apps/web/src/**/*.test.tsx",
      "apps/pixel-office/src/**/*.test.ts",
    ],
    environment: "node",
  },
});
