import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      ...configDefaults.exclude,
      "slopboss/workspaces/**",
      "funscript-board/**",
    ],
  },
});
