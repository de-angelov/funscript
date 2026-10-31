import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("generated reference documentation", () => {
  it("matches the compiled CLI catalogue and package exports", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/generate-reference-docs.mjs", "--check"], {
        encoding: "utf8",
      })
    ).not.toThrow();
  });
});
