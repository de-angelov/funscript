import { Effect } from "effect";
import MagicString, { type SourceMap } from "magic-string";
import ts from "typescript";
import { Lexer, LexerError } from "./lexer/lexer.js";
import { Parser, ParseError } from "./parser/parser.js";
import { Emitter } from "./emitter/emitter.js";
import { Program } from "./ast/types.js";
import { FunScriptError } from "./errors.js";
import { TypeScriptCompilationContext } from "./compiler/typescript-compilation-context.js";
import { validateNumericComparisons } from "./compiler/numeric-comparisons.js";
import { inferPipelineCompanions } from "./compiler/pipeline-companions.js";

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
