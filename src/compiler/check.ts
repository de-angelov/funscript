import { isEffectOnlyFile, isPathPolicyEnabled } from "./project-config.js";
import ts from "typescript";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as Effect from "effect/Effect";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { codeFrameColumns } from "@babel/code-frame";
import { compileString, CompilerError, type SourceMap } from "../compiler.js";
import { incrementalDependencyKeys } from "./incremental-dependencies.js";
import { ImportedSchemaError } from "./imported-schemas.js";
import { toErrorMessage } from "../errors.js";
import type { ASTNode, Program, Span } from "../ast/types.js";
import {
  TS_RESET_DECLARATION,
  JSX_INTRINSICS_DECLARATION,
  TYPE_FEST_DECLARATION,
} from "./typescript-context.js";

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
  related?: DiagnosticLocation;
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
  stamp?: string;
  sourceFile: ts.SourceFile;
}

export interface TypeCheckCache {
  oldProgram?: ts.Program;
  sourceFiles: Map<string, CachedSourceFile>;
  compiledFiles: Map<
    string,
    {
      source: string;
      dependencyKey?: string;
      compiled: {
        typescript: string;
        map?: SourceMap;
        ast?: Program;
        pipelineStageInputCompanions?: ReadonlyMap<number, string>;
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
  /** Reject raw TypeScript escapes in all checked FunScript files. */
  noTs?: boolean;
  noGlobalThis?: boolean;
  noOptional?: boolean;
  barePipelines?: boolean;
  noDeepDestructure?: boolean;
  maxDestructureDepth?: number;
  effectOnly?: string[];
  noTsPaths?: string[];
  noGlobalThisPaths?: string[];
  noOptionalPaths?: string[];
  barePipelinesPaths?: string[];
  noDeepDestructurePaths?: string[];
  /** Allow unfinished typed holes ('???') during type-checking (defaults to false; holes fail check by default). */
  allowHoles?: boolean;
  allowHolesPaths?: string[];
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

function getCompilerOptions(
  cwd: string,
  userOptions?: ts.CompilerOptions,
): ts.CompilerOptions {
  let baseOptions = { ...DEFAULT_COMPILER_OPTIONS };
  const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, "tsconfig.json");
  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (!configFile.error && configFile.config) {
      const parsed = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(configPath),
      );
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

  const { line: tsLine0, character: tsCol0 } =
    diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
  const tsLine = tsLine0 + 1;
  const tsCol = tsCol0;

  const orig = originalPositionFor(traceMap, { line: tsLine, column: tsCol });
  const funLines = funSource.split("\n");

  let origLine = orig && orig.line !== null ? orig.line : tsLine;
  let lineText = funLines[origLine - 1] ?? "";

  let origCol =
    orig && orig.column !== null && orig.column > 0 ? orig.column + 1 : 1;
  let spanLen = 1;

  if (diagnostic.length !== undefined && diagnostic.length > 0) {
    const tsSpanText = tsCode
      .slice(diagnostic.start, diagnostic.start + diagnostic.length)
      .trim();
    if (tsSpanText.length > 0) {
      const isExhaustiveError =
        tsSpanText.includes(".exhaustive") ||
        (typeof diagnostic.messageText === "string"
          ? diagnostic.messageText.includes("NonExhaustiveError")
          : diagnostic.messageText
            ? JSON.stringify(diagnostic.messageText).includes(
                "NonExhaustiveError",
              )
            : false);
      spanLen = isExhaustiveError ? 5 : tsSpanText.length;
      const idMatch = tsSpanText.match(/^[A-Za-z0-9_$]+/);
      const isId =
        isExhaustiveError || Boolean(idMatch && idMatch[0] === tsSpanText);
      const searchToken = isExhaustiveError
        ? "match"
        : isId
          ? idMatch![0]
          : tsSpanText;

      // Whole declarations can map to one source position. If an identifier is
      // preserved exactly and occurs equally often on both sides, its occurrence
      // number disambiguates repeated diagnostics within that declaration.
      if (isId && !isExhaustiveError) {
        const pattern = new RegExp(`\\b${escapeRegExp(searchToken)}\\b`, "g");
        const generated = [...tsCode.matchAll(pattern)];
        const original = [...funSource.matchAll(pattern)];
        const ordinal = generated.findIndex(
          (match) => match.index === diagnostic.start,
        );
        if (
          generated.length > 1 &&
          generated.length === original.length &&
          ordinal >= 0
        ) {
          const offset = original[ordinal].index;
          const prefix = funSource.slice(0, offset);
          const line = prefix.split("\n").length;
          const column = offset - prefix.lastIndexOf("\n");
          return {
            file: funPath,
            line,
            column,
            endLine: line,
            endColumn: column + searchToken.length,
          };
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
    if (
      firstNonSpace > 0 &&
      (!orig || orig.column === null || orig.column === 0)
    ) {
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
  const warningCount = diagnostics.filter(
    (d) => d.category === "warning",
  ).length;

  const summaryParts: string[] = [];
  if (errorCount > 0) {
    summaryParts.push(`${errorCount} error${errorCount === 1 ? "" : "s"}`);
  }
  if (warningCount > 0) {
    summaryParts.push(
      `${warningCount} warning${warningCount === 1 ? "" : "s"}`,
    );
  }

  const summary =
    summaryParts.length > 0 ? `\nFound ${summaryParts.join(" and ")}.` : "";
  return blocks.join("\n\n") + summary;
}

export function isEntryModule(
  funPath: string,
  ast?: Program,
  cwd: string = process.cwd(),
): boolean {
  const normPath = path.normalize(funPath);
  const baseName = path.basename(normPath);
  if (baseName === "main.fun" || baseName === "main.funx") return true;

  if (ast?.body && Array.isArray(ast.body)) {
    for (const stmt of ast.body as unknown as Array<Record<string, unknown>>) {
      if (
        stmt.kind === "ExportDeclaration" &&
        (stmt.declaration as { id?: { name?: string } } | undefined)?.id
          ?.name === "main"
      ) {
        return true;
      }
      if (
        stmt.kind === "BindingDeclaration" &&
        (stmt.id as { name?: string } | undefined)?.name === "main"
      ) {
        return true;
      }
      if (
        stmt.kind === "ExportFromDeclaration" &&
        Array.isArray(stmt.specifiers)
      ) {
        if (
          (
            stmt.specifiers as Array<{
              exported?: { name?: string };
              local?: { name?: string };
            }>
          ).some((s) => s.exported?.name === "main" || s.local?.name === "main")
        ) {
          return true;
        }
      }
    }
  }

  try {
    const configPath = path.join(cwd, "funscript.json");
    if (syncFs.existsSync(configPath)) {
      const config = JSON.parse(syncFs.readFileSync(configPath, "utf8"));
      if (Array.isArray(config.entry)) {
        for (const entry of config.entry) {
          const resolvedEntry = path.normalize(path.resolve(cwd, entry));
          if (
            normPath === resolvedEntry ||
            normPath.endsWith(path.normalize(entry))
          ) {
            return true;
          }
        }
      }
    }
  } catch {}

  return false;
}

const EFFECT_RUNNER_FUNCTIONS = new Set([
  "runPromise",
  "runSync",
  "runFork",
  "runPromiseExit",
  "runSyncExit",
  "runMain",
]);

const EFFECT_RUNNER_MODULES = new Set([
  "Effect",
  "Runtime",
  "ManagedRuntime",
  "NodeRuntime",
  "BunRuntime",
]);

function getEffectRunnerName(
  node:
    | {
        kind?: string;
        object?: { name?: string };
        property?: { name?: string };
        name?: string;
      }
    | null
    | undefined,
): string | null {
  if (!node) return null;
  if (node.kind === "MemberExpression") {
    const objName = node.object?.name;
    const propName = node.property?.name;
    if (
      objName &&
      propName &&
      EFFECT_RUNNER_MODULES.has(objName) &&
      EFFECT_RUNNER_FUNCTIONS.has(propName)
    ) {
      return `${objName}.${propName}`;
    }
  } else if (node.kind === "Identifier") {
    if (node.name && EFFECT_RUNNER_FUNCTIONS.has(node.name)) {
      return node.name;
    }
  }
  return null;
}

interface CheckScope {
  parent: CheckScope | null;
  isEffectBoundary: boolean;
  bindings: Map<string, { isMut: boolean }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AstAny = any;
interface AstInspectNode {
  kind: string;
  span?: Span;
  [key: string]: AstAny;
}

function collectPatternVars(pat: unknown): string[] {
  if (!pat || typeof pat !== "object") return [];
  const p = pat as Record<string, unknown>;
  if (p.kind === "Identifier" || p.kind === "UpperIdentifier") {
    return typeof p.name === "string" ? [p.name] : [];
  }
  if (p.kind === "VariablePattern") {
    const n =
      typeof p.name === "object" && p.name
        ? (p.name as { name?: string }).name
        : p.name;
    return typeof n === "string" ? [n] : [];
  }
  if (p.kind === "RecordPattern") {
    const vars: string[] = [];
    const fields = Array.isArray(p.fields) ? p.fields : [];
    for (const f of fields as Array<Record<string, unknown>>) {
      if (!f.pattern) {
        const key = f.key as { name?: string } | undefined;
        if (key?.name) vars.push(key.name);
      } else {
        vars.push(...collectPatternVars(f.pattern));
      }
    }
    return vars;
  }
  if (p.kind === "ArrayPattern") {
    const vars: string[] = [];
    const elements = Array.isArray(p.elements) ? p.elements : [];
    for (const el of elements) {
      vars.push(...collectPatternVars(el));
    }
    return vars;
  }
  if (p.kind === "ConstructorPattern") {
    const vars: string[] = [];
    const args = Array.isArray(p.args) ? p.args : [];
    for (const arg of args) {
      vars.push(...collectPatternVars(arg));
    }
    return vars;
  }
  if (p.kind === "OrPattern") {
    return [...collectPatternVars(p.left), ...collectPatternVars(p.right)];
  }
  if (p.kind === "RestPattern") {
    return collectPatternVars(p.argument);
  }
  return [];
}

function checkCapturedMutInEffect(
  ast: Program | null | undefined,
  addAstDiag: (
    span: Span | undefined,
    code: string,
    customMsg: string,
    category: DiagnosticCategory,
    explanation?: string,
    suggestedAction?: string,
  ) => void,
): void {
  if (!ast) return;

  const rootScope: CheckScope = {
    parent: null,
    isEffectBoundary: false,
    bindings: new Map(),
  };

  // First pass: register top-level declarations
  for (const topDecl of ast.body || []) {
    const decl =
      topDecl.kind === "ExportDeclaration" ? topDecl.declaration : topDecl;
    if (decl && decl.kind === "BindingDeclaration") {
      const isMut = Boolean(decl.isMut);
      for (const name of collectPatternVars(decl.id)) {
        rootScope.bindings.set(name, { isMut });
      }
    }
  }

  const lookup = (
    scope: CheckScope,
    name: string,
  ): { isMut: boolean; crossedEffectBoundary: boolean } | null => {
    let curr: CheckScope | null = scope;
    let crossed = false;
    while (curr) {
      const b = curr.bindings.get(name);
      if (b) {
        return { isMut: b.isMut, crossedEffectBoundary: crossed };
      }
      if (curr.isEffectBoundary) {
        crossed = true;
      }
      curr = curr.parent;
    }
    return null;
  };

  const checkIdent = (
    node: { name?: string; span?: Span } | null | undefined,
    scope: CheckScope,
  ) => {
    if (!node || !node.name || !node.span) return;
    const res = lookup(scope, node.name);
    if (res && res.isMut && res.crossedEffectBoundary) {
      addAstDiag(
        node.span,
        "CAPTURED_MUT",
        `Mutable variable '${node.name}' declared outside this effect block cannot be captured inside an effect block. Concurrent fibers or asynchronous steps could access '${node.name}' without synchronization, causing data races. Use 'Ref' or 'SynchronizedRef' instead.`,
        "error",
        "Closing over mutable 'mut' variables across effect boundaries introduces non-deterministic data races when effects run concurrently or across fiber suspensions.",
        "Use 'Ref.make' or 'SynchronizedRef.make' for concurrency-safe shared state, or pass immutable values.",
      );
    }
  };

  const visit = (node: ASTNode | null | undefined, scope: CheckScope): void => {
    if (!node || typeof node !== "object") return;
    if (
      node.kind === "TsEscapeDeclaration" ||
      node.kind === "TsEscapeExpression" ||
      node.kind === "AsDeclaration"
    )
      return;

    switch (node.kind) {
      case "Program": {
        for (const stmt of node.body || []) {
          visit(stmt, scope);
        }
        break;
      }

      case "ExportDeclaration": {
        visit(node.declaration, scope);
        break;
      }

      case "ExportDefaultDeclaration": {
        visit(node.expression, scope);
        break;
      }

      case "BindingDeclaration": {
        if (node.init?.kind === "FunctionExpression") {
          // Allow recursive immutable functions
          if (!node.isMut) {
            for (const name of collectPatternVars(node.id)) {
              scope.bindings.set(name, { isMut: false });
            }
          }
          visit(node.init, scope);
        } else {
          visit(node.init, scope);
          const isMut = Boolean(node.isMut);
          for (const name of collectPatternVars(node.id)) {
            scope.bindings.set(name, { isMut });
          }
        }
        break;
      }

      case "AssignmentStatement": {
        if (node.target) {
          if (node.target.kind === "Identifier") {
            checkIdent(node.target, scope);
          } else if (node.target.kind === "DotPathExpression") {
            if (node.target.path?.length > 0) {
              checkIdent(node.target.path[0], scope);
            }
          } else if (node.target.kind === "IndexExpression") {
            visit(node.target.object, scope);
            visit(node.target.index, scope);
          }
        }
        visit(node.value, scope);
        break;
      }

      case "FunctionExpression": {
        const fnScope: CheckScope = {
          parent: scope,
          isEffectBoundary: false,
          bindings: new Map(),
        };
        for (const param of node.params || []) {
          for (const name of collectPatternVars(param.name)) {
            fnScope.bindings.set(name, { isMut: false });
          }
          if (param.defaultValue) {
            visit(param.defaultValue, fnScope);
          }
        }
        visit(node.body, fnScope);
        break;
      }

      case "BlockStatement": {
        const blockScope: CheckScope = {
          parent: scope,
          isEffectBoundary: false,
          bindings: new Map(),
        };
        for (const stmt of node.statements || []) {
          visit(stmt, blockScope);
        }
        if (node.finalExpression) {
          visit(node.finalExpression, blockScope);
        }
        break;
      }

      case "EffectBlockExpression":
      case "ParBlockExpression": {
        if ("concurrency" in node && node.concurrency) {
          visit(node.concurrency, scope);
        }
        const effectScope: CheckScope = {
          parent: scope,
          isEffectBoundary: true,
          bindings: new Map(),
        };
        for (const stmt of node.body || []) {
          visit(stmt, effectScope);
        }
        if (node.finalExpression) {
          visit(node.finalExpression, effectScope);
        }
        break;
      }

      case "EffectBindStatement": {
        visit(node.effect, scope);
        for (const name of collectPatternVars(node.id)) {
          scope.bindings.set(name, { isMut: false });
        }
        break;
      }

      case "EffectDiscardStatement": {
        visit(node.effect, scope);
        break;
      }

      case "EffectControlFlowStatement": {
        visit(node.statement, scope);
        break;
      }

      case "WhenStatement": {
        visit(node.condition, scope);
        visit(node.consequent, scope);
        break;
      }

      case "ReturnStatement": {
        visit(node.argument, scope);
        break;
      }

      case "ExpressionStatement": {
        visit(node.expression, scope);
        break;
      }

      case "Identifier":
      case "UpperIdentifier": {
        checkIdent(node, scope);
        break;
      }

      case "CallExpression": {
        visit(node.callee, scope);
        for (const arg of node.args || []) {
          visit(arg, scope);
        }
        break;
      }

      case "MemberExpression": {
        visit(node.object, scope);
        // Do not visit node.property - it is a member property name
        break;
      }

      case "IndexExpression": {
        visit(node.object, scope);
        visit(node.index, scope);
        break;
      }

      case "PipelineExpression":
      case "BinaryExpression": {
        visit(node.left, scope);
        visit(node.right, scope);
        break;
      }

      case "UnaryExpression": {
        visit(node.argument, scope);
        break;
      }

      case "RecordExpression": {
        for (const entry of node.entries || []) {
          if (entry.kind === "FieldEntry") {
            visit(entry.value, scope);
          } else if (entry.kind === "DotPathEntry") {
            visit(entry.value, scope);
          } else if (entry.kind === "ShorthandEntry") {
            checkIdent(entry.key, scope);
          } else if (entry.kind === "SpreadEntry") {
            visit(entry.argument, scope);
          }
        }
        break;
      }

      case "ArrayExpression": {
        for (const el of node.elements || []) {
          visit(el, scope);
        }
        break;
      }

      case "MatchExpression": {
        if (node.scrutinee) visit(node.scrutinee, scope);
        for (const arm of node.arms || []) {
          const armScope: CheckScope = {
            parent: scope,
            isEffectBoundary: false,
            bindings: new Map(),
          };
          for (const name of collectPatternVars(arm.pattern)) {
            armScope.bindings.set(name, { isMut: false });
          }
          if (arm.guard) visit(arm.guard, armScope);
          visit(arm.body, armScope);
        }
        break;
      }

      case "MutBlockExpression": {
        const mutScope: CheckScope = {
          parent: scope,
          isEffectBoundary: false,
          bindings: new Map(),
        };
        const draftName = node.draftParam?.name;
        if (draftName) {
          mutScope.bindings.set(draftName, { isMut: false });
        }
        visit(node.body, mutScope);
        break;
      }

      case "StringLiteral":
      case "TemplateLiteral": {
        for (const part of node.parts || []) {
          if (part.kind === "StringInterpolationPart") {
            visit(part.expression, scope);
          }
        }
        break;
      }

      case "TaggedTemplateExpression": {
        visit(node.tag, scope);
        for (const part of node.template?.parts || []) {
          if (part.kind === "StringInterpolationPart") {
            visit(part.expression, scope);
          }
        }
        break;
      }

      case "SpreadElement": {
        visit(node.argument, scope);
        break;
      }

      case "JsExpression": {
        visit(node.expression, scope);
        break;
      }

      case "JSXElement": {
        const opening = node.openingElement;
        if (
          opening.name?.kind === "Identifier" ||
          opening.name?.kind === "UpperIdentifier"
        ) {
          checkIdent(opening.name, scope);
        } else if (opening.name?.kind === "MemberExpression") {
          visit(opening.name.object, scope);
        }
        for (const attr of opening.attributes || []) {
          if (attr.kind === "JSXSpreadAttribute") visit(attr.argument, scope);
          else if (attr.value?.kind === "JSXExpressionContainer")
            visit(attr.value.expression, scope);
          else if (
            attr.value?.kind === "Identifier" ||
            attr.value?.kind === "UpperIdentifier"
          )
            checkIdent(attr.value, scope);
        }
        for (const child of node.children || []) {
          if (
            child.kind === "JSXElement" ||
            child.kind === "JSXSelfClosingElement"
          )
            visit(child, scope);
          else if (child.kind === "JSXExpressionContainer")
            visit(child.expression, scope);
        }
        break;
      }

      case "JSXSelfClosingElement": {
        if (
          node.name?.kind === "Identifier" ||
          node.name?.kind === "UpperIdentifier"
        ) {
          checkIdent(node.name, scope);
        } else if (node.name?.kind === "MemberExpression") {
          visit(node.name.object, scope);
        }
        for (const attr of node.attributes || []) {
          if (attr.kind === "JSXSpreadAttribute") visit(attr.argument, scope);
          else if (attr.value?.kind === "JSXExpressionContainer")
            visit(attr.value.expression, scope);
          else if (
            attr.value?.kind === "Identifier" ||
            attr.value?.kind === "UpperIdentifier"
          )
            checkIdent(attr.value, scope);
        }
        break;
      }

      default:
        break;
    }
  };

  visit(ast, rootScope);
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
          ast?: Program;
        }
      >();

      const earlyDiagnostics: TypeCheckDiagnostic[] = [];
      const virtualSources = new Map(
        Object.entries(virtualInputFiles).map(([file, content]) => [
          path.resolve(cwd, file),
          content,
        ]),
      );

      const cache = options?.cache;
      const dependencyKeys = cache
        ? incrementalDependencyKeys(virtualSources, cwd)
        : undefined;

      for (const [filePath, source] of Object.entries(virtualInputFiles)) {
        const fullFunPath = path.isAbsolute(filePath)
          ? path.normalize(filePath)
          : path.normalize(path.join(cwd, filePath));
        const ext = fullFunPath.endsWith(".funx") ? ".tsx" : ".ts";
        const virtualTsPath = fullFunPath.replace(/\.(fun|funx)$/, ext);

        let compiled;
        const effectOnly = isEffectOnlyFile(
          { effectOnly: options?.effectOnly },
          cwd,
          fullFunPath,
        );
        const noTs =
          !!options?.noTs ||
          isPathPolicyEnabled(options?.noTsPaths, cwd, fullFunPath);
        const noGlobalThis =
          !!options?.noGlobalThis ||
          isPathPolicyEnabled(options?.noGlobalThisPaths, cwd, fullFunPath);
        const noOptional =
          !!options?.noOptional ||
          isPathPolicyEnabled(options?.noOptionalPaths, cwd, fullFunPath);
        const barePipelines =
          !!options?.barePipelines ||
          isPathPolicyEnabled(options?.barePipelinesPaths, cwd, fullFunPath);
        const noDeepDestructure =
          !!options?.noDeepDestructure ||
          isPathPolicyEnabled(
            options?.noDeepDestructurePaths,
            cwd,
            fullFunPath,
          );
        const maxDestructureDepth = options?.maxDestructureDepth;
        const allowHoles =
          !!options?.allowHoles ||
          isPathPolicyEnabled(options?.allowHolesPaths, cwd, fullFunPath);
        const graphKey = dependencyKeys?.get(fullFunPath);
        const dependencyKey =
          graphKey &&
          JSON.stringify([
            graphKey,
            noTs,
            noGlobalThis,
            noOptional,
            barePipelines,
            effectOnly,
            options?.effectOnly ?? [],
            compilerOptions,
            noDeepDestructure,
            maxDestructureDepth,
            allowHoles,
          ]);
        const existing = cache?.compiledFiles.get(fullFunPath);
        if (
          cache &&
          existing &&
          existing.source === source &&
          existing.dependencyKey !== dependencyKey
        ) {
          // TypeScript's old program can retain module-resolution and package
          // metadata after a dependency changes. Recreate it before checking.
          cache.oldProgram = undefined;
          cache.sourceFiles.clear();
        }
        const cachedCompiled = !dependencyKey ? undefined : existing;
        if (
          cachedCompiled &&
          cachedCompiled.source === source &&
          cachedCompiled.dependencyKey === dependencyKey
        ) {
          compiled = cachedCompiled.compiled;
        } else {
          try {
            compiled = await Effect.runPromise(
              compileString(source, filePath, {
                sourcemap: true,
                sourcePath: fullFunPath,
                virtualSources,
                noTs,
                noGlobalThis,
                noOptional,
                barePipelines,
                noDeepDestructure,
                maxDestructureDepth,
                allowHoles,
                effectOnly,
                effectOnlyDirectories: options?.effectOnly,
                policyRoot: cwd,
              }),
            );
            if (cache && dependencyKey) {
              cache.compiledFiles.set(fullFunPath, {
                source,
                dependencyKey,
                compiled,
              });
            } else {
              cache?.compiledFiles.delete(fullFunPath);
            }
          } catch (err: unknown) {
            if (cache) {
              cache.compiledFiles.delete(fullFunPath);
              cache.sourceFiles.delete(virtualTsPath);
            }
            const compErr =
              err instanceof CompilerError
                ? err
                : new CompilerError(
                    toErrorMessage(err),
                    err instanceof Error ? err : new Error(toErrorMessage(err)),
                  );
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
                {
                  message: compErr.message,
                  highlightCode: options?.highlightCode ?? false,
                },
              );
            } catch {
              frame = undefined;
            }

            const schemaError =
              compErr.error instanceof ImportedSchemaError
                ? compErr.error
                : undefined;
            let code = schemaError ? "IMPORTED_SCHEMA" : "SYNTAX";
            let diagnosticCode = schemaError?.code ?? "FS_SYNTAX";
            let explanation =
              schemaError?.explanation ??
              "The FunScript source could not be parsed.";
            let suggestedAction =
              schemaError?.suggestedAction ??
              "Fix the syntax at the highlighted location and run `funscript check` again.";

            if (compErr.message.includes("Typed hole")) {
              code = "TYPED_HOLE";
              diagnosticCode = "FS_TYPED_HOLE";
              explanation =
                "Typed holes are placeholders for incomplete code during drafting. They throw at runtime and are prohibited by default in completed builds and type-checking.";
              suggestedAction =
                "Implement this expression before building or type-checking.";
            } else if (
              compErr.message.includes("FunScript has no 'throw'") ||
              compErr.message.includes("is unsafe because it throws")
            ) {
              code = "THROW";
              diagnosticCode = "FS_THROW";
              explanation =
                "FunScript has no 'throw' and bans throwing APIs. Recoverable failures must be modeled using typed errors in the Effect E channel, and unrecoverable bugs should use 'Effect.die'.";
              suggestedAction =
                "Replace throwing code with Effect typed errors or schema decoding.";
            } else if (
              compErr.message.includes("is banned by the Effect style guide") ||
              compErr.message.includes("In-place mutation") ||
              compErr.message.includes("quarantined")
            ) {
              code = "INPLACE_MUTATION";
              diagnosticCode = "FS_INPLACE_MUTATION";
              explanation =
                "In-place mutation is quarantined in FunScript. Arrays and records are immutable by default outside 'mut (draft) =>' blocks.";
              suggestedAction =
                "Use immutable functional alternatives (e.g. 'Array.append', 'Array.modify') or wrap local mutations in 'mut (draft) => { ... }'.";
            }

            const header = `${filePath}:${errLine}:${errCol} - error: ${compErr.message}`;
            const related = schemaError?.related;
            const relatedText = related
              ? `\n  TypeScript declaration: ${related.file}:${related.line + 1}:${related.column + 1}`
              : "";
            const formatted = `${frame ? `${header}\n${frame}` : header}${relatedText}\n  help: ${suggestedAction}`;

            earlyDiagnostics.push({
              file: filePath,
              line: errLine,
              column: errCol,
              message: compErr.message,
              diagnosticCode,
              explanation,
              suggestedAction,
              ...(related
                ? {
                    related: {
                      file: related.file,
                      line: related.line + 1,
                      column: related.column + 1,
                      endLine: related.endLine + 1,
                      endColumn: related.endColumn + 1,
                    },
                  }
                : {}),
              category: "error",
              code,
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

      const hasTsx = Array.from(virtualTsFiles.keys()).some((fileName) =>
        fileName.endsWith(".tsx"),
      );
      const hasJsxIntrinsicTypes = Array.from(virtualTsFiles.values()).some(
        (source) => /namespace\s+JSX[\s\S]*?IntrinsicElements/.test(source),
      );
      if (hasTsx && !hasJsxIntrinsicTypes) {
        const jsxTypesPath = path.join(
          cwd,
          "__funscript_jsx_intrinsics__.d.ts",
        );
        virtualTsFiles.set(jsxTypesPath, JSX_INTRINSICS_DECLARATION);
      }

      const resetPath = path.join(cwd, "__funscript_ts_reset__.d.ts");
      virtualTsFiles.set(resetPath, TS_RESET_DECLARATION);

      const typeFestPath = path.join(cwd, "__funscript_type_fest__.d.ts");
      virtualTsFiles.set(typeFestPath, TYPE_FEST_DECLARATION);

      const defaultHost = ts.createCompilerHost(compilerOptions);

      const resolveVirtualContent = (fileName: string): string | undefined => {
        const norm = path.normalize(fileName);
        const content = virtualTsFiles.get(norm);
        if (content !== undefined) return content;
        if (virtualTsFiles.has(norm + ".ts"))
          return virtualTsFiles.get(norm + ".ts");
        if (virtualTsFiles.has(norm + ".tsx"))
          return virtualTsFiles.get(norm + ".tsx");
        if (
          norm.endsWith(".js") &&
          virtualTsFiles.has(norm.slice(0, -3) + ".ts")
        ) {
          return virtualTsFiles.get(norm.slice(0, -3) + ".ts");
        }
        if (
          norm.endsWith(".jsx") &&
          virtualTsFiles.has(norm.slice(0, -4) + ".tsx")
        ) {
          return virtualTsFiles.get(norm.slice(0, -4) + ".tsx");
        }
        if (path.basename(fileName) === "__funscript_type_fest__.d.ts") {
          return TYPE_FEST_DECLARATION;
        }
        if (path.basename(fileName) === "__funscript_ts_reset__.d.ts") {
          return TS_RESET_DECLARATION;
        }
        if (path.basename(fileName) === "__funscript_jsx_intrinsics__.d.ts") {
          return JSX_INTRINSICS_DECLARATION;
        }
        return undefined;
      };

      const host: ts.CompilerHost = {
        ...defaultHost,
        getSourceFile: (
          fileName,
          languageVersion,
          onError,
          shouldCreateNewSourceFile,
        ) => {
          const content = resolveVirtualContent(fileName);
          const norm = path.normalize(fileName);

          if (content !== undefined) {
            if (cache) {
              const cached = cache.sourceFiles.get(norm);
              if (cached && cached.sourceFile.text === content) {
                return cached.sourceFile;
              }
              const sf = ts.createSourceFile(
                fileName,
                content,
                languageVersion,
                true,
              );
              cache.sourceFiles.set(norm, { sourceFile: sf });
              return sf;
            }
            return ts.createSourceFile(
              fileName,
              content,
              languageVersion,
              true,
            );
          }

          if (cache) {
            const cached = cache.sourceFiles.get(norm);
            if (cached) {
              try {
                const stat = syncFs.statSync(fileName, { bigint: true });
                const stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
                if (cached.stamp === stamp) return cached.sourceFile;
              } catch {
                // A removed file must not reuse its old source.
              }
            }

            const sf = defaultHost.getSourceFile(
              fileName,
              languageVersion,
              onError,
              shouldCreateNewSourceFile,
            );
            if (sf) {
              let stamp: string | undefined;
              try {
                const stat = syncFs.statSync(fileName, { bigint: true });
                stamp = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
              } catch {
                /* Missing files are never reused. */
              }
              cache.sourceFiles.set(norm, { sourceFile: sf, stamp });
            }
            return sf;
          }

          return defaultHost.getSourceFile(
            fileName,
            languageVersion,
            onError,
            shouldCreateNewSourceFile,
          );
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

          const loc = mapDiagnosticLocation(
            diag,
            meta.funPath,
            meta.funSource,
            meta.traceMap,
            meta.tsCode,
          );
          const category = mapCategory(diag.category);
          let message = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
          let code: number | string = diag.code;

          // Only customize unresolved names: TypeScript has already accounted for
          // local shadowing and imported bindings, so valid user functions are untouched.
          if (
            diag.code === 2304 &&
            diag.start !== undefined &&
            diag.length !== undefined
          ) {
            const identifier = diag.file.text.slice(
              diag.start,
              diag.start + diag.length,
            );
            if (identifier.endsWith("DecodeChecked")) {
              const contract = identifier.slice(0, -"DecodeChecked".length);
              if (
                meta.tsCode.includes(
                  `declare const $funscriptRecordContract$${contract}: unique symbol;`,
                )
              ) {
                code = "FS_CHECKED_DECODER_UNSUPPORTED";
                message = `${contract} has no generated checked decoder for this signature. Only required callbacks with supported primitive or local data-schema arguments and results are supported; use explicit callback adapters for other shapes.`;
              }
            }
            if (identifier.endsWith("FromUnknown")) {
              const contract = identifier.slice(0, -"FromUnknown".length);
              if (
                meta.tsCode.includes(
                  `declare const $funscriptRecordContract$${contract}: unique symbol;`,
                )
              ) {
                code = "FS_CONTRACT_DECODER";
                message = `${contract} is a compile-time record contract and has no generated FromUnknown decoder. Use its DecodeChecked function when supported, or validate data separately and use an explicit checked callback boundary.`;
              }
            }
          }

          let explanation =
            typeof code === "number"
              ? `TypeScript reported diagnostic TS${code} for the generated source.`
              : message;
          let suggestedAction: string | undefined;

          if (
            (diag.code === 2488 || diag.code === 2461) &&
            /Promise/.test(message)
          ) {
            code = "PROMISE_BIND";
            message =
              "Cannot bind raw Promise in effect block. External asynchronous calls must be explicitly lifted using the 'js' operator (e.g. '<- js <expr>') or wrapped in 'Effect.tryPromise'.";
            explanation = message;
            suggestedAction =
              "Use '<- js <expr>' to lift foreign asynchronous calls into the effect block.";
          }

          if (
            diag.code === 2339 &&
            /Option<|Option\.|\bOption\b/.test(message) &&
            !diag.file.text
              .slice(
                Math.max(0, (diag.start ?? 0) - 100),
                (diag.start ?? 0) + (diag.length ?? 0),
              )
              .includes("Option.fromNullishOr") &&
            diag.file.text
              .slice(
                Math.max(0, (diag.start ?? 0) - 100),
                (diag.start ?? 0) + (diag.length ?? 0),
              )
              .includes("fromNullishOr")
          ) {
            continue;
          }

          if (diag.code === 2349 && message.includes("NonExhaustiveError")) {
            code = "NON_EXHAUSTIVE_MATCH";
            const tagMatch = message.match(/_tag:\s*["']([^"']+)["']/);
            const missingInfo = tagMatch
              ? ` Missing variant: '${tagMatch[1]}'.`
              : "";
            explanation =
              "The pattern match expression does not handle all possible variants of the scrutinee type.";
            suggestedAction = tagMatch
              ? `Add arm '| ${tagMatch[1]} => ...' or use wildcard '| _ => ...' to handle remaining cases.`
              : "Add arms for the missing variants or use a wildcard '| _ => ...'.";
            message = `Pattern match is not exhaustive.${missingInfo} In FunScript, all variants must be handled or guarded with a fallback '| _ =>'.`;
          }

          let frame: string | undefined;
          try {
            frame = codeFrameColumns(
              meta.funSource,
              {
                start: { line: loc.line, column: loc.column },
                end: loc.endColumn
                  ? { line: loc.line, column: loc.endColumn }
                  : undefined,
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
          const formatted = `${frame ? `${header}\n${frame}` : header}${suggestedAction ? `\n  help: ${suggestedAction}` : ""}`;

          tsDiagnostics.push({
            file: loc.file,
            line: loc.line,
            column: loc.column,
            endLine: loc.endLine,
            endColumn: loc.endColumn,
            message,
            diagnosticCode:
              typeof code === "number" ? `TS${code}` : `FS_${code}`,
            explanation,
            suggestedAction,
            category,
            code,
            frame,
            formatted,
          });
        }

        const getFunScriptUnannotatedBindings = (
          ast?: Program,
        ): Set<string> => {
          const names = new Set<string>();
          const walk = (node: unknown) => {
            if (!node || typeof node !== "object") return;
            const n = node as Record<string, unknown>;
            if (
              n.kind === "TsEscapeDeclaration" ||
              n.kind === "TsEscapeExpression"
            )
              return;
            if (n.kind === "BindingDeclaration") {
              const id = n.id as { name?: string } | undefined;
              if (id?.name && !n.typeAnnotation) {
                names.add(id.name);
              }
            }
            for (const key of Object.keys(n)) {
              if (key === "span") continue;
              const child = n[key];
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

        const getFunScriptMemberAccesses = (ast?: Program): Set<string> => {
          const names = new Set<string>();
          const walk = (node: unknown) => {
            if (!node || typeof node !== "object") return;
            const n = node as Record<string, unknown>;
            if (
              n.kind === "TsEscapeDeclaration" ||
              n.kind === "TsEscapeExpression"
            )
              return;
            if (n.kind === "MemberExpression") {
              const prop = n.property as { name?: string } | undefined;
              if (prop?.name) {
                names.add(prop.name);
              }
            }
            for (const key of Object.keys(n)) {
              if (key === "span") continue;
              const child = n[key];
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

          const isEffectType = (type: ts.Type): boolean => {
            if (!type) return false;
            if (type.isUnion()) return type.types.some((t) => isEffectType(t));
            if (
              type.symbol?.name === "Effect" ||
              type.aliasSymbol?.name === "Effect"
            )
              return true;
            if (
              type
                .getProperties()
                .some(
                  (p) =>
                    p.name.includes("effect/Effect") ||
                    p.name === "~effect/Effect",
                )
            )
              return true;
            const str = checker.typeToString(type);
            return str.startsWith("Effect<") || str.includes("Effect.Effect<");
          };

          const addCustomDiag = (
            targetNode: ts.Node,
            code: string,
            customMsg: string,
            explanation?: string,
            suggestedAction?: string,
          ) => {
            const loc = mapDiagnosticLocation(
              {
                file: sf,
                start: targetNode.getStart(sf),
                length: targetNode.getWidth(sf),
                messageText: customMsg,
                category: ts.DiagnosticCategory.Error,
                code: 9999,
              },
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
                  end: loc.endColumn
                    ? { line: loc.line, column: loc.endColumn }
                    : undefined,
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
              diagnosticCode: `FS_${code}`,
              explanation,
              suggestedAction,
              category: "error",
              code,
              frame,
              formatted: frame ? `${header}\n${frame}` : header,
            });
          };

          const reportedSpans = new Set<string>();
          const addAstDiag = (
            span:
              | {
                  start: { line: number; column: number };
                  end: { line: number; column: number };
                }
              | undefined,
            code: string,
            customMsg: string,
            category: DiagnosticCategory = "error",
            explanation?: string,
            suggestedAction?: string,
          ) => {
            if (!span || !span.start || !span.end) return;
            const key = `${span.start.line}:${span.start.column}:${code}`;
            if (reportedSpans.has(key)) return;
            reportedSpans.add(key);

            let frame: string | undefined;
            try {
              frame = codeFrameColumns(
                meta.funSource,
                {
                  start: { line: span.start.line, column: span.start.column },
                  end: { line: span.end.line, column: span.end.column },
                },
                {
                  message: customMsg,
                  highlightCode: options?.highlightCode ?? false,
                },
              );
            } catch {
              frame = undefined;
            }
            const header = `${meta.funPath}:${span.start.line}:${span.start.column} - ${category} ${code}: ${customMsg}`;
            tsDiagnostics.push({
              file: meta.funPath,
              line: span.start.line,
              column: span.start.column,
              endLine: span.end.line,
              endColumn: span.end.column,
              message: customMsg,
              diagnosticCode: `FS_${code}`,
              explanation,
              suggestedAction,
              category,
              code,
              frame,
              formatted: frame ? `${header}\n${frame}` : header,
            });
          };

          if (meta.ast) {
            const isEntry = isEntryModule(meta.funPath, meta.ast, cwd);
            const INPLACE_MUTATING_METHODS = new Set([
              "push",
              "pop",
              "shift",
              "unshift",
              "splice",
              "sort",
              "reverse",
            ]);
            const ERROR_CONSTRUCTORS = new Set([
              "Error",
              "TypeError",
              "RangeError",
              "SyntaxError",
              "ReferenceError",
              "EvalError",
              "URIError",
            ]);

            // § Pit of Success: Module-scope Ref allocation
            for (const decl of meta.ast.body || []) {
              const binding =
                decl.kind === "ExportDeclaration" ? decl.declaration : decl;
              if (
                binding &&
                binding.kind === "BindingDeclaration" &&
                binding.init
              ) {
                const isRefMake = (expr: unknown): boolean => {
                  if (!expr || typeof expr !== "object") return false;
                  const e = expr as Record<string, unknown>;
                  if (e.kind === "CallExpression") {
                    const c = e.callee as Record<string, unknown> | undefined;
                    if (c?.kind === "MemberExpression") {
                      const obj = (c.object as { name?: string } | undefined)
                        ?.name;
                      const prop = (c.property as { name?: string } | undefined)
                        ?.name;
                      if (
                        (obj === "Ref" ||
                          obj === "SynchronizedRef" ||
                          obj === "SubscriptionRef") &&
                        (prop === "make" || prop === "unsafeMake")
                      ) {
                        return true;
                      }
                      if (
                        obj === "Effect" &&
                        (prop === "runSync" || prop === "runPromise") &&
                        Array.isArray(e.args) &&
                        e.args[0]
                      ) {
                        return isRefMake(e.args[0]);
                      }
                    } else if (
                      c?.kind === "Identifier" &&
                      (c as { name?: string }).name === "unsafeMake"
                    ) {
                      return true;
                    }
                  } else if (e.kind === "PipelineExpression") {
                    return isRefMake(e.right);
                  }
                  return false;
                };
                if (isRefMake(binding.init)) {
                  const name =
                    "name" in binding.id
                      ? ((binding.id as { name?: string }).name ?? "binding")
                      : "binding";
                  addAstDiag(
                    binding.span || decl.span,
                    "TOP_LEVEL_REF",
                    `Top-level '${name}' allocates a mutable Ref at module scope. This creates ambient shared mutable state across concurrent fibers. Allocate Refs inside an effect block (e.g. 'ref <- Ref.make(...)') or provide them via a Layer service.`,
                    "error",
                    "Global mutable Refs introduce hidden shared state across fibers and requests, breaking concurrency isolation and testing.",
                    "Allocate Refs inside an `effect { ... }` block or provide them via a `Layer` service.",
                  );
                }
              }
            }
            const walkAst = (
              node: AstInspectNode | null | undefined,
              parent?: AstInspectNode | null,
              inMutBlock = false,
              inMatchArm = false,
            ) => {
              if (!node || typeof node !== "object") return;
              if (
                node.kind === "TsEscapeDeclaration" ||
                node.kind === "TsEscapeExpression" ||
                node.kind === "JsExpression"
              )
                return;

              const currentInMut =
                inMutBlock || node.kind === "MutBlockExpression";
              const currentInMatchArm =
                node.kind === "FunctionExpression" ||
                node.kind === "ArrowFunction"
                  ? false
                  : inMatchArm;

              if (
                node.kind === "TypedHole" &&
                !options?.allowHoles &&
                !isPathPolicyEnabled(
                  options?.allowHolesPaths,
                  cwd,
                  meta.funPath,
                )
              ) {
                const label = (node as { label?: string }).label || "???";
                addAstDiag(
                  node.span,
                  "TYPED_HOLE",
                  `Typed hole '${label}' is unfinished code.`,
                  "error",
                  "Typed holes are placeholders for incomplete code during drafting. They throw at runtime and are prohibited by default in completed builds and type-checking.",
                  "Implement this expression before building or type-checking.",
                );
              }

              if (node.kind === "MatchExpression" && currentInMatchArm) {
                addAstDiag(
                  node.span,
                  "NESTED_MATCH",
                  "Nested 'match' expression detected. In FunScript, nested matching is an anti-pattern ('match abuse'). Flatten branching by computing local variables beforehand, using multi-value tuple matching (e.g. 'match (a, b)'), adding 'when' guards, or sequencing Options with Effect blocks ('x <- opt').",
                  "error",
                  "Nested pattern matching creates a pyramid of doom and procedural ladder branching, obscuring domain logic.",
                  "Flatten the match: 1) extract local variables before the match, 2) match multiple values with tuples `match (a, b)`, 3) use `when` guard clauses, or 4) sequence Options inside `effect { x <- opt }`.",
                );
              }

              if (node.kind === "CallExpression") {
                const callee = node.callee;
                if (
                  !currentInMut &&
                  callee?.kind === "MemberExpression" &&
                  INPLACE_MUTATING_METHODS.has(callee.property?.name)
                ) {
                  addAstDiag(
                    node.span,
                    "INPLACE_MUTATION",
                    `In-place mutation '.${callee.property.name}()' is quarantined in FunScript. Arrays are immutable by default outside 'mut (draft) =>' blocks.`,
                    "error",
                    "Direct array mutation outside draft proxy blocks causes accidental state pollution.",
                    `Use immutable functional alternatives (e.g. 'Array.append', 'Array.modify') or wrap local mutations in 'mut (draft) => { ... }'.`,
                  );
                } else if (
                  (callee?.kind === "UpperIdentifier" ||
                    callee?.kind === "Identifier") &&
                  ERROR_CONSTRUCTORS.has(callee.name)
                ) {
                  addAstDiag(
                    node.span,
                    "THROW",
                    `\`${callee.name}(...)\` constructs an unmanaged JavaScript exception. In FunScript, declare domain failures with 'error Name { ... }' or fail within Effect using 'Effect.fail' or 'Effect.die'.`,
                    "error",
                    "FunScript avoids raw JavaScript Error exceptions in favor of typed errors or explicit defects.",
                    "Declare a typed error using `error Name { ... }` or use `Effect.dieMessage(...)`.",
                  );
                } else if (
                  callee?.kind === "Identifier" &&
                  callee.name === "fetch"
                ) {
                  addAstDiag(
                    node.span,
                    "NATIVE_API",
                    "`fetch` is an unmanaged native HTTP client returning an untyped Promise. In FunScript, use '@effect/platform' HttpClient or lift with 'js fetch(...)'.",
                    "error",
                    "Bare fetch returns an unmanaged Promise without typed errors or retry policies.",
                    "Use '@effect/platform' HttpClient or lift with `js fetch(...)`.",
                  );
                } else if (
                  callee?.kind === "Identifier" &&
                  (callee.name === "setTimeout" ||
                    callee.name === "setInterval" ||
                    callee.name === "clearTimeout" ||
                    callee.name === "clearInterval")
                ) {
                  addAstDiag(
                    node.span,
                    "NATIVE_API",
                    `\`${callee.name}\` is an unmanaged native timer. Time and scheduling are Effect services; use 'Effect.sleep' or 'Schedule.spaced' to ensure fibers can be interrupted and tested deterministically.`,
                    "error",
                    "Native timers run outside Effect's fiber scheduler, leak when tasks are cancelled, and cannot be controlled with TestClock.",
                    "Replace with `Effect.sleep(...)` or `Schedule.spaced(...)`.",
                  );
                } else if (
                  callee?.kind === "Identifier" &&
                  (callee.name === "getOrThrow" ||
                    callee.name === "getOrThrowWith")
                ) {
                  addAstDiag(
                    node.span,
                    "THROW",
                    `\`${callee.name}\` throws an unhandled exception at runtime. In FunScript, handle absence or failure safely using 'getOrElse', pattern matching ('match'), or lift with 'Effect.fromOption'.`,
                    "error",
                    "FunScript disallows runtime throwing methods.",
                    "Use `Option.getOrElse`, `Option.match`, or `Effect.fromOption`.",
                  );
                } else if (
                  callee?.kind === "UpperIdentifier" &&
                  callee.name === "Date"
                ) {
                  addAstDiag(
                    node.span,
                    "HIDDEN_INPUT",
                    "`Date()` is a hidden input. Time is an Effect service; use 'Clock.currentTimeMillis' or 'DateTime.now' to make code testable.",
                    "error",
                    "Time and randomness are Effect services; reading global non-deterministic constructors creates flaky tests.",
                    "Replace `Date()` with `now <- Clock.currentTimeMillis` or `DateTime.now`.",
                  );
                } else if (callee?.kind === "MemberExpression") {
                  const o = callee.object?.name;
                  const p = callee.property?.name;
                  if (
                    (o === "Semaphore" || (o && /semaphore|sem/i.test(o))) &&
                    (p === "take" || p === "release")
                  ) {
                    addAstDiag(
                      node.span,
                      "MANUAL_SEMAPHORE",
                      `Manual semaphore permit management leaks permits on fiber interruption. Use 'withPermits' instead.`,
                      "error",
                      "Manually calling take and release on a semaphore leaks permits if the fiber is interrupted or fails between take and release.",
                      "Wrap the critical section in 'semaphore.withPermits(n)(effect)' for guaranteed permit acquisition and release.",
                    );
                  } else if (o === "Queue" && p === "unbounded") {
                    addAstDiag(
                      node.span,
                      "UNBOUNDED_QUEUE",
                      `Queue created with infinite capacity. High-volume producers can exhaust memory without backpressure. Prefer 'Queue.bounded(capacity)' or specify '{ capacity: 1024 }'.`,
                      "warning",
                      "Unbounded queues buffer work indefinitely without limit. If producers outpace consumers, the queue will grow until memory is exhausted.",
                      "Prefer 'Queue.bounded(capacity)' or specify '{ capacity: 1024 }'.",
                    );
                  } else if (
                    o === "Queue" &&
                    p === "make" &&
                    (!node.args || node.args.length === 0)
                  ) {
                    addAstDiag(
                      node.span,
                      "UNBOUNDED_QUEUE",
                      `Queue created with infinite capacity. High-volume producers can exhaust memory without backpressure. Prefer 'Queue.bounded(capacity)' or specify '{ capacity: 1024 }'.`,
                      "warning",
                      "Queue.make() defaults to unbounded capacity in Effect v4.",
                      "Specify a bounded capacity with 'Queue.bounded(capacity)' or 'Queue.make({ capacity })'.",
                    );
                  } else if (o === "Date" && p === "now") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`Date.now()` is a hidden input. Time is an Effect service; use 'Clock.currentTimeMillis' or 'DateTime.now' to make code testable.",
                      "error",
                      "Time and randomness are Effect services; reading global non-deterministic APIs creates flaky tests.",
                      "Replace `Date.now()` with `now <- Clock.currentTimeMillis` or `DateTime.now`.",
                    );
                  } else if (o === "Math" && p === "random") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`Math.random()` is a hidden input. Randomness is an Effect service; use 'Random.nextInt', 'Random.next', or 'Random.nextIntBetween' to make code testable.",
                      "error",
                      "Randomness is an Effect service; reading global non-deterministic Math.random creates non-reproducible bugs.",
                      "Replace `Math.random()` with `Random.nextInt` or `Random.next` from the Effect Random service.",
                    );
                  } else if (o === "performance" && p === "now") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`performance.now()` is a hidden input. Time is an Effect service; use 'Clock.currentTimeNanos' or 'Clock.currentTimeMillis' to make code testable.",
                      "error",
                      "Time is an Effect service; use Clock to measure duration deterministically.",
                      "Replace `performance.now()` with `Clock.currentTimeNanos`.",
                    );
                  } else if (o === "crypto" && p === "randomUUID") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`crypto.randomUUID()` is a hidden input. Randomness is an Effect service; use 'Random' or 'UUID' schemas to make code testable.",
                      "error",
                      "Randomness is an Effect service; reading crypto directly creates non-reproducible states in tests.",
                      "Use Effect's Random service or validated UUID schemas.",
                    );
                  } else if (o === "crypto" && p === "getRandomValues") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`crypto.getRandomValues()` is a hidden input. Randomness is an Effect service; use 'Random' to make code testable.",
                      "error",
                      "Randomness is an Effect service; reading crypto directly creates non-reproducible states in tests.",
                      "Use Effect's Random service.",
                    );
                  } else if (o === "JSON" && p === "parse") {
                    addAstDiag(
                      node.span,
                      "THROW",
                      "`JSON.parse` is an unmanaged API that throws SyntaxError on invalid input. In FunScript, decode JSON safely using Effect's 'Schema.parseJson' or 'Schema.decodeUnknown'.",
                      "error",
                      "JSON.parse throws raw exceptions on malformed input.",
                      "Use `Schema.parseJson(MySchema)` or `Schema.decodeUnknown(MySchema)`.",
                    );
                  } else if (
                    (o === "Option" || o === "Either") &&
                    (p === "getOrThrow" || p === "getOrThrowWith")
                  ) {
                    addAstDiag(
                      node.span,
                      "THROW",
                      `\`${o}.${p}\` throws an unhandled exception at runtime. In FunScript, handle absence or failure safely using '${o}.getOrElse', pattern matching ('match'), or lift with 'Effect.from${o}'.`,
                      "error",
                      "FunScript disallows runtime throwing methods.",
                      `Use \`${o}.getOrElse\`, \`${o}.match\`, or \`Effect.from${o}\`.`,
                    );
                  } else if (
                    (o === "globalThis" || o === "window") &&
                    (p === "setTimeout" ||
                      p === "setInterval" ||
                      p === "clearTimeout" ||
                      p === "clearInterval" ||
                      p === "fetch")
                  ) {
                    addAstDiag(
                      node.span,
                      "NATIVE_API",
                      `\`${o}.${p}\` is an unmanaged native API. In FunScript, use Effect services instead.`,
                      "error",
                      "Unmanaged native APIs bypass Effect cancellation and tracing.",
                      "Use Effect services ('Effect.sleep', '@effect/platform' HttpClient).",
                    );
                  } else if (
                    !isEntry &&
                    o === "console" &&
                    (p === "log" ||
                      p === "error" ||
                      p === "warn" ||
                      p === "info")
                  ) {
                    addAstDiag(
                      node.span,
                      "NATIVE_API",
                      `\`console.${p}\` writes unmanaged output to global stream. In FunScript library code, use Effect's 'Console.${p}' service to keep logging contextual, traceable, and testable.`,
                      "error",
                      "Direct console logging in library code bypasses Effect's Logger services and cannot be intercepted or silenced in tests.",
                      `Use \`Console.${p}\` from 'effect'.`,
                    );
                  }
                }
              }

              if (
                node.kind === "Identifier" ||
                node.kind === "UpperIdentifier"
              ) {
                const isProp =
                  parent?.kind === "MemberExpression" &&
                  parent?.property === node;
                const isCallee =
                  parent?.kind === "CallExpression" && parent?.callee === node;
                const isBinding =
                  (parent?.kind === "BindingDeclaration" &&
                    parent?.id === node) ||
                  parent?.kind === "FunctionDeclaration" ||
                  parent?.kind === "VariablePattern";
                const isImport =
                  parent?.kind === "ImportSpecifier" ||
                  parent?.kind === "ImportDeclaration";
                const isType =
                  parent?.kind === "TypeReferenceNode" ||
                  parent?.kind === "QualifiedTypeReferenceNode";

                if (
                  !isProp &&
                  !isCallee &&
                  !isBinding &&
                  !isImport &&
                  !isType
                ) {
                  if (node.name === "fetch") {
                    addAstDiag(
                      node.span,
                      "NATIVE_API",
                      "`fetch` is an unmanaged native HTTP client returning an untyped Promise. In FunScript, use '@effect/platform' HttpClient or lift with 'js fetch(...)'.",
                      "error",
                      "Bare fetch returns an unmanaged Promise without typed errors or retry policies.",
                      "Use '@effect/platform' HttpClient or lift with `js fetch(...)`.",
                    );
                  } else if (
                    node.name === "setTimeout" ||
                    node.name === "setInterval" ||
                    node.name === "clearTimeout" ||
                    node.name === "clearInterval"
                  ) {
                    addAstDiag(
                      node.span,
                      "NATIVE_API",
                      `\`${node.name}\` is an unmanaged native timer. Time and scheduling are Effect services; use 'Effect.sleep' or 'Schedule.spaced'.`,
                      "error",
                      "Native timers run outside Effect's fiber scheduler and cannot be controlled with TestClock.",
                      "Replace with `Effect.sleep(...)` or `Schedule.spaced(...)`.",
                    );
                  } else if (ERROR_CONSTRUCTORS.has(node.name)) {
                    addAstDiag(
                      node.span,
                      "THROW",
                      `\`${node.name}\` is an unmanaged JavaScript exception constructor. In FunScript, declare domain failures with 'error Name { ... }' or fail within Effect using 'Effect.fail' or 'Effect.die'.`,
                      "error",
                      "FunScript avoids raw JavaScript Error exceptions in favor of typed errors or explicit defects.",
                      "Declare a typed error using `error Name { ... }` or use `Effect.dieMessage(...)`.",
                    );
                  }
                }
              } else if (node.kind === "PipelineExpression") {
                const r = node.right;
                if (
                  (r?.kind === "MemberExpression" &&
                    (r.object?.name === "Option" ||
                      r.object?.name === "Either") &&
                    (r.property?.name === "getOrThrow" ||
                      r.property?.name === "getOrThrowWith")) ||
                  (r?.kind === "Identifier" &&
                    (r.name === "getOrThrow" || r.name === "getOrThrowWith"))
                ) {
                  const targetName =
                    r.kind === "MemberExpression"
                      ? `${r.object.name}.${r.property.name}`
                      : r.name;
                  addAstDiag(
                    r.span || node.span,
                    "THROW",
                    `\`${targetName}\` throws an unhandled exception at runtime. In FunScript, handle absence or failure safely using 'getOrElse', pattern matching ('match'), or lift to Effect.`,
                    "error",
                    "FunScript disallows runtime throwing methods.",
                    "Use `Option.getOrElse`, `Option.match`, or `Effect.fromOption`.",
                  );
                } else if (r?.kind === "CallExpression") {
                  const c = r.callee;
                  if (
                    (c?.kind === "MemberExpression" &&
                      (c.object?.name === "Option" ||
                        c.object?.name === "Either") &&
                      (c.property?.name === "getOrThrow" ||
                        c.property?.name === "getOrThrowWith")) ||
                    (c?.kind === "Identifier" &&
                      (c.name === "getOrThrow" || c.name === "getOrThrowWith"))
                  ) {
                    const targetName =
                      c.kind === "MemberExpression"
                        ? `${c.object.name}.${c.property.name}`
                        : c.name;
                    addAstDiag(
                      c.span || r.span,
                      "THROW",
                      `\`${targetName}\` throws an unhandled exception at runtime. In FunScript, handle absence or failure safely using 'getOrElse', pattern matching ('match'), or lift to Effect.`,
                      "error",
                      "FunScript disallows runtime throwing methods.",
                      "Use `Option.getOrElse`, `Option.match`, or `Effect.fromOption`.",
                    );
                  }
                }
              } else if (node.kind === "MemberExpression") {
                if (
                  node.object?.kind === "IndexExpression" &&
                  node.object.index?.kind !== "StringLiteral"
                ) {
                  addAstDiag(
                    node.span,
                    "INDEX_OPTION_PROPERTY",
                    "Array indexing returns an Option<T>. Unwrap with match, Option.map, or Option.getOrElse before accessing properties.",
                    "error",
                    "In FunScript's Pit of Success, array indexing returns an Option<T> to prevent runtime undefined errors. Direct property access on an Option reads undefined at runtime.",
                    "Unwrap with match, Option.map, or Option.getOrElse before accessing properties.",
                  );
                }
                if (parent?.kind !== "CallExpression") {
                  const o = node.object?.name;
                  const p = node.property?.name;
                  if (o === "Date" && p === "now") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`Date.now` is a hidden input. Time is an Effect service; use 'Clock.currentTimeMillis' or 'DateTime.now' to make code testable.",
                      "error",
                    );
                  } else if (o === "Math" && p === "random") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`Math.random` is a hidden input. Randomness is an Effect service; use 'Random.nextInt', 'Random.next', or 'Random.nextIntBetween' to make code testable.",
                      "error",
                    );
                  } else if (o === "performance" && p === "now") {
                    addAstDiag(
                      node.span,
                      "HIDDEN_INPUT",
                      "`performance.now` is a hidden input. Time is an Effect service; use 'Clock.currentTimeNanos' or 'Clock.currentTimeMillis' to make code testable.",
                      "error",
                    );
                  }
                }
              }

              if (!isEntry) {
                // §1.10: Running Effects mid-program
                let runnerName: string | null = null;
                let runnerSpan: Span | null = null;

                if (node.kind === "CallExpression") {
                  runnerName = getEffectRunnerName(node.callee);
                  runnerSpan = node.callee?.span || node.span;
                } else if (node.kind === "PipelineExpression") {
                  const r = node.right;
                  if (r?.kind === "CallExpression") {
                    runnerName = getEffectRunnerName(r.callee);
                    runnerSpan = r.callee?.span || r.span;
                  } else {
                    runnerName = getEffectRunnerName(r);
                    runnerSpan = r?.span || node.span;
                  }
                }

                if (runnerName && runnerSpan) {
                  addAstDiag(
                    runnerSpan,
                    "EFFECT_RUN",
                    `\`${runnerName}\` executes an Effect mid-program. In FunScript, library code must compose and return Effects. Only entry modules (e.g. 'main.fun', or modules exporting 'main') may run effects.`,
                    "error",
                    "Running effects mid-program breaks composability, defeats dependency injection with Layer/Context, and prevents the caller from controlling execution or handling errors.",
                    "Return the `Effect` directly from this function and allow the entry module (or main) to execute it.",
                  );
                }

                // §1.11: Reading globals for configuration
                if (node.kind === "MemberExpression") {
                  const obj = node.object;
                  const prop = node.property;
                  if (
                    obj?.kind === "Identifier" &&
                    (obj.name === "process" ||
                      obj.name === "Deno" ||
                      obj.name === "Bun") &&
                    prop?.name === "env"
                  ) {
                    const fullName = `${obj.name}.env`;
                    addAstDiag(
                      node.span,
                      "ENV_GLOBAL",
                      `\`${fullName}\` reads environment configuration directly from global state. In FunScript, library code should declare configuration dependencies using Effect's 'Config' service, or receive configuration as parameters.`,
                      "error",
                      "Reading global environment variables in library code couples modules to ambient state and makes testing and re-configuration difficult.",
                      "Use Effect 'Config' (e.g. `Config.string('VAR')`) or pass configuration explicitly as arguments.",
                    );
                  }
                }

                // §1.13: Detached fibers
                if (node.kind === "CallExpression") {
                  const c = node.callee;
                  if (
                    (c?.kind === "MemberExpression" &&
                      c.object?.name === "Effect" &&
                      c.property?.name === "forkDetach") ||
                    (c?.kind === "Identifier" && c.name === "forkDetach")
                  ) {
                    addAstDiag(
                      c.span || node.span,
                      "DETACHED_FIBER",
                      "`Effect.forkDetach` creates a detached fiber nobody owns. It keeps running after its caller is interrupted. Use 'Effect.forkScoped' (tied to Scope) or 'Effect.forkChild' (tied to parent fiber) to ensure structured concurrency.",
                      "error",
                      "Detached fibers leak beyond the lifetime of the caller with no owner.",
                      "Use `Effect.forkScoped` (tied to Scope) or `Effect.forkChild` (tied to parent fiber), or long-lived background work in `Layer.effectDiscard(Effect.forkScoped(...))`.",
                    );
                  }
                } else if (node.kind === "PipelineExpression") {
                  const r = node.right;
                  if (
                    (r?.kind === "MemberExpression" &&
                      r.object?.name === "Effect" &&
                      r.property?.name === "forkDetach") ||
                    (r?.kind === "Identifier" && r.name === "forkDetach")
                  ) {
                    addAstDiag(
                      r.span || node.span,
                      "DETACHED_FIBER",
                      "`Effect.forkDetach` creates a detached fiber nobody owns. It keeps running after its caller is interrupted. Use 'Effect.forkScoped' (tied to Scope) or 'Effect.forkChild' (tied to parent fiber) to ensure structured concurrency.",
                      "error",
                      "Detached fibers leak beyond the lifetime of the caller with no owner.",
                      "Use `Effect.forkScoped` (tied to Scope) or `Effect.forkChild` (tied to parent fiber), or long-lived background work in `Layer.effectDiscard(Effect.forkScoped(...))`.",
                    );
                  } else if (r?.kind === "CallExpression") {
                    const c = r.callee;
                    if (
                      (c?.kind === "MemberExpression" &&
                        c.object?.name === "Effect" &&
                        c.property?.name === "forkDetach") ||
                      (c?.kind === "Identifier" && c.name === "forkDetach")
                    ) {
                      addAstDiag(
                        c.span || r.span,
                        "DETACHED_FIBER",
                        "`Effect.forkDetach` creates a detached fiber nobody owns. It keeps running after its caller is interrupted. Use 'Effect.forkScoped' (tied to Scope) or 'Effect.forkChild' (tied to parent fiber) to ensure structured concurrency.",
                        "error",
                        "Detached fibers leak beyond the lifetime of the caller with no owner.",
                        "Use `Effect.forkScoped` (tied to Scope) or `Effect.forkChild` (tied to parent fiber), or long-lived background work in `Layer.effectDiscard(Effect.forkScoped(...))`.",
                      );
                    }
                  }
                }

                // § Pit of Success: Untyped literal error in Effect.fail
                if (node.kind === "CallExpression") {
                  const callee = node.callee;
                  const isFail =
                    (callee?.kind === "MemberExpression" &&
                      callee.object?.name === "Effect" &&
                      callee.property?.name === "fail") ||
                    (callee?.kind === "Identifier" && callee.name === "fail");
                  if (isFail && node.args?.length > 0) {
                    const arg = node.args[0];
                    if (
                      arg.kind === "StringLiteral" ||
                      arg.kind === "NumberLiteral"
                    ) {
                      addAstDiag(
                        arg.span || node.span,
                        "UNTYPED_ERROR",
                        "`Effect.fail` with untyped literal. In FunScript, library domain errors should be tagged (using Schema.TaggedError or Data.TaggedError) to enable type-safe error discrimination with 'catchTag'.",
                        "warning",
                        "Failing with raw strings or numbers prevents callers from discriminating errors with catchTag or pattern matching.",
                        "Define a tagged error schema or use `Data.TaggedError` to represent expected failures.",
                      );
                    }
                  }
                } else if (node.kind === "PipelineExpression") {
                  const r = node.right;
                  const isFail =
                    (r?.kind === "MemberExpression" &&
                      r.object?.name === "Effect" &&
                      r.property?.name === "fail") ||
                    (r?.kind === "Identifier" && r.name === "fail");
                  if (
                    isFail &&
                    (node.left?.kind === "StringLiteral" ||
                      node.left?.kind === "NumberLiteral")
                  ) {
                    addAstDiag(
                      node.left.span || node.span,
                      "UNTYPED_ERROR",
                      "`Effect.fail` with untyped literal. In FunScript, library domain errors should be tagged (using Schema.TaggedError or Data.TaggedError) to enable type-safe error discrimination with 'catchTag'.",
                      "warning",
                      "Failing with raw strings or numbers prevents callers from discriminating errors with catchTag or pattern matching.",
                      "Define a tagged error schema or use `Data.TaggedError` to represent expected failures.",
                    );
                  }
                }
              }

              if (
                node.kind === "RecordExpression" &&
                Array.isArray(node.entries)
              ) {
                for (const entry of node.entries) {
                  if (entry.kind === "FieldEntry") {
                    const key = entry.key?.name;
                    const val =
                      entry.value?.raw || entry.value?.parts?.[0]?.value;
                    if (
                      key === "concurrency" &&
                      (val === '"unbounded"' || val === "unbounded")
                    ) {
                      addAstDiag(
                        entry.span || node.span,
                        "UNBOUNDED_CONCURRENCY",
                        '`concurrency: "unbounded"` can overwhelm system resources. Specify an explicit concurrency limit (e.g. `{ concurrency: 10 }`).',
                        "warning",
                        "Unbounded concurrency can exhaust sockets, file handles, or memory under burst traffic.",
                        "Specify a bounded concurrency number, e.g. `{ concurrency: 10 }`.",
                      );
                    }
                  }
                }
              }

              // § Pit of Success: Eager evaluation in Effect.succeed
              const isPureDataConstructor = (expr: unknown): boolean => {
                if (!expr || typeof expr !== "object") return false;
                const e = expr as Record<string, unknown>;
                if (e.kind !== "CallExpression") return false;
                const c = e.callee as Record<string, unknown> | undefined;
                if (c?.kind === "MemberExpression") {
                  const obj = (c.object as { name?: string } | undefined)?.name;
                  const prop = (c.property as { name?: string } | undefined)
                    ?.name;
                  if (obj === "Option" && (prop === "some" || prop === "none"))
                    return true;
                  if (obj === "Chunk" && (prop === "empty" || prop === "make"))
                    return true;
                  if (
                    obj === "HashMap" &&
                    (prop === "empty" || prop === "make")
                  )
                    return true;
                  if (
                    obj === "HashSet" &&
                    (prop === "empty" || prop === "make")
                  )
                    return true;
                }
                return false;
              };

              if (node.kind === "CallExpression") {
                const callee = node.callee;
                const isSucceed =
                  (callee?.kind === "MemberExpression" &&
                    callee.object?.name === "Effect" &&
                    callee.property?.name === "succeed") ||
                  (callee?.kind === "Identifier" && callee.name === "succeed");
                if (isSucceed && node.args?.length > 0) {
                  const arg = node.args[0];
                  if (
                    (arg.kind === "CallExpression" &&
                      !isPureDataConstructor(arg)) ||
                    arg.kind === "NewExpression"
                  ) {
                    addAstDiag(
                      arg.span || node.span,
                      "EAGER_SUCCEED",
                      "`Effect.succeed` evaluates its argument eagerly at construction time. If the expression contains function calls or side effects, use `Effect.sync(() => ...)` for deferred evaluation.",
                      "warning",
                      "Passing a function call or constructor to Effect.succeed executes it immediately upon effect construction, not when the effect runs.",
                      "Use `Effect.sync(() => ...)` or `Effect.try(...)` to defer evaluation until the effect is executed.",
                    );
                  }
                }
              } else if (node.kind === "PipelineExpression") {
                const r = node.right;
                const isSucceed =
                  (r?.kind === "MemberExpression" &&
                    r.object?.name === "Effect" &&
                    r.property?.name === "succeed") ||
                  (r?.kind === "Identifier" && r.name === "succeed");
                if (isSucceed) {
                  const left = node.left;
                  if (
                    (left?.kind === "CallExpression" &&
                      !isPureDataConstructor(left)) ||
                    left?.kind === "NewExpression"
                  ) {
                    addAstDiag(
                      left.span || node.span,
                      "EAGER_SUCCEED",
                      "`Effect.succeed` evaluates its argument eagerly at construction time. If the expression contains function calls or side effects, use `Effect.sync(() => ...)` for deferred evaluation.",
                      "warning",
                      "Passing a function call or constructor to Effect.succeed executes it immediately upon effect construction, not when the effect runs.",
                      "Use `Effect.sync(() => ...)` or `Effect.try(...)` to defer evaluation until the effect is executed.",
                    );
                  }
                }
              }

              if (
                node.kind === "EffectBlockExpression" ||
                node.kind === "ParBlockExpression"
              ) {
                const readRefs = new Set<string>();
                const getRefOp = (
                  expr: unknown,
                ): { type: "get" | "set"; refName: string } | null => {
                  if (!expr || typeof expr !== "object") return null;
                  const e = expr as Record<string, unknown>;
                  if (e.kind !== "CallExpression") return null;
                  const c = e.callee as Record<string, unknown> | undefined;
                  if (!c || c.kind !== "MemberExpression") return null;
                  const obj = c.object as Record<string, unknown> | undefined;
                  const prop = (c.property as { name?: string } | undefined)
                    ?.name;
                  if (
                    (obj as { name?: string } | undefined)?.name === "Ref" &&
                    (prop === "get" || prop === "set")
                  ) {
                    const args = e.args as unknown[] | undefined;
                    const firstArg = args?.[0] as
                      Record<string, unknown> | undefined;
                    if (
                      firstArg &&
                      (firstArg.kind === "Identifier" ||
                        firstArg.kind === "UpperIdentifier")
                    ) {
                      return { type: prop, refName: firstArg.name as string };
                    }
                  } else if (
                    (prop === "get" || prop === "set") &&
                    (obj?.kind === "Identifier" ||
                      obj?.kind === "UpperIdentifier")
                  ) {
                    return { type: prop, refName: obj.name as string };
                  }
                  return null;
                };

                for (const stmt of node.body || []) {
                  let effExpr: unknown;
                  if (
                    stmt.kind === "EffectBindStatement" ||
                    stmt.kind === "EffectDiscardStatement"
                  ) {
                    effExpr = stmt.effect;
                  }
                  if (effExpr) {
                    const op = getRefOp(effExpr);
                    if (op) {
                      if (op.type === "get") {
                        readRefs.add(op.refName);
                      } else if (
                        op.type === "set" &&
                        readRefs.has(op.refName)
                      ) {
                        addAstDiag(
                          stmt.span,
                          "REF_RACE",
                          `Insecure non-atomic Ref mutation. Consecutive 'Ref.get' and 'Ref.set' on '${op.refName}' creates a concurrency race condition. Use 'Ref.update(${op.refName}, ...)' or 'Ref.modify' for atomic updates.`,
                          "error",
                          "Reading a Ref and subsequently writing to it in separate effect steps allows concurrent fibers to interleave and overwrite state updates.",
                          `Use 'Ref.update(${op.refName}, ...)' or 'Ref.modify' for atomic updates.`,
                        );
                      }
                    }
                  }
                }
              }

              if (node.kind === "EffectBlockExpression" && !node.unscoped) {
                const isUnit =
                  (node.finalExpression?.kind === "Identifier" ||
                    node.finalExpression?.kind === "UpperIdentifier") &&
                  node.finalExpression.name === "Void";

                if (!isUnit) {
                  const findFinalizer = (
                    n: unknown,
                  ): { name: string; span: Span } | null => {
                    if (!n || typeof n !== "object") return null;
                    const objNode = n as Record<string, unknown>;
                    if (
                      objNode !== node &&
                      objNode.kind === "EffectBlockExpression"
                    )
                      return null;
                    if (objNode.kind === "CallExpression") {
                      const callee = objNode.callee as
                        Record<string, unknown> | undefined;
                      if (callee?.kind === "MemberExpression") {
                        const obj = (
                          callee.object as { name?: string } | undefined
                        )?.name;
                        const prop = (
                          callee.property as { name?: string } | undefined
                        )?.name;
                        if (
                          (obj === "Effect" || obj === "Scope") &&
                          (prop === "addFinalizer" || prop === "acquireRelease")
                        ) {
                          return {
                            name: `${obj}.${prop}`,
                            span: objNode.span as Span,
                          };
                        }
                      } else if (callee?.kind === "Identifier") {
                        const calleeName = (callee as { name?: string }).name;
                        if (
                          calleeName === "addFinalizer" ||
                          calleeName === "acquireRelease"
                        ) {
                          return {
                            name: calleeName,
                            span: objNode.span as Span,
                          };
                        }
                      }
                    }
                    for (const k of Object.keys(objNode)) {
                      if (k === "span") continue;
                      const val = objNode[k];
                      if (Array.isArray(val)) {
                        for (const item of val) {
                          const res = findFinalizer(item);
                          if (res) return res;
                        }
                      } else if (val && typeof val === "object") {
                        const res = findFinalizer(val);
                        if (res) return res;
                      }
                    }
                    return null;
                  };

                  let detectedCall: { name: string; span: Span } | null = null;
                  for (const stmt of node.body || []) {
                    const res = findFinalizer(stmt);
                    if (res) {
                      detectedCall = res;
                      break;
                    }
                  }
                  if (!detectedCall && node.finalExpression) {
                    detectedCall = findFinalizer(node.finalExpression);
                  }

                  if (detectedCall) {
                    const callInfo: { name: string; span: Span } = detectedCall;
                    addAstDiag(
                      callInfo.span,
                      "PREMATURE_FINALIZER_CLOSE",
                      `Finalizer registered with '${callInfo.name}' in a scoped effect block will execute immediately when this function returns, closing the returned resource.`,
                      "error",
                      "By default, 'effect' blocks create a scoped boundary ('Effect.scoped'). Any finalizer registered via 'Effect.addFinalizer' or 'Effect.acquireRelease' executes as soon as the block returns, tearing down the resource before the caller can use it.",
                      "Change 'effect' to 'effect (unscoped)' so the resource's lifetime is bound to the caller's scope, or return 'Void' if all work is completed inside this block.",
                    );
                  }
                }
              }

              const nodeRecord = node as Record<string, unknown>;
              for (const k of Object.keys(nodeRecord)) {
                if (k === "span") continue;
                const child = nodeRecord[k];
                const nextInMatchArm =
                  node.kind === "MatchArm" && k === "body"
                    ? true
                    : currentInMatchArm;
                if (Array.isArray(child)) {
                  for (const c of child)
                    walkAst(
                      c as AstInspectNode,
                      node,
                      currentInMut,
                      nextInMatchArm,
                    );
                } else if (child && typeof child === "object") {
                  walkAst(
                    child as AstInspectNode,
                    node,
                    currentInMut,
                    nextInMatchArm,
                  );
                }
              }
            };
            walkAst(meta.ast);
            checkCapturedMutInEffect(meta.ast, addAstDiag);
          }

          const visit = (node: ts.Node): void => {
            if (
              ts.isFunctionDeclaration(node) &&
              (node.name?.text === "__funscriptJs" ||
                node.name?.text === "fromNullishOrElse" ||
                node.name?.text === "fromNullishOr" ||
                node.name?.text === "optionTry")
            )
              return;
            if (
              ts.isClassDeclaration(node) &&
              node.name?.text === "JsInteropError"
            )
              return;
            if (ts.isReturnStatement(node) && node.expression) {
              let enc: ts.Node | undefined = node.parent;
              while (
                enc &&
                !ts.isFunctionExpression(enc) &&
                !ts.isArrowFunction(enc) &&
                !ts.isFunctionDeclaration(enc)
              ) {
                enc = enc.parent;
              }
              if (enc && ts.isFunctionExpression(enc) && enc.asteriskToken) {
                const parentCall = enc.parent;
                if (parentCall && ts.isCallExpression(parentCall)) {
                  const calleeText = parentCall.expression.getText(sf);
                  if (
                    calleeText === "Effect.gen" ||
                    calleeText.endsWith(".gen")
                  ) {
                    const retType = checker.getTypeAtLocation(node.expression);
                    if (isEffectType(retType)) {
                      addCustomDiag(
                        node.expression,
                        "NESTED_EFFECT",
                        "Returning an Effect from inside an 'effect' block creates a nested 'Effect<Effect<...>>' that will not be executed. Use '<-' to bind and execute the effect (e.g. 'result <- <effect>; => result').",
                        "An 'effect' block automatically wraps its final value in an Effect. Returning an Effect without binding it means the inner effect is returned as unexecuted data.",
                        "Bind the effect with `<-` before returning it, or return a non-Effect value.",
                      );
                    }
                  }
                }
              }
            } else if (
              ts.isYieldExpression(node) &&
              node.asteriskToken &&
              node.expression
            ) {
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
            } else if (
              ts.isVariableDeclaration(node) &&
              ts.isIdentifier(node.name) &&
              !node.type
            ) {
              if (unannotatedBindings.has(node.name.text)) {
                const type = checker.getTypeAtLocation(node.name);
                if (type.flags & ts.TypeFlags.Any) {
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
                if (targetType.flags & ts.TypeFlags.Any) {
                  if (
                    !ts.isPropertyAccessExpression(node.expression) &&
                    !ts.isElementAccessExpression(node.expression)
                  ) {
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
              if (targetType.flags & ts.TypeFlags.Any) {
                if (
                  !ts.isPropertyAccessExpression(node.expression) &&
                  !ts.isElementAccessExpression(node.expression)
                ) {
                  addCustomDiag(
                    node.argumentExpression,
                    "ANY_ACCESS",
                    "Cannot access index on untyped 'any' value. External values must be typed as 'Unknown' and validated with a schema.",
                  );
                }
              }
            } else if (ts.isCallExpression(node)) {
              const calleeType = checker.getTypeAtLocation(node.expression);
              if (calleeType.flags & ts.TypeFlags.Any) {
                if (
                  !ts.isPropertyAccessExpression(node.expression) &&
                  !ts.isElementAccessExpression(node.expression)
                ) {
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

      const errorCount = tsDiagnostics.filter(
        (d) => d.category === "error",
      ).length;
      const warningCount = tsDiagnostics.filter(
        (d) => d.category === "warning",
      ).length;
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
    catch: (error: unknown) =>
      new Error(`Type-checking failed: ${toErrorMessage(error)}`),
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
      const fullPath = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(cwd, filePath);
      const content = yield* Effect.tryPromise({
        try: () => fs.readFile(fullPath, "utf-8"),
        catch: (err: unknown) =>
          new Error(
            `Failed to read file '${filePath}': ${toErrorMessage(err)}`,
          ),
      });
      virtualFiles[filePath] = content;
    }

    return yield* typeCheckVirtualFiles(virtualFiles, options);
  });
