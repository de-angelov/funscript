import { describe, expect, it } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import { Emitter } from "../src/emitter/emitter.js";

function emit(source: string, runtimeApis: ReadonlyMap<string, any>) {
  const ast = new Parser(
    new Lexer(source, "test.fun").tokenize(),
    "test.fun",
    source,
  ).parse();
  return new Emitter(ast, undefined, {
    preparedRuntimeApis: runtimeApis,
  }).emit();
}

const runtime = (declarationId: string, exported: boolean, exports: any[]) => ({
  declarationId,
  name: declarationId,
  providerId: "example/provider",
  span: {
    start: { line: 1, column: 1, offset: 0 },
    end: { line: 1, column: 2, offset: 1 },
  },
  exported,
  moduleSpecifier: "@example/runtime'\nimport('evil')//",
  exports,
});

describe("provider runtime emission", () => {
  it("emits escaped imports and typed exported and local bindings", () => {
    const output = emit(
      'export database Catalog = sqlite<"one">\ndatabase Local = sqlite<"two">\n',
      new Map([
        [
          "Catalog",
          runtime("Catalog", true, [
            {
              name: "find-user",
              parameters: [{ name: "id", type: { kind: "number" } }],
              result: { kind: "string" },
            },
            { name: "count", type: { kind: "number" } },
          ]),
        ],
        [
          "Local",
          runtime("Local", false, [
            { name: "ready", type: { kind: "boolean" } },
          ]),
        ],
      ]),
    );
    expect(output).toContain(
      `from ${JSON.stringify("@example/runtime'\nimport('evil')//")}`,
    );
    expect(output).toContain('"find-user": ("id": number) => string');
    expect(output).toContain("export const Catalog:");
    expect(output).toContain("const Local:");
  });

  it("reports missing or malformed prepared exports at the declaration", () => {
    expect(() => emit('database Missing = sqlite<"x">', new Map())).toThrow(
      /Missing prepared provider runtime result/,
    );
    expect(() =>
      emit(
        'database Bad = sqlite<"x">',
        new Map([
          [
            "Bad",
            runtime("Bad", false, [
              { name: "safe", type: { kind: "string" } },
              { name: "safe", type: { kind: "string" } },
            ]),
          ],
        ]),
      ),
    ).toThrow(/Invalid or colliding/);
  });
});
