import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { StreamMessageReader, StreamMessageWriter } from "vscode-languageserver/node";
// Exercise the packaged JavaScript worker, as used by the actual language server.
import { FunScriptLspServer } from "../dist/lsp/server.js";

describe("rename worker", () => {
  it("keeps the server responsive and discards results after an editor change", async () => {
    const root = mkdtempSync(join(tmpdir(), "funscript-worker-"));
    const server = new FunScriptLspServer();
    try {
      const uri = pathToFileURL(join(root, "lib.fun")).href;
      const app = pathToFileURL(join(root, "app.ts")).href;
      writeFileSync(join(root, "lib.fun"), "export value = 1\n");
      writeFileSync(join(root, "app.ts"), 'import { value } from "./lib.js";\nconsole.log(value);\n');
      server.onInitializeHandler({ processId: null, rootUri: pathToFileURL(root).href, capabilities: {} });
      server.onDidOpenHandler({ textDocument: { uri, languageId: "funscript", version: 1, text: "export value = 1\n" } });
      const request = { jsonrpc: "2.0" as const, id: 1, method: "textDocument/rename", params: { textDocument: { uri }, position: { line: 0, character: 8 }, newName: "amount" } };
      const pending = server.handleMessage(request);
      const first = await Promise.race([pending.then(() => "rename"), new Promise<string>(resolve => setTimeout(() => resolve("timer"), 0))]);
      expect(first).toBe("timer");
      const response = await pending;
      expect(response).toMatchObject({ result: { changes: { [app]: expect.any(Array) } } });

      await server.handleMessage({ jsonrpc: "2.0", method: "funscript/interopDocument", params: { kind: "upsert", textDocument: { uri: app, languageId: "typescript", version: 2, text: "export const unrelated = 1;\n" } } });
      const unsaved = await server.handleMessage({ ...request, id: 4 });
      expect((unsaved as any).result.changes[app]).toBeUndefined();
      const staleInterop = server.handleMessage({ ...request, id: 5 });
      await server.handleMessage({ jsonrpc: "2.0", method: "funscript/interopDocument", params: { kind: "upsert", textDocument: { uri: app, languageId: "typescript", version: 3, text: "export const changed = 1;\n" } } });
      expect(await staleInterop).toMatchObject({ result: null });
      await server.handleMessage({ jsonrpc: "2.0", method: "funscript/interopDocument", params: { kind: "close", uri: app } });

      const stale = server.handleMessage({ ...request, id: 2 });
      server.onDidChangeHandler({ textDocument: { uri, version: 2 }, contentChanges: [{ text: "export value = 2\n" }] });
      expect(await stale).toMatchObject({ result: null });
      const current = await server.handleMessage({ ...request, id: 3 });
      expect(current).toMatchObject({ result: { changes: { [app]: expect.any(Array) } } });
    } finally {
      server.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);

  it("routes editor buffer notifications and rename through the LSP connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "funscript-worker-protocol-"));
    const server = new FunScriptLspServer();
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = new StreamMessageReader(output);
    const writer = new StreamMessageWriter(input);
    const responses: any[] = [];
    reader.listen(message => responses.push(message));
    try {
      const uri = pathToFileURL(join(root, "lib.fun")).href;
      const app = pathToFileURL(join(root, "app.ts")).href;
      writeFileSync(join(root, "lib.fun"), "export value = 1\n");
      writeFileSync(join(root, "app.ts"), 'import { value } from "./lib.js";\n');
      server.listen(input, output);
      await writer.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { processId: null, rootUri: pathToFileURL(root).href, capabilities: {} } });
      await vi.waitFor(() => expect(responses.some(response => response.id === 1)).toBe(true));
      await writer.write({ jsonrpc: "2.0", method: "initialized", params: {} });
      await writer.write({ jsonrpc: "2.0", method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "funscript", version: 1, text: "export value = 1\n" } } });
      await writer.write({ jsonrpc: "2.0", method: "funscript/interopDocument", params: { kind: "upsert", textDocument: { uri: app, languageId: "typescript", version: 2, text: "export const unrelated = 1;\n" } } });
      await writer.write({ jsonrpc: "2.0", id: 2, method: "textDocument/rename", params: { textDocument: { uri }, position: { line: 0, character: 8 }, newName: "amount" } });
      await vi.waitFor(() => expect(responses.some(response => response.id === 2)).toBe(true), { timeout: 20000 });
      expect(responses.find(response => response.id === 2).result.changes[app]).toBeUndefined();
      await writer.write({ jsonrpc: "2.0", method: "funscript/interopDocument", params: { kind: "close", uri: app } });
      await writer.write({ jsonrpc: "2.0", id: 3, method: "textDocument/rename", params: { textDocument: { uri }, position: { line: 0, character: 8 }, newName: "amount" } });
      await vi.waitFor(() => expect(responses.some(response => response.id === 3)).toBe(true), { timeout: 20000 });
      expect(responses.find(response => response.id === 3).result.changes[app]).toBeDefined();
    } finally {
      reader.dispose();
      writer.dispose();
      server.dispose();
      input.destroy();
      output.destroy();
      rmSync(root, { recursive: true, force: true });
    }
  }, 30000);
});
