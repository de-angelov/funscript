import { describe, it, expect } from "vitest";
import { Lexer, LexerError } from "../src/lexer/lexer.js";
import { TokenType } from "../src/lexer/tokens.js";

describe("FunScript Lexer", () => {
  it("tokenizes basic bindings and numbers", () => {
    const code = `x = 42\ny = 3.14`;
    const lexer = new Lexer(code);
    const tokens = lexer.tokenize();

    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.IDENTIFIER,
      TokenType.EQ,
      TokenType.NUMBER,
      TokenType.NEWLINE,
      TokenType.IDENTIFIER,
      TokenType.EQ,
      TokenType.NUMBER,
      TokenType.EOF,
    ]);
  });

  it("handles 2-space indentation (INDENT and DEDENT)", () => {
    const code = `match x\n  | 1 -> "one"\n  | _ -> "other"`;
    const lexer = new Lexer(code);
    const tokens = lexer.tokenize();

    expect(tokens.some((t) => t.type === TokenType.INDENT)).toBe(true);
    expect(tokens.some((t) => t.type === TokenType.DEDENT)).toBe(true);
  });

  it("tokenizes string interpolation", () => {
    const code = `greeting = "Hello, {name}!"`;
    const lexer = new Lexer(code);
    const tokens = lexer.tokenize();

    expect(tokens.map((t) => t.type)).toEqual([
      TokenType.IDENTIFIER,
      TokenType.EQ,
      TokenType.STRING_PART,
      TokenType.INTERPOLATION_START,
      TokenType.IDENTIFIER,
      TokenType.INTERPOLATION_END,
      TokenType.STRING_PART,
      TokenType.EOF,
    ]);
  });

  it("rejects banned keywords with friendly diagnostics", () => {
    expect(() => new Lexer(`let x = 1`).tokenize()).toThrow(LexerError);
    expect(() => new Lexer(`var x = 1`).tokenize()).toThrow(LexerError);
    expect(() => new Lexer(`function add() {}`).tokenize()).toThrow(LexerError);
  });

  it("rejects banned symbols with friendly diagnostics", () => {
    expect(() => new Lexer(`a === b`).tokenize()).toThrow(LexerError);
    expect(() => new Lexer(`a && b`).tokenize()).toThrow(LexerError);
    expect(() => new Lexer(`!a`).tokenize()).toThrow(LexerError);
  });
});
