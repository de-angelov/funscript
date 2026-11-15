import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("declines when matching TypeScript or unparseable FunScript may contain references", () => {
    const { server, uri, write } = project();
    write("lib.fun", "export value = 1\n");
    server.onDidOpenHandler({ textDocument: { uri: uri("lib.fun"), languageId: "funscript", version: 1, text: "export value = 1\n" } });
    const request = { textDocument: { uri: uri("lib.fun") }, position: { line: 0, character: 8 }, newName: "amount" };
    write("app.ts", 'import { value } from "./lib.fun";\n');
    expect(server.onRenameHandler(request)).toBeNull();
    expect(server.onPrepareRenameHandler(request)).toBeNull();
    write("app.ts", "const unrelated = 1;\n");
    write("broken.fun", "value = (\n");
    expect(server.onRenameHandler(request)).toBeNull();
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
});
