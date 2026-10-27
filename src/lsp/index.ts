import type { Readable, Writable } from "node:stream";
import { FunScriptLspServer } from "./server.js";

export * from "./protocol.js";
export * from "./transport.js";
export * from "./server.js";

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
