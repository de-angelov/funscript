import ts from "typescript";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { Effect } from "effect";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { codeFrameColumns } from "@babel/code-frame";
import { compileString, CompilerError } from "../compiler.js";

export type DiagnosticCategory = "error" | "warning" | "suggestion" | "message";

export interface DiagnosticLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}

export interface TypeCheckDiagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  category: DiagnosticCategory;
  code?: number | string;
  frame?: string;
  formatted: string;
}

export interface TypeCheckResult {
  success: boolean;
  diagnostics: TypeCheckDiagnostic[];
  errorCount: number;
  warningCount: number;
  formattedOutput: string;
}

export interface CheckOptions {
  compilerOptions?: ts.CompilerOptions;
  cwd?: string;
  highlightCode?: boolean;
}

export const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  esModuleInterop: true,
  skipLibCheck: true,
  allowSyntheticDefaultImports: true,
  jsx: ts.JsxEmit.Preserve,
};

function getCompilerOptions(cwd: string, userOptions?: ts.CompilerOptions): ts.CompilerOptions {
  let baseOptions = { ...DEFAULT_COMPILER_OPTIONS };
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!configFile.error && configFile.config) {
      const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
      baseOptions = { ...baseOptions, ...parsed.options };
    }
  }
  return {
    ...baseOptions,
    noEmit: true,
    ...userOptions,
  };
}

function mapCategory(category: ts.DiagnosticCategory): DiagnosticCategory {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    case ts.DiagnosticCategory.Message:
      return "message";
    default:
      return "error";
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findTokenInLine(
  line: string,
  token: string,
  isIdentifier: boolean,
): { index: number; length: number } | null {
  if (isIdentifier) {
    const regex = new RegExp(`\\b${escapeRegExp(token)}\\b`);
    const match = regex.exec(line);
    if (match) return { index: match.index, length: match[0].length };
    return null;
  }
  const idx = line.indexOf(token);
  if (idx !== -1) return { index: idx, length: token.length };
  return null;
}

function mapDiagnosticLocation(
  diagnostic: ts.Diagnostic,
  funPath: string,
  funSource: string,
  traceMap: TraceMap,
  tsCode: string,
): DiagnosticLocation {
  if (!diagnostic.file || diagnostic.start === undefined) {
    return { file: funPath, line: 1, column: 1 };
  }

  const { line: tsLine0, character: tsCol0 } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const tsLine = tsLine0 + 1;
  const tsCol = tsCol0;

  const orig = originalPositionFor(traceMap, { line: tsLine, column: tsCol });
  const funLines = funSource.split("\n");

  let origLine = orig && orig.line !== null ? orig.line : tsLine;
  let lineText = funLines[origLine - 1] ?? "";

  let origCol = orig && orig.column !== null && orig.column > 0 ? orig.column + 1 : 1;
  let spanLen = 1;

  if (diagnostic.length !== undefined && diagnostic.length > 0) {
    const tsSpanText = tsCode.slice(diagnostic.start, diagnostic.start + diagnostic.length).trim();
    if (tsSpanText.length > 0) {
      spanLen = tsSpanText.length;
      const idMatch = tsSpanText.match(/^[A-Za-z0-9_$]+/);
      const isId = Boolean(idMatch && idMatch[0] === tsSpanText);
      const searchToken = isId ? idMatch![0] : tsSpanText;

      // 1. Try finding on current origLine
      let match = findTokenInLine(lineText, searchToken, isId);

      // 2. If not found on origLine, search lines forward from origLine then backward
      if (!match) {
        for (let i = origLine - 1; i < funLines.length; i++) {
          const m = findTokenInLine(funLines[i], searchToken, isId);
          if (m) {
            origLine = i + 1;
            lineText = funLines[i];
            match = m;
            break;
          }
        }
        if (!match) {
          for (let i = 0; i < origLine - 1; i++) {
            const m = findTokenInLine(funLines[i], searchToken, isId);
            if (m) {
              origLine = i + 1;
              lineText = funLines[i];
              match = m;
              break;
            }
          }
        }
      }

      if (match) {
        origCol = match.index + 1;
        spanLen = match.length;
      }
    }
  }

  if (origCol === 1 && lineText.length > 0) {
    const firstNonSpace = lineText.search(/\S/);
    if (firstNonSpace > 0 && (!orig || orig.column === null || orig.column === 0)) {
      origCol = firstNonSpace + 1;
    }
  }

  return {
    file: funPath,
    line: origLine,
    column: origCol,
    endLine: origLine,
    endColumn: origCol + spanLen,
  };
}

export function formatDiagnostics(diagnostics: TypeCheckDiagnostic[]): string {
  if (diagnostics.length === 0) return "";

  const blocks = diagnostics.map((d) => d.formatted);
  const errorCount = diagnostics.filter((d) => d.category === "error").length;
  const warningCount = diagnostics.filter((d) => d.category === "warning").length;

  const summaryParts: string[] = [];
  if (errorCount > 0) {
    summaryParts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
  }
  if (warningCount > 0) {
    summaryParts.push(`${warningCount} warning${warningCount === 1 ? "" : "s"}`);
  }

  const summary = summaryParts.length > 0 ? `\nFound ${summaryParts.join(" and ")}.` : "";
  return blocks.join("\n\n") + summary;
}

export const typeCheckVirtualFiles = (
  virtualInputFiles: Record<string, string>,
  options?: CheckOptions,
): Effect.Effect<TypeCheckResult, Error> =>
  Effect.tryPromise({
    try: async () => {
      const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
      const compilerOptions = getCompilerOptions(cwd, options?.compilerOptions);

      const virtualTsFiles = new Map<string, string>();
      const virtualSourceMap = new Map<
        string,
        {
          funPath: string;
          funSource: string;
          traceMap: TraceMap;
          tsCode: string;
        }
      >();

      const earlyDiagnostics: TypeCheckDiagnostic[] = [];

      for (const [filePath, source] of Object.entries(virtualInputFiles)) {
        const fullFunPath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(cwd, filePath));
        const ext = fullFunPath.endsWith(".funx") ? ".tsx" : ".ts";
        const virtualTsPath = fullFunPath.replace(/\.(fun|funx)$/, ext);

        let compiled;
        try {
          compiled = await Effect.runPromise(compileString(source, filePath, { sourcemap: true }));
        } catch (err: any) {
          const compErr = err instanceof CompilerError ? err : new CompilerError(err.message, err);
          let errLine = 1;
          let errCol = 1;
          if ("span" in compErr.error && compErr.error.span?.start) {
            errLine = compErr.error.span.start.line;
            errCol = compErr.error.span.start.column;
          }

          let frame: string | undefined;
          try {
            frame = codeFrameColumns(
              source,
              { start: { line: errLine, column: errCol } },
              { message: compErr.message, highlightCode: options?.highlightCode ?? false },
            );
          } catch {
            frame = undefined;
          }

          const header = `${filePath}:${errLine}:${errCol} - error: ${compErr.message}`;
          const formatted = frame ? `${header}\n${frame}` : header;

          earlyDiagnostics.push({
            file: filePath,
            line: errLine,
            column: errCol,
            message: compErr.message,
            category: "error",
            code: "SYNTAX",
            frame,
            formatted,
          });
          continue;
        }

        virtualTsFiles.set(virtualTsPath, compiled.typescript);
        virtualSourceMap.set(virtualTsPath, {
          funPath: filePath,
          funSource: source,
          traceMap: new TraceMap(compiled.map!.toString()),
          tsCode: compiled.typescript,
        });
      }

      const hasTsx = Array.from(virtualTsFiles.keys()).some((fileName) => fileName.endsWith(".tsx"));
      const hasJsxIntrinsicTypes = Array.from(virtualTsFiles.values()).some((source) =>
        /namespace\s+JSX[\s\S]*?IntrinsicElements/.test(source),
      );
      if (hasTsx && !hasJsxIntrinsicTypes) {
        const jsxTypesPath = path.join(cwd, "__funscript_jsx_intrinsics__.d.ts");
        virtualTsFiles.set(
          jsxTypesPath,
          "declare namespace JSX { interface IntrinsicElements { [element: string]: any } }",
        );
      }

      const defaultHost = ts.createCompilerHost(compilerOptions);

      const resolveVirtualContent = (fileName: string): string | undefined => {
        const norm = path.normalize(fileName);
        let content = virtualTsFiles.get(norm);
        if (content !== undefined) return content;
        if (virtualTsFiles.has(norm + ".ts")) return virtualTsFiles.get(norm + ".ts");
        if (virtualTsFiles.has(norm + ".tsx")) return virtualTsFiles.get(norm + ".tsx");
        if (norm.endsWith(".js") && virtualTsFiles.has(norm.slice(0, -3) + ".ts")) {
          return virtualTsFiles.get(norm.slice(0, -3) + ".ts");
        }
        if (norm.endsWith(".jsx") && virtualTsFiles.has(norm.slice(0, -4) + ".tsx")) {
          return virtualTsFiles.get(norm.slice(0, -4) + ".tsx");
        }
        return undefined;
      };

      const host: ts.CompilerHost = {
        ...defaultHost,
        getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
          const content = resolveVirtualContent(fileName);
          if (content !== undefined) {
            return ts.createSourceFile(fileName, content, languageVersion, true);
          }
          return defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
        },
        fileExists: (fileName) => {
          if (resolveVirtualContent(fileName) !== undefined) return true;
          return defaultHost.fileExists(fileName);
        },
        readFile: (fileName) => {
          const content = resolveVirtualContent(fileName);
          if (content !== undefined) return content;
          return defaultHost.readFile(fileName);
        },
        writeFile: () => {},
      };

      const tsDiagnostics: TypeCheckDiagnostic[] = [...earlyDiagnostics];

      if (virtualTsFiles.size > 0) {
        const rootNames = Array.from(virtualTsFiles.keys());
        const program = ts.createProgram({
          rootNames,
          options: compilerOptions,
          host,
        });

        const preEmit = ts.getPreEmitDiagnostics(program);

        for (const diag of preEmit) {
          if (!diag.file) continue;
          const normFile = path.normalize(diag.file.fileName);
          const meta = virtualSourceMap.get(normFile);
          if (!meta) continue;

          const loc = mapDiagnosticLocation(diag, meta.funPath, meta.funSource, meta.traceMap, meta.tsCode);
          const category = mapCategory(diag.category);
          const message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
          const code = diag.code;

          let frame: string | undefined;
          try {
            frame = codeFrameColumns(
              meta.funSource,
              {
                start: { line: loc.line, column: loc.column },
                end: loc.endColumn ? { line: loc.line, column: loc.endColumn } : undefined,
              },
              {
                message,
                highlightCode: options?.highlightCode ?? false,
              },
            );
          } catch {
            frame = undefined;
          }

          const header = `${loc.file}:${loc.line}:${loc.column} - ${category} TS${code}: ${message}`;
          const formatted = frame ? `${header}\n${frame}` : header;

          tsDiagnostics.push({
            file: loc.file,
            line: loc.line,
            column: loc.column,
            endLine: loc.endLine,
            endColumn: loc.endColumn,
            message,
            category,
            code,
            frame,
            formatted,
          });
        }
      }

      const errorCount = tsDiagnostics.filter((d) => d.category === "error").length;
      const warningCount = tsDiagnostics.filter((d) => d.category === "warning").length;
      const success = errorCount === 0;
      const formattedOutput = formatDiagnostics(tsDiagnostics);

      return {
        success,
        diagnostics: tsDiagnostics,
        errorCount,
        warningCount,
        formattedOutput,
      };
    },
    catch: (error: any) => new Error(`Type-checking failed: ${error.message}`),
  });

export const typeCheckSource = (
  source: string,
  filename: string = "source.fun",
  options?: CheckOptions,
): Effect.Effect<TypeCheckResult, Error> =>
  typeCheckVirtualFiles({ [filename]: source }, options);

export const typeCheckFiles = (
  filePaths: string[],
  options?: CheckOptions,
): Effect.Effect<TypeCheckResult, Error> =>
  Effect.gen(function* () {
    const cwd = options?.cwd ? path.resolve(options.cwd) : process.cwd();
    const virtualFiles: Record<string, string> = {};

    for (const filePath of filePaths) {
      const fullPath = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(fullPath, "utf-8"),
        catch: (err: any) => new Error(`Failed to read file '${filePath}': ${err.message}`),
      });
      virtualFiles[filePath] = content;
    }

    return yield* typeCheckVirtualFiles(virtualFiles, options);
  });
