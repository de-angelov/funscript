import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const resolve = createRequire(import.meta.url).resolve;

describe("package entry points", () => {
  it.each([
    ["prettier-plugin-funscript", "prettier"],
    ["interop/zod", "zod"],
    ["interop/valibot", "valibot"],
    ["plugins/vite", "vite"],
    ["plugins/bun", "bun"],
    ["plugins/bun-preload", "bun/preload"],
    ["plugins/esbuild", "esbuild"],
    ["testing", "test"],
  ])("replaces %s with %s", (removed, canonical) => {
    expect(() => resolve(`funscript/${canonical}`)).not.toThrow();
    expect(() => resolve(`funscript/${removed}`)).toThrow(
      /not defined by "exports"/,
    );
  });
});
