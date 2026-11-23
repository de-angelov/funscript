import { defineConfig, configDefaults } from "vitest/config";
import { funscriptPlugin } from "./dist/plugins/vite.js";

export default defineConfig({
  plugins: [funscriptPlugin()],
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
    include: [
      ...configDefaults.include,
      "**/*.{test,spec}.fun",
      "**/*.{test,spec}.funx",
    ],
    exclude: [
      ...configDefaults.exclude,
      "slopboss/workspaces/**",
      "funscript-board/**",
    ],
  },
});
