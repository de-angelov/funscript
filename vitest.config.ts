import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
    exclude: [
      ...configDefaults.exclude,
      "slopboss/workspaces/**",
      "funscript-board/**",
    ],
  },
});
