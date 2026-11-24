import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import {
  DiagnosticSeverity,
  type Diagnostic,
  type PublishDiagnosticsParams,
  type TextDocumentItem,
} from "vscode-languageserver/node";
import type { TypeCheckCache, TypeCheckResult } from "../compiler/check.js";
import { loadProjectConfigForFile } from "../compiler/project-config.js";
import { validateFunScript } from "./validation.js";

type Request = { revision: number; documents: TextDocumentItem[] };
const caches = new Map<string, TypeCheckCache>();
let previousFiles = new Set<string>();

parentPort?.on("message", async (request: Request) => {
  try {
    const groups = new Map<
      string,
      {
        files: Record<string, string>;
        config: ReturnType<typeof loadProjectConfigForFile>["config"];
      }
    >();
    const filenames = new Map<string, string>();
    const semantic = new Map<string, Diagnostic[]>();
    for (const doc of request.documents) {
      const direct = validateFunScript(doc.text, doc.uri);
      semantic.set(doc.uri, direct);
      if (direct.length)
        parentPort?.postMessage({
          revision: request.revision,
          complete: false,
          diagnostics: [
            { uri: doc.uri, version: doc.version, diagnostics: direct },
          ],
        });
      if (!doc.uri.startsWith("file:")) continue;
      try {
        const filename = fileURLToPath(doc.uri);
        const policy = loadProjectConfigForFile(filename);
        const group = groups.get(policy.root) ?? {
          files: {},
          config: policy.config,
        };
        group.files[filename] = doc.text;
        groups.set(policy.root, group);
        filenames.set(doc.uri, filename);
      } catch {
        /* Non-file documents still receive semantic diagnostics. */
      }
    }
    const currentFiles = new Set(
      [...groups.values()].flatMap((group) => Object.keys(group.files)),
    );
    for (const filename of previousFiles)
      if (!currentFiles.has(filename)) {
        for (const cache of caches.values()) {
          cache.compiledFiles.delete(filename);
          cache.sourceFiles.delete(
            filename.replace(
              /\.(fun|funx)$/,
              filename.endsWith(".funx") ? ".tsx" : ".ts",
            ),
          );
        }
      }
    previousFiles = currentFiles;
    const checkedDiagnostics = new Map<
      string,
      TypeCheckResult["diagnostics"]
    >();
    if (currentFiles.size) {
      const [{ Effect }, { createTypeCheckCache, typeCheckVirtualFiles }] =
        await Promise.all([import("effect"), import("../compiler/check.js")]);
      for (const [root, group] of groups) {
        let cache = caches.get(root);
        if (!cache) {
          cache = createTypeCheckCache();
          caches.set(root, cache);
        }
        const policy = group.config;
        const checked = await Effect.runPromise(
          typeCheckVirtualFiles(group.files, {
            cwd: root,
            cache,
            noTs: policy.noTs === true,
            noGlobalThis: policy.noGlobalThis === true,
            noOptional: policy.noOptional === true,
            barePipelines: policy.barePipelines === true,
            noDeepDestructure: policy.noDeepDestructure === true,
            maxDestructureDepth: policy.maxDestructureDepth,
            noTsPaths: Array.isArray(policy.noTs) ? policy.noTs : undefined,
            noGlobalThisPaths: Array.isArray(policy.noGlobalThis)
              ? policy.noGlobalThis
              : undefined,
            noOptionalPaths: Array.isArray(policy.noOptional)
              ? policy.noOptional
              : undefined,
            barePipelinesPaths: Array.isArray(policy.barePipelines)
              ? policy.barePipelines
              : undefined,
            noDeepDestructurePaths: Array.isArray(policy.noDeepDestructure)
              ? policy.noDeepDestructure
              : undefined,
            effectOnly: policy.effectOnly,
          }),
        );
        for (const filename of Object.keys(group.files))
          checkedDiagnostics.set(
            filename,
            checked.diagnostics.filter((item) => item.file === filename),
          );
      }
    }
    const diagnostics: PublishDiagnosticsParams[] = request.documents.flatMap(
      (doc) => {
        const direct = semantic.get(doc.uri) ?? [];
        const filename = filenames.get(doc.uri);
        if (direct.length || !filename) return [];
        const mapped: Diagnostic[] = (
          checkedDiagnostics.get(filename) ?? []
        ).map((item) => ({
          range: {
            start: {
              line: Math.max(0, item.line - 1),
              character: Math.max(0, item.column - 1),
            },
            end: {
              line: Math.max(0, (item.endLine ?? item.line) - 1),
              character: Math.max(0, (item.endColumn ?? item.column + 1) - 1),
            },
          },
          severity:
            item.category === "error"
              ? DiagnosticSeverity.Error
              : item.category === "warning"
                ? DiagnosticSeverity.Warning
                : DiagnosticSeverity.Information,
          source: "funscript",
          code: item.code,
          message: item.message,
        }));
        return [{ uri: doc.uri, version: doc.version, diagnostics: mapped }];
      },
    );
    const pipelineInputs = request.documents.flatMap((doc) => {
      const filename = filenames.get(doc.uri);
      if (!filename) return [];
      const root = loadProjectConfigForFile(filename).root;
      const compiled = caches.get(root)?.compiledFiles.get(filename)?.compiled;
      const inputs = compiled?.pipelineStageInputCompanions;
      return inputs
        ? [
            {
              uri: doc.uri,
              version: doc.version,
              source: doc.text,
              inputs: [...inputs],
            },
          ]
        : [];
    });
    parentPort?.postMessage({
      revision: request.revision,
      diagnostics,
      pipelineInputs,
    });
  } catch (error) {
    parentPort?.postMessage({
      revision: request.revision,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
