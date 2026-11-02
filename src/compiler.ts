import { Effect } from "effect";
import MagicString, { type SourceMap } from "magic-string";
import ts from "typescript";
import { Lexer, LexerError } from "./lexer/lexer.js";
import { Parser, ParseError } from "./parser/parser.js";
import { Emitter } from "./emitter/emitter.js";
import { type PipelineCompanionModule } from "./emitter/pipeline-catalog.js";
import { Program, type Span } from "./ast/types.js";
import { FunScriptError } from "./errors.js";

export interface CompileOptions {
  sourcemap?: boolean;
  outputFile?: string;
}

export interface CompileResult {
  source: string;
  ast: Program;
  typescript: string;
  targetExtension: string;
  map?: SourceMap;
  sourcemap?: SourceMap;
}

export class CompilerError extends FunScriptError {
  readonly _tag = "CompilerError";
  constructor(
    public readonly message: string,
    public readonly error: LexerError | ParseError | Error,
  ) {
    const span = "span" in error ? (error as any).span : undefined;
    super(message, span);
    this.name = "CompilerError";
  }
}

class NumericComparisonError extends Error {
  constructor(message: string, readonly span: Span) {
    super(message);
    this.name = "NumericComparisonError";
  }
}

/** Reuses the host, library files and previous program throughout one compilation. */
class TypeScriptCompilationContext {
  private readonly options: ts.CompilerOptions = {
    strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, jsx: ts.JsxEmit.Preserve,
  };
  private readonly virtualFile: string;
  private readonly normalized: string;
  private readonly host: ts.CompilerHost;
  private source = "";
  private program?: ts.Program;

  constructor(filename: string) {
    this.virtualFile = filename.endsWith(".funx") ? filename.slice(0, -5) + ".tsx"
      : filename.endsWith(".fun") ? filename.slice(0, -4) + ".ts" : filename + ".ts";
    this.normalized = ts.sys.resolvePath(this.virtualFile);
    const host = ts.createCompilerHost(this.options, true);
    const getSourceFile = host.getSourceFile.bind(host);
    const sourceFiles = new Map<string, ts.SourceFile>();
    const readFile = host.readFile.bind(host);
    const fileExists = host.fileExists.bind(host);
    host.getSourceFile = (name, version, onError, shouldCreateNewSourceFile) => {
      const key = ts.sys.resolvePath(name);
      if (key === this.normalized) return ts.createSourceFile(name, this.source, version, true);
      const cached = sourceFiles.get(key);
      if (cached && !shouldCreateNewSourceFile) return cached;
      const file = getSourceFile(name, version, onError, shouldCreateNewSourceFile);
      if (file) sourceFiles.set(key, file);
      return file;
    };
    host.readFile = (name) => ts.sys.resolvePath(name) === this.normalized ? this.source : readFile(name);
    host.fileExists = (name) => ts.sys.resolvePath(name) === this.normalized || fileExists(name);
    this.host = host;
  }

  check(source: string): { sourceFile: ts.SourceFile; checker: ts.TypeChecker } | undefined {
    this.source = source;
    this.program = ts.createProgram({ rootNames: [this.virtualFile], options: this.options, host: this.host, oldProgram: this.program });
    const sourceFile = this.program.getSourceFile(this.normalized) ?? this.program.getSourceFile(this.virtualFile);
    return sourceFile ? { sourceFile, checker: this.program.getTypeChecker() } : undefined;
  }
}

function spanAtOffset(source: string, offset: number): Span {
  const prefix = source.slice(0, offset);
  const lines = prefix.split(/\r?\n/);
  const position = {
    offset,
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
  return { start: position, end: position };
}

/**
 * Native relational operators deliberately have a much narrower domain than
 * JavaScript: both operands must be proven numbers. This keeps string,
 * locale, and domain ordering explicit through Effect's Order API.
 */
function validateNumericComparisons(ast: Program, source: string, context: TypeScriptCompilationContext): void {
  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markNumericComparisonOperands: true,
  }).emit();
  if (!marked.includes("__funscriptNumericOperand(")) return;

  const generated = `const __funscriptNumericOperand = <T,>(_offset: number, _operator: string, value: T): T => value;\n${marked}`;
  const checked = context.check(generated);
  if (!checked) return;
  const { sourceFile, checker } = checked;

  const isDefinitelyNumber = (type: ts.Type): boolean => {
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    if (type.isUnion()) return type.types.every(isDefinitelyNumber);
    if (type.flags & ts.TypeFlags.TypeParameter) {
      const constraint = checker.getBaseConstraintOfType(type);
      return constraint !== undefined && constraint !== type && isDefinitelyNumber(constraint);
    }
    return Boolean(type.flags & ts.TypeFlags.NumberLike);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__funscriptNumericOperand" &&
      node.arguments.length === 3 &&
      ts.isNumericLiteral(node.arguments[0]) &&
      ts.isStringLiteral(node.arguments[1])
    ) {
      const type = checker.getTypeAtLocation(node.arguments[2]);
      if (!isDefinitelyNumber(type)) {
        const operator = node.arguments[1].text;
        const helper = operator.startsWith(">") ? "isGreaterThan" : "isLessThan";
        const received = checker.typeToString(type);
        throw new NumericComparisonError(
          `${operator} is only available for numbers; this operand has type ${received}. Use Order.${helper}(String.Order)(...) or an explicit domain Order.`,
          spanAtOffset(source, Number(node.arguments[0].text)),
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

/**
 * Finds the source type of every pipeline before final emission. The marker is
 * an identity function, so TypeScript sees precisely the expression that will
 * become the first argument to `pipe`, including imports and function calls.
 */
function inferPipelineCompanions(ast: Program, context: TypeScriptCompilationContext): ReadonlyMap<number, PipelineCompanionModule> {
  const marked = new Emitter(ast, undefined, {
    allowAmbiguousPipeline: true,
    markPipelineSources: true,
  }).emit();
  if (!marked.includes("__funscriptPipelineSource(")) return new Map();

  // The provisional emitter deliberately leaves unresolved stages bare. Add
  // companion imports here so source expressions such as `Option.some(...)`
  // still receive their real TypeScript type during this analysis pass.
  const source = `import { Array, Chunk, Effect, Layer, Option, Result, Schedule, Schema, Stream } from "effect";\nconst __funscriptPipelineSource = <T>(_id: number, value: T): T => value;\n${marked}`;
  const checked = context.check(source);
  if (!checked) return new Map();
  const { sourceFile, checker } = checked;
  const companions = new Map<number, PipelineCompanionModule>();

  const companionForType = (type: ts.Type): PipelineCompanionModule | undefined => {
    const printed = checker.typeToString(type);
    if (/^Option(?:<|$)/.test(printed)) return "Option";
    if (/^Result(?:<|$)/.test(printed)) return "Result";
    if (/^Chunk(?:<|$)/.test(printed)) return "Chunk";
    if (/^Effect(?:<|$)/.test(printed)) return "Effect";
    if (/^Schedule(?:<|$)/.test(printed)) return "Schedule";
    if (/^Layer(?:<|$)/.test(printed)) return "Layer";
    if (/^Stream(?:<|$)/.test(printed)) return "Stream";
    if (/^Schema(?:<|$)/.test(printed)) return "Schema";
    if (type.isUnion()) {
      const members = [...new Set(type.types.map(companionForType).filter((member): member is PipelineCompanionModule => Boolean(member)))];
      return members.length === 1 ? members[0] : undefined;
    }
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
    if (checker.isArrayType(type) || checker.isTupleType(type)) return "Array";
    const symbol = type.aliasSymbol ?? type.getSymbol();
    switch (symbol?.getName()) {
      case "Option": return "Option";
      case "Result": return "Result";
      case "Chunk": return "Chunk";
      case "Effect": return "Effect";
      default: {
        // Some Effect interfaces retain a concrete implementation symbol
        // (for example `Some`) while printing as their public companion type.
        if (/^Option(?:<|$)/.test(printed)) return "Option";
        if (/^Result(?:<|$)/.test(printed)) return "Result";
        if (/^Chunk(?:<|$)/.test(printed)) return "Chunk";
        if (/^Effect(?:<|$)/.test(printed)) return "Effect";
        if (/^Schedule(?:<|$)/.test(printed)) return "Schedule";
        if (/^Layer(?:<|$)/.test(printed)) return "Layer";
        if (/^Stream(?:<|$)/.test(printed)) return "Stream";
        if (/^Schema(?:<|$)/.test(printed)) return "Schema";
        return undefined;
      }
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__funscriptPipelineSource" &&
      node.arguments.length === 2 &&
      ts.isNumericLiteral(node.arguments[0])
    ) {
      const companion = companionForType(checker.getTypeAtLocation(node.arguments[1]));
      if (companion) companions.set(Number(node.arguments[0].text), companion);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return companions;
}

/**
 * Resolves the awaited TypeScript type of each generated js interop call. The
 * emitter deliberately keeps its interface small: it always emits the same
 * adapter and this pass supplies the one runtime fact that TypeScript erases —
 * whether the resolved native value can be null or undefined.
 */
function applyJsInteropNullability(typescript: string, context: TypeScriptCompilationContext): string {
  if (!typescript.includes("__funscriptJs(")) return typescript;

  const checked = context.check(typescript);
  if (!checked) return typescript;
  const { sourceFile, checker } = checked;
  const replacements: Array<{ start: number; end: number; value: "true" | "false" | '"unknown"' }> = [];

  const includesNullish = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(includesNullish);
    return Boolean(type.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined));
  };
  const isUntrusted = (type: ts.Type): boolean => {
    if (type.isUnion()) return type.types.some(isUntrusted);
    return Boolean(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown));
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "__funscriptJs" &&
      node.arguments.length === 2 &&
      ts.isArrowFunction(node.arguments[0])
    ) {
      const returnType = checker.getTypeAtLocation(node.arguments[0].body);
      const awaited = checker.getAwaitedType(returnType);
      const flag = !awaited || isUntrusted(awaited)
        ? '"unknown"'
        : includesNullish(awaited)
        ? "true"
        : "false";
      replacements.push({ start: node.arguments[1].getStart(sourceFile), end: node.arguments[1].getEnd(), value: flag });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    typescript = typescript.slice(0, replacement.start) + replacement.value + typescript.slice(replacement.end);
  }
  return typescript;
}

/**
 * Compiles FunScript source code directly to TypeScript code as an Effect.
 */
export const compileString = (
  source: string,
  filename: string = "<anonymous>",
  options?: CompileOptions,
): Effect.Effect<CompileResult, CompilerError> =>
  Effect.try({
    try: () => {
      // 1. Tokenize
      const lexer = new Lexer(source, filename);
      const tokens = lexer.tokenize();

      // 2. Parse AST
      const parser = new Parser(tokens, filename, source);
      const ast = parser.parse();

      // 3. Emit TypeScript
      const context = new TypeScriptCompilationContext(filename);
      validateNumericComparisons(ast, source, context);
      const pipelineCompanions = inferPipelineCompanions(ast, context);
      const emitter = new Emitter(ast, undefined, { pipelineCompanions });
      const typescript = applyJsInteropNullability(emitter.emit(), context);
      const targetExtension = filename.endsWith(".funx") ? ".tsx" : ".ts";

      // 4. Source map generation using magic-string
      let map: SourceMap | undefined;
      const wantsSourceMap = options?.sourcemap ?? true;

      if (wantsSourceMap) {
        const outTarget = options?.outputFile
          ? options.outputFile
          : filename.endsWith(".funx")
          ? `${filename.slice(0, -5)}.tsx`
          : filename.endsWith(".fun")
          ? `${filename.slice(0, -4)}.ts`
          : `${filename}.ts`;

        const s = new MagicString(source);

        const headerLines: string[] = [];
        for (const line of typescript.split("\n")) {
          if (line.startsWith("import ")) headerLines.push(line);
          else if (line.trim() === "" && headerLines.length > 0) break;
        }
        const header = headerLines.length > 0 ? headerLines.join("\n") + "\n\n" : "";

        if (ast.body.length === 0) {
          if (source.length > 0) {
            s.overwrite(0, source.length, typescript);
          }
        } else {
          for (let i = 0; i < ast.body.length; i++) {
            const decl = ast.body[i];
            const nextDecl = ast.body[i + 1];
            const single = new Emitter(
              { kind: "Program", body: [decl], span: decl.span },
              ast,
              { pipelineCompanions },
            );
            const singleOut = single.emit();
            const code = singleOut
              .split("\n")
              .filter((l) => !l.startsWith("import "))
              .join("\n")
              .trim();
            const startOffset = i === 0 ? 0 : decl.span.start.offset;
            const endOffset = nextDecl ? nextDecl.span.start.offset : source.length;
            const isLast = i === ast.body.length - 1;
            const replacement = code + (isLast ? "\n" : "\n\n");
            s.overwrite(startOffset, endOffset, replacement);
          }
        }

        if (header.length > 0) {
          s.prepend(header);
        }

        if (s.toString() !== typescript) {
          const fallback = new MagicString(source);
          if (source.length > 0) {
            fallback.overwrite(0, source.length, typescript);
          }
          map = fallback.generateMap({
            source: filename,
            file: outTarget,
            hires: true,
            includeContent: true,
          });
        } else {
          map = s.generateMap({
            source: filename,
            file: outTarget,
            hires: true,
            includeContent: true,
          });
        }
      }

      return {
        source,
        ast,
        typescript,
        targetExtension,
        map,
        sourcemap: map,
      };
    },
    catch: (error: any) => new CompilerError(error.message, error),
  });

/**
 * Parses and checks a FunScript source string.
 */
export const checkString = (
  source: string,
  filename: string = "<anonymous>",
): Effect.Effect<Program, CompilerError> =>
  Effect.try({
    try: () => {
      const lexer = new Lexer(source, filename);
      const tokens = lexer.tokenize();
      const parser = new Parser(tokens, filename, source);
      return parser.parse();
    },
    catch: (error: any) => new CompilerError(error.message, error),
  });
