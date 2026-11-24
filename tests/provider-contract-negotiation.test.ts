import { describe, expect, it } from "vitest";
import path from "node:path";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import type { FunscriptProviderV1 } from "../src/providers/contract.js";
import { prepareProviderResults } from "../src/compiler/provider-resolution.js";
import { createProviderRegistry } from "../src/compiler/provider-registry.js";

const entry = {
  id: "@example/catalog/provider",
  moduleSpecifier: "@example/catalog-provider",
  version: "1.0.0",
  trust: "trusted" as const,
};
const source = "database Catalog = provider<1>\n";
const sourceFile = path.join(process.cwd(), "package.json");
const program = new Parser(
  new Lexer(source, sourceFile).tokenize(),
  sourceFile,
  source,
).parse();

function provider(maxMinor: number, minMinor = 0): FunscriptProviderV1 {
  return {
    manifest: {
      id: entry.id,
      version: entry.version,
      contract: { major: 1, minMinor, maxMinor },
      parameters: [{ name: "input", kind: "number", required: true }],
      inputRoots: [],
      requestedCapabilities: [],
    },
    async provide(request) {
      return {
        contract: request.contract,
        schema: {
          kind: "object",
          properties: [],
          required: [],
          additionalProperties: "reject",
        },
        ...(request.contract.minor === 1
          ? {
              runtimeModule: {
                specifier: "@example/runtime",
                exports: [
                  {
                    name: "find",
                    parameters: [
                      { name: "id", type: { kind: "string" as const } },
                    ],
                    result: { kind: "string" as const },
                  },
                ],
              },
            }
          : {}),
        dependencies: [],
        diagnostics: [],
      };
    },
  };
}

describe("provider contract negotiation", () => {
  async function resolve(
    value: unknown,
    trust: "trusted" | "untrusted" = "trusted",
  ) {
    return prepareProviderResults(
      program,
      sourceFile,
      new Map([[entry.id, { ...entry, trust }]]),
      [],
      async () => value,
    );
  }

  it("negotiates 1.0 for legacy schema-only providers", async () => {
    const result = await resolve(provider(0));
    expect(result.results[0]?.result.contract).toEqual({ major: 1, minor: 0 });
    expect(result.results[0]?.result.runtimeModule).toBeUndefined();
  });

  it("negotiates 1.1 and accepts data-only callable descriptions", async () => {
    const result = await resolve(provider(1));
    expect(result.results[0]?.result.contract).toEqual({ major: 1, minor: 1 });
    expect(result.results[0]?.result.runtimeModule?.exports[0]).toMatchObject({
      name: "find",
      parameters: [{ name: "id" }],
    });
  });

  it("rejects unsupported ranges and mismatched result versions", async () => {
    await expect(resolve(provider(2, 2))).rejects.toThrow(
      /does not support contract/,
    );
    const mismatched: FunscriptProviderV1 = {
      ...provider(1),
      async provide() {
        return {
          contract: { major: 1, minor: 0 },
          schema: {
            kind: "object",
            properties: [],
            required: [],
            additionalProperties: "reject",
          },
          dependencies: [],
          diagnostics: [],
        };
      },
    };
    await expect(resolve(mismatched)).rejects.toThrow(
      /incompatible result envelope/,
    );
  });

  it("does not load untrusted providers", async () => {
    let loads = 0;
    await expect(
      prepareProviderResults(
        program,
        sourceFile,
        new Map([[entry.id, { ...entry, trust: "untrusted" as const }]]),
        [],
        async () => {
          loads++;
          return provider(1);
        },
      ),
    ).rejects.toThrow(/not trusted/);
    expect(loads).toBe(0);
  });
});
