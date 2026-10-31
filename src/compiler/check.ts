import ts from "typescript";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
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
  /** Stable FunScript diagnostic identifier; TypeScript codes remain available in `code`. */
  diagnosticCode?: string;
  explanation?: string;
  suggestedAction?: string;
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

export interface CachedSourceFile {
  mtime?: number;
  sourceFile: ts.SourceFile;
}

export interface TypeCheckCache {
  oldProgram?: ts.Program;
  sourceFiles: Map<string, CachedSourceFile>;
  compiledFiles: Map<
    string,
    {
      source: string;
      compiled: {
        typescript: string;
        map?: any;
        ast?: any;
      };
    }
  >;
  clear(): void;
}

export function createTypeCheckCache(): TypeCheckCache {
  return {
    sourceFiles: new Map(),
    compiledFiles: new Map(),
    clear() {
      this.oldProgram = undefined;
      this.sourceFiles.clear();
      this.compiledFiles.clear();
    },
  };
}

export interface CheckOptions {
  compilerOptions?: ts.CompilerOptions;
  cwd?: string;
  highlightCode?: boolean;
  cache?: TypeCheckCache;
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

export function mapDiagnosticLocation(
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
      const isExhaustiveError =
        tsSpanText.includes(".exhaustive") ||
        (typeof diagnostic.messageText === "string"
          ? diagnostic.messageText.includes("NonExhaustiveError")
          : diagnostic.messageText
          ? JSON.stringify(diagnostic.messageText).includes("NonExhaustiveError")
          : false);
      spanLen = isExhaustiveError ? 5 : tsSpanText.length;
      const idMatch = tsSpanText.match(/^[A-Za-z0-9_$]+/);
      const isId = isExhaustiveError || Boolean(idMatch && idMatch[0] === tsSpanText);
      const searchToken = isExhaustiveError ? "match" : (isId ? idMatch![0] : tsSpanText);

      // Whole declarations can map to one source position. If an identifier is
      // preserved exactly and occurs equally often on both sides, its occurrence
      // number disambiguates repeated diagnostics within that declaration.
      if (isId && !isExhaustiveError) {
        const pattern = new RegExp(`\\b${escapeRegExp(searchToken)}\\b`, "g");
        const generated = [...tsCode.matchAll(pattern)];
        const original = [...funSource.matchAll(pattern)];
        const ordinal = generated.findIndex((match) => match.index === diagnostic.start);
        if (generated.length > 1 && generated.length === original.length && ordinal >= 0) {
          const offset = original[ordinal].index!;
          const prefix = funSource.slice(0, offset);
          const line = prefix.split("\n").length;
          const column = offset - prefix.lastIndexOf("\n");
          return { file: funPath, line, column, endLine: line, endColumn: column + searchToken.length };
        }
      }

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
          ast?: any;
        }
      >();

      const earlyDiagnostics: TypeCheckDiagnostic[] = [];
      const virtualSources = new Map(Object.entries(virtualInputFiles).map(([file, content]) => [path.resolve(cwd, file), content]));

      const cache = options?.cache;

      for (const [filePath, source] of Object.entries(virtualInputFiles)) {
        const fullFunPath = path.isAbsolute(filePath) ? path.normalize(filePath) : path.normalize(path.join(cwd, filePath));
        const ext = fullFunPath.endsWith(".funx") ? ".tsx" : ".ts";
        const virtualTsPath = fullFunPath.replace(/\.(fun|funx)$/, ext);

        let compiled;
        const cachedCompiled = cache?.compiledFiles.get(fullFunPath);
        if (cachedCompiled && cachedCompiled.source === source) {
          compiled = cachedCompiled.compiled;
        } else {
          try {
            compiled = await Effect.runPromise(compileString(source, filePath, { sourcemap: true, sourcePath: fullFunPath, virtualSources }));
            if (cache) {
              cache.compiledFiles.set(fullFunPath, { source, compiled });
            }
          } catch (err: any) {
            if (cache) {
              cache.compiledFiles.delete(fullFunPath);
              cache.sourceFiles.delete(virtualTsPath);
            }
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
            const formatted = `${frame ? `${header}\n${frame}` : header}\n  help: Fix the syntax at the highlighted location and run \`funscript check\` again.`;

            earlyDiagnostics.push({
              file: filePath,
              line: errLine,
              column: errCol,
              message: compErr.message,
              diagnosticCode: "FS_SYNTAX",
              explanation: "The FunScript source could not be parsed.",
              suggestedAction: "Fix the syntax at the highlighted location and run \`funscript check\` again.",
              category: "error",
              code: "SYNTAX",
              frame,
              formatted,
            });
            continue;
          }
        }

        virtualTsFiles.set(virtualTsPath, compiled.typescript);
        virtualSourceMap.set(virtualTsPath, {
          funPath: filePath,
          funSource: source,
          traceMap: new TraceMap(compiled.map!.toString()),
          tsCode: compiled.typescript,
          ast: compiled.ast,
        });
      }

      if (cache) {
        for (const key of cache.compiledFiles.keys()) {
          if (!(key in virtualInputFiles) && !virtualSources.has(key)) {
            cache.compiledFiles.delete(key);
            const ext = key.endsWith(".funx") ? ".tsx" : ".ts";
            cache.sourceFiles.delete(key.replace(/\.(fun|funx)$/, ext));
          }
        }
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

      const resetPath = path.join(cwd, "__funscript_ts_reset__.d.ts");
      virtualTsFiles.set(
        resetPath,
        '/// <reference types="@total-typescript/ts-reset" />\n' +
        'interface JSON { parse(text: string, reviver?: (this: any, key: string, value: any) => any): unknown; }\n' +
        'interface Body { json(): Promise<unknown>; }\n',
      );

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
          const norm = path.normalize(fileName);

          if (content !== undefined) {
            if (cache) {
              const cached = cache.sourceFiles.get(norm);
              if (cached && cached.sourceFile.text === content) {
                return cached.sourceFile;
              }
              const sf = ts.createSourceFile(fileName, content, languageVersion, true);
              cache.sourceFiles.set(norm, { sourceFile: sf });
              return sf;
            }
            return ts.createSourceFile(fileName, content, languageVersion, true);
          }

          if (cache) {
            const cached = cache.sourceFiles.get(norm);
            if (cached) {
              if (norm.includes("node_modules") || norm.includes("typescript/lib") || norm.includes("@types")) {
                return cached.sourceFile;
              }
              try {
                const stat = syncFs.statSync(fileName);
                if (cached.mtime !== undefined && stat.mtimeMs === cached.mtime) {
                  return cached.sourceFile;
                }
              } catch {
                // fall through on stat failure
              }
            }

            const sf = defaultHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
            if (sf) {
              let mtime: number | undefined;
              if (!norm.includes("node_modules") && !norm.includes("typescript/lib")) {
                try {
                  mtime = syncFs.statSync(fileName).mtimeMs;
                } catch {
                  // ignore
                }
              }
              cache.sourceFiles.set(norm, { sourceFile: sf, mtime });
            }
            return sf;
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
          oldProgram: cache?.oldProgram,
        });

        if (cache) {
          cache.oldProgram = program;
        }

        const preEmit = ts.getPreEmitDiagnostics(program);

        for (const diag of preEmit) {
          if (!diag.file) continue;
          const normFile = path.normalize(diag.file.fileName);
          const meta = virtualSourceMap.get(normFile);
          if (!meta) continue;

          const loc = mapDiagnosticLocation(diag, meta.funPath, meta.funSource, meta.traceMap, meta.tsCode);
          const category = mapCategory(diag.category);
          let message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
          let code: number | string = diag.code;

          if (
            (diag.code === 2488 || diag.code === 2461) &&
            /Promise/.test(message)
          ) {
            code = "PROMISE_BIND";
            message = "Cannot bind raw Promise in effect block. External asynchronous calls must be explicitly lifted using the 'js' operator (e.g. '<- js <expr>') or wrapped in 'Effect.tryPromise'.";
          }

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

          const codePrefix = typeof code === "number" ? `TS${code}` : code;
          const header = `${loc.file}:${loc.line}:${loc.column} - ${category} ${codePrefix}: ${message}`;
          const formatted = frame ? `${header}\n${frame}` : header;

          tsDiagnostics.push({
            file: loc.file,
            line: loc.line,
            column: loc.column,
            endLine: loc.endLine,
            endColumn: loc.endColumn,
            message,
            diagnosticCode: `TS${code}`,
            explanation: `TypeScript reported diagnostic TS${code} for the generated source.`,
            category,
            code,
            frame,
            formatted,
          });
        }

        const getFunScriptUnannotatedBindings = (ast?: any): Set<string> => {
          const names = new Set<string>();
          const walk = (node: any) => {
            if (!node || typeof node !== "object") return;
            if (node.kind === "TsEscapeDeclaration" || node.kind === "TsEscapeExpression") return;
            if (node.kind === "BindingDeclaration" && node.id?.name) {
              if (!node.typeAnnotation) {
                names.add(node.id.name);
              }
            }
            for (const key of Object.keys(node)) {
              if (key === "span") continue;
              const child = node[key];
              if (Array.isArray(child)) {
                for (const c of child) walk(c);
              } else if (child && typeof child === "object") {
                walk(child);
              }
            }
          };
          walk(ast);
          return names;
        };

        const getFunScriptMemberAccesses = (ast?: any): Set<string> => {
          const names = new Set<string>();
          const walk = (node: any) => {
            if (!node || typeof node !== "object") return;
            if (node.kind === "TsEscapeDeclaration" || node.kind === "TsEscapeExpression") return;
            if (node.kind === "MemberExpression" && node.property?.name) {
              names.add(node.property.name);
            }
            for (const key of Object.keys(node)) {
              if (key === "span") continue;
              const child = node[key];
              if (Array.isArray(child)) {
                for (const c of child) walk(c);
              } else if (child && typeof child === "object") {
                walk(child);
              }
            }
          };
          walk(ast);
          return names;
        };

        const checker = program.getTypeChecker();
        for (const [normFile, meta] of virtualSourceMap) {
          const sf = program.getSourceFile(normFile);
          if (!sf) continue;

          const unannotatedBindings = getFunScriptUnannotatedBindings(meta.ast);
          const memberAccesses = getFunScriptMemberAccesses(meta.ast);

          const addCustomDiag = (
            targetNode: ts.Node,
            code: string,
            customMsg: string,
          ) => {
            const loc = mapDiagnosticLocation(
              {
                file: sf,
                start: targetNode.getStart(sf),
                length: targetNode.getWidth(sf),
                messageText: customMsg,
                category: ts.DiagnosticCategory.Error,
                code: 9999,
              } as ts.Diagnostic,
              meta.funPath,
              meta.funSource,
              meta.traceMap,
              meta.tsCode,
            );
            let frame: string | undefined;
            try {
              frame = codeFrameColumns(
                meta.funSource,
                {
                  start: { line: loc.line, column: loc.column },
                  end: loc.endColumn ? { line: loc.line, column: loc.endColumn } : undefined,
                },
                {
                  message: customMsg,
                  highlightCode: options?.highlightCode ?? false,
                },
              );
            } catch {
              frame = undefined;
            }
            const header = `${loc.file}:${loc.line}:${loc.column} - error ${code}: ${customMsg}`;
            tsDiagnostics.push({
              file: loc.file,
              line: loc.line,
              column: loc.column,
              endLine: loc.endLine,
              endColumn: loc.endColumn,
              message: customMsg,
              category: "error",
              code,
              frame,
              formatted: frame ? `${header}\n${frame}` : header,
            });
          };

          const visit = (node: ts.Node): void => {
            if (ts.isYieldExpression(node) && node.asteriskToken && node.expression) {
              const isJsInterop =
                ts.isCallExpression(node.expression) &&
                ts.isIdentifier(node.expression.expression) &&
                node.expression.expression.text === "__funscriptJs";

              if (!isJsInterop) {
                const type = checker.getTypeAtLocation(node.expression);
                const isAny = Boolean(type.flags & ts.TypeFlags.Any);
                if (isAny) {
                  addCustomDiag(
                    node.expression,
                    "ANY_BIND",
                    "Cannot bind untyped 'any' expression in effect block. External asynchronous calls must be explicitly lifted using the 'js' operator (e.g. '<- js <expr>') or validated with a schema.",
                  );
                }
              }
            } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !node.type) {
              if (unannotatedBindings.has(node.name.text)) {
                const type = checker.getTypeAtLocation(node.name);
                if (Boolean(type.flags & ts.TypeFlags.Any)) {
                  addCustomDiag(
                    node.name,
                    "ANY_BINDING",
                    `Cannot infer untyped 'any' for binding '${node.name.text}'. Values from untyped foreign JavaScript or TypeScript must be explicitly typed as 'Unknown' (e.g. '${node.name.text}: Unknown = ...') or validated with a schema.`,
                  );
                }
              }
            } else if (ts.isPropertyAccessExpression(node)) {
              if (memberAccesses.has(node.name.text)) {
                const targetType = checker.getTypeAtLocation(node.expression);
                if (Boolean(targetType.flags & ts.TypeFlags.Any)) {
                  if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) {
                    addCustomDiag(
                      node.name,
                      "ANY_ACCESS",
                      `Cannot access property '${node.name.text}' on untyped 'any' value. External values must be typed as 'Unknown' and validated with a schema before accessing properties.`,
                    );
                  }
                }
              }
            } else if (ts.isElementAccessExpression(node)) {
              const targetType = checker.getTypeAtLocation(node.expression);
              if (Boolean(targetType.flags & ts.TypeFlags.Any)) {
                if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) {
                  addCustomDiag(
                    node.argumentExpression,
                    "ANY_ACCESS",
                    "Cannot access index on untyped 'any' value. External values must be typed as 'Unknown' and validated with a schema.",
                  );
                }
              }
            } else if (ts.isCallExpression(node)) {
              const calleeType = checker.getTypeAtLocation(node.expression);
              if (Boolean(calleeType.flags & ts.TypeFlags.Any)) {
                if (!ts.isPropertyAccessExpression(node.expression) && !ts.isElementAccessExpression(node.expression)) {
                  addCustomDiag(
                    node.expression,
                    "ANY_CALL",
                    "Cannot call untyped 'any' value as a function. External functions must have typed signatures or be adapted with an explicit signature.",
                  );
                }
              }
            }
            ts.forEachChild(node, visit);
          };
          visit(sf);
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
