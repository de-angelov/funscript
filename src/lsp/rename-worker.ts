import { parentPort } from "node:worker_threads";
import type {
  PrepareRenameParams,
  RenameParams,
  TextDocumentItem,
} from "vscode-languageserver/node";
import { FunScriptLspServer } from "./server.js";

type Request = {
  id: number;
  roots: string[];
  documents: TextDocumentItem[];
  method: "prepare" | "rename";
  params: PrepareRenameParams | RenameParams;
};

const server = new FunScriptLspServer();
let initialized = false;
parentPort?.on("message", (request: Request) => {
  try {
    if (!initialized) {
      server.onInitializeHandler({
        processId: null,
        rootUri: null,
        workspaceFolders: request.roots.map((uri) => ({ uri, name: uri })),
        capabilities: {},
      });
      initialized = true;
    }
    server.setRenameWorkerDocuments(request.documents);
    const result =
      request.method === "prepare"
        ? server.onPrepareRenameHandler(request.params)
        : server.onRenameHandler(request.params as RenameParams);
    parentPort?.postMessage({ id: request.id, result });
  } catch {
    parentPort?.postMessage({ id: request.id, result: null });
  }
});
