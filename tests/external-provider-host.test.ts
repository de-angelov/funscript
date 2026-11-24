import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { compileStringAsync } from "../src/compiler.js";
import { FunScriptLspServer } from "../dist/lsp/server.js";

describe("trusted external provider host", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });

  function project(providerBody: string) {
    const root = mkdtempSync(path.join(tmpdir(), "external-provider-host-"));
    roots.push(root);
    const packageRoot = path.join(root, "node_modules", "fixture-provider");
    mkdirSync(packageRoot, { recursive: true });
    mkdirSync(path.join(root, "data"));
    writeFileSync(
      path.join(root, "funscript.config.fun"),
      'export config = { providers: [{ name: "fixture", id: "@fixture/catalog/provider", moduleSpecifier: "fixture-provider", version: "1.0.0", trust: "trusted" }], providerRoots: ["data"] }\n',
    );
    writeFileSync(
      path.join(root, "main.fun"),
      'export database Catalog = provider<"data/catalog.json">\n',
    );
    writeFileSync(path.join(root, "data", "catalog.json"), "{}\n");
    writeFileSync(
      path.join(packageRoot, "package.json"),
      '{"type":"module","exports":"./index.js"}',
    );
    writeFileSync(path.join(packageRoot, "index.js"), providerBody);
    return root;
  }

  it("uses an independently authored provider in compiler and background editor validation", async () => {
    const root = project(`export default {
      manifest: { id: "@fixture/catalog/provider", version: "1.0.0", contract: { major: 1, minMinor: 0, maxMinor: 1 }, parameters: [{ name: "input", kind: "string", required: true, path: true }], inputRoots: [], requestedCapabilities: [] },
      async provide(request) {
        if (!request.paths[0]?.canonicalPath.endsWith("/data/catalog.json")) throw new Error("unexpected path");
        return { contract: request.contract, schema: { kind: "object", properties: [{ name: "label", schema: { kind: "string" } }], required: ["label"], additionalProperties: "allow" }, runtimeModule: { specifier: "fixture-provider/runtime", exports: [] }, dependencies: [{ kind: "file", path: request.paths[0].canonicalPath }], diagnostics: [] };
      }
    };`);
    const filename = path.join(root, "main.fun");
    const source = 'export database Catalog = provider<"data/catalog.json">\n';
    const compiled = await Effect.runPromise(
      compileStringAsync(source, filename, { sourcePath: filename }),
    );
    expect(compiled.typescript).toContain("export const Catalog");
    expect(compiled.providerDependencies).toContain(
      path.join(root, "data", "catalog.json"),
    );

    const server = new FunScriptLspServer();
    const published: any[] = [];
    server.on("diagnostics", (event) => published.push(event));
    try {
      const uri = pathToFileURL(filename).href;
      server.onDidOpenHandler({
        textDocument: {
          uri,
          languageId: "funscript",
          version: 1,
          text: source,
        },
      });
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("provider diagnostics timed out")),
          20000,
        );
        const poll = () => {
          if (
            published.some(
              (event) => event.version === 1 && event.diagnostics.length === 0,
            )
          ) {
            clearTimeout(timer);
            resolve();
          } else setTimeout(poll, 25);
        };
        poll();
      });
      expect(
        published.some(
          (event) => event.version === 1 && event.diagnostics.length,
        ),
      ).toBe(false);
    } finally {
      server.dispose();
    }
  }, 30000);

  it("returns declaration located failures without exposing provider exceptions", async () => {
    const root = project(`export default {
      manifest: { id: "@fixture/catalog/provider", version: "1.0.0", contract: { major: 1, minMinor: 0, maxMinor: 1 }, parameters: [{ name: "input", kind: "string", required: true, path: true }], inputRoots: [], requestedCapabilities: [] },
      async provide() { throw new Error("private-provider-secret"); }
    };`);
    const filename = path.join(root, "main.fun");
    const result = await Effect.runPromiseExit(
      compileStringAsync(
        'export database Catalog = provider<"data/catalog.json">\n',
        filename,
        { sourcePath: filename },
      ),
    );
    const failure = JSON.stringify(result);
    expect(failure).toContain('"kind":"DatabaseDeclaration"');
    expect(failure).toContain('"line":1');
    expect(failure).not.toContain("private-provider-secret");
  });
});
