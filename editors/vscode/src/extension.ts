import * as vscode from "vscode";
import * as cp from "node:child_process";
import * as path from "node:path";
import {
  LanguageClient,
  type LanguageClientOptions,
  type ServerOptions,
  Trace,
  State,
} from "vscode-languageclient/node";

let client: LanguageClient | undefined;
let statusBarItem: vscode.StatusBarItem | undefined;
let outputChannel: vscode.LogOutputChannel | undefined;
let traceOutputChannel: vscode.LogOutputChannel | undefined;

export enum ServerStatus {
  Starting = "starting",
  Ready = "ready",
  Stopped = "stopped",
  Error = "error",
}

export function getClient(): LanguageClient | undefined {
  return client;
}

export function getStatusBarItem(): vscode.StatusBarItem | undefined {
  return statusBarItem;
}

export function getOutputChannel(): vscode.LogOutputChannel | undefined {
  return outputChannel;
}

export function updateStatusBar(status: ServerStatus, tooltip?: string): void {
  if (!statusBarItem) {
    return;
  }
  switch (status) {
    case ServerStatus.Starting:
      statusBarItem.text = "$(sync~spin) FunScript";
      statusBarItem.tooltip = tooltip ?? "FunScript Language Server is initializing...";
      statusBarItem.command = "funscript.restartServer";
      break;
    case ServerStatus.Ready:
      statusBarItem.text = "$(check) FunScript";
      statusBarItem.tooltip = tooltip ?? "FunScript Language Server is active (click to restart)";
      statusBarItem.command = "funscript.restartServer";
      break;
    case ServerStatus.Stopped:
      statusBarItem.text = "$(circle-slash) FunScript";
      statusBarItem.tooltip = tooltip ?? "FunScript Language Server is stopped (click to restart)";
      statusBarItem.command = "funscript.restartServer";
      break;
    case ServerStatus.Error:
      statusBarItem.text = "$(error) FunScript";
      statusBarItem.tooltip = tooltip ?? "FunScript Language Server encountered an error (click to restart)";
      statusBarItem.command = "funscript.restartServer";
      break;
  }
  statusBarItem.show();
}

export function buildServerOptions(serverPath = "funscript"): ServerOptions {
  return {
    command: serverPath,
    args: ["lsp", "--stdio"],
  };
}

export function buildClientOptions(
  outChannel?: vscode.LogOutputChannel,
  traceChannel?: vscode.LogOutputChannel
): LanguageClientOptions {
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
    outputChannel: outChannel,
    traceOutputChannel: traceChannel,
  };
}

export async function checkCliAvailability(serverPath: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const proc = cp.spawn(serverPath, ["version"], { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

function isFunScriptDocument(doc: vscode.TextDocument): boolean {
  if (doc.languageId === "funscript" || doc.languageId === "funscriptx") {
    return true;
  }
  return /\.funx?$/.test(doc.fileName);
}

function handleOpenSettings(selection: string | undefined): void {
  if (selection === "Open Settings") {
    vscode.commands.executeCommand("workbench.action.openSettings", "funscript");
  }
}

export async function restartServer(): Promise<void> {
  const config = vscode.workspace.getConfiguration("funscript");
  const serverPath = config.get<string>("serverPath") || "funscript";

  updateStatusBar(ServerStatus.Starting, `Restarting FunScript server using '${serverPath}'...`);

  const available = await checkCliAvailability(serverPath);
  if (!available) {
    updateStatusBar(ServerStatus.Error, `FunScript CLI not found at '${serverPath}'`);
    outputChannel?.appendLine(`[Error] FunScript CLI is unavailable at '${serverPath}'.`);
    void vscode.window
      .showErrorMessage(
        `FunScript CLI is unavailable at '${serverPath}'. Please check your 'funscript.serverPath' setting or ensure 'funscript' is in PATH.`,
        "Open Settings"
      )
      .then(handleOpenSettings);
    return;
  }

  if (client) {
    try {
      await client.stop();
    } catch (err: any) {
      outputChannel?.appendLine(`[Warn] Error stopping existing server: ${err?.message || err}`);
    }
    client = undefined;
  }

  const serverOptions = buildServerOptions(serverPath);
  const clientOptions = buildClientOptions(outputChannel, traceOutputChannel);

  client = new LanguageClient("funscriptLsp", "FunScript Language Server", serverOptions, clientOptions);

  client.onDidChangeState((e) => {
    if (e.newState === State.Running) {
      updateStatusBar(ServerStatus.Ready);
    } else if (e.newState === State.Stopped) {
      updateStatusBar(ServerStatus.Stopped);
    }
  });

  const traceSetting = config.get<string>("trace.server") || "off";
  try {
    await client.setTrace(Trace.fromString(traceSetting));
  } catch {
    // ignore trace configuration errors
  }

  try {
    await client.start();
    updateStatusBar(ServerStatus.Ready);
    vscode.window.showInformationMessage("FunScript Language Server restarted successfully.");
  } catch (error: any) {
    updateStatusBar(ServerStatus.Error, "Failed to start language server");
    outputChannel?.appendLine(`[Error] Failed to start FunScript language server: ${error?.message || error}`);
    void vscode.window
      .showErrorMessage(
        `Failed to start FunScript language server with command '${serverPath}'. Check 'funscript.serverPath' in settings.`,
        "Open Settings"
      )
      .then(handleOpenSettings);
  }
}

export async function checkCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isFunScriptDocument(editor.document)) {
    vscode.window.showWarningMessage("No active FunScript document to check.");
    return;
  }

  if (editor.document.isUntitled) {
    vscode.window.showWarningMessage("Please save the FunScript file to disk before checking.");
    return;
  }

  if (editor.document.isDirty) {
    await editor.document.save();
  }

  const config = vscode.workspace.getConfiguration("funscript");
  const serverPath = config.get<string>("serverPath") || "funscript";

  const available = await checkCliAvailability(serverPath);
  if (!available) {
    void vscode.window
      .showErrorMessage(
        `FunScript CLI is unavailable at '${serverPath}'. Cannot check file. Please ensure 'funscript' is installed or configure 'funscript.serverPath'.`,
        "Open Settings"
      )
      .then(handleOpenSettings);
    return;
  }

  const filePath = editor.document.fileName;
  cp.execFile(serverPath, ["check", filePath], (error, stdout, stderr) => {
    if (error) {
      const output = `${stdout || ""}\n${stderr || ""}`.trim();
      outputChannel?.appendLine(`[Check Failed] ${filePath}\n${output}`);
      outputChannel?.show(true);
      vscode.window.showErrorMessage(
        `FunScript check found errors in ${path.basename(filePath)}. See FunScript output channel for details.`
      );
    } else {
      vscode.window.showInformationMessage(`✓ ${path.basename(filePath)} checked successfully (0 errors).`);
    }
  });
}

export async function formatCurrentFile(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isFunScriptDocument(editor.document)) {
    vscode.window.showWarningMessage("No active FunScript document to format.");
    return;
  }

  const config = vscode.workspace.getConfiguration("funscript");
  const serverPath = config.get<string>("serverPath") || "funscript";

  const available = await checkCliAvailability(serverPath);
  if (!available) {
    void vscode.window
      .showErrorMessage(
        `FunScript CLI is unavailable at '${serverPath}'. Cannot format file. Please ensure 'funscript' is installed or configure 'funscript.serverPath'.`,
        "Open Settings"
      )
      .then(handleOpenSettings);
    return;
  }

  await vscode.commands.executeCommand("editor.action.formatDocument");
}

export async function openGeneratedTypeScript(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isFunScriptDocument(editor.document)) {
    vscode.window.showWarningMessage("No active FunScript document to emit TypeScript.");
    return;
  }

  if (editor.document.isUntitled) {
    vscode.window.showWarningMessage("Please save the FunScript file to disk before viewing generated TypeScript.");
    return;
  }

  if (editor.document.isDirty) {
    await editor.document.save();
  }

  const config = vscode.workspace.getConfiguration("funscript");
  const serverPath = config.get<string>("serverPath") || "funscript";

  const available = await checkCliAvailability(serverPath);
  if (!available) {
    void vscode.window
      .showErrorMessage(
        `FunScript CLI is unavailable at '${serverPath}'. Cannot generate TypeScript. Please ensure 'funscript' is installed or configure 'funscript.serverPath'.`,
        "Open Settings"
      )
      .then(handleOpenSettings);
    return;
  }

  const filePath = editor.document.fileName;
  cp.execFile(serverPath, ["emit", filePath], async (error, stdout, stderr) => {
    if (error) {
      const output = `${stdout || ""}\n${stderr || ""}`.trim();
      outputChannel?.appendLine(`[Emit Failed] ${filePath}\n${output}`);
      outputChannel?.show(true);
      vscode.window.showErrorMessage(
        `Failed to generate TypeScript for ${path.basename(filePath)}. See FunScript output channel.`
      );
      return;
    }

    const isFunx = filePath.endsWith(".funx");
    const doc = await vscode.workspace.openTextDocument({
      language: isFunx ? "typescriptreact" : "typescript",
      content: stdout,
    });
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside });
  });
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("FunScript", { log: true });
  traceOutputChannel = vscode.window.createOutputChannel("FunScript Language Server Trace", { log: true });
  context.subscriptions.push(outputChannel, traceOutputChannel);

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.name = "FunScript Language Server";
  context.subscriptions.push(statusBarItem);

  context.subscriptions.push(
    vscode.commands.registerCommand("funscript.checkFile", checkCurrentFile),
    vscode.commands.registerCommand("funscript.formatFile", formatCurrentFile),
    vscode.commands.registerCommand("funscript.restartServer", restartServer),
    vscode.commands.registerCommand("funscript.openGeneratedTs", openGeneratedTypeScript)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (event.affectsConfiguration("funscript.serverPath")) {
        const answer = await vscode.window.showInformationMessage(
          "FunScript server path setting changed. Restart language server?",
          "Restart",
          "Later"
        );
        if (answer === "Restart") {
          await restartServer();
        }
      } else if (event.affectsConfiguration("funscript.trace.server")) {
        const config = vscode.workspace.getConfiguration("funscript");
        const traceSetting = config.get<string>("trace.server") || "off";
        if (client) {
          try {
            await client.setTrace(Trace.fromString(traceSetting));
          } catch {
            // ignore
          }
        }
      }
    })
  );

  const config = vscode.workspace.getConfiguration("funscript");
  const serverPath = config.get<string>("serverPath") || "funscript";

  updateStatusBar(ServerStatus.Starting);

  const serverOptions = buildServerOptions(serverPath);
  const clientOptions = buildClientOptions(outputChannel, traceOutputChannel);

  client = new LanguageClient("funscriptLsp", "FunScript Language Server", serverOptions, clientOptions);

  client.onDidChangeState((e) => {
    if (e.newState === State.Running) {
      updateStatusBar(ServerStatus.Ready);
    } else if (e.newState === State.Stopped) {
      updateStatusBar(ServerStatus.Stopped);
    }
  });

  const traceSetting = config.get<string>("trace.server") || "off";
  try {
    void client.setTrace(Trace.fromString(traceSetting));
  } catch {
    // ignore trace configuration errors
  }

  client.start().then(
    () => {
      updateStatusBar(ServerStatus.Ready);
    },
    (error: any) => {
      updateStatusBar(ServerStatus.Error, "Language server failed to start");
      outputChannel?.appendLine(`[Error] Failed to start FunScript language server: ${error?.message || error}`);
      void vscode.window
        .showErrorMessage(
          `Failed to start FunScript language server with command '${serverPath}'. Check 'funscript.serverPath' in settings.`,
          "Open Settings"
        )
        .then(handleOpenSettings);
    }
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  const stopPromise = client.stop();
  client = undefined;
  return stopPromise;
}
