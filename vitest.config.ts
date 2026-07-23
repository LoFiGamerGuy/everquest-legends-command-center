import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Source tests only — never the tsc -b output in dist/.
    include: ["packages/*/tests/**/*.test.ts"],
  },
});
