import { describe, it, expect } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser, ParseError } from "../src/parser/parser.js";
import { Program, BindingDeclaration } from "../src/ast/types.js";

function createParser(source: string, filename = "test.fun"): Parser {
  const lexer = new Lexer(source, filename);
  const tokens = lexer.tokenize();
  return new Parser(tokens, filename, source);
}

describe("Parser Error Recovery & Multi-Diagnostic Reporting", () => {
  describe("Top-Level Statement Synchronization", () => {
    it("collects multiple syntax errors across top-level declarations in a single run", () => {
      const source = [
        "a = 1 +",
        "b = 20",
        "c = * 3",
        "d = 40",
      ].join("\n");

      const parser = createParser(source);
      const ast = parser.parse(false);

      expect(parser.diagnostics.length).toBe(2);
      expect(parser.diagnostics[0].span.start.line).toBe(1);
      expect(parser.diagnostics[1].span.start.line).toBe(3);

      // Successfully parsed declarations should be present in AST body
      expect(ast.body.length).toBe(2);
      const bDecl = ast.body[0] as BindingDeclaration;
      expect(bDecl.kind).toBe("BindingDeclaration");
      expect(bDecl.id.name).toBe("b");

      const dDecl = ast.body[1] as BindingDeclaration;
      expect(dDecl.kind).toBe("BindingDeclaration");
      expect(dDecl.id.name).toBe("d");
    });

    it("recovers across different declaration kinds (schema, binding, import)", () => {
      const source = [
        "schema User", // missing '='
        "validVar = 100",
        "import { unclosed", // unclosed import
        "anotherVar = 200",
      ].join("\n");

      const parser = createParser(source);
      const ast = parser.parse(false);

      expect(parser.diagnostics.length).toBe(2);
      expect(parser.diagnostics[0].message).toContain("Expected '=' after schema name");
      expect(parser.diagnostics[0].span.start.line).toBe(1);

      expect(parser.diagnostics[1].span.start.line).toBe(3);

      // Valid declarations should be captured
      expect(ast.body.length).toBe(2);
      expect((ast.body[0] as BindingDeclaration).id.name).toBe("validVar");
      expect((ast.body[1] as BindingDeclaration).id.name).toBe("anotherVar");
    });

    it("reports diagnostics with accurate line and column spans", () => {
      const source = [
        "x = 10 +",
        "y = 20 +",
      ].join("\n");

      const parser = createParser(source);
      parser.parse(false);

      expect(parser.diagnostics.length).toBe(2);
      for (const diag of parser.diagnostics) {
        expect(diag).toBeInstanceOf(ParseError);
        expect(diag.span).toBeDefined();
        expect(diag.span.start.line).toBeGreaterThan(0);
        expect(diag.span.start.column).toBeGreaterThan(0);
      }
      expect(parser.diagnostics[0].span.start.line).toBe(1);
      expect(parser.diagnostics[1].span.start.line).toBe(2);
    });
  });

  describe("Block Statement Synchronization", () => {
    it("recovers and collects multiple errors inside a function body", () => {
      const source = [
        "compute = (x: Int) ->",
        "  a = 1 +",
        "  b = 10",
        "  c = 2 +",
        "  b + 5",
      ].join("\n");

      const parser = createParser(source);
      const ast = parser.parse(false);

      expect(parser.diagnostics.length).toBe(2);
      expect(parser.diagnostics[0].span.start.line).toBe(2);
      expect(parser.diagnostics[1].span.start.line).toBe(4);

      expect(ast.body.length).toBe(1);
      const fnDecl = ast.body[0] as BindingDeclaration;
      expect(fnDecl.id.name).toBe("compute");
    });
  });

  describe("throwOnError Behavior", () => {
    it("throws the first ParseError when throwOnError is true (default), while retaining all diagnostics", () => {
      const source = [
        "err1 = 1 +",
        "err2 = 2 +",
        "valid = 3",
      ].join("\n");

      const parser = createParser(source);
      let caughtError: any = null;

      try {
        parser.parse();
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(ParseError);
      expect(caughtError.span.start.line).toBe(1);
      expect(caughtError.diagnostics).toBeDefined();
      expect(caughtError.diagnostics.length).toBe(2);
      expect(parser.diagnostics.length).toBe(2);
    });

    it("does not throw when throwOnError is explicitly false", () => {
      const source = [
        "bad1 = 1 +",
        "bad2 = 2 +",
      ].join("\n");

      const parser = createParser(source);
      let ast: Program | null = null;
      expect(() => {
        ast = parser.parse({ throwOnError: false });
      }).not.toThrow();

      expect(ast).not.toBeNull();
      expect(parser.diagnostics.length).toBe(2);
    });
  });

  describe("Valid Programs", () => {
    it("produces zero diagnostics and complete AST for valid FunScript code", () => {
      const source = [
        "name = \"FunScript\"",
        "add = (a: Int, b: Int) -> a + b",
        "total = add(10, 20)",
      ].join("\n");

      const parser = createParser(source);
      const ast = parser.parse();

      expect(parser.diagnostics).toHaveLength(0);
      expect(parser.getDiagnostics()).toHaveLength(0);
      expect(ast.body).toHaveLength(3);
    });
  });
});
