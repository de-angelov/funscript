import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  existsSync,
  readdirSync,
  readFileSync,
  watch as watchDirectory,
  type FSWatcher,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  createConnection,
  type Connection,
  StreamMessageReader,
  StreamMessageWriter,
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
  type DocumentSymbolParams,
  type WorkspaceSymbolParams,
  type ReferenceParams,
  type PrepareRenameParams,
  type RenameParams,
  type WorkspaceEdit,
  type CodeActionParams,
  type CodeAction,
  type DocumentSymbol,
  type SymbolInformation,
  type PrepareRenameResult,
  type InlayHint,
  type InlayHintParams,
  SymbolKind,
} from "vscode-languageserver/node";
import { format } from "../formatter/index.js";
import {
  loadFormatConfigForFile,
  loadProjectConfigForFile,
} from "../compiler/project-config.js";
import { convertPipelineStyle } from "../tooling/pipeline-style.js";
import { findHoverAsync } from "./hover.js";
import { findInlayHints } from "./inlay-hints.js";
import { complete } from "./completion.js";
import {
  documentSymbols,
  workspaceSymbols,
  references,
  prepareRename,
  rename,
  findWorkspaceDefinition,
} from "./navigation.js";
import { InteropRenameSession, renameInterop } from "./interop-rename.js";
import { ParsedDocumentCache } from "./parsed-documents.js";
import { validateFunScript, validateSyntax } from "./validation.js";
import { FUNSCRIPT_VERSION } from "../version.js";
export { toDiagnostic, validateFunScript } from "./validation.js";

type InteropDocumentNotification =
  | { kind: "upsert"; textDocument: TextDocumentItem }
  | { kind: "close"; uri: string };

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
  private interopDocuments: Map<string, TextDocumentItem> = new Map();
  private isInitialized = false;
  private isShutdown = false;
  private clientCapabilities: any = null;
  private workspaceRoots: string[] = [];
  private readonly projectConfigWatchers = new Map<string, FSWatcher>();
  private readonly interopRenameSession = new InteropRenameSession();
  private readonly parsedDocuments = new ParsedDocumentCache();
  private readonly pipelineCompletionInputs = new Map<
    string,
    { source: string; version: number; inputs: Array<[number, string]> }
  >();
  private codeActionWorker?: Worker;
  private codeActionWorkerId = 0;
  private readonly pendingCodeActions = new Map<
    number,
    {
      version: number;
      text: string;
      uri: string;
      resolve: (result: CodeAction[]) => void;
    }
  >();
  private renameWorker?: Worker;
  private renameWorkerId = 0;
  private documentRevision = 0;
  private readonly pendingRenames = new Map<
    number,
    { revision: number; resolve: (result: any) => void }
  >();
  private connection: Connection | null = null;
  private diagnosticTimer: ReturnType<typeof setTimeout> | undefined;
  private diagnosticRevision = 0;
  private diagnosticWorker?: Worker;
  private diagnosticBusy = false;
  private queuedDiagnostics?: {
    revision: number;
    documents: TextDocumentItem[];
  };
  private readonly syntaxErrors = new Set<string>();

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
    connection.onNotification("funscript/interopDocument", (params) =>
      this.onInteropDocument(params as InteropDocumentNotification),
    );

    connection.onCodeAction((params) => this.codeActionInWorker(params));
    connection.onDocumentFormatting((params) =>
      this.onFormattingHandler(params),
    );
    connection.onDocumentRangeFormatting((params) =>
      this.onRangeFormattingHandler(params),
    );
    connection.onDefinition((params) => this.onDefinitionHandler(params));
    connection.onHover((params) => this.onHoverHandler(params));
    connection.onCompletion((params) => this.onCompletionHandler(params));
    connection.onDocumentSymbol((params) =>
      this.onDocumentSymbolHandler(params),
    );
    connection.onWorkspaceSymbol((params) =>
      this.onWorkspaceSymbolHandler(params),
    );
    connection.onReferences((params) => this.onReferencesHandler(params));
    connection.onPrepareRename((params) =>
      this.renameInWorker("prepare", params),
    );
    connection.onRenameRequest((params) =>
      this.renameInWorker("rename", params),
    );
    connection.onRequest("textDocument/inlayHint", (params) =>
      this.onInlayHintHandler(params as InlayHintParams),
    );
  }

  public onInitializeHandler(params: InitializeParams): InitializeResult {
    this.isInitialized = true;
    this.clientCapabilities = params?.capabilities;
    this.stopRenameWorker();
    this.stopCodeActionWorker();
    this.stopDiagnosticWorker();
    this.documentRevision++;
    this.interopDocuments.clear();
    this.interopRenameSession.dispose();
    this.parsedDocuments.clear();
    this.pipelineCompletionInputs.clear();
    const roots =
      params?.workspaceFolders?.map((folder) => folder.uri) ??
      (params?.rootUri ? [params.rootUri] : []);
    this.workspaceRoots = roots.flatMap((uri) => {
      try {
        return [resolve(fileURLToPath(uri))];
      } catch {
        return [];
      }
    });
    this.syncProjectConfigWatchers();
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Full,
        documentFormattingProvider: true,
        documentRangeFormattingProvider: true,
        definitionProvider: true,
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        hoverProvider: true,
        completionProvider: {
          resolveProvider: false,
          triggerCharacters: [".", "<"],
        },
        codeActionProvider: true,
        inlayHintProvider: { resolveProvider: false },
      },
      serverInfo: {
        name: "funscript-lsp",
        version: FUNSCRIPT_VERSION,
      },
    };
  }

  public onShutdownHandler(): null {
    this.isShutdown = true;
    this.stopRenameWorker();
    this.stopCodeActionWorker();
    this.stopDiagnosticWorker();
    this.stopProjectConfigWatchers();
    return null;
  }

  public onExitHandler(): void {
    const exitCode = this.isShutdown ? 0 : 1;
    this.emit("exit", exitCode);
  }

  public onDidOpenHandler(params: DidOpenTextDocumentParams): void {
    if (params?.textDocument) {
      this.documentRevision++;
      this.cancelCodeActionsFor(params.textDocument.uri);
      this.documents.set(params.textDocument.uri, params.textDocument);
      this.syncProjectConfigWatchers();
      const diagnostics = validateSyntax(
        params.textDocument.text,
        params.textDocument.uri,
      ).diagnostics;
      if (diagnostics.length) this.syntaxErrors.add(params.textDocument.uri);
      else this.syntaxErrors.delete(params.textDocument.uri);
      this.publishDiagnostics(
        params.textDocument.uri,
        params.textDocument.version,
        diagnostics,
      );
      this.scheduleTypeDiagnostics();
    }
  }

  public onDidChangeHandler(params: DidChangeTextDocumentParams): void {
    if (params?.textDocument && Array.isArray(params.contentChanges)) {
      this.documentRevision++;
      this.cancelCodeActionsFor(params.textDocument.uri);
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
      this.syncProjectConfigWatchers();
      const diagnostics = validateSyntax(
        newText,
        params.textDocument.uri,
      ).diagnostics;
      if (diagnostics.length) this.syntaxErrors.add(updatedDoc.uri);
      else this.syntaxErrors.delete(updatedDoc.uri);
      this.publishDiagnostics(
        params.textDocument.uri,
        updatedVersion,
        diagnostics,
      );
      this.scheduleTypeDiagnostics();
    }
  }

  public onDidCloseHandler(params: DidCloseTextDocumentParams): void {
    if (params?.textDocument) {
      this.documentRevision++;
      this.cancelCodeActionsFor(params.textDocument.uri);
      this.documents.delete(params.textDocument.uri);
      this.pipelineCompletionInputs.delete(params.textDocument.uri);
      this.syncProjectConfigWatchers();
      this.syntaxErrors.delete(params.textDocument.uri);
      this.scheduleTypeDiagnostics();
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
      const projectFormat = filename
        ? loadFormatConfigForFile(filename)
        : undefined;
      const formatted = format(doc.text, {
        ...(indentSize !== undefined ? { indentSize } : {}),
        ...projectFormat,
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

  private codeActionInWorker(params: CodeActionParams): Promise<CodeAction[]> {
    const doc = this.documents.get(params.textDocument.uri);
    if (!doc) return Promise.resolve([]);
    if (!this.codeActionWorker) {
      try {
        const worker = new Worker(
          new URL("./code-action-worker.js", import.meta.url),
          { execArgv: [] },
        );
        worker.unref();
        this.codeActionWorker = worker;
        worker.on(
          "message",
          (message: { id: number; result: CodeAction[] }) => {
            const pending = this.pendingCodeActions.get(message.id);
            if (!pending) return;
            this.pendingCodeActions.delete(message.id);
            const current = this.documents.get(pending.uri);
            pending.resolve(
              current?.version === pending.version &&
                current.text === pending.text
                ? message.result
                : [],
            );
          },
        );
        const failed = () => {
          if (this.codeActionWorker !== worker) return;
          this.codeActionWorker = undefined;
          for (const pending of this.pendingCodeActions.values())
            pending.resolve([]);
          this.pendingCodeActions.clear();
        };
        worker.on("error", failed);
        worker.on("exit", failed);
      } catch {
        return Promise.resolve([]);
      }
    }
    const id = ++this.codeActionWorkerId;
    return new Promise((resolve) => {
      this.pendingCodeActions.set(id, {
        version: doc.version,
        text: doc.text,
        uri: doc.uri,
        resolve,
      });
      try {
        this.codeActionWorker!.postMessage({ id, doc, params });
      } catch {
        this.pendingCodeActions.delete(id);
        resolve([]);
      }
    });
  }

  private cancelCodeActionsFor(uri: string): void {
    if (
      [...this.pendingCodeActions.values()].some(
        (pending) => pending.uri === uri,
      )
    )
      this.stopCodeActionWorker();
  }

  private stopCodeActionWorker(): void {
    const worker = this.codeActionWorker;
    this.codeActionWorker = undefined;
    for (const pending of this.pendingCodeActions.values()) pending.resolve([]);
    this.pendingCodeActions.clear();
    if (worker) void worker.terminate();
  }

  public onCodeActionHandler(params: CodeActionParams): CodeAction[] {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc || !doc.text.trim()) return [];
    const actions: CodeAction[] = [];
    const lines = doc.text.split("\n");
    const wholeRange = {
      start: { line: 0, character: 0 },
      end: { line: lines.length - 1, character: lines.at(-1)!.length },
    };
    const offset = (position: { line: number; character: number }) =>
      lines
        .slice(0, position.line)
        .reduce((n, line) => n + line.length + 1, 0) + position.character;
    try {
      const filename = uri ? fileURLToPath(uri) : undefined;
      const formatted = format(doc.text, {
        ...(filename ? loadFormatConfigForFile(filename) : {}),
        filename,
      });
      if (formatted !== doc.text)
        actions.push({
          title: "Format document",
          kind: "source",
          edit: {
            changes: { [uri]: [{ range: wholeRange, newText: formatted }] },
          },
        });
    } catch {
      /* Invalid source has no formatting action. */
    }
    if (!doc.text.includes("|>")) return actions;
    const filename = uri.startsWith("file:") ? fileURLToPath(uri) : uri;
    for (const style of ["bare", "qualified"] as const) {
      try {
        const result = convertPipelineStyle(doc.text, filename, style, {
          start: offset(params.range.start),
          end: offset(params.range.end),
        });
        if (result.changed)
          actions.push({
            title:
              style === "bare"
                ? "Use bare pipeline stages"
                : "Qualify pipeline stages",
            kind: "refactor.rewrite",
            edit: {
              changes: { [uri]: [{ range: wholeRange, newText: result.text }] },
            },
          });
      } catch {
        /* Incomplete or ambiguous source cannot safely be rewritten. */
      }
    }
    return actions;
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

    return findWorkspaceDefinition(
      doc.text,
      uri,
      params.position,
      this.workspaceSnapshot()?.fun ?? this.getDocuments(),
      clientSupportsLink,
    );
  }

  public async onHoverHandler(params: HoverParams): Promise<Hover | null> {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc || !params?.position) {
      return null;
    }

    return findHoverAsync(doc.text, uri, params.position);
  }

  public onInlayHintHandler(params: InlayHintParams): InlayHint[] {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc) return [];
    return findInlayHints(doc.text, uri, params?.range);
  }

  public onCompletionHandler(params: CompletionParams): CompletionItem[] {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc || !params?.position) return [];
    return complete(
      doc.text,
      uri,
      params.position,
      this.getDocuments(),
      this.pipelineCompletionInputs.get(uri),
    );
  }

  public onDocumentSymbolHandler(
    params: DocumentSymbolParams,
  ): DocumentSymbol[] {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    return doc ? documentSymbols(doc.text, uri) : [];
  }

  public onWorkspaceSymbolHandler(
    params: WorkspaceSymbolParams,
  ): SymbolInformation[] {
    return workspaceSymbols(this.getDocuments(), params?.query ?? "");
  }

  public onReferencesHandler(params: ReferenceParams): Location[] {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    return doc
      ? references(
          doc.text,
          uri,
          params.position,
          this.workspaceSnapshot()?.fun ?? this.getDocuments(),
          params.context.includeDeclaration,
        )
      : [];
  }

  public onPrepareRenameHandler(
    params: PrepareRenameParams,
  ): PrepareRenameResult | null {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    const snapshot = this.workspaceSnapshot();
    if (this.isInitialized && (!this.workspaceRoots.length || !snapshot))
      return null;
    if (!doc) return null;
    const selected = prepareRename(
      doc.text,
      uri,
      params.position,
      snapshot?.fun ?? this.getDocuments(),
      this.parsedDocuments,
    );
    if (!selected || !("placeholder" in selected)) return null;
    return this.onRenameHandler({
      textDocument: params.textDocument,
      position: params.position,
      newName: selected.placeholder,
    })
      ? selected
      : null;
  }

  /** Synchronize an immutable editor snapshot inside the dedicated rename worker. */
  public setRenameWorkerDocuments(docs: TextDocumentItem[]): void {
    this.documents = new Map(docs.map((doc) => [doc.uri, doc]));
  }

  private onInteropDocument(params: InteropDocumentNotification): void {
    if (
      params?.kind === "upsert" &&
      params.textDocument &&
      /\.[cm]?[jt]sx?$/.test(params.textDocument.uri)
    ) {
      const current = this.interopDocuments.get(params.textDocument.uri);
      if (
        current &&
        current.version === params.textDocument.version &&
        current.text === params.textDocument.text &&
        current.languageId === params.textDocument.languageId
      )
        return;
      this.documentRevision++;
      this.interopDocuments.set(params.textDocument.uri, params.textDocument);
    } else if (
      params?.kind === "close" &&
      this.interopDocuments.delete(params.uri)
    ) {
      this.documentRevision++;
    }
  }

  private renameInWorker(
    method: "prepare" | "rename",
    params: PrepareRenameParams | RenameParams,
  ): Promise<any> {
    if (!this.renameWorker) {
      try {
        const worker = new Worker(
          new URL("./rename-worker.js", import.meta.url),
          { execArgv: [] },
        );
        worker.unref();
        this.renameWorker = worker;
        worker.on("message", (message: { id: number; result: unknown }) => {
          const pending = this.pendingRenames.get(message.id);
          if (!pending) return;
          this.pendingRenames.delete(message.id);
          pending.resolve(
            pending.revision === this.documentRevision ? message.result : null,
          );
        });
        const failed = () => {
          if (this.renameWorker !== worker) return;
          this.renameWorker = undefined;
          for (const pending of this.pendingRenames.values())
            pending.resolve(null);
          this.pendingRenames.clear();
        };
        worker.on("error", failed);
        worker.on("exit", failed);
      } catch {
        return Promise.resolve(null);
      }
    }
    const id = ++this.renameWorkerId;
    return new Promise((resolve) => {
      this.pendingRenames.set(id, { revision: this.documentRevision, resolve });
      try {
        this.renameWorker!.postMessage({
          id,
          method,
          params,
          roots: this.workspaceRoots.map((root) => pathToFileURL(root).href),
          documents: [
            ...this.documents.values(),
            ...this.interopDocuments.values(),
          ],
        });
      } catch {
        this.pendingRenames.delete(id);
        resolve(null);
      }
    });
  }

  private stopRenameWorker(): void {
    const worker = this.renameWorker;
    this.renameWorker = undefined;
    for (const pending of this.pendingRenames.values()) pending.resolve(null);
    this.pendingRenames.clear();
    if (worker) void worker.terminate();
  }

  public onRenameHandler(params: RenameParams): WorkspaceEdit | null {
    const uri = params?.textDocument?.uri;
    const doc = uri ? this.documents.get(uri) : undefined;
    if (!doc) return null;
    if (this.isInitialized && !this.inWorkspace(uri)) return null;
    const snapshot = this.workspaceSnapshot();
    if (this.isInitialized && (!this.workspaceRoots.length || !snapshot))
      return null;
    const docs = snapshot?.fun ?? this.getDocuments();
    this.parsedDocuments.retain(docs);
    const selected = prepareRename(
      doc.text,
      uri,
      params.position,
      docs,
      this.parsedDocuments,
    );
    if (!selected || !("placeholder" in selected)) return null;
    const name = selected.placeholder;
    const identifier = new RegExp(
      `(^|[^\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$]|$)`,
    );
    for (const file of docs) {
      if (!identifier.test(file.text)) continue;
      if (!this.parsedDocuments.get(file).ast) return null;
    }
    let edit = rename(
      doc.text,
      uri,
      params.position,
      params.newName,
      docs,
      this.parsedDocuments,
    );
    if (
      this.isInitialized &&
      edit?.changes &&
      Object.keys(edit.changes).some((target) => !this.inWorkspace(target))
    )
      return null;
    if (edit?.changes)
      for (const file of docs) {
        if (!edit.changes[file.uri]) continue;
        const ast = this.parsedDocuments.get(file).ast;
        if (!ast) return null;
        for (const item of ast.body) {
          if (
            item.kind !== "ExportDeclaration" ||
            item.declaration.kind !== "SchemaDeclaration"
          )
            continue;
          const id = item.declaration.id;
          if (
            !edit.changes[file.uri].some(
              (change) =>
                change.range.start.line === id.span.start.line - 1 &&
                change.range.start.character === id.span.start.column - 1,
            )
          )
            continue;
          const companion = new RegExp(
            `\\b${id.name}(?:FromUnknown|DecodeChecked|Checked)\\b`,
          );
          if (
            [...docs, ...(snapshot?.interop ?? [])].some((candidate) =>
              companion.test(candidate.text),
            )
          )
            return null;
        }
      }
    if (edit && snapshot) {
      try {
        edit = renameInterop(
          docs,
          snapshot.interop,
          edit,
          name,
          params.newName,
          this.workspaceRoots,
          this.interopRenameSession,
          this.parsedDocuments,
        );
      } catch {
        return null;
      }
    }
    if (
      this.isInitialized &&
      edit?.changes &&
      Object.keys(edit.changes).some((target) => !this.inWorkspace(target))
    )
      return null;
    return edit;
  }

  private inWorkspace(uri: string): boolean {
    let path: string;
    try {
      path = fileURLToPath(uri);
    } catch {
      return false;
    }
    return this.workspaceRoots.some((root) => {
      const child = relative(root, path);
      return (
        child !== ".." &&
        !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(child)
      );
    });
  }

  /** Read a fresh workspace view; unsaved open buffers always win over disk. */
  private workspaceSnapshot(): {
    fun: TextDocumentItem[];
    interop: TextDocumentItem[];
  } | null {
    if (!this.workspaceRoots.length) return null;
    const files = new Map<string, TextDocumentItem>();
    const visited = new Set<string>();
    const excluded = new Set([
      "node_modules",
      ".git",
      ".funscript",
      "dist",
      "build",
      "coverage",
    ]);
    const walk = (directory: string): void => {
      if (visited.has(directory)) return;
      visited.add(directory);
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink())
          throw new Error("Workspace contains an unindexed symbolic link");
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (
          !entry.isFile() ||
          !/\.(?:fun|funs|funx|[cm]?[jt]sx?)$/.test(entry.name)
        )
          continue;
        const uri = pathToFileURL(path).href;
        files.set(uri, {
          uri,
          languageId: "",
          version: 0,
          text: readFileSync(path, "utf8"),
        });
      }
    };
    try {
      for (const root of this.workspaceRoots) walk(root);
    } catch {
      return null;
    }
    for (const doc of [
      ...this.documents.values(),
      ...this.interopDocuments.values(),
    ])
      files.set(doc.uri, doc);
    const all = [...files.values()];
    return {
      fun: all.filter((doc) => /\.(?:fun|funs|funx)$/.test(doc.uri)),
      interop: all.filter((doc) => /\.[cm]?[jt]sx?$/.test(doc.uri)),
    };
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

  private async handleRequest(req: RequestMessage): Promise<ResponseMessage> {
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

    if (req.method === "textDocument/codeAction") {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: await this.codeActionInWorker(req.params as CodeActionParams),
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
      const result = await this.onHoverHandler(req.params as HoverParams);
      return {
        jsonrpc: "2.0",
        id: req.id,
        result,
      };
    }

    if (req.method === "textDocument/inlayHint") {
      const result = this.onInlayHintHandler(req.params as InlayHintParams);
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

    if (req.method === "textDocument/documentSymbol")
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: this.onDocumentSymbolHandler(
          req.params as DocumentSymbolParams,
        ),
      };
    if (req.method === "workspace/symbol")
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: this.onWorkspaceSymbolHandler(
          req.params as WorkspaceSymbolParams,
        ),
      };
    if (req.method === "textDocument/references")
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: this.onReferencesHandler(req.params as ReferenceParams),
      };
    if (req.method === "textDocument/prepareRename")
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: await this.renameInWorker(
          "prepare",
          req.params as PrepareRenameParams,
        ),
      };
    if (req.method === "textDocument/rename")
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: await this.renameInWorker("rename", req.params as RenameParams),
      };

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
    if (notif.method === "funscript/interopDocument") {
      this.onInteropDocument(notif.params as InteropDocumentNotification);
      return;
    }
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

  private scheduleTypeDiagnostics(): void {
    const revision = ++this.diagnosticRevision;
    if (this.diagnosticTimer) clearTimeout(this.diagnosticTimer);
    this.diagnosticTimer = setTimeout(() => {
      this.diagnosticTimer = undefined;
      const request = { revision, documents: this.getDocuments() };
      if (!request.documents.length && !this.diagnosticWorker) return;
      if (this.diagnosticBusy) this.queuedDiagnostics = request;
      else this.dispatchDiagnostics(request);
    }, 250);
    this.diagnosticTimer.unref();
  }

  private dispatchDiagnostics(request: {
    revision: number;
    documents: TextDocumentItem[];
  }): void {
    if (!this.diagnosticWorker) {
      try {
        let workerUrl = new URL("./diagnostics-worker.js", import.meta.url);
        // Source-level tests and development load the compiled worker from dist.
        if (!existsSync(fileURLToPath(workerUrl)))
          workerUrl = new URL(
            "../../dist/lsp/diagnostics-worker.js",
            import.meta.url,
          );
        const worker = new Worker(workerUrl, { execArgv: [] });
        worker.unref();
        this.diagnosticWorker = worker;
        worker.on(
          "message",
          (response: {
            revision: number;
            complete?: boolean;
            diagnostics?: PublishDiagnosticsParams[];
            pipelineInputs?: Array<{
              uri: string;
              version: number;
              source: string;
              inputs: Array<[number, string]>;
            }>;
            error?: string;
          }) => {
            if (this.diagnosticWorker !== worker) return;
            if (response.error)
              console.error("FunScript type checking failed:", response.error);
            if (
              !response.error &&
              response.revision === this.diagnosticRevision
            ) {
              for (const result of response.diagnostics ?? [])
                if (!this.syntaxErrors.has(result.uri))
                  this.publishDiagnostics(
                    result.uri,
                    result.version,
                    result.diagnostics,
                  );
              for (const result of response.pipelineInputs ?? [])
                this.pipelineCompletionInputs.set(result.uri, {
                  source: result.source,
                  version: result.version,
                  inputs: result.inputs,
                });
            }
            if (response.complete === false) return;
            this.diagnosticBusy = false;
            const queued = this.queuedDiagnostics;
            this.queuedDiagnostics = undefined;
            if (queued && queued.revision === this.diagnosticRevision)
              this.dispatchDiagnostics(queued);
          },
        );
        const failed = (error?: Error) => {
          if (this.diagnosticWorker !== worker) return;
          this.diagnosticWorker = undefined;
          this.diagnosticBusy = false;
          this.queuedDiagnostics = undefined;
          if (error)
            console.error("FunScript diagnostic worker failed:", error.message);
        };
        worker.on("error", failed);
        worker.on("exit", () => failed());
      } catch (error) {
        console.error("FunScript diagnostic worker failed:", error);
        return;
      }
    }
    this.diagnosticBusy = true;
    try {
      this.diagnosticWorker.postMessage(request);
    } catch (error) {
      this.diagnosticBusy = false;
      console.error("FunScript diagnostic worker failed:", error);
    }
  }

  private stopDiagnosticWorker(): void {
    if (this.diagnosticTimer) clearTimeout(this.diagnosticTimer);
    this.diagnosticTimer = undefined;
    this.diagnosticRevision++;
    this.diagnosticBusy = false;
    this.queuedDiagnostics = undefined;
    const worker = this.diagnosticWorker;
    this.diagnosticWorker = undefined;
    if (worker) void worker.terminate();
  }

  private syncProjectConfigWatchers(): void {
    const directories = new Set(this.workspaceRoots);
    for (const document of this.documents.values()) {
      try {
        const filename = fileURLToPath(document.uri);
        const workspaceRoot = this.workspaceRoots
          .filter((root) => {
            const rel = relative(root, filename);
            return (
              rel === "" ||
              (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
            );
          })
          .sort((a, b) => b.length - a.length)[0];
        const cwd = resolve(process.cwd());
        const cwdRelative = relative(cwd, filename);
        const watchRoot =
          workspaceRoot ??
          (cwdRelative === "" ||
          (cwdRelative !== ".." &&
            !cwdRelative.startsWith(`..${sep}`) &&
            !isAbsolute(cwdRelative))
            ? cwd
            : dirname(filename));
        let directory = dirname(filename);
        for (;;) {
          directories.add(directory);
          if (directory === watchRoot || dirname(directory) === directory)
            break;
          directory = dirname(directory);
        }
        const policyRoot = loadProjectConfigForFile(filename).root;
        if (existsSync(join(policyRoot, "funscript.config.fun")))
          directories.add(policyRoot);
      } catch {
        /* Non-file documents do not have project config files. */
      }
    }

    for (const [directory, watcher] of this.projectConfigWatchers) {
      if (directories.has(directory)) continue;
      watcher.close();
      this.projectConfigWatchers.delete(directory);
    }
    for (const directory of directories) {
      if (this.projectConfigWatchers.has(directory) || !existsSync(directory))
        continue;
      try {
        const watcher = watchDirectory(directory, (_event, filename) => {
          if (filename?.toString() === "funscript.config.fun")
            this.scheduleTypeDiagnostics();
        });
        watcher.on("error", () => {
          watcher.close();
          this.projectConfigWatchers.delete(directory);
        });
        this.projectConfigWatchers.set(directory, watcher);
      } catch {
        /* Some virtual or restricted workspaces cannot be watched. */
      }
    }
  }

  private stopProjectConfigWatchers(): void {
    for (const watcher of this.projectConfigWatchers.values()) watcher.close();
    this.projectConfigWatchers.clear();
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
      void this.connection.sendDiagnostics(params);
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
    this.stopDiagnosticWorker();
    this.stopProjectConfigWatchers();
    this.stopCodeActionWorker();
    this.interopRenameSession.dispose();
    this.parsedDocuments.clear();
    this.stopRenameWorker();
    if (this.connection) {
      this.connection.dispose();
      this.connection = null;
    }
    this.documents.clear();
    this.pipelineCompletionInputs.clear();
    this.syntaxErrors.clear();
    this.interopDocuments.clear();
    this.removeAllListeners();
  }
}
