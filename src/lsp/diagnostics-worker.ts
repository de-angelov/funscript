import { parentPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { DiagnosticSeverity, type Diagnostic, type PublishDiagnosticsParams, type TextDocumentItem } from "vscode-languageserver/node";
import type { TypeCheckCache, TypeCheckResult } from "../compiler/check.js";
import { validateFunScript } from "./validation.js";

type Request = { revision: number; documents: TextDocumentItem[] };
let cache: TypeCheckCache | undefined;
let previousFiles = new Set<string>();

parentPort?.on("message", async (request: Request) => {
  try {
    const files: Record<string, string> = {};
    const filenames = new Map<string, string>();
    const semantic = new Map<string, Diagnostic[]>();
    for (const doc of request.documents) {
      const direct = validateFunScript(doc.text, doc.uri);
      semantic.set(doc.uri, direct);
      if (direct.length) parentPort?.postMessage({ revision: request.revision, complete: false, diagnostics: [{ uri: doc.uri, version: doc.version, diagnostics: direct }] });
      if (!doc.uri.startsWith("file:")) continue;
      try {
        const filename = fileURLToPath(doc.uri);
        files[filename] = doc.text;
        filenames.set(doc.uri, filename);
      } catch { /* Non-file documents still receive semantic diagnostics. */ }
    }
    const currentFiles = new Set(Object.keys(files));
    for (const filename of previousFiles) if (!currentFiles.has(filename)) {
      cache?.compiledFiles.delete(filename);
      cache?.sourceFiles.delete(filename.replace(/\.(fun|funx)$/, filename.endsWith(".funx") ? ".tsx" : ".ts"));
    }
    previousFiles = currentFiles;
    let checked: TypeCheckResult | undefined;
    if (currentFiles.size) {
      const [{ Effect }, { createTypeCheckCache, typeCheckVirtualFiles }] = await Promise.all([import("effect"), import("../compiler/check.js")]);
      cache ??= createTypeCheckCache();
      checked = await Effect.runPromise(typeCheckVirtualFiles(files, { cache }));
    }
    const diagnostics: PublishDiagnosticsParams[] = request.documents.flatMap(doc => {
      const direct = semantic.get(doc.uri) ?? [];
      const filename = filenames.get(doc.uri);
      if (direct.length || !filename) return [];
      const mapped: Diagnostic[] = (checked?.diagnostics ?? []).filter(item => item.file === filename).map(item => ({
        range: {
          start: { line: Math.max(0, item.line - 1), character: Math.max(0, item.column - 1) },
          end: { line: Math.max(0, (item.endLine ?? item.line) - 1), character: Math.max(0, (item.endColumn ?? item.column + 1) - 1) },
        },
        severity: item.category === "error" ? DiagnosticSeverity.Error : item.category === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Information,
        source: "funscript",
        code: item.code,
        message: item.message,
      }));
      return [{ uri: doc.uri, version: doc.version, diagnostics: mapped }];
    });
    parentPort?.postMessage({ revision: request.revision, diagnostics });
  } catch (error) {
    parentPort?.postMessage({ revision: request.revision, error: error instanceof Error ? error.message : String(error) });
  }
});
