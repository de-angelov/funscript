import type { Readable, Writable } from "node:stream";
import { FunScriptLspServer } from "./server.js";

export * from "./server.js";
export * from "./docs.js";
export * from "./definition.js";
export * from "./hover.js";

export {
  DiagnosticSeverity,
  ErrorCodes,
  TextDocumentSyncKind,
  MarkupKind,
  StreamMessageReader,
  StreamMessageWriter,
  type Message,
  type RequestMessage,
  type ResponseMessage,
  type NotificationMessage,
  type Diagnostic,
  type TextDocumentItem,
  type TextDocumentPositionParams,
  type TextDocumentIdentifier,
  type PublishDiagnosticsParams,
  type DocumentFormattingParams,
  type TextEdit,
  type Location,
  type LocationLink,
  type DefinitionParams,
  type Hover,
  type HoverParams,
  type Position,
  type Range,
} from "vscode-languageserver/node";

export interface StartLspServerOptions {
  reader?: Readable;
  writer?: Writable;
}

export function startLspServer(options: StartLspServerOptions = {}): FunScriptLspServer {
  const server = new FunScriptLspServer();
  const reader = options.reader ?? process.stdin;
  const writer = options.writer ?? process.stdout;
  server.listen(reader, writer);
  return server;
}
