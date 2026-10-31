import { describe, it, expect, vi, beforeAll } from "vitest";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import * as path from "node:path";
import {
  FunScriptLspServer,
  StreamMessageReader,
  StreamMessageWriter,
  validateFunScript,
  DiagnosticSeverity,
  ErrorCodes,
  TextDocumentSyncKind,
  type RequestMessage,
  type NotificationMessage,
  type ResponseMessage,
  type PublishDiagnosticsParams,
  type DocumentFormattingParams,
  type TextEdit,
  type Location,
  type LocationLink,
  type DefinitionParams,
  type Hover,
  type HoverParams,
  MarkupKind,
} from "../src/lsp/index.js";
import { format } from "../src/formatter/index.js";

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
          documentFormattingProvider: true,
          documentRangeFormattingProvider: true,
          definitionProvider: true,
          hoverProvider: true,
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
            text: 'export greeting = "hello"\nexport add = (a: Number, b: Number) -> a + b\n',
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

      const code = 'name = "Ada"\nage && 30\n';
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
      expect(diag.message).toContain("FunScript logical AND is 'and'");
      expect(diag.range).toEqual({
        start: { line: 1, character: 4 },
        end: { line: 1, character: 6 },
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

  describe("Document Formatting (textDocument/formatting)", () => {
    it("formats unformatted documents and returns a TextEdit replacing the whole document range", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///workspace/format-test.fun";
      const source = 'name = "Ada"\nage =   36\nisActive = true';

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: source,
          },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 10,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri },
          options: { tabSize: 2, insertSpaces: true },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      expect(response.id).toBe(10);
      expect(Array.isArray(response.result)).toBe(true);
      expect(response.result).toHaveLength(1);

      const edit: TextEdit = response.result[0];
      expect(edit.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 2, character: 15 },
      });
      expect(edit.newText).toBe('name = "Ada"\nage = 36\nisActive = true\n');
    });

    it("formats functions and schemas conforming to FunScript formatting rules", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///workspace/schema.fun";
      const source = `
export schema User = {
    id: String
    name: String
}

export greet = (user: User) ->
    "Hello, {user.name}!"
`.trim();

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: source,
          },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 20,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      expect(response.result).toHaveLength(1);
      const edit: TextEdit = response.result[0];
      expect(edit.newText).toBe(
        'export schema User = {\n  id: String\n  name: String\n}\n\nexport greet = (user: User) ->\n  "Hello, {user.name}!"\n'
      );
    });

    it("respects tabSize formatting option", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///workspace/indent.fun";
      const source = `
export schema Config = {
  host: String
}
`.trim();

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: source,
          },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 30,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri },
          options: { tabSize: 4, insertSpaces: true },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      expect(response.result).toHaveLength(1);
      const edit: TextEdit = response.result[0];
      expect(edit.newText).toBe('export schema Config = {\n    host: String\n}\n');
    });

    it("returns null when formatting an unknown or unopened document", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 40,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri: "file:///workspace/nonexistent.fun" },
        },
      })) as ResponseMessage;

      expect(response.id).toBe(40);
      expect(response.result).toBeNull();
    });

    it("returns null when formatting document with syntax errors", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///workspace/syntax-error.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: "let invalid = 123\n",
          },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 50,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri },
        },
      })) as ResponseMessage;

      expect(response.id).toBe(50);
      expect(response.result).toBeNull();
    });

    it("matches CLI formatting for .funx documents and declines partial ranges", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
      const uri = "file:///workspace/message.funx";
      const source = `export Message = () => <p>Done!</p>`;
      await server.handleMessage({
        jsonrpc: "2.0", method: "textDocument/didOpen",
        params: { textDocument: { uri, languageId: "funscriptx", version: 1, text: source } },
      });
      const formatted = await server.handleMessage({
        jsonrpc: "2.0", id: 51, method: "textDocument/formatting",
        params: { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } },
      }) as ResponseMessage;
      expect(formatted.result[0].newText).toBe(format(source, { filename: "/workspace/message.funx" }));

      const partial = server.onRangeFormattingHandler({
        textDocument: { uri }, options: { tabSize: 2, insertSpaces: true },
        range: { start: { line: 0, character: 1 }, end: { line: 0, character: 4 } },
      } as any);
      expect(partial).toBeNull();
    });

    it("returns empty array for empty documents", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///workspace/empty.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: "   \n\n  ",
          },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 60,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri },
        },
      })) as ResponseMessage;

      expect(response.id).toBe(60);
      expect(response.result).toEqual([]);
    });

    it("formats modified document after textDocument/didChange", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///workspace/change-and-format.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri,
            languageId: "funscript",
            version: 1,
            text: "x = 1\n",
          },
        },
      });

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: "total =    100 +   200\n" }],
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 70,
        method: "textDocument/formatting",
        params: {
          textDocument: { uri },
        },
      })) as ResponseMessage;

      expect(response.id).toBe(70);
      expect(response.result).toHaveLength(1);
      expect(response.result[0].newText).toBe("total = 100 + 200\n");
    });
  });

  describe("Go to Definition (textDocument/definition)", () => {
    it("returns null when document is not open", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 10,
        method: "textDocument/definition",
        params: {
          textDocument: { uri: "file:///nonexistent.fun" },
          position: { line: 0, character: 0 },
        },
      })) as ResponseMessage;

      expect(response.id).toBe(10);
      expect(response.result).toBeNull();
    });

    it("returns null for empty documents", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///empty.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: "   \n\n  " },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 11,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 1 },
        },
      })) as ResponseMessage;

      expect(response.result).toBeNull();
    });

    it("returns null when cursor is on whitespace or non-identifier token", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///whitespace.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: "x = 42 + 10\n" },
        },
      });

      // Cursor on '=' (character 2)
      const resEqual = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 12,
        method: "textDocument/definition",
        params: { textDocument: { uri }, position: { line: 0, character: 2 } },
      })) as ResponseMessage;
      expect(resEqual.result).toBeNull();

      // Cursor on number literal '42' (character 4)
      const resNum = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 13,
        method: "textDocument/definition",
        params: { textDocument: { uri }, position: { line: 0, character: 4 } },
      })) as ResponseMessage;
      expect(resNum.result).toBeNull();
    });

    it("returns null for undefined / unresolved identifiers", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///undefined.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: "y = unknownVariable + 1\n" },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 14,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 6 }, // on unknownVariable
        },
      })) as ResponseMessage;

      expect(response.result).toBeNull();
    });

    it("resolves function calls to top-level function declaration range", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///fn.fun";
      const source = [
        "add = (a: Number, b: Number) -> a + b",
        "result = add(10, 20)",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'add' at call site: line 1, character 9
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 20,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 9 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 37 },
      });
    });

    it("resolves function definition when cursor is directly on declaration identifier", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///fn-decl.fun";
      const source = "add = (a: Number, b: Number) -> a + b\n";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'add' in 'add = ...': line 0, character 1
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 21,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 1 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 37 },
      });
    });

    it("resolves exported function declarations including the export statement range", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///export-fn.fun";
      const source = [
        "export multiply = (x: Number, y: Number) -> x * y",
        "value = multiply(3, 4)",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'multiply' at call site: line 1, character 8
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 22,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 8 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 49 },
      });
    });

    it("resolves variable usages to top-level variable declaration range", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///var.fun";
      const source = "total = 42\nnext = total + 1\n";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'total' in 'next = total + 1': line 1, character 8
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 23,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 8 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 10 },
      });
    });

    it("resolves function parameters inside function body", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///params.fun";
      const source = "double = (count: Number) -> count * 2\n";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'count' in 'count * 2': line 0, character 29
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 24,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 29 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      // Parameter 'count: number' starts at character 10, ends at 15
      expect(loc.range).toEqual({
        start: { line: 0, character: 10 },
        end: { line: 0, character: 15 },
      });
    });

    it("resolves local variable bindings inside block statements", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///block.fun";
      const source = [
        "calculate = (n: Number) ->",
        "  subtotal = n * 10",
        "  subtotal + 5",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'subtotal' on line 2, character 4
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 25,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 2, character: 4 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      // 'subtotal = n * 10' on line 1: characters 2 to 19
      expect(loc.range).toEqual({
        start: { line: 1, character: 2 },
        end: { line: 1, character: 19 },
      });
    });

    it("resolves type references to schema declaration range", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///schema.fun";
      const source = [
        "schema User = {",
        "  id: String",
        "  name: String",
        "}",
        "export getUserName = (user: User) -> user.name",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'User' in 'user: User': line 4, character 29
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 26,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 4, character: 29 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 3, character: 1 },
      });
    });

    it("resolves tagged union variant constructors to their variant declaration", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///variants.fun";
      const source = [
        "schema Shape =",
        "  | Circle(radius: Number)",
        "  | Rectangle(w: Number, h: Number)",
        "shape = Circle(15)",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'Circle' in 'Circle(15)': line 3, character 9
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 27,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 3, character: 9 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 1, character: 2 },
        end: { line: 1, character: 26 },
      });
    });

    it("resolves error declarations and service declarations", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///services.fun";
      const source = [
        "error NotFound(id: String)",
        "service OrderService",
        "  getOrder: (id: String) -> Effect<Order, NotFound>",
        "result = OrderService",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'NotFound' in Service signature: line 2, character 43
      const errRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 28,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 2, character: 43 },
        },
      })) as ResponseMessage;

      expect(errRes.error).toBeUndefined();
      expect((errRes.result as Location).range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      });

      // Cursor on 'OrderService' on line 3, character 12
      const svcRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 29,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 3, character: 12 },
        },
      })) as ResponseMessage;

      expect(svcRes.error).toBeUndefined();
      expect((svcRes.result as Location).range).toEqual({
        start: { line: 1, character: 0 },
        end: { line: 3, character: 0 },
      });
    });

    it("resolves effect-bound variables inside effect block expressions", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///effect.fun";
      const source = [
        "getAccount = () ->",
        "  effect",
        '    user <- findUser("123")',
        "    user",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'user' on line 3, character 5
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 30,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 3, character: 5 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      // 'user <- findUser("123")' on line 2
      expect(loc.range).toEqual({
        start: { line: 2, character: 4 },
        end: { line: 2, character: 27 },
      });
    });

    it("resolves pattern variables inside match expression arms", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///match.fun";
      const source = [
        "schema Shape = | Circle(radius: Number)",
        "calc = (s: Shape) ->",
        "  match s",
        "    | Circle(radius) -> radius * 2",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'radius' in 'radius * 2': line 3, character 25
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 31,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 3, character: 25 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 3, character: 13 },
        end: { line: 3, character: 19 },
      });
    });

    it("resolves draft parameters inside mut block expressions", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///mut.fun";
      const source = [
        "appendTag = (p: Profile, tag: String) ->",
        "  p",
        "  |> mut (draft) ->",
        "    draft.tags.push(tag)",
        "    draft",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'draft' in 'draft.tags': line 3, character 4
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 32,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 3, character: 4 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 2, character: 10 },
        end: { line: 2, character: 15 },
      });
    });

    it("resolves imported specifiers to the import declaration", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///import.fun";
      const source = [
        'import { helper } from "./utils.js"',
        "callHelper = () -> helper()",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      // Cursor on 'helper' at call site: line 1, character 20
      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 33,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 20 },
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.uri).toBe(uri);
      expect(loc.range).toEqual({
        start: { line: 0, character: 9 },
        end: { line: 0, character: 15 },
      });
    });

    it("updates definitions after document changes via textDocument/didChange", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///change.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: "foo = 10\nbar = foo\n" },
        },
      });

      // Change document: rename foo to newFoo
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didChange",
        params: {
          textDocument: { uri, version: 2 },
          contentChanges: [{ text: "newFoo = 100\nbar = newFoo\n" }],
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 34,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 8 }, // on 'newFoo'
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      const loc = response.result as Location;
      expect(loc.range).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 12 },
      });
    });

    it("returns LocationLink array when client capability linkSupport is enabled", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          capabilities: {
            textDocument: {
              definition: {
                linkSupport: true,
              },
            },
          },
        },
      });

      const uri = "file:///link-support.fun";
      const source = "export greet = () -> 42\nres = greet()\n";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: source },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 35,
        method: "textDocument/definition",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 7 }, // on 'greet'
        },
      })) as ResponseMessage;

      expect(response.error).toBeUndefined();
      expect(Array.isArray(response.result)).toBe(true);
      const links = response.result as LocationLink[];
      expect(links).toHaveLength(1);
      const link = links[0];
      expect(link.targetUri).toBe(uri);
      expect(link.targetRange).toEqual({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 23 },
      });
      expect(link.targetSelectionRange).toEqual({
        start: { line: 0, character: 7 },
        end: { line: 0, character: 12 },
      });
      expect(link.originSelectionRange).toEqual({
        start: { line: 1, character: 6 },
        end: { line: 1, character: 11 },
      });
    });
  });

  describe("Hover Provider (textDocument/hover)", () => {
    it("returns null when document is not open", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 10,
        method: "textDocument/hover",
        params: {
          textDocument: { uri: "file:///notfound.fun" },
          position: { line: 0, character: 0 },
        },
      })) as ResponseMessage;

      expect(response.id).toBe(10);
      expect(response.result).toBeNull();
    });

    it("returns null for empty documents", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///empty.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: "   \n  " },
        },
      });

      const response = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 11,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 1 },
        },
      })) as ResponseMessage;

      expect(response.result).toBeNull();
    });

    it("returns null when cursor is on whitespace or undocumented user identifier", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///code.fun";
      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text: "myCustomVar = 123\n" },
        },
      });

      // Cursor on whitespace
      const wsRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 12,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 11 }, // on space
        },
      })) as ResponseMessage;
      expect(wsRes.result).toBeNull();

      // Cursor on custom variable
      const varRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 13,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 4 }, // on 'myCustomVar'
        },
      })) as ResponseMessage;
      expect(varRes.result).toBeNull();
    });

    it("returns rich Markdown hover documentation for language keywords (service, effect, match, mut)", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///keywords.fun";
      const text = [
        "export service UserRepo",
        "  find: (id: String) -> Effect<User, NotFound>",
        "",
        "getUser = (id: String) ->",
        "  effect",
        "    mut count = 0",
        "    user <- UserRepo.find(id)",
        "    match user",
        "      | Some(u) -> u",
        "      | None -> fail(NotFound(id))",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text },
        },
      });

      // 1. Hover on 'service'
      const serviceRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 20,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 9 }, // 'service'
        },
      })) as ResponseMessage;

      const serviceHover = serviceRes.result as Hover;
      expect(serviceHover).toBeDefined();
      expect(serviceHover.contents).toEqual(
        expect.objectContaining({
          kind: MarkupKind.Markdown,
        })
      );
      expect((serviceHover.contents as any).value).toContain("Context.Service");
      expect((serviceHover.contents as any).value).toContain("```funscript");
      expect(serviceHover.range).toBeDefined();

      // 2. Hover on 'effect'
      const effectRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 21,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 4, character: 4 }, // 'effect'
        },
      })) as ResponseMessage;
      const effectHover = effectRes.result as Hover;
      expect((effectHover.contents as any).value).toContain("Effect.gen");

      // 3. Hover on 'mut'
      const mutRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 22,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 5, character: 5 }, // 'mut'
        },
      })) as ResponseMessage;
      const mutHover = mutRes.result as Hover;
      expect((mutHover.contents as any).value).toContain("Mutative");

      // 4. Hover on 'match'
      const matchRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 23,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 7, character: 6 }, // 'match'
        },
      })) as ResponseMessage;
      const matchHover = matchRes.result as Hover;
      expect((matchHover.contents as any).value).toContain("ts-pattern");

      // 5. Hover on 'fail'
      const failRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 24,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 9, character: 17 }, // 'fail'
        },
      })) as ResponseMessage;
      const failHover = failRes.result as Hover;
      expect((failHover.contents as any).value).toContain("Effect.fail");
    });

    it("returns rich Markdown hover documentation for interop keywords (js, ts)", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///interop.fun";
      const text = [
        "schema Config = {",
        "  options: ts \"Record<string, unknown>\"",
        "}",
        "",
        "fetchData = (url: String) ->",
        "  effect",
        "    res <- js fetch(url)",
        "    res",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text },
        },
      });

      // Hover on 'ts'
      const tsRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 30,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 12 }, // 'ts'
        },
      })) as ResponseMessage;
      const tsHover = tsRes.result as Hover;
      expect((tsHover.contents as any).value).toContain("TypeScript type system escape hatch");

      // Hover on 'js'
      const jsRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 31,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 6, character: 12 }, // 'js'
        },
      })) as ResponseMessage;
      const jsHover = jsRes.result as Hover;
      expect((jsHover.contents as any).value).toContain("JavaScript and npm interop");
    });

    it("returns rich Markdown hover documentation for primitives and built-in types", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///types.fun";
      const text = "fn = (name: String, count: Number, flag: Boolean) -> Option<Array<String>>\n";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text },
        },
      });

      // Hover on 'string'
      const stringRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 40,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 14 }, // 'string'
        },
      })) as ResponseMessage;
      const stringHover = stringRes.result as Hover;
      expect((stringHover.contents as any).value).toContain("UTF-16 text string primitive");

      // Hover on 'Option'
      const optionRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 41,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 54 }, // 'Option'
        },
      })) as ResponseMessage;
      const optionHover = optionRes.result as Hover;
      expect((optionHover.contents as any).value).toContain("Option");
    });

    it("returns rich Markdown hover documentation for syntax operators (<- , |> , -> , ???)", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///operators.fun";
      const text = [
        "pipeline = (x: Number) ->",
        "  x |> double",
        "",
        "run = () ->",
        "  effect",
        "    v <- doWork()",
        "    v",
        "",
        "stub = ???",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text },
        },
      });

      // 1. Hover on '|>'
      const pipeRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 50,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 5 }, // '|>'
        },
      })) as ResponseMessage;
      const pipeHover = pipeRes.result as Hover;
      expect((pipeHover.contents as any).value).toContain("|>");

      // 2. Hover on '<-'
      const arrowRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 51,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 5, character: 7 }, // '<-'
        },
      })) as ResponseMessage;
      const arrowHover = arrowRes.result as Hover;
      expect((arrowHover.contents as any).value).toContain("<-");

      // 3. Hover on '->'
      const fnArrowRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 52,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 24 }, // '->'
        },
      })) as ResponseMessage;
      const fnArrowHover = fnArrowRes.result as Hover;
      expect((fnArrowHover.contents as any).value).toContain("->");

      // 4. Hover on '???'
      const holeRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 53,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 8, character: 8 }, // '???'
        },
      })) as ResponseMessage;
      const holeHover = holeRes.result as Hover;
      expect((holeHover.contents as any).value).toContain("???");
    });

    it("returns rich Markdown hover documentation for Effect methods and Layer methods", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///effect-members.fun";
      const text = [
        "val = Effect.succeed(42)",
        "layer = Layer.succeed(Service, impl)",
      ].join("\n");

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text },
        },
      });

      // Hover on 'succeed' in Effect.succeed
      const succeedRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 60,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 15 }, // 'succeed'
        },
      })) as ResponseMessage;
      const succeedHover = succeedRes.result as Hover;
      expect(succeedHover).toBeDefined();
      expect((succeedHover.contents as any).value).toContain("Effect.succeed");

      // Hover on 'Effect' in Effect.succeed
      const effectRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 61,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 8 }, // 'Effect'
        },
      })) as ResponseMessage;
      const effectHover = effectRes.result as Hover;
      expect(effectHover).toBeDefined();
      expect((effectHover.contents as any).value).toContain("Effect");

      // Hover on 'succeed' in Layer.succeed
      const layerSucceedRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 62,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 1, character: 15 }, // 'succeed'
        },
      })) as ResponseMessage;
      const layerSucceedHover = layerSucceedRes.result as Hover;
      expect(layerSucceedHover).toBeDefined();
      expect((layerSucceedHover.contents as any).value).toContain("Layer.succeed");
    });

    it("returns helpful disallowed keyword explanation when hovering over banned keywords", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///banned.fun";
      const text = "let x = 10\nvar y = 20\nconst z = 30\n";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text },
        },
      });

      const letRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 70,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 1 }, // 'let'
        },
      })) as ResponseMessage;

      const letHover = letRes.result as Hover;
      expect(letHover).toBeDefined();
      expect((letHover.contents as any).value).toContain("FunScript has no 'let'");
    });

    it("resiliently provides hover documentation even in files with parse errors", async () => {
      const server = new FunScriptLspServer();
      await server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

      const uri = "file:///syntax-error.fun";
      const text = "service BadService\n  !@#$ invalid syntax error\n";

      await server.handleMessage({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { uri, languageId: "funscript", version: 1, text },
        },
      });

      const serviceRes = (await server.handleMessage({
        jsonrpc: "2.0",
        id: 80,
        method: "textDocument/hover",
        params: {
          textDocument: { uri },
          position: { line: 0, character: 2 }, // on 'service'
        },
      })) as ResponseMessage;

      const serviceHover = serviceRes.result as Hover;
      expect(serviceHover).toBeDefined();
      expect((serviceHover.contents as any).value).toContain("Context.Service");
    });
  });

  describe("Message Transport & Framing", () => {
    it("encodes and decodes messages over streams using Content-Length framing", async () => {
      const stream = new PassThrough();
      const reader = new StreamMessageReader(stream);
      const writer = new StreamMessageWriter(stream);

      const received: any[] = [];
      reader.listen((msg) => received.push(msg));

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
      const reader = new StreamMessageReader(stream);

      const received: any[] = [];
      reader.listen((msg) => received.push(msg));

      const msg1 = { jsonrpc: "2.0", id: 1, method: "msg1" };
      const msg2 = { jsonrpc: "2.0", id: 2, method: "msg2" };

      const formatMessage = (msg: any) => {
        const json = JSON.stringify(msg);
        return `Content-Length: ${Buffer.byteLength(json, "utf-8")}\r\n\r\n${json}`;
      };

      const chunk = formatMessage(msg1) + formatMessage(msg2);
      stream.write(chunk);

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(received).toHaveLength(2);
      expect(received[0].id).toBe(1);
      expect(received[1].id).toBe(2);

      reader.dispose();
    });

    it("handles headers with extra fields such as Content-Type", async () => {
      const stream = new PassThrough();
      const reader = new StreamMessageReader(stream);

      const received: any[] = [];
      reader.listen((msg) => received.push(msg));

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
      const reader = new StreamMessageReader(child.stdout);
      reader.listen((msg) => responses.push(msg));

      const writer = new StreamMessageWriter(child.stdin);

      // 1. Send initialize
      writer.write({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      } as any);

      await vi.waitFor(
        () => {
          expect(responses.some((r) => r.id === 1)).toBe(true);
        },
        { timeout: 10000, interval: 50 }
      );

      const initRes = responses.find((r) => r.id === 1);
      expect(initRes.result.capabilities.textDocumentSync).toBe(TextDocumentSyncKind.Full);
      expect(initRes.result.capabilities.documentFormattingProvider).toBe(true);
      expect(initRes.result.capabilities.definitionProvider).toBe(true);
      expect(initRes.result.capabilities.hoverProvider).toBe(true);

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

      await vi.waitFor(
        () => {
          expect(
            responses.some(
              (r) => r.method === "textDocument/publishDiagnostics" && r.params.diagnostics.length > 0
            )
          ).toBe(true);
        },
        { timeout: 10000, interval: 50 }
      );

      const diagNotif = responses.find((r) => r.method === "textDocument/publishDiagnostics");
      expect(diagNotif.params.diagnostics[0].message).toContain("FunScript has no 'let'");

      // 3. Open unformatted valid document and request formatting over stdio
      writer.write({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///fmt-stdio.fun",
            languageId: "funscript",
            version: 1,
            text: 'x =    42\ny = "hi"\n',
          },
        },
      } as any);

      writer.write({
        jsonrpc: "2.0",
        id: 100,
        method: "textDocument/formatting",
        params: {
          textDocument: {
            uri: "file:///fmt-stdio.fun",
          },
          options: {
            tabSize: 2,
            insertSpaces: true,
          },
        },
      } as any);

      await vi.waitFor(
        () => {
          expect(responses.some((r) => r.id === 100)).toBe(true);
        },
        { timeout: 10000, interval: 50 }
      );

      const fmtRes = responses.find((r) => r.id === 100);
      expect(fmtRes.result).toHaveLength(1);
      expect(fmtRes.result[0].newText).toBe('x = 42\ny = "hi"\n');

      // 4. Open document and request definition over stdio
      writer.write({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///def-stdio.fun",
            languageId: "funscript",
            version: 1,
            text: "val = 42\nres = val + 1\n",
          },
        },
      } as any);

      writer.write({
        jsonrpc: "2.0",
        id: 101,
        method: "textDocument/definition",
        params: {
          textDocument: { uri: "file:///def-stdio.fun" },
          position: { line: 1, character: 7 }, // on 'val'
        },
      } as any);

      await vi.waitFor(
        () => {
          expect(responses.some((r) => r.id === 101)).toBe(true);
        },
        { timeout: 10000, interval: 50 }
      );

      const defRes = responses.find((r) => r.id === 101);
      expect(defRes.result).toEqual({
        uri: "file:///def-stdio.fun",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 8 },
        },
      });

      // 5. Open document and request hover over stdio
      writer.write({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            uri: "file:///hover-stdio.fun",
            languageId: "funscript",
            version: 1,
            text: "service UserService\n",
          },
        },
      } as any);

      writer.write({
        jsonrpc: "2.0",
        id: 102,
        method: "textDocument/hover",
        params: {
          textDocument: { uri: "file:///hover-stdio.fun" },
          position: { line: 0, character: 2 }, // on 'service'
        },
      } as any);

      await vi.waitFor(() => {
        expect(responses.some((r) => r.id === 102)).toBe(true);
      }, { timeout: 5000 });

      const hoverRes = responses.find((r) => r.id === 102);
      expect(hoverRes.result).toBeDefined();
      expect(hoverRes.result.contents.value).toContain("Context.Service");

      // 6. Send shutdown
      writer.write({
        jsonrpc: "2.0",
        id: 2,
        method: "shutdown",
      } as any);

      await vi.waitFor(
        () => {
          expect(responses.some((r) => r.id === 2)).toBe(true);
        },
        { timeout: 10000, interval: 50 }
      );

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
