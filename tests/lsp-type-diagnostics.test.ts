import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { Effect } from "effect";
import { FunScriptLspServer } from "../src/lsp/server.js";
import { typeCheckVirtualFiles, createTypeCheckCache } from "../src/compiler/check.js";
import { TypeScriptCompilationContext } from "../src/compiler/typescript-context.js";

describe("LSP TypeScript diagnostics", () => {
  it("maps generic constraint errors to FunScript and clears them after an edit", async () => {
    const server = new FunScriptLspServer();
    const uri = pathToFileURL(path.resolve("lsp-generics.fun")).href;
    const events: any[] = [];
    server.on("diagnostics", (event) => events.push(event));
    const source = `ts { type Client = { close: () => void } }
export connect = <A extends Client>(factory: () => A) => factory()
export bad = connect(() => "bad")`;
    try {
      server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: source } });
      await vi.waitFor(() => {
        const diagnostic = events.flatMap((event) => event.diagnostics).find((d: any) => String(d.code) === "2322");
        expect(diagnostic).toBeDefined();
        expect(diagnostic.range.start.line).toBe(2);
      }, { timeout: 10000 });
      server.onDidChangeHandler({ textDocument: { uri, version: 2 }, contentChanges: [{ text: source.replace('"bad"', '{ close: () => {} }') }] });
      await vi.waitFor(() => {
        expect(events.filter((event) => event.version === 2 && event.diagnostics.length === 0).length).toBeGreaterThanOrEqual(2);
      }, { timeout: 10000 });
    } finally {
      server.dispose();
    }
  });

  it("rechecks an open caller when its imported document changes", async () => {
    const server = new FunScriptLspServer();
    const dependency = pathToFileURL(path.resolve("lsp-dependency.fun")).href;
    const caller = pathToFileURL(path.resolve("lsp-caller.fun")).href;
    const events: any[] = [];
    server.on("diagnostics", (event) => events.push(event));
    try {
      server.onDidOpenHandler({ textDocument: { uri: dependency, languageId: "funscript", version: 1, text: "export accept = (value: Number) => value" } });
      server.onDidOpenHandler({ textDocument: { uri: caller, languageId: "funscript", version: 1, text: 'import { accept } from "./lsp-dependency.js"\nexport result = accept(1)' } });
      await vi.waitFor(() => expect(events.filter((event) => event.uri === caller).length).toBeGreaterThanOrEqual(2), { timeout: 10000 });
      server.onDidChangeHandler({ textDocument: { uri: dependency, version: 2 }, contentChanges: [{ text: "export accept = (value: String) => value" }] });
      await vi.waitFor(() => {
        const diagnostic = events.filter((event) => event.uri === caller).flatMap((event) => event.diagnostics).find((item: any) => item.code === 2345);
        expect(diagnostic?.range.start.line).toBe(1);
      }, { timeout: 10000 });
    } finally {
      server.dispose();
    }
  });

  it("reuses incremental program and source cache across edits", async () => {
    const cache = createTypeCheckCache();
    const files = {
      "modA.fun": "export num = 42\nexport getNum = () => num",
      "modB.fun": 'import { getNum } from "./modA.js"\nexport result = getNum()',
    };

    // Cold check
    const coldStart = performance.now();
    const options = { cache, compilerOptions: { rootDir: process.cwd() } };
    const firstResult = await Effect.runPromise(typeCheckVirtualFiles(files, options));
    const coldDuration = performance.now() - coldStart;

    expect(firstResult.success, firstResult.formattedOutput).toBe(true);
    expect(cache.oldProgram).toBeDefined();
    expect(cache.sourceFiles.size).toBeGreaterThan(0);

    // Warm edit on modB only
    const updatedFiles = {
      ...files,
      "modB.fun": 'import { getNum } from "./modA.js"\nexport result = getNum() + 1',
    };
    const warmStart = performance.now();
    const secondResult = await Effect.runPromise(typeCheckVirtualFiles(updatedFiles, options));
    const warmDuration = performance.now() - warmStart;

    expect(secondResult.success, secondResult.formattedOutput).toBe(true);
    expect(warmDuration).toBeLessThan(coldDuration);
  });

  it("verifies TypeScriptCompilationContext loads ts-reset and types JSON.parse as unknown", () => {
    const context = new TypeScriptCompilationContext("test-reset.fun");
    const result = context.check('export const parsed = JSON.parse("[]"); export const bad = parsed.foo;');
    expect(result).toBeDefined();
    const sourceFiles = result!.program.getSourceFiles().map((sf) => sf.fileName);
    expect(sourceFiles.some((name) => name.includes("__funscript_ts_reset__.d.ts"))).toBe(true);
    const stmt = result!.sourceFile.statements[0] as any;
    const type = result!.checker.getTypeAtLocation(stmt.declarationList.declarations[0].name);
    expect(result!.checker.typeToString(type)).toBe("unknown");
  });

  it("verifies TypeScriptCompilationContext loads JSX intrinsics when compiling/checking .funx files", () => {
    const context = new TypeScriptCompilationContext("test-widget.funx");
    const result = context.check('export const View = () => <div className="container"><span>Hello</span></div>;');
    expect(result).toBeDefined();
    const sourceFiles = result!.program.getSourceFiles().map((sf) => sf.fileName);
    expect(sourceFiles.some((name) => name.includes("__funscript_jsx_intrinsics__.d.ts"))).toBe(true);
    expect(sourceFiles.some((name) => name.includes("__funscript_ts_reset__.d.ts"))).toBe(true);
    const diags = result!.program.getSemanticDiagnostics(result!.sourceFile);
    expect(diags).toHaveLength(0);
  });

  it("verifies JSON.parse returns unknown rather than any in LSP diagnostics", async () => {
    const server = new FunScriptLspServer();
    const uri = pathToFileURL(path.resolve("lsp-json-parse.fun")).href;
    const events: any[] = [];
    server.on("diagnostics", (event) => events.push(event));
    const source = `export parsed = ts { JSON.parse("[]") }\nexport bad = parsed.foo`;
    try {
      server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: source } });
      await vi.waitFor(() => {
        const diagnostic = events
          .flatMap((event) => event.diagnostics)
          .find((d: any) => d.message.includes("'parsed' is of type 'unknown'") || String(d.code) === "18046");
        expect(diagnostic).toBeDefined();
        expect(diagnostic.message).toContain("unknown");
      }, { timeout: 10000 });
    } finally {
      server.dispose();
    }
  }, 15000);

  it("resolves JSX elements cleanly in .funx files in LSP diagnostics without errors", async () => {
    const server = new FunScriptLspServer();
    const uri = pathToFileURL(path.resolve("lsp-clean-jsx.funx")).href;
    const events: any[] = [];
    server.on("diagnostics", (event) => events.push(event));
    const source = `export View = () => <div className="container"><span>Hello FunScript</span></div>`;
    try {
      server.onDidOpenHandler({ textDocument: { uri, languageId: "funscriptx", version: 1, text: source } });
      await vi.waitFor(() => {
        const fileEvents = events.filter((e) => e.uri === uri);
        expect(fileEvents.length).toBeGreaterThanOrEqual(1);
        const diagnostics = fileEvents.flatMap((e) => e.diagnostics);
        expect(diagnostics).toHaveLength(0);
      }, { timeout: 10000 });
    } finally {
      server.dispose();
    }
  });
});
