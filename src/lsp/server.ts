import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import {
  createConnection,
  type Connection,
  StreamMessageReader,
  StreamMessageWriter,
  DiagnosticSeverity,
  ErrorCodes,
  TextDocumentSyncKind,
  type Diagnostic,
  type DidCloseTextDocumentParams,
  type DidChangeTextDocumentParams,
  type DidOpenTextDocumentParams,
  type DocumentFormattingParams,
  type DocumentRangeFormattingParams,
  type DefinitionParams,
  type HoverParams,
  type Hover,
  type InitializeParams,
  type InitializeResult,
  type Message,
  type NotificationMessage,
  type PublishDiagnosticsParams,
  type RequestMessage,
  type ResponseMessage,
  type TextDocumentItem,
  type TextEdit,
  type Location,
  type LocationLink,
  type CompletionParams,
  type CompletionItem,
} from "vscode-languageserver/node";
import { Lexer } from "../lexer/lexer.js";
import { Parser } from "../parser/parser.js";
import { format } from "../formatter/index.js";
import type { Span } from "../ast/types.js";
import { findDefinition } from "./definition.js";
import { findHover } from "./hover.js";
import { complete } from "./completion.js";

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

    if (
      endLine < startLine ||
      (endLine === startLine && endChar <= startChar)
    ) {
      endLine = startLine;
      endChar = startChar + 1;
    }
  } else {
    startLine = 0;
    startChar = 0;
    endLine = 0;
    endChar = 1;
  }

  let rawMessage =
    typeof error.message === "string" ? error.message : String(error);
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

export function validateFunScript(
  source: string,
  uri: string = "<anonymous>",
): Diagnostic[] {
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

class NormalizingMessageReader extends StreamMessageReader {
  public override listen(callback: (value: any) => void) {
    return super.listen((msg: any) => {
      if (msg && msg.method === "initialize") {
        if (!msg.params) msg.params = {};
        if (!msg.params.capabilities) msg.params.capabilities = {};
      }
      callback(msg);
    });
  }
}

export class FunScriptLspServer extends EventEmitter {
  private documents: Map<string, TextDocumentItem> = new Map();
  private isInitialized = false;
  private isShutdown = false;
  private clientCapabilities: any = null;
  private connection: Connection | null = null;

  constructor() {
    super();
  }

  public listen(readerStream?: Readable, writerStream?: Writable): Connection {
    const reader = readerStream
      ? new NormalizingMessageReader(readerStream)
      : undefined;
    const writer = writerStream
      ? new StreamMessageWriter(writerStream)
      : undefined;

    const connection =
      reader && writer
        ? createConnection(reader, writer)
        : createConnection(process.stdin, process.stdout);

    this.connection = connection;
    this.setupConnection(connection);
    connection.listen();
    return connection;
  }

  private setupConnection(connection: Connection): void {
    connection.onInitialize((params) => this.onInitializeHandler(params));
    connection.onInitialized(() => {
      this.emit("initialized");
    });
    connection.onShutdown(() => {
      this.onShutdownHandler();
    });
    connection.onExit(() => {
      this.onExitHandler();
    });

    connection.onDidOpenTextDocument((params) => {
      this.onDidOpenHandler(params);
    });
    connection.onDidChangeTextDocument((params) => {
      this.onDidChangeHandler(params);
    });
    connection.onDidCloseTextDocument((params) => {
      this.onDidCloseHandler(params);
    });

    connection.onDocumentFormatting((params) =>
      this.onFormattingHandler(params),
    );
    connection.onDocumentRangeFormatting((params) =>
      this.onRangeFormattingHandler(params),
    );
    connection.onDefinition((params) => this.onDefinitionHandler(params));
    connection.onHover((params) => this.onHoverHandler(params));
    connection.onCompletion((params) => this.onCompletionHandler(params));
  }

  public onInitializeHandler(params: InitializeParams): InitializeResult {
    this.isInitialized = true;
    this.clientCapabilities = params?.capabilities;
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        definitionProvider: true,
        hoverProvider: true,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: [".", "<"],
        },
      },
      serverInfo: {
        name: "funscript-lsp",
        version: "0.1.0",
      },
    };
  }

  public onShutdownHandler(): null {
    this.isShutdown = true;
    return null;
  }

  public onExitHandler(): void {
    const exitCode = this.isShutdown ? 0 : 1;
    this.emit("exit", exitCode);
  }

  public onDidOpenHandler(params: DidOpenTextDocumentParams): void {
    if (params?.textDocument) {
      this.documents.set(params.textDocument.uri, params.textDocument);
      const diagnostics = this.validateSource(
        params.textDocument.text,
        params.textDocument.uri,
      );
      this.publishDiagnostics(
        params.textDocument.uri,
        params.textDocument.version,
        diagnostics,
      );
    }
  }

  public onDidChangeHandler(params: DidChangeTextDocumentParams): void {
    if (params?.textDocument && Array.isArray(params.contentChanges)) {
      const doc = this.documents.get(params.textDocument.uri);
      const lastChange =
        params.contentChanges[params.contentChanges.length - 1];
      const newText = lastChange ? lastChange.text : (doc?.text ?? "");
      const updatedVersion =
        params.textDocument.version ?? (doc ? doc.version + 1 : 1);
      const updatedDoc: TextDocumentItem = {
        uri: params.textDocument.uri,
        languageId: doc?.languageId ?? "funscript",
        version: updatedVersion,
        text: newText,
      };
      this.documents.set(params.textDocument.uri, updatedDoc);
      const diagnostics = this.validateSource(newText, params.textDocument.uri);
      this.publishDiagnostics(
        params.textDocument.uri,
        updatedVersion,
        diagnostics,
      );
    }
  }

  public onDidCloseHandler(params: DidCloseTextDocumentParams): void {
    if (params?.textDocument) {
      this.documents.delete(params.textDocument.uri);
      this.publishDiagnostics(params.textDocument.uri, undefined, []);
    }
  }

  public onFormattingHandler(
    params: DocumentFormattingParams,
  ): TextEdit[] | null {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc) {
      return null;
    }

    if (doc.text.trim().length === 0) {
      return [];
    }

    try {
      const indentSize =
        typeof params?.options?.tabSize === "number" &&
        params.options.tabSize > 0
          ? params.options.tabSize
          : undefined;
      const filename = uri ? new URL(uri).pathname : undefined;
      const formatted = format(doc.text, {
        ...(indentSize !== undefined ? { indentSize } : {}),
        ...(filename ? { filename } : {}),
      });

      const lines = doc.text.split("\n");
      const lastLine = Math.max(0, lines.length - 1);
      const lastChar = lines[lastLine].length;

      const edit: TextEdit = {
        range: {
          start: { line: 0, character: 0 },
          end: { line: lastLine, character: lastChar },
        },
        newText: formatted,
      };

      return [edit];
    } catch {
      return null;
    }
  }

  public onRangeFormattingHandler(
    params: DocumentRangeFormattingParams,
  ): TextEdit[] | null {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc) return null;

    // The formatter currently operates on complete syntax trees. Only accept a
    // range that covers the full document; partial edits could alter unrelated code.
    const lines = doc.text.split("\n");
    const lastLine = lines.length - 1;
    const end = params.range?.end;
    const start = params.range?.start;
    if (
      !start ||
      !end ||
      start.line !== 0 ||
      start.character !== 0 ||
      end.line < lastLine ||
      (end.line === lastLine && end.character < lines[lastLine].length)
    ) {
      return null;
    }
    return this.onFormattingHandler({
      textDocument: params.textDocument,
      options: params.options,
    });
  }

  public onDefinitionHandler(
    params: DefinitionParams,
  ): Location | Location[] | LocationLink[] | null {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc || !params?.position) {
      return null;
    }

    const clientSupportsLink = Boolean(
      this.clientCapabilities?.textDocument?.definition?.linkSupport,
    );

    return findDefinition(doc.text, uri, params.position, clientSupportsLink);
  }

  public onHoverHandler(params: HoverParams): Hover | null {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc || !params?.position) {
      return null;
    }

    return findHover(doc.text, uri, params.position);
  }

  public onCompletionHandler(params: CompletionParams): CompletionItem[] {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc || !params?.position) return [];
    return complete(doc.text, uri, params.position, this.getDocuments());
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
      const result = this.onInitializeHandler(req.params as InitializeParams);
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
      const result = this.onShutdownHandler();
      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    }

    if (req.method === "textDocument/formatting") {
      const result = this.onFormattingHandler(
        req.params as DocumentFormattingParams,
      );
      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    }

    if (req.method === "textDocument/definition") {
      const result = this.onDefinitionHandler(req.params as DefinitionParams);
      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    }

    if (req.method === "textDocument/hover") {
      const result = this.onHoverHandler(req.params as HoverParams);
      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    }

    if (req.method === "textDocument/completion") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: this.onCompletionHandler(req.params as CompletionParams),
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
      this.onExitHandler();
      return;
    }

    if (notif.method === "textDocument/didOpen") {
      this.onDidOpenHandler(notif.params as DidOpenTextDocumentParams);
      return;
    }

    if (notif.method === "textDocument/didChange") {
      this.onDidChangeHandler(notif.params as DidChangeTextDocumentParams);
      return;
    }

    if (notif.method === "textDocument/didClose") {
      this.onDidCloseHandler(notif.params as DidCloseTextDocumentParams);
      return;
    }
  }

  public validateSource(source: string, uri: string): Diagnostic[] {
    return validateFunScript(source, uri);
  }

  public publishDiagnostics(
    uri: string,
    version: number | undefined,
    diagnostics: Diagnostic[],
  ): void {
    const params: PublishDiagnosticsParams = {
      uri,
      ...(version !== undefined ? { version } : {}),
      diagnostics,
    };

    this.emit("diagnostics", params);

    if (this.connection) {
      this.connection.sendDiagnostics(params);
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

  public getConnection(): Connection | null {
    return this.connection;
  }

  public dispose(): void {
    if (this.connection) {
      this.connection.dispose();
      this.connection = null;
    }
    this.documents.clear();
    this.removeAllListeners();
  }
}
