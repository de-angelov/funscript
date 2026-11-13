import { prepareAssemblyScript } from "./emitter/assemblyscript.js";
import { Effect } from "effect";
import type { SourceMap } from "magic-string";
import { generateSourceMap } from "./compiler/source-map.js";
import { Lexer, LexerError } from "./lexer/lexer.js";
import { Parser, ParseError } from "./parser/parser.js";
import { Emitter, type EmitterOptions } from "./emitter/emitter.js";
import { Program, type RecordTypeNode } from "./ast/types.js";
import { FunScriptError } from "./errors.js";
import { TypeScriptCompilationContext } from "./compiler/typescript-context.js";
import { validateNumericComparisons } from "./compiler/numeric-comparisons.js";
import { inferPipelineCompanions } from "./compiler/pipeline-companions.js";
import { applyJsInteropNullability } from "./compiler/js-interop-nullability.js";
import { resolveImportedSchemas } from "./compiler/imported-schemas.js";
import { resolveImportedRecordFunctions } from "./compiler/imported-record-functions.js";
import { resolvePackageRecordContracts } from "./compiler/package-record-contracts.js";

export {
  TypeScriptCompilationContext,
  TYPE_FEST_DECLARATION,
} from "./compiler/typescript-context.js";

export interface CompileOptions {
  sourcemap?: boolean;
  outputFile?: string;
  context?: TypeScriptCompilationContext;
  /** In-memory source files, keyed by absolute path, for cross-module analysis. */
  virtualSources?: ReadonlyMap<string, string>;
  /** Absolute source path when the displayed filename is project-relative. */
  sourcePath?: string;
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
 * Compiles FunScript source code directly to TypeScript code as an Effect.
 */
export const compileString = (
  source: string,
  filename: string = "<anonymous>",
  options?: CompileOptions,
): Effect.Effect<CompileResult, CompilerError> =>
  Effect.flatMap(
    /\bas[ \t]*\{/.test(source)
      ? Effect.flatMap(Effect.try({
          try: () => new Parser(new Lexer(source, filename).tokenize(), filename, source).parse(),
          catch: (error: any) => new CompilerError(error.message, error),
        }), ast => {
          const blocks = ast.body.filter(decl => decl.kind === "AsDeclaration");
          return blocks.length === 0 ? Effect.succeed(ast) : Effect.tryPromise({
            try: async () => { for (const decl of blocks) await prepareAssemblyScript(decl); return ast; },
            catch: (error: any) => new CompilerError(error.message, error),
          });
        })
      : Effect.succeed(undefined),
    (preparedAst) => Effect.try({
    try: () => {
      // 1. Tokenize
      const lexer = new Lexer(source, filename);
      const tokens = lexer.tokenize();

      // 2. Parse AST
      const parser = new Parser(tokens, filename, source);
      const ast = preparedAst ?? parser.parse();

      // 3. Emit TypeScript
      const context = options?.context ?? new TypeScriptCompilationContext(options?.sourcePath ?? filename);
      context.setFilename(options?.sourcePath ?? filename);
      const importedRecordContracts = new Map<string, RecordTypeNode>();
      const importedRecordFunctions = resolveImportedRecordFunctions(ast, options?.sourcePath ?? filename, options?.virtualSources, importedRecordContracts);
      for (const [name, contract] of resolvePackageRecordContracts(ast, context, importedRecordContracts)) importedRecordContracts.set(name, contract);
      validateNumericComparisons(ast, source, context, importedRecordFunctions, importedRecordContracts);
      const { pipelineCompanions, stageResolutions, directCallResolutions } = inferPipelineCompanions(ast, context, importedRecordFunctions, importedRecordContracts);
      const importedSchemas = resolveImportedSchemas(ast, source, context);
      const emitterOptions: EmitterOptions = {
        pipelineCompanions,
        stageResolutions,
        directCallResolutions,
        importedSchemas,
        importedRecordFunctions,
        importedRecordContracts,
        isJsx: filename.endsWith(".funx"),
      };
      const emitter = new Emitter(ast, undefined, emitterOptions);
      const typescript = applyJsInteropNullability(emitter.emit(), context);
      const targetExtension = filename.endsWith(".funx") ? ".tsx" : ".ts";

      const map = (options?.sourcemap ?? true)
        ? generateSourceMap(source, filename, typescript, ast, emitterOptions, options?.outputFile)
        : undefined;

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
  }));

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
