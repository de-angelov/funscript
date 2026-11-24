import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import type { FunscriptProviderV1 } from "../src/providers/contract.js";
import { prepareProviderResults } from "../src/compiler/provider-resolution.js";
import { createProviderRegistry } from "../src/compiler/provider-registry.js";

describe("prepared provider runtime metadata", () => {
  let directory = "";
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = "";
  });

  it("retains declaration identity and validated runtime structure independently", async () => {
    directory = mkdtempSync(path.join(tmpdir(), "provider-runtime-prep-"));
    const source = path.join(directory, "main.fun");
    const text =
      'export database First = sqlite<"first.db">\ndatabase Second = sqlite<"second.db">\n';
    writeFileSync(source, text);
    const program = new Parser(
      new Lexer(text, source).tokenize(),
      source,
      text,
    ).parse();
    const entry = {
      id: "@example/catalog/sqlite",
      moduleSpecifier: "@example/catalog-provider",
      version: "1.0.0",
      trust: "trusted" as const,
    };
    const provider: FunscriptProviderV1 = {
      manifest: {
        id: entry.id,
        version: entry.version,
        contract: { major: 1, minMinor: 0, maxMinor: 1 },
        parameters: [
          { name: "path", kind: "string", required: true, path: false },
        ],
        inputRoots: [],
        requestedCapabilities: [],
      },
      async provide(request) {
        const name = request.declaration.name;
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
            exports: [
              {
                name,
                type: {
                  kind: "object",
                  properties: [{ name: "id", schema: { kind: "string" } }],
                  required: ["id"],
                  additionalProperties: "reject",
                },
              },
            ],
          },
          dependencies: [{ kind: "file", path: `${directory}/${name}.db` }],
          diagnostics: [],
        };
      },
    };

    const prepared = await prepareProviderResults(
      program,
      source,
      createProviderRegistry([entry]),
      [directory],
      async () => provider,
    );
    const [first, second] = prepared.results;
    expect(first).toMatchObject({ name: "First", exported: true });
    expect(second).toMatchObject({ name: "Second", exported: false });
    expect(first?.declarationId).not.toBe(second?.declarationId);
    expect(first?.span.start.offset).toBe(7);
    expect(second?.span.start.offset).toBeGreaterThan(
      first?.span.end.offset ?? 0,
    );
    expect(first?.result.runtimeModule?.exports[0]).toMatchObject({
      name: "First",
      type: {
        kind: "object",
        properties: [{ name: "id", schema: { kind: "string" } }],
        required: ["id"],
        additionalProperties: "reject",
      },
    });
    expect(second?.result.runtimeModule?.exports[0]?.name).toBe("Second");
    expect(prepared.dependencies).toHaveLength(2);
    expect(prepared.dependencies.map((item) => item.path)).toEqual([
      `${directory}/First.db`,
      `${directory}/Second.db`,
    ]);
  });
});
