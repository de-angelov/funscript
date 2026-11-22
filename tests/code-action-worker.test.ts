import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import path from "node:path";
import { StreamMessageReader, StreamMessageWriter } from "vscode-languageserver/node";

describe("code action worker", () => {
  it("serves stdio actions without blocking unrelated requests and drops stale edits", async () => {
    const child = spawn("node", [path.resolve("dist/cli/index.js"), "lsp", "--stdio"]);
    const messages: any[] = [];
    const reader = new StreamMessageReader(child.stdout);
    reader.listen(message => messages.push(message));
    const writer = new StreamMessageWriter(child.stdin);
    const send = (message: any) => writer.write({ jsonrpc: "2.0", ...message });
    const uri = `file://${process.cwd()}/worker-example.fun`;
    try {
      await send({ id: 1, method: "initialize", params: {} });
      await vi.waitFor(() => expect(messages.some(m => m.id === 1)).toBe(true), { timeout: 20000 });
      await send({ method: "initialized", params: {} });
      const source = 'import { String } from "effect"\nexport result = "hello" |> String.startsWith("h")\n';
      await send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "funscript", version: 1, text: source } } });
      await send({ id: 2, method: "textDocument/codeAction", params: { textDocument: { uri }, range: { start: { line: 1, character: 30 }, end: { line: 1, character: 30 } }, context: { diagnostics: [] } } });
      await send({ id: 3, method: "textDocument/formatting", params: { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } } });
      await vi.waitFor(() => expect(messages.some(m => m.id === 3)).toBe(true), { timeout: 10000 });
      expect(messages.some(m => m.id === 2)).toBe(false);
      await send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 2 }, contentChanges: [{ text: 'x = 1\n' }] } });
      await vi.waitFor(() => expect(messages.some(m => m.id === 2)).toBe(true), { timeout: 60000 });
      expect(messages.find(m => m.id === 2).result).toEqual([]);
      await send({ id: 4, method: "textDocument/codeAction", params: { textDocument: { uri }, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, context: { diagnostics: [] } } });
      await vi.waitFor(() => expect(messages.some(m => m.id === 4)).toBe(true), { timeout: 10000 });
      expect(Array.isArray(messages.find(m => m.id === 4).result)).toBe(true);
      await send({ method: "textDocument/didChange", params: { textDocument: { uri, version: 3 }, contentChanges: [{ text: source }] } });
      await send({ id: 5, method: "textDocument/codeAction", params: { textDocument: { uri }, range: { start: { line: 1, character: 30 }, end: { line: 1, character: 30 } }, context: { diagnostics: [] } } });
      await vi.waitFor(() => expect(messages.some(m => m.id === 5)).toBe(true), { timeout: 60000 });
      expect(messages.find(m => m.id === 5).result.some((action: any) => action.title === "Use bare pipeline stages")).toBe(true);
    } finally {
      child.kill();
      reader.dispose();
      writer.dispose();
    }
  }, 160000);
});
