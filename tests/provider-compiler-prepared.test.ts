import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { compileString } from "../src/compiler.js";

describe("prepared provider schemas in compiler analysis", () => {
  const source = `schema Row = from custom<"./does-not-exist.json">
row: { value: Number } = { value: 2 }
export valid = row.value > 1
export filtered = row.value |> isGreaterThan(1)
`;
  const preparedProviderSchemas = {
    schemas: new Map([["Row", "Schema.Struct({ value: Schema.Finite })"]]),
    dependencies: ["/project/data.json"],
  };

  it("uses prepared output during analysis and emission without loading providers", async () => {
    const result = await Effect.runPromise(
      compileString(source, "/project/main.fun", { preparedProviderSchemas }),
    );

    expect(result.typescript).toContain(
      "const Row = Schema.Struct({ value: Schema.Finite });",
    );
    expect(result.typescript).toContain("row.value > 1");
    expect(result.providerDependencies).toEqual(["/project/data.json"]);
    expect(result.pipelineStageResolutions.size).toBeGreaterThan(0);
  });

  it("keeps plain source compilation synchronous and preserves source maps", () => {
    const result = Effect.runSync(compileString("export value = 1"));
    expect(result.typescript).toContain("export const value = 1");
    expect(result.map).toBeDefined();
    expect(result.providerDependencies).toEqual([]);
  });
});
