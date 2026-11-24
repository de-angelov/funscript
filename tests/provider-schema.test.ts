import { describe, expect, it } from "vitest";
import { renderProviderSchema } from "../src/compiler/provider-schema.js";
import type { ProviderSchemaNodeV1 } from "../src/providers/contract.js";

describe("renderProviderSchema", () => {
  it.each([
    [{ kind: "string" }, "Schema.String"],
    [{ kind: "number" }, "Schema.Finite"],
    [{ kind: "boolean" }, "Schema.Boolean"],
    [{ kind: "null" }, "Schema.Null"],
  ] as const)("renders %s", (node, expected) => {
    expect(renderProviderSchema(node)).toBe(expected);
    expect(renderProviderSchema(node)).toBe(expected);
  });

  it.each([
    [
      { kind: "array", items: { kind: "string" } },
      "Schema.Array(Schema.String)",
    ],
    [
      { kind: "array", items: { kind: "array", items: { kind: "number" } } },
      "Schema.Array(Schema.Array(Schema.Finite))",
    ],
  ] as const)("renders arrays deterministically", (node, expected) => {
    expect(renderProviderSchema(node)).toBe(expected);
    expect(renderProviderSchema(node)).toBe(expected);
  });

  it.each([
    { kind: "bytes" },
    {
      kind: "object",
      properties: [{ name: "injected", schema: { kind: "string" } }],
      required: [],
      additionalProperties: "reject",
    },
  ] satisfies ReadonlyArray<ProviderSchemaNodeV1>)(
    "rejects unsupported %s nodes",
    (node) => {
      expect(() => renderProviderSchema(node)).toThrow(
        `Unsupported provider schema node '${node.kind}'`,
      );
    },
  );

  it("rejects unsupported item nodes inside arrays", () => {
    expect(() =>
      renderProviderSchema({ kind: "array", items: { kind: "bytes" } }),
    ).toThrow("Unsupported provider schema node 'bytes'");
  });

  it.each([
    [
      { kind: "union", alternatives: [{ kind: "string" }, { kind: "number" }] },
      "Schema.Union(Schema.String, Schema.Finite)",
    ],
    [
      {
        kind: "array",
        items: {
          kind: "union",
          alternatives: [
            { kind: "boolean" },
            {
              kind: "array",
              items: {
                kind: "union",
                alternatives: [{ kind: "null" }, { kind: "string" }],
              },
            },
          ],
        },
      },
      "Schema.Array(Schema.Union(Schema.Boolean, Schema.Array(Schema.Union(Schema.Null, Schema.String))))",
    ],
  ] as const)(
    "renders unions recursively and deterministically",
    (node, expected) => {
      expect(renderProviderSchema(node)).toBe(expected);
      expect(renderProviderSchema(node)).toBe(expected);
    },
  );

  it("propagates unsupported alternatives in unions", () => {
    expect(() =>
      renderProviderSchema({
        kind: "union",
        alternatives: [{ kind: "string" }, { kind: "bytes" }],
      }),
    ).toThrow("Unsupported provider schema node 'bytes'");
  });
});
