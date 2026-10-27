import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import type { Span } from "../ast/types.js";
import {
  Diagnostic,
  DiagnosticSeverity,
  DidCloseTextDocumentParams,
  DidChangeTextDocumentParams,
  DidOpenTextDocumentParams,
  ErrorCodes,
  InitializeResult,
  Message,
  NotificationMessage,
  PublishDiagnosticsParams,
  RequestMessage,
  ResponseMessage,
  TextDocumentItem,
  TextDocumentSyncKind,
} from "./protocol.js";
import { MessageReader, MessageWriter } from "./transport.js";

export function toDiagnostic(error: any): Diagnostic {
  const span: Span | undefined = error.span;
  let startLine = 0;
  let startChar = 0;
  let endLine = 0;
  let endChar = 0;

  if (span && span.start) {
    startLine = Math.max(0, span.start.line - 1);
    startChar = Math.max(0, span.start.column - 1);

    if (span.end) {
      endLine = Math.max(0, span.end.line - 1);
      endChar = Math.max(0, span.end.column - 1);
    } else {
      endLine = startLine;
      endChar = startChar + 1;
    }

    if (endLine < startLine || (endLine === startLine && endChar <= startChar)) {
      endLine = startLine;
      endChar = startChar + 1;
    }
  } else {
    startLine = 0;
    startChar = 0;
    endLine = 0;
    endChar = 1;
  }

  let rawMessage = typeof error.message === "string" ? error.message : String(error);
  rawMessage = rawMessage.replace(/\s+at line \d+, col \d+$/, "");

  return {
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar },
    },
    severity: DiagnosticSeverity.Error,
    source: "funscript",
    message: rawMessage,
  };
}

export function validateFunScript(source: string, uri: string = "<anonymous>"): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  try {
    const lexer = new Lexer(source, uri);
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens, uri);
    parser.parse();

    if (Array.isArray((parser as any).diagnostics)) {
      for (const diag of (parser as any).diagnostics) {
        diagnostics.push(toDiagnostic(diag));
      }
    }
  } catch (error: any) {
    diagnostics.push(toDiagnostic(error));
  }

  return diagnostics;
}

export class FunScriptLspServer extends EventEmitter {
  private documents: Map<string, TextDocumentItem> = new Map();
  private isInitialized = false;
  private isShutdown = false;
  private reader: MessageReader | null = null;
  private writer: MessageWriter | null = null;

  constructor() {
    super();
  }

  public listen(readerStream: Readable, writerStream: Writable): void {
    this.reader = new MessageReader(readerStream);
    this.writer = new MessageWriter(writerStream);

    this.reader.on("message", async (msg: Message) => {
      const response = await this.handleMessage(msg);
      if (response && this.writer) {
        this.writer.write(response);
      }
    });

    this.reader.on("error", (err: Error) => {
      this.emit("error", err);
    });

    this.reader.on("close", () => {
      this.emit("close");
    });
  }

  public async handleMessage(msg: Message): Promise<ResponseMessage | void> {
    if ("id" in msg && msg.id !== undefined && msg.id !== null) {
      return this.handleRequest(msg as RequestMessage);
    } else if ("method" in msg) {
      this.handleNotification(msg as NotificationMessage);
      return undefined;
    }
    return undefined;
  }

  private handleRequest(req: RequestMessage): ResponseMessage {
    if (req.method === "initialize") {
      this.isInitialized = true;
      const result: InitializeResult = {
        capabilities: {
          textDocumentSync: TextDocumentSyncKind.Full,
        },
        serverInfo: {
          name: "funscript-lsp",
          version: "0.1.0",
        },
      };
      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    }

    if (!this.isInitialized) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: ErrorCodes.ServerNotInitialized,
          message: "Server has not been initialized",
        },
      };
    }

    if (this.isShutdown) {
      return {
        jsonrpc: "2.0",
        id: req.id,
        error: {
          code: ErrorCodes.InvalidRequest,
          message: "Server is shut down",
        },
      };
    }

    if (req.method === "shutdown") {
      this.isShutdown = true;
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: null,
      };
    }

    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: ErrorCodes.MethodNotFound,
        message: `Method not found: ${req.method}`,
      },
    };
  }

  private handleNotification(notif: NotificationMessage): void {
    if (notif.method === "initialized") {
      this.emit("initialized");
      return;
    }

    if (notif.method === "exit") {
      const exitCode = this.isShutdown ? 0 : 1;
      this.emit("exit", exitCode);
      return;
    }

    if (notif.method === "textDocument/didOpen") {
      const params = notif.params as DidOpenTextDocumentParams;
      if (params?.textDocument) {
        this.documents.set(params.textDocument.uri, params.textDocument);
        const diagnostics = this.validateSource(params.textDocument.text, params.textDocument.uri);
        this.publishDiagnostics(params.textDocument.uri, params.textDocument.version, diagnostics);
      }
      return;
    }

    if (notif.method === "textDocument/didChange") {
      const params = notif.params as DidChangeTextDocumentParams;
      if (params?.textDocument && Array.isArray(params.contentChanges)) {
        const doc = this.documents.get(params.textDocument.uri);
        const lastChange = params.contentChanges[params.contentChanges.length - 1];
        const newText = lastChange ? lastChange.text : doc?.text ?? "";
        const updatedVersion = params.textDocument.version ?? (doc ? doc.version + 1 : 1);
        const updatedDoc: TextDocumentItem = {
          uri: params.textDocument.uri,
          languageId: doc?.languageId ?? "funscript",
          version: updatedVersion,
          text: newText,
        };
        this.documents.set(params.textDocument.uri, updatedDoc);
        const diagnostics = this.validateSource(newText, params.textDocument.uri);
        this.publishDiagnostics(params.textDocument.uri, updatedVersion, diagnostics);
      }
      return;
    }

    if (notif.method === "textDocument/didClose") {
      const params = notif.params as DidCloseTextDocumentParams;
      if (params?.textDocument) {
        this.documents.delete(params.textDocument.uri);
        this.publishDiagnostics(params.textDocument.uri, undefined, []);
      }
      return;
    }
  }

  public validateSource(source: string, uri: string): Diagnostic[] {
    return validateFunScript(source, uri);
  }

  public publishDiagnostics(uri: string, version: number | undefined, diagnostics: Diagnostic[]): void {
    const params: PublishDiagnosticsParams = {
      uri,
      ...(version !== undefined ? { version } : {}),
      diagnostics,
    };

    const notif: NotificationMessage = {
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params,
    };

    this.emit("diagnostics", params);

    if (this.writer) {
      this.writer.write(notif);
    }
  }

  public onExit(callback: (code: number) => void): this {
    this.on("exit", callback);
    return this;
  }

  public getDocument(uri: string): TextDocumentItem | undefined {
    return this.documents.get(uri);
  }

  public getDocuments(): TextDocumentItem[] {
    return Array.from(this.documents.values());
  }

  public dispose(): void {
    if (this.reader) {
      this.reader.dispose();
      this.reader = null;
    }
    if (this.writer) {
      this.writer.dispose();
      this.writer = null;
    }
    this.documents.clear();
    this.removeAllListeners();
  }
}
