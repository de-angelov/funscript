import { describe, expect, it } from "vitest";
import { Schema } from "effect";
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

  it("rejects object policies that the schema expression cannot enforce", () => {
    expect(() =>
      renderProviderSchema({
        kind: "object",
        properties: [{ name: "injected", schema: { kind: "string" } }],
        required: [],
        additionalProperties: "reject",
      }),
    ).toThrow("cannot be enforced by an Effect Schema expression");
  });

  it("rejects unsupported item nodes inside arrays", () => {
    expect(
      renderProviderSchema({ kind: "array", items: { kind: "bytes" } }),
    ).toBe("Schema.Array(Schema.Uint8Array)");
  });

  it("renders object fields, optional members, and escaped keys", () => {
    expect(
      renderProviderSchema({
        kind: "object",
        properties: [
          { name: "required-key", schema: { kind: "string" } },
          { name: "__proto__", schema: { kind: "bytes" } },
        ],
        required: ["required-key"],
        additionalProperties: "allow",
      }),
    ).toBe(
      'Schema.Struct({ ["required-key"]: Schema.String, ["__proto__"]: Schema.optional(Schema.Uint8Array) })',
    );
  });

  it("decodes required and optional fields, bytes, and nullable nested schemas", () => {
    const schema = new Function(
      "Schema",
      `return ${renderProviderSchema({
        kind: "object",
        properties: [
          { name: "payload", schema: { kind: "bytes" } },
          {
            name: "nested",
            schema: {
              kind: "array",
              items: {
                kind: "union",
                alternatives: [{ kind: "null" }, { kind: "string" }],
              },
            },
          },
          { name: "optional", schema: { kind: "boolean" } },
        ],
        required: ["payload", "nested"],
        additionalProperties: "allow",
      })}`,
    )(Schema);
    const value = { payload: new Uint8Array([1, 2]), nested: [null, "ok"] };
    expect(Schema.decodeUnknownSync(schema)(value)).toEqual(value);
    expect(() => Schema.decodeUnknownSync(schema)({ nested: [] })).toThrow();
  });

  it.each([
    [
      { kind: "union", alternatives: [{ kind: "string" }, { kind: "number" }] },
      "Schema.Union([Schema.String, Schema.Finite])",
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
      "Schema.Array(Schema.Union([Schema.Boolean, Schema.Array(Schema.Union([Schema.Null, Schema.String]))]))",
    ],
  ] as const)(
    "renders unions recursively and deterministically",
    (node, expected) => {
      expect(renderProviderSchema(node)).toBe(expected);
      expect(renderProviderSchema(node)).toBe(expected);
    },
  );

  it("renders bytes alternatives in unions", () => {
    expect(
      renderProviderSchema({
        kind: "union",
        alternatives: [{ kind: "string" }, { kind: "bytes" }],
      }),
    ).toBe("Schema.Union([Schema.String, Schema.Uint8Array])");
  });
});
