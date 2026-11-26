import { parentPort } from "node:worker_threads";
import type {
  CodeActionParams,
  TextDocumentItem,
} from "vscode-languageserver/node";
import { FunScriptLspServer } from "./server.js";

const server = new FunScriptLspServer();
parentPort?.on(
  "message",
  ({
    id,
    doc,
    params,
  }: {
    id: number;
    doc: TextDocumentItem;
    params: CodeActionParams;
  }) => {
    try {
      server.setRenameWorkerDocuments([doc]);
      parentPort?.postMessage({
        id,
        result: server.onCodeActionHandler(params),
      });
    } catch (error) {
      console.error("code-action-worker failed:", error);
      parentPort?.postMessage({ id, result: [] });
    }
  },
);
