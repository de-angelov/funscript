import { Effect } from "effect";
import MagicString, { type SourceMap } from "magic-string";
import { Lexer, LexerError } from "./lexer/lexer.js";
import { Parser, ParseError } from "./parser/parser.js";
import { Emitter } from "./emitter/emitter.js";
import { Program } from "./ast/types.js";

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

export class CompilerError {
  readonly _tag = "CompilerError";
  constructor(public readonly message: string, public readonly error: LexerError | ParseError | Error) {}
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
      const emitter = new Emitter(ast);
      const typescript = emitter.emit();
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
            const single = new Emitter({ kind: "Program", body: [decl], span: decl.span });
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
