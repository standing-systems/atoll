import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@standing-systems\/atoll\/testing$/, replacement: src("testing.ts") },
      { find: /^@standing-systems\/atoll$/, replacement: src("index.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts", "examples/*/test/**/*.test.ts"],
    exclude: process.env.ATOLL_LIVE === "1" ? ["**/node_modules/**"] : ["**/node_modules/**", "test/live/**"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
