import * as vscode from "vscode";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;

export function buildServerOptions(serverPath = "funscript"): ServerOptions {
  return {
    command: serverPath,
    args: ["lsp", "--stdio"],
  };
}

export function buildClientOptions(): LanguageClientOptions {
  return {
    documentSelector: [
      { scheme: "file", language: "funscript" },
      { scheme: "file", language: "funscriptx" },
      { scheme: "untitled", language: "funscript" },
      { scheme: "untitled", language: "funscriptx" },
    ],
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.{fun,funx}"),
    },
  };
}

export function activate(context: vscode.ExtensionContext): void {
  const config = vscode.workspace.getConfiguration("funscript");
  const serverPath = config.get<string>("serverPath") || "funscript";

  const serverOptions = buildServerOptions(serverPath);
  const clientOptions = buildClientOptions();

  client = new LanguageClient(
    "funscriptLsp",
    "FunScript Language Server",
    serverOptions,
    clientOptions
  );

  client.start();
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

export function getClient(): LanguageClient | undefined {
  return client;
}
