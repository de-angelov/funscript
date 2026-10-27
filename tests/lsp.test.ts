import { describe, it, expect, vi, beforeAll } from "vitest";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  FunScriptLspServer,
  MessageReader,
  MessageWriter,
  formatLspMessage,
  validateFunScript,
  DiagnosticSeverity,
  ErrorCodes,
  TextDocumentSyncKind,
  type RequestMessage,
  type NotificationMessage,
  type ResponseMessage,
  type PublishDiagnosticsParams,
} from "../src/lsp/index.js";

describe("FunScript LSP Server", () => {
  describe("Lifecycle Handling", () => {
    it("returns capabilities and serverInfo on initialize request", async () => {
      const server = new FunScriptLspServer();
      const initReq: RequestMessage = {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          processId: null,
          rootUri: null,
          capabilities: {},
        },
      };

      const response = await server.handleMessage(initReq);
      expect(response).toBeDefined();
      expect((response as ResponseMessage).id).toBe(1);
      expect((response as ResponseMessage).result).toEqual({
        capabilities: {
          textDocumentSync: TextDocumentSyncKind.Full,
        },
        serverInfo: {
          name: "funscript-lsp",
          version: "0.1.0",
        },
      });
    });

    it("accepts initialized notification", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const initializedSpy = vi.fn();
      server.on("initialized", initializedSpy);

      const response = await server.handleMessage({
        jsonrpc: "2.0",
        method: "initialized",
        params: {},
      });

      expect(response).toBeUndefined();
      expect(initializedSpy).toHaveBeenCalledOnce();
    });

    it("rejects requests before initialize with ServerNotInitialized error", async () => {
      const server = new FunScriptLspServer();
      const req: RequestMessage = {
        jsonrpc: "2.0",
        id: 10,
        method: "textDocument/hover",
        params: {},
      };

      const response = (await server.handleMessage(req)) as ResponseMessage;
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(ErrorCodes.ServerNotInitialized);
    });

    it("handles shutdown request and responds with null", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 2,
        method: "shutdown",
      })) as ResponseMessage;

      expect(response.id).toBe(2);
      expect(response.result).toBeNull();
    });

    it("rejects subsequent requests after shutdown with InvalidRequest error", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "shutdown" });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 3,
        method: "textDocument/definition",
      })) as ResponseMessage;

      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(ErrorCodes.InvalidRequest);
    });

    it("emits exit with code 0 if preceded by shutdown", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      await server.handleMessage({ jsonrpc: "2.0", id: 2, method: "shutdown" });

      const exitSpy = vi.fn();
      server.onExit(exitSpy);

      await server.handleMessage({ jsonrpc: "2.0", method: "exit" });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it("emits exit with code 1 if shutdown was not called", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const exitSpy = vi.fn();
      server.onExit(exitSpy);

      await server.handleMessage({ jsonrpc: "2.0", method: "exit" });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("returns MethodNotFound for unsupported request method", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 99,
        method: "workspace/symbol",
        params: {},
      })) as ResponseMessage;

      expect(response.error?.code).toBe(ErrorCodes.MethodNotFound);
    });
  });

  describe("Document Synchronization & Diagnostic Reporting", () => {
    it("publishes empty diagnostics for clean valid FunScript documents on didOpen", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/valid.fun",
            languageId: "funscript",
            version: 1,
            text: 'export greeting = "hello"\nexport add = (a: number, b: number) -> a + b\n',
          },
        },
      });

      expect(server.getDocument("file:///workspace/valid.fun")).toBeDefined();
      expect(diagEvents).toHaveLength(1);
      expect(diagEvents[0].uri).toBe("file:///workspace/valid.fun");
      expect(diagEvents[0].diagnostics).toEqual([]);
    });

    it("reports diagnostic for banned let keyword with exact line and column range", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/error-let.fun",
            languageId: "funscript",
            version: 1,
            text: "let x = 10\n",
          },
        },
      });

      expect(diagEvents).toHaveLength(1);
      const diagnostics = diagEvents[0].diagnostics;
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostics[0].source).toBe("funscript");
      expect(diagnostics[0].message).toContain("FunScript has no 'let'");
      expect(diagnostics[0].range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 3 },
      });
    });

    it("reports diagnostic on second line for banned operator with accurate range", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      const code = 'name = "Ada"\nage === 30\n';
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/error-op.fun",
            languageId: "funscript",
            version: 1,
            text: code,
          },
        },
      });

      expect(diagEvents).toHaveLength(1);
      const diag = diagEvents[0].diagnostics[0];
      expect(diag.message).toContain("FunScript strict equality is '=='");
      expect(diag.range).toEqual({
        start: { line: 1, character: 4 },
        end: { line: 1, character: 7 },
      });
    });

    it("reports diagnostic for tabs indentation", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/error-tabs.fun",
            languageId: "funscript",
            version: 1,
            text: "x\t= 1\n",
          },
        },
      });

      expect(diagEvents).toHaveLength(1);
      const diag = diagEvents[0].diagnostics[0];
      expect(diag.message).toContain("Tabs are not allowed");
      expect(diag.range.start.line).toBe(0);
      expect(diag.range.start.character).toBe(1);
    });

    it("reports parser syntax errors with token positions", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///workspace/error-parser.fun",
            languageId: "funscript",
            version: 1,
            text: "schema User\n",
          },
        },
      });

      expect(diagEvents).toHaveLength(1);
      const diag = diagEvents[0].diagnostics[0];
      expect(diag.message).toContain("Expected '=' after schema name");
      expect(diag.range.start.line).toBe(0);
    });

    it("updates diagnostics on textDocument/didChange (clearing errors when fixed)", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      const uri = "file:///workspace/editing.fun";

      // 1. Open with error
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: "let a = 1\n",
          },
        },
      });

      expect(diagEvents).toHaveLength(1);
      expect(diagEvents[0].diagnostics).toHaveLength(1);

      // 2. Change to valid code
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: "a = 1\n" }],
        },
      });

      expect(diagEvents).toHaveLength(2);
      expect(diagEvents[1].version).toBe(2);
      expect(diagEvents[1].diagnostics).toEqual([]);
      expect(server.getDocument(uri)?.text).toBe("a = 1\n");
    });

    it("clears diagnostics and untracks document on textDocument/didClose", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const diagEvents: PublishDiagnosticsParams[] = [];
      server.on("diagnostics", (p) => diagEvents.push(p));

      const uri = "file:///workspace/temp.fun";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: "let invalid = 1\n",
          },
        },
      });

      expect(server.getDocument(uri)).toBeDefined();

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didClose",
        params: {
          textDocument: { uri },
        },
      });

      expect(server.getDocument(uri)).toBeUndefined();
      expect(diagEvents).toHaveLength(2);
      expect(diagEvents[1].diagnostics).toEqual([]);
    });

    it("tracks multiple open documents simultaneously", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///doc1.fun",
            languageId: "funscript",
            version: 1,
            text: "x = 1\n",
          },
        },
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///doc2.fun",
            languageId: "funscript",
            version: 1,
            text: "y = 2\n",
          },
        },
      });

      expect(server.getDocuments()).toHaveLength(2);
      expect(server.getDocument("file:///doc1.fun")?.text).toBe("x = 1\n");
      expect(server.getDocument("file:///doc2.fun")?.text).toBe("y = 2\n");
    });

    it("validates FunScript effect block errors using validateFunScript helper", () => {
      const invalidEffectCode = `
getUser = () ->
  effect
    user <- UserRepo.find("123")
`.trim();

      const diagnostics = validateFunScript(invalidEffectCode, "file:///test.fun");
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
      expect(diagnostics[0].message).toContain("Effect block must end with a return expression");
    });
  });

  describe("Message Transport & Framing", () => {
    it("encodes and decodes messages over streams using Content-Length framing", async () => {
      const stream = new PassThrough();
      const reader = new MessageReader(stream);
      const writer = new MessageWriter(stream);

      const received: any[] = [];
      reader.on("message", (msg) => received.push(msg));

      const message: RequestMessage = {
        jsonrpc: "2.0",
        id: 42,
        method: "custom/test",
        params: { greeting: "hello 🚀" },
      };

      writer.write(message);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(message);

      reader.dispose();
      writer.dispose();
    });

    it("handles multiple messages chunked together in a single stream write", async () => {
      const stream = new PassThrough();
      const reader = new MessageReader(stream);

      const received: any[] = [];
      reader.on("message", (msg) => received.push(msg));

      const msg1 = { jsonrpc: "2.0", id: 1, method: "msg1" };
      const msg2 = { jsonrpc: "2.0", id: 2, method: "msg2" };

      const chunk = formatLspMessage(msg1 as any) + formatLspMessage(msg2 as any);
      stream.write(chunk);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(2);
      expect(received[0].id).toBe(1);
      expect(received[1].id).toBe(2);

      reader.dispose();
    });

    it("handles headers with extra fields such as Content-Type", async () => {
      const stream = new PassThrough();
      const reader = new MessageReader(stream);

      const received: any[] = [];
      reader.on("message", (msg) => received.push(msg));

      const payload = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "test/extraHeaders" });
      const byteLength = Buffer.byteLength(payload, "utf-8");
      const messageWithHeaders = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${byteLength}\r\n\r\n${payload}`;

      stream.write(messageWithHeaders);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(received).toHaveLength(1);
      expect(received[0].id).toBe(7);

      reader.dispose();
    });
  });

  describe("CLI Stdio Integration (funscript lsp --stdio)", () => {
    it("boots over stdio, responds to initialize, and publishes diagnostics", async () => {
      const cliPath = path.resolve(__dirname, "../dist/cli/index.js");

      const child = spawn("node", [cliPath, "lsp", "--stdio"]);

      const responses: any[] = [];
      const reader = new MessageReader(child.stdout);
      reader.on("message", (msg) => responses.push(msg));

      const writer = new MessageWriter(child.stdin);

      // 1. Send initialize
      writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      } as any);

      await vi.waitFor(() => {
        expect(responses.some((r) => r.id === 1)).toBe(true);
      });

      const initRes = responses.find((r) => r.id === 1);
      expect(initRes.result.capabilities.textDocumentSync).toBe(TextDocumentSyncKind.Full);

      // 2. Open document with error
      writer.write({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///test.fun",
            languageId: "funscript",
            version: 1,
            text: "let bad = true\n",
          },
        },
      } as any);

      await vi.waitFor(() => {
        expect(
          responses.some(
            (r) => r.method === "textDocument/publishDiagnostics" && r.params.diagnostics.length > 0
          )
        ).toBe(true);
      });

      const diagNotif = responses.find((r) => r.method === "textDocument/publishDiagnostics");
      expect(diagNotif.params.diagnostics[0].message).toContain("FunScript has no 'let'");

      // 3. Send shutdown
      writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: "shutdown",
      } as any);

      await vi.waitFor(() => {
        expect(responses.some((r) => r.id === 2)).toBe(true);
      });

      // 4. Send exit
      const exitPromise = new Promise<number>((resolve) => {
        child.on("exit", (code) => resolve(code ?? 0));
      });

      writer.write({
        jsonrpc: "2.0",
        method: "exit",
      } as any);

      const exitCode = await exitPromise;
      expect(exitCode).toBe(0);

      reader.dispose();
      writer.dispose();
    });
  });
});
