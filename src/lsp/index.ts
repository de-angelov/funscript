import type { Readable, Writable } from "node:stream";
import { FunScriptLspServer } from "./server.js";

export * from "./definition.js";
export * from "./docs.js";
export * from "./hover.js";
export * from "./imports.js";
export * from "./inlay-hints.js";
export * from "./match-arms.js";
export * from "./server.js";

export {
  DiagnosticSeverity,
  ErrorCodes,
  InlayHintKind,
  MarkupKind,
  StreamMessageReader,
  StreamMessageWriter,
  TextDocumentSyncKind,
  type DefinitionParams,
  type Diagnostic,
  type DocumentFormattingParams,
  type Hover,
  type HoverParams,
  type InlayHint,
  type InlayHintParams,
  type Location,
  type LocationLink,
  type Message,
  type NotificationMessage,
  type Position,
  type PublishDiagnosticsParams,
  type Range,
  type RequestMessage,
  type ResponseMessage,
  type TextDocumentIdentifier,
  type TextDocumentItem,
  type TextDocumentPositionParams,
  type TextEdit,
} from "vscode-languageserver/node";

export interface StartLspServerOptions {
  reader?: Readable;
  writer?: Writable;
}

export function startLspServer(
  options: StartLspServerOptions = {},
): FunScriptLspServer {
  const server = new FunScriptLspServer();
  const reader = options.reader ?? process.stdin;
  const writer = options.writer ?? process.stdout;
  server.listen(reader, writer);
  return server;
}
