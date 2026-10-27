import { Effect, Console } from "effect";
import { Lexer, LexerError } from "./lexer/lexer.js";
import { Parser, ParseError } from "./parser/parser.js";
import { Emitter } from "./emitter/emitter.js";
import { Program } from "./ast/types.js";

export interface CompileResult {
  source: string;
  ast: Program;
  typescript: string;
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

      return {
        source,
        ast,
        typescript,
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
