import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

function provider(runtimeModule: unknown): FunscriptProviderV1 {
  return {
    manifest: {
      id: entry.id,
      version: entry.version,
      contract: { major: 1, minMinor: 0, maxMinor: 1 },
      parameters: [
        { name: "input", kind: "string", required: true, path: true },
      ],
      inputRoots: ["/project"],
      requestedCapabilities: [],
    },
    async provide(request) {
      return {
        contract: request.contract,
        schema: { kind: "string" },
        runtimeModule: runtimeModule as never,
        dependencies: [],
        diagnostics: [],
      };
    },
  };
}

async function resolve(
  runtimeModule: unknown,
  loadSpy?: (specifier: string) => void,
) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "runtime-module-validation-"),
  );
  try {
    const sourceText = 'database Catalog = provider<"data.json">\n';
    const sourceFile = path.join(directory, "main.fun");
    const inputFile = path.join(directory, "data.json");
    writeFileSync(sourceFile, sourceText);
    writeFileSync(inputFile, "{}");
    const program = new Parser(
      new Lexer(sourceText, sourceFile).tokenize(),
      sourceFile,
      sourceText,
    ).parse();
    return await prepareProviderResults(
      program,
      sourceFile,
      createProviderRegistry([entry]),
      [directory],
      async (specifier) => {
        loadSpy?.(specifier);
        return provider(runtimeModule);
      },
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("provider runtime module references", () => {
  it("accepts scoped package subpaths and preserves the data only contract", async () => {
    const data = {
      specifier: "@example/helpers/runtime/decode",
      exports: [{ name: "decodeCatalog", type: { kind: "string" } }],
    };
    const result = await resolve(data);
    expect(result.results[0]?.result.runtimeModule).toEqual(data);
  });

  it.each([
    "./runtime.js",
    "../runtime",
    "/tmp/runtime",
    "node:fs",
    "@example/pkg/../escape",
    "@example/pkg?x=1",
    "pkg#fragment",
    "pkg\\runtime",
    "pkg\u0000runtime",
    "@/pkg",
  ])(
    "rejects unsafe runtime specifier %j with declaration location",
    async (specifier) => {
      await expect(resolve({ specifier, exports: [] })).rejects.toMatchObject({
        declaration: expect.objectContaining({
          span: expect.objectContaining({
            start: expect.objectContaining({ line: 1 }),
          }),
        }),
        message: expect.stringContaining("malformed runtime module"),
      });
    },
  );

  it.each(["default", "class", "bad-name", "with space"])(
    "rejects invalid runtime export name %j",
    async (name) => {
      await expect(
        resolve({
          specifier: "@example/runtime",
          exports: [{ name, type: { kind: "string" } }],
        }),
      ).rejects.toThrow(/malformed runtime module/);
    },
  );

  it("rejects duplicate exports and malformed callable signatures", async () => {
    await expect(
      resolve({
        specifier: "@example/runtime",
        exports: [
          { name: "lookup", type: { kind: "string" } },
          { name: "lookup", type: { kind: "string" } },
        ],
      }),
    ).rejects.toThrow(/malformed runtime module/);
    await expect(
      resolve({
        specifier: "@example/runtime",
        exports: [
          {
            name: "lookup",
            parameters: [
              { name: "id", type: { kind: "string" } },
              { name: "id", type: { kind: "number" } },
            ],
            result: { kind: "string" },
          },
        ],
      }),
    ).rejects.toThrow(/malformed runtime module/);
    await expect(
      resolve({
        specifier: "@example/runtime",
        exports: [
          {
            name: "lookup",
            parameters: [],
            result: { kind: "string" },
            extra: true,
          },
        ],
      }),
    ).rejects.toThrow(/malformed runtime module/);
  });

  it("loads only the registered provider during discovery, never the runtime reference", async () => {
    const loaded: string[] = [];
    await resolve(
      { specifier: "@example/runtime/decode", exports: [] },
      (specifier) => loaded.push(specifier),
    );
    expect(loaded).toEqual([entry.moduleSpecifier]);
  });
});
