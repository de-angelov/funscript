/**
 * Language Server Protocol (LSP) types and values re-exported from official vscode-languageserver.
 */

export type {
  Position,
  Range,
  Diagnostic,
  TextDocumentItem,
  TextDocumentIdentifier,
  VersionedTextDocumentIdentifier,
  TextDocumentContentChangeEvent,
  DidOpenTextDocumentParams,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
  PublishDiagnosticsParams,
  ServerCapabilities,
  Location,
  LocationLink,
  TextDocumentPositionParams,
  DefinitionParams,
  Definition,
  TextEdit,
  FormattingOptions,
  DocumentFormattingParams,
  InitializeParams,
  InitializeResult,
  RequestMessage,
  ResponseMessage,
  NotificationMessage,
  Message,
} from "vscode-languageserver/node";

export {
  DiagnosticSeverity,
  TextDocumentSyncKind,
  ErrorCodes,
  ResponseError,
} from "vscode-languageserver/node";
