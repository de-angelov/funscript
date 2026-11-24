import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import type { FunscriptProviderV1 } from "../src/providers/contract.js";
import { prepareProviderResults } from "../src/compiler/provider-resolution.js";
import { createProviderRegistry } from "../src/compiler/provider-registry.js";

const entry = {
  id: "@example/catalog/sqlite",
  moduleSpecifier: "@example/catalog-provider",
  version: "1.0.0",
  trust: "trusted" as const,
};

describe("prepareProviderResults", () => {
  let directory = "";
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = "";
  });

  function fixture() {
    directory = mkdtempSync(path.join(tmpdir(), "provider-resolution-"));
    const dataDir = path.join(directory, "data");
    mkdirSync(dataDir);
    const sourceFile = path.join(directory, "main.fun");
    const inputFile = path.join(dataDir, "schema.db");
    writeFileSync(sourceFile, 'database Catalog = sqlite<"data/schema.db">\n');
    writeFileSync(inputFile, "fixture");
    const program = new Parser(
      new Lexer(
        'database Catalog = sqlite<"data/schema.db">\n',
        sourceFile,
      ).tokenize(),
      sourceFile,
      'database Catalog = sqlite<"data/schema.db">\n',
    ).parse();
    const provider: FunscriptProviderV1 = {
      manifest: {
        id: entry.id,
        version: entry.version,
        contract: { major: 1, minMinor: 0, maxMinor: 0 },
        parameters: [
          { name: "path", kind: "string", required: true, path: true },
        ],
        inputRoots: [],
        requestedCapabilities: [],
      },
      async provide(request) {
        await Promise.resolve();
        expect(request.paths).toEqual([
          { argumentIndex: 0, canonicalPath: inputFile },
        ]);
        return {
          contract: request.contract,
          schema: {
            kind: "object",
            properties: [],
            required: [],
            additionalProperties: "reject",
          },
          runtimeModule: {
            specifier: "@example/catalog-runtime",
            exports: [{ name: "Catalog", type: { kind: "string" } }],
          },
          dependencies: [{ kind: "file", path: inputFile }],
          diagnostics: [],
        };
      },
    };
    return { sourceFile, program, provider, dataDir };
  }

  it("prepares trusted results asynchronously with source-relative authorized paths", async () => {
    const f = fixture();
    let loaded = false;
    const prepared = await prepareProviderResults(
      f.program,
      f.sourceFile,
      createProviderRegistry([entry]),
      [f.dataDir],
      async (specifier) => {
        loaded = true;
        expect(specifier).toBe(entry.moduleSpecifier);
        return f.provider;
      },
    );
    expect(loaded).toBe(true);
    expect(
      prepared.results.map(({ name, providerId }) => ({ name, providerId })),
    ).toEqual([{ name: "Catalog", providerId: entry.id }]);
    expect(prepared.results[0]?.result.runtimeModule?.exports[0]?.name).toBe(
      "Catalog",
    );
    expect(prepared.results[0]).toMatchObject({
      declarationId: `${f.program.body[0]?.span.start.offset}:${f.program.body[0]?.span.end.offset}`,
      name: "Catalog",
      exported: false,
      span: f.program.body[0]?.span,
    });
    expect(prepared.dependencies).toEqual([
      { kind: "file", path: path.join(f.dataDir, "schema.db") },
    ]);
  });

  it("does not execute unregistered, untrusted, or malformed providers", async () => {
    const f = fixture();
    let loads = 0;
    const load = async () => {
      loads++;
      return f.provider;
    };
    await expect(
      prepareProviderResults(
        f.program,
        f.sourceFile,
        createProviderRegistry([]),
        [f.dataDir],
        load,
      ),
    ).rejects.toMatchObject({
      declaration: expect.objectContaining({ kind: "DatabaseDeclaration" }),
    });
    await expect(
      prepareProviderResults(
        f.program,
        f.sourceFile,
        new Map([[entry.id, { ...entry, trust: "untrusted" as const }]]),
        [f.dataDir],
        load,
      ),
    ).rejects.toThrow(/not trusted/);
    await expect(
      prepareProviderResults(
        f.program,
        f.sourceFile,
        createProviderRegistry([entry]),
        [f.dataDir],
        async () => {
          loads++;
          return {
            manifest: {
              id: entry.id,
              version: entry.version,
              parameters: "bad",
            },
            provide: () => {
              throw new Error("secret");
            },
          };
        },
      ),
    ).rejects.toThrow(/Could not load trusted provider/);
    expect(loads).toBe(1);
  });

  it("reports malformed declarations at their source span and omits provider secrets", async () => {
    const f = fixture();
    const wrongIdentity = {
      ...f.provider,
      manifest: { ...f.provider.manifest, id: "@evil/catalog/sqlite" },
    };
    await expect(
      prepareProviderResults(
        f.program,
        f.sourceFile,
        createProviderRegistry([entry]),
        [f.dataDir],
        async () => wrongIdentity,
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining("identity mismatch"),
      declaration: expect.objectContaining({ span: f.program.body[0]?.span }),
    });
    expect(JSON.stringify(wrongIdentity)).not.toContain("secret");
  });
});
