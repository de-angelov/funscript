import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import ts from "typescript";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { funscriptPlugin } from "../src/plugins/vite.js";
import { findDefinition } from "../src/lsp/definition.js";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import { compileString } from "../src/compiler.js";
import { format } from "../src/formatter/index.js";

const forms = [
  'import "./app.css"',
  'import {} from "./initialize.js"',
  'import React from "react"',
  'import * as React from "react"',
  'import React, { useState, type ReactNode } from "react"',
  'import React, * as ReactNS from "react"',
  'import { default as styles } from "./app.css?url"',
  'import type ReactNode from "react"',
  'import type * as React from "react"',
  'import type { default as ReactNode } from "react"',
  'import { type as alias } from "pkg"',
];

describe("static ESM imports", () => {
  it.each(forms)("parses, formats idempotently and emits valid TypeScript: %s", async (source) => {
    const formatted = format(source);
    expect(format(formatted)).toBe(formatted);
    const compiled = await Effect.runPromise(compileString(formatted, "test.fun"));
    expect(compiled.typescript).toContain(`${source};`);
    const parsed = ts.createSourceFile("test.ts", compiled.typescript, ts.ScriptTarget.Latest, true);
    expect((parsed as any).parseDiagnostics).toEqual([]);
  });

  it("preserves side-effect imports and their order in emitted JavaScript", async () => {
    const source = 'import "./first.js"\nimport "./second.js"\nexport value = 1';
    const compiled = await Effect.runPromise(compileString(source, "test.fun"));
    const js = ts.transpileModule(compiled.typescript, { compilerOptions: { module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText;
    expect(js.indexOf('import "./first.js"')).toBeGreaterThanOrEqual(0);
    expect(js.indexOf('import "./second.js"')).toBeGreaterThan(js.indexOf('import "./first.js"'));
  });

  it("derives a schema from a default type import", async () => {
    const source = 'import type UserType from "./fixtures/imported-schemas/default-model"\nexport ts schema User = UserType';
    const compiled = await Effect.runPromise(compileString(source, resolve("tests/imported-default.fun")));
    expect(compiled.typescript).toContain("id: Schema.String");
  });

  it("does not duplicate a generated Effect schema import when Schema is a namespace import", async () => {
    const source = 'import * as Schema from "effect/Schema"\nexport schema User = { id: String }';
    const compiled = await Effect.runPromise(compileString(source, "test.fun"));
    expect(compiled.typescript).toContain('import * as Schema from "effect/Schema"');
    expect(compiled.typescript).not.toMatch(/import \{ Schema \} from "effect"/);
  });

  it("resolves default and namespace bindings in editor navigation", () => {
    for (const declaration of ['import Foo from "pkg"', 'import * as Foo from "pkg"']) {
      const source = `${declaration}\nexport result = Foo`;
      const result = findDefinition(source, "file:///test.fun", { line: 1, character: 17 });
      expect(result && !Array.isArray(result) && result.range.start.line).toBe(0);
    }
  });

  it("builds a FunScript entry with CSS and a default import through Vite", async () => {
    const root = await mkdtemp(join(tmpdir(), "funscript-imports-"));
    try {
      await writeFile(join(root, "entry.fun"), 'import "./style.css"\nimport value from "./value.js"\nexport result = value');
      await writeFile(join(root, "style.css"), ".dogfood { color: rebeccapurple; }");
      await writeFile(join(root, "value.js"), 'export default "works";');
      await build({ configFile: false, root, logLevel: "silent", plugins: [funscriptPlugin()], build: { outDir: "out", lib: { entry: join(root, "entry.fun"), formats: ["es"], fileName: "entry" } } });
      const outputs = await readdir(join(root, "out"));
      const jsName = outputs.find((file) => /\.(?:m?js)$/.test(file));
      const cssName = outputs.find((file) => file.endsWith(".css"));
      expect(jsName).toBeDefined();
      expect(cssName).toBeDefined();
      const js = await readFile(join(root, "out", jsName!), "utf8");
      const css = await readFile(join(root, "out", cssName!), "utf8");
      expect(js).toContain("works");
      expect(css).toContain(".dogfood");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    'import * React from "react"',
    'import { default } from "react"',
    'import Foo from',
    'import Foo from "./{name}"',
    'import type Foo, { Bar } from "pkg"',
    'import type { type Foo } from "pkg"',
  ])("rejects malformed imports: %s", (source) => {
    expect(() => new Parser(new Lexer(source, "test.fun").tokenize(), "test.fun").parse()).toThrow();
  });
});
