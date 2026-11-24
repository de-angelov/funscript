import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  renderProviderRuntimeExportType,
  renderProviderRuntimeType,
} from "../src/compiler/provider-runtime-types.js";

describe("provider runtime type rendering", () => {
  it("renders nested structural types and all supported primitives", () => {
    expect(
      renderProviderRuntimeType({
        kind: "object",
        properties: [
          {
            name: "odd-name",
            schema: { kind: "array", items: { kind: "bytes" } },
          },
          {
            name: "maybe",
            schema: {
              kind: "union",
              alternatives: [{ kind: "string" }, { kind: "null" }],
            },
          },
          { name: "flag", schema: { kind: "boolean" } },
          { name: "count", schema: { kind: "number" } },
        ],
        required: ["odd-name"],
        additionalProperties: "reject",
      }),
    ).toBe(
      '{ "odd-name": ReadonlyArray<Uint8Array>; "maybe"?: string | null; "flag"?: boolean; "count"?: number }',
    );
    expect(
      renderProviderRuntimeType({
        kind: "object",
        properties: [],
        required: [],
        additionalProperties: "allow",
      }),
    ).toBe("{ [key: string]: unknown }");
  });

  it("renders callable parameter and result types as data", () => {
    expect(
      renderProviderRuntimeExportType({
        name: "fetch",
        parameters: [{ name: "input value", type: { kind: "string" } }],
        result: { kind: "array", items: { kind: "number" } },
      }),
    ).toBe('("input value": string) => ReadonlyArray<number>');
    expect(
      renderProviderRuntimeExportType({
        name: "answer",
        type: { kind: "number" },
      }),
    ).toBe("number");
  });

  it("rejects malformed nodes instead of widening them", () => {
    expect(() =>
      renderProviderRuntimeType({ kind: "union", alternatives: [] }),
    ).toThrow();
    expect(() =>
      renderProviderRuntimeType({
        kind: "object",
        properties: [{ name: "x", schema: { kind: "string" } }],
        required: ["missing"],
        additionalProperties: "reject",
      }),
    ).toThrow();
    expect(() =>
      renderProviderRuntimeType({
        kind: "array",
        items: { kind: "wat" } as never,
      }),
    ).toThrow();
  });

  it("produces valid types under the installed TypeScript 7.1 compiler", () => {
    const typeText = renderProviderRuntimeType({
      kind: "object",
      properties: [
        { name: "user-name", schema: { kind: "string" } },
        { name: "tags", schema: { kind: "array", items: { kind: "string" } } },
      ],
      required: ["user-name"],
      additionalProperties: "reject",
    });
    const source = `type Value = ${typeText}; const value: Value = { "user-name": "Ada", tags: ["compiler"] };`;
    const file = path.resolve(".provider-runtime-type-check.ts");
    try {
      fs.writeFileSync(file, source);
      expect(() =>
        execFileSync(
          process.execPath,
          [
            path.resolve("node_modules/typescript71/bin/tsc"),
            file,
            "--strict",
            "--noEmit",
            "--skipLibCheck",
          ],
          { stdio: "pipe" },
        ),
      ).not.toThrow();
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  });
});
