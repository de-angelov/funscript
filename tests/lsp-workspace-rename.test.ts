import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FunScriptLspServer } from "../src/lsp/server.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function project() {
  const root = mkdtempSync(join(tmpdir(), "funscript-lsp-"));
  directories.push(root);
  const uri = (name: string) => pathToFileURL(join(root, name)).href;
  const write = (name: string, text: string) => writeFileSync(join(root, name), text);
  const server = new FunScriptLspServer();
  server.onInitializeHandler({ processId: null, rootUri: pathToFileURL(root).href, capabilities: {} });
  return { server, uri, write };
}

describe("workspace rename", () => {
  it("includes unopened re-exports and consumers, preferring unsaved open text", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    write("barrel.fun", 'export { value } from "./lib.js"\n');
    write("app.fun", 'import { value } from "./barrel.js"\nresult = value\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 2\n" } });
    server.onDidOpenHandler({ textDocument: { uri: uri("app.fun"), languageId: "funscript", version: 2, text: 'import { value } from "./barrel.js"\nresult = value\nmore = value\n' } });
    const position = { line: 0, character: 8 };
    const changes = server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position, newName: "amount" })?.changes;
    expect(Object.keys(changes ?? {}).sort()).toEqual([uri("lib.fun"), uri("barrel.fun"), uri("app.fun")].sort());
    expect(changes?.[uri("app.fun")]).toHaveLength(3);
    expect(server.onDefinitionHandler({ textDocument: { uri: uri("app.fun") }, position: { line: 1, character: 10 } })).toMatchObject({ uri: uri("lib.fun") });
    expect(server.onReferencesHandler({ textDocument: { uri: uri("lib.fun") }, position, context: { includeDeclaration: true } }).some(ref => ref.uri === uri("barrel.fun"))).toBe(true);
    server.dispose();
  });

  it("renames imported TypeScript symbols while preserving explicit aliases and unrelated text", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const request = { textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" };
    write("app.ts", 'import { value as local } from "./lib.js";\nconsole.log(local);\nconst message = "value";\n');
    const edits = server.onRenameHandler(request)?.changes;
    expect(edits?.[uri("app.ts")]).toEqual([{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } }, newText: "amount" }]);
    expect(server.onPrepareRenameHandler(request)).not.toBeNull();
    server.dispose();
  });

  it("declines when unparseable FunScript may contain references", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const request = { textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" };
    write("broken.fun", "value = (\n");
    expect(server.onRenameHandler(request)).toBeNull();
    server.dispose();
  });

  it("follows TypeScript re-exports and open buffers", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    write("barrel.ts", 'export { value } from "./lib.fun";\n');
    write("app.ts", 'import { value } from "./barrel";\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    server.onDidOpenHandler({ textDocument: { uri: uri("app.ts"), languageId: "typescript", version: 2, text: 'import { value } from "./barrel";\nconsole.log(value);\n' } });
    const result = server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" });
    expect(result?.changes?.[uri("barrel.ts")]).toEqual([{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } }, newText: "amount as value" }]);
    expect(result?.changes?.[uri("app.ts")]).toBeUndefined();
    server.dispose();
  });

  it("updates schema imports through FunScript re-exports and leaves shadowed names alone", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export schema Country = { name: String }\n");
    write("barrel.fun", 'export { Country } from "./lib.js"\n');
    write("app.tsx", 'import type { Country } from "./barrel.fun";\ntype Card = { country: Country };\nfunction other(Country: string) { return Country; }\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export schema Country = { name: String }\n" } });
    const result = server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 16 }, newName: "Nation" });
    expect(result?.changes?.[uri("barrel.fun")]).toHaveLength(1);
    const tsEdits = result?.changes?.[uri("app.tsx")];
    expect(tsEdits).toBeDefined();
    expect(tsEdits?.every(edit => edit.range.start.line !== 2)).toBe(true);
    server.dispose();
  });

  it("follows TypeScript star re-exports", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    write("barrel.ts", 'export * from "./lib.js";\n');
    write("app.ts", 'import { value } from "./barrel";\nconsole.log(value);\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const result = server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" });
    expect(result?.changes?.[uri("app.ts")]).toBeDefined();
    server.dispose();
  });

  it("renames TypeScript namespace property accesses", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    write("app.ts", 'import * as lib from "./lib.js";\nconsole.log(lib.value, lib["value"]);\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const result = server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" });
    expect(result?.changes?.[uri("app.ts")]).toHaveLength(2);
    server.dispose();
  });

  it("refuses potentially unsafe dynamic access and TypeScript binding collisions", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const request = { textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" };
    write("app.ts", 'import * as lib from "./lib.js";\nconst key = "value";\nconsole.log(lib[key]);\n');
    expect(server.onRenameHandler(request)).toBeNull();
    write("app.ts", 'import { value } from "./lib.js";\nconst amount = 5;\nconsole.log(value, amount);\n');
    expect(server.onRenameHandler(request)).toBeNull();
    server.dispose();
  });

  it("refuses unresolved TypeScript import types that may refer to the symbol", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export schema Country = { name: String }\n");
    write("app.ts", 'type Row = import("@missing/country").Country;\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export schema Country = { name: String }\n" } });
    expect(server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 16 }, newName: "Nation" })).toBeNull();
    server.dispose();
  });

  it("requires a workspace for rename", () => {
    const server = new FunScriptLspServer();
    server.onInitializeHandler({ processId: null, rootUri: null, capabilities: {} });
    const uri = "file:///project/lib.fun";
    server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: "export value = 1" } });
    expect(server.onRenameHandler({ textDocument: { uri }, position: { line: 0, character: 8 }, newName: "amount" })).toBeNull();
    server.dispose();
  });

  it("refuses schema renames when generated companion names are in use", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export schema Country = { name: String }\n");
    write("app.ts", 'import { CountryFromUnknown } from "./lib.fun";\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export schema Country = { name: String }\n" } });
    expect(server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 16 }, newName: "Nation" })).toBeNull();
    server.dispose();
  });

  it("resolves TypeScript path aliases through the generated FunScript type view", () => {
    const { server, uri, write } = project();
    const root = new URL(".", uri("lib.fun"));
    mkdirSync(new URL(".funscript/types/", root), { recursive: true });
    write(".funscript/types/lib.ts", "export type Country = { name: string };\n");
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": [".funscript/types/*"] } } }));
    write("lib.fun", "export schema Country = { name: String }\n");
    write("app.ts", 'import type { Country } from "@/lib";\nexport type Card = { country: Country };\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export schema Country = { name: String }\n" } });
    const result = server.onRenameHandler({ textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 16 }, newName: "Nation" });
    expect(result?.changes?.[uri("app.ts")]).toBeDefined();
    server.dispose();
  });

  it("refreshes reused TypeScript analysis after disk and unsaved buffer changes", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    write("app.ts", 'import { value } from "./lib.js";\nconsole.log(value);\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const request = { textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" };
    expect(server.onRenameHandler(request)?.changes?.[uri("app.ts")]).toBeDefined();
    write("app.ts", "export const unrelated = 1;\n");
    expect(server.onRenameHandler(request)?.changes?.[uri("app.ts")]).toBeUndefined();
    write("new.ts", 'import { value } from "./lib.js";\n');
    expect(server.onRenameHandler(request)?.changes?.[uri("new.ts")]).toBeDefined();
    server.onDidOpenHandler({ textDocument: { uri: uri("new.ts"), languageId: "typescript", version: 1, text: "export const unrelated = 1;\n" } });
    expect(server.onRenameHandler(request)?.changes?.[uri("new.ts")]).toBeUndefined();
    server.onDidCloseHandler({ textDocument: { uri: uri("new.ts") } });
    expect(server.onRenameHandler(request)?.changes?.[uri("new.ts")]).toBeDefined();
    unlinkSync(new URL(uri("new.ts")));
    expect(server.onRenameHandler(request)?.changes?.[uri("new.ts")]).toBeUndefined();
    server.dispose();
  });

  it("refreshes module resolution after tsconfig changes", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    write("app.ts", 'import { value } from "@/lib.fun";\n');
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const request = { textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" };
    expect(server.onRenameHandler(request)?.changes?.[uri("app.ts")]).toBeDefined();
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["missing/*"] } } }));
    expect(server.onRenameHandler(request)).toBeNull();
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    expect(server.onRenameHandler(request)?.changes?.[uri("app.ts")]).toBeDefined();
    server.dispose();
  });

  it("refreshes resolution when a TypeScript module starts or stops shadowing FunScript", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    write("app.ts", 'import { value } from "./lib.js";\nconsole.log(value);\n');
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const request = { textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" };
    expect(server.onRenameHandler(request)?.changes?.[uri("app.ts")]).toBeDefined();
    write("lib.ts", "export const value = 2;\n");
    expect(server.onRenameHandler(request)?.changes?.[uri("app.ts")]).toBeUndefined();
    unlinkSync(new URL(uri("lib.ts")));
    expect(server.onRenameHandler(request)?.changes?.[uri("app.ts")]).toBeDefined();
    server.dispose();
  });
});
