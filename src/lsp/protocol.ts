/**
 * Language Server Protocol (LSP) 3.17 base types and JSON-RPC definitions
 * for FunScript language server.
 */

export interface Position {
  line: number; // 0-based
  character: number; // 0-based
}

export interface Range {
  start: Position;
  end: Position;
}

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export interface Diagnostic {
  range: Range;
  severity?: DiagnosticSeverity;
  code?: number | string;
  source?: string;
  message: string;
}

export interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

export interface TextDocumentIdentifier {
  uri: string;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentContentChangeEvent {
  range?: Range;
  text: string;
}

export interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

export interface DidChangeTextDocumentParams {
  textDocument: VersionedTextDocumentIdentifier;
  contentChanges: TextDocumentContentChangeEvent[];
}

export interface DidCloseTextDocumentParams {
  textDocument: TextDocumentIdentifier;
}

export interface PublishDiagnosticsParams {
  uri: string;
  version?: number;
  diagnostics: Diagnostic[];
}

export enum TextDocumentSyncKind {
  None = 0,
  Full = 1,
  Incremental = 2,
}

export interface ServerCapabilities {
  textDocumentSync?:
    | TextDocumentSyncKind
    | {
        openClose?: boolean;
        change?: TextDocumentSyncKind;
      };
  [key: string]: any;
}

export interface InitializeParams {
  processId?: number | null;
  rootUri?: string | null;
  capabilities?: any;
  initializationOptions?: any;
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
  serverInfo?: {
    name: string;
    version?: string;
  };
}

export interface RequestMessage {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: any;
}

export interface ResponseMessage {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: any;
  error?: ResponseError;
}

export interface NotificationMessage {
  jsonrpc: "2.0";
  method: string;
  params?: any;
}

export type Message = RequestMessage | ResponseMessage | NotificationMessage;

export interface ResponseError {
  code: number;
  message: string;
  data?: any;
}

export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ServerNotInitialized: -32002,
  UnknownErrorCode: -32001,
} as const;
