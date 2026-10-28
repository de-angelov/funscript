import { describe, it, expect } from "vitest";
import { FunScriptError } from "../src/errors.js";
import { LexerError, Lexer } from "../src/lexer/lexer.js";
import { ParseError, Parser } from "../src/parser/parser.js";
import { CompilerError } from "../src/compiler.js";
import { Span } from "../src/ast/types.js";

describe("FunScript Unified Error Hierarchy", () => {
  const dummySpan: Span = {
    start: { line: 2, column: 5, offset: 10 },
    end: { line: 2, column: 12, offset: 17 },
  };

  it("FunScriptError creates base error with span and formatted message", () => {
    const err = new FunScriptError("Base syntax problem", dummySpan);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(FunScriptError);
    expect(err.name).toBe("FunScriptError");
    expect(err.span).toEqual(dummySpan);
    expect(err.message).toContain("Base syntax problem at line 2, col 5");
  });

  it("LexerError extends FunScriptError", () => {
    const lexErr = new LexerError("Unexpected character", dummySpan);
    expect(lexErr).toBeInstanceOf(Error);
    expect(lexErr).toBeInstanceOf(FunScriptError);
    expect(lexErr).toBeInstanceOf(LexerError);
    expect(lexErr.name).toBe("LexerError");
    expect(lexErr.span).toEqual(dummySpan);
    expect(lexErr.message).toContain("Unexpected character at line 2, col 5");
  });

  it("Lexer throws LexerError inheriting from FunScriptError", () => {
    expect(() => {
      new Lexer("\tinvalidTabIndentation").tokenize();
    }).toThrowError(FunScriptError);
  });

  it("ParseError extends FunScriptError", () => {
    const parseErr = new ParseError("Expected token", dummySpan);
    expect(parseErr).toBeInstanceOf(Error);
    expect(parseErr).toBeInstanceOf(FunScriptError);
    expect(parseErr).toBeInstanceOf(ParseError);
    expect(parseErr.name).toBe("ParseError");
    expect(parseErr.span).toEqual(dummySpan);
    expect(parseErr.message).toContain("Expected token at line 2, col 5");
  });

  it("Parser throws ParseError inheriting from FunScriptError", () => {
    const lexer = new Lexer("fn foo ->");
    const tokens = lexer.tokenize();
    const parser = new Parser(tokens);
    expect(() => {
      parser.parse();
    }).toThrowError(FunScriptError);
  });

  it("CompilerError extends FunScriptError and preserves underlying error and span", () => {
    const lexErr = new LexerError("Lexer issue", dummySpan);
    const compErr = new CompilerError("Compilation failed", lexErr);

    expect(compErr).toBeInstanceOf(Error);
    expect(compErr).toBeInstanceOf(FunScriptError);
    expect(compErr).toBeInstanceOf(CompilerError);
    expect(compErr.name).toBe("CompilerError");
    expect(compErr._tag).toBe("CompilerError");
    expect(compErr.error).toBe(lexErr);
    expect(compErr.span).toEqual(dummySpan);
  });
});
