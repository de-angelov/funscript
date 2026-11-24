import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import ts from "typescript";
import { compileStringAsync } from "../src/compiler.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function project(
  providerExports: unknown[] | null = [
    {
      name: "findCatalog",
      parameters: [{ name: "id", type: { kind: "string" } }],
      result: {
        kind: "object",
        properties: [{ name: "id", schema: { kind: "string" } }],
        required: ["id"],
        additionalProperties: "allow",
      },
    },
  ],
) {
  const root = fs.mkdtempSync(path.join(process.cwd(), ".provider-runtime-"));
  directories.push(root);
  const providerDir = path.join(
    root,
    "node_modules",
    "@fixture",
    "catalog-provider",
  );
  const runtimeDir = path.join(
    root,
    "node_modules",
    "@fixture",
    "catalog-runtime",
  );
  fs.mkdirSync(providerDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.writeFileSync(
    path.join(providerDir, "package.json"),
    '{"type":"module","exports":"./index.js"}',
  );
  fs.writeFileSync(
    path.join(runtimeDir, "package.json"),
    '{"type":"module","exports":"./index.js"}',
  );
  fs.writeFileSync(
    path.join(providerDir, "index.js"),
    `const fs = await import("node:fs");\nfs.appendFileSync(${JSON.stringify(path.join(root, "executed"))}, "provider\\n");\n` +
      `export default { manifest: { id: "@fixture/catalog/catalog", version: "1.0.0", contract: { major: 1, minMinor: 0, maxMinor: 1 }, parameters: [{ name: "source", kind: "string", required: true }], inputRoots: [], requestedCapabilities: [] }, async provide(request) { return { contract: request.contract, schema: { kind: "object", properties: [], required: [], additionalProperties: "allow" }, ${providerExports === null ? "" : `runtimeModule: { specifier: "@fixture/catalog-runtime", exports: ${JSON.stringify(providerExports)} }, `}dependencies: [], diagnostics: [] }; } };\n`,
  );
  expect(
    createRequire(path.join(root, "package.json")).resolve(
      "@fixture/catalog-provider",
    ),
  ).toBe(path.join(providerDir, "index.js"));
  fs.writeFileSync(
    path.join(runtimeDir, "index.js"),
    `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(path.join(root, "executed"))}, "runtime\\n");\nexport const findCatalog = (id) => ({ id });\n`,
  );
  fs.writeFileSync(
    path.join(runtimeDir, "index.d.ts"),
    "export declare function findCatalog(id: string): { id: string };\n",
  );
  fs.writeFileSync(
    path.join(root, "funscript.config.fun"),
    'export config = { providers: [{ name: "catalog", id: "@fixture/catalog/catalog", moduleSpecifier: "@fixture/catalog-provider", version: "1.0.0", trust: "trusted" }] }',
  );
  return root;
}

describe("separately packaged provider runtime modules", () => {
  it("compiles and executes a typed callable through package resolution", async () => {
    const root = project();
    const file = path.join(root, "main.fun");
    const source =
      'export database Catalog = catalog<"catalog.json">\nexport result = Catalog.findCatalog("abc")';
    fs.writeFileSync(file, source);
    const compiled = await Effect.runPromise(
      compileStringAsync(source, file, { sourcePath: file }),
    );
    expect(compiled.typescript).toContain('"findCatalog": (id: string) =>');
    const generatedTypes = path.join(root, "generated.ts");
    fs.writeFileSync(generatedTypes, compiled.typescript);
    execFileSync(
      process.execPath,
      [
        path.resolve("node_modules/typescript71/bin/tsc"),
        "--ignoreConfig",
        "--noEmit",
        "--skipLibCheck",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        generatedTypes,
      ],
      { stdio: "inherit" },
    );
    const output = path.join(root, "generated.mjs");
    const executable = compiled.typescript
      .replace('"findCatalog" as', "findCatalog as")
      .replace(
        /export const Catalog:[\s\S]*?;\n/,
        "export const Catalog = { findCatalog: $funscriptRuntime_Catalog_0 };\n",
      );
    fs.writeFileSync(
      output,
      ts.transpileModule(executable, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
      }).outputText,
    );
    const loaded = await import(pathToFileURL(output).href);
    expect(loaded.result).toEqual({ id: "abc" });
    expect(fs.readFileSync(path.join(root, "executed"), "utf8")).toContain(
      "runtime",
    );
  });

  it("does not execute provider or runtime packages during synchronous discovery", async () => {
    const root = project();
    const file = path.join(root, "main.fun");
    fs.writeFileSync(file, 'database Catalog = catalog<"catalog.json">');
    const { loadProjectConfig } =
      await import("../src/compiler/project-config.js");
    expect(
      loadProjectConfig(root).providers?.has("@fixture/catalog/catalog"),
    ).toBe(true);
    expect(fs.existsSync(path.join(root, "executed"))).toBe(false);
  });

  it.each([
    { label: "missing", exports: null },
    {
      label: "malformed",
      exports: [
        { name: "bad-name", parameters: [], result: { kind: "string" } },
      ],
    },
    {
      label: "colliding",
      exports: [
        { name: "findCatalog", type: { kind: "string" } },
        { name: "findCatalog", type: { kind: "string" } },
      ],
    },
  ])(
    "locates $label runtime export errors at the declaration",
    async ({ exports }) => {
      const root = project(exports);
      const file = path.join(root, "main.fun");
      const source = 'database Catalog = catalog<"catalog.json">';
      fs.writeFileSync(file, source);
      await expect(
        Effect.runPromise(
          compileStringAsync(source, file, { sourcePath: file }),
        ),
      ).rejects.toMatchObject({ span: { start: { line: 1 } } });
    },
  );
});
