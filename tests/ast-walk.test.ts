import { describe, it, expect } from "vitest";
import { walkAst } from "../src/ast/walk.js";
import { Parser } from "../src/parser/parser.js";
import { Lexer } from "../src/lexer/lexer.js";

describe("walkAst utility", () => {
  it("visits all AST nodes recursively", () => {
    const code = "export a = 1 + 2\nexport b = (x: Number) => x * 2";
    const tokens = new Lexer(code, "test.fun").tokenize();
    const ast = new Parser(tokens, "test.fun", code).parse();

    const kinds: string[] = [];
    walkAst(ast, (node) => {
      if (typeof node.kind === "string") {
        kinds.push(node.kind);
      }
    });

    expect(kinds).toContain("Program");
    expect(kinds).toContain("BindingDeclaration");
    expect(kinds).toContain("BinaryExpression");
    expect(kinds).toContain("NumberLiteral");
    expect(kinds).toContain("FunctionExpression");
    expect(kinds).toContain("Parameter");
  });

  it("stops recursing into children when visitor returns false", () => {
    const code = "export a = 1 + 2\nexport b = 3 + 4";
    const tokens = new Lexer(code, "test.fun").tokenize();
    const ast = new Parser(tokens, "test.fun", code).parse();

    const visitedKinds: string[] = [];
    walkAst(ast, (node) => {
      visitedKinds.push(String(node.kind));
      if (node.kind === "BindingDeclaration") {
        return false; // Skip traversing into the binding's init expression
      }
    });

    expect(visitedKinds).toContain("Program");
    expect(visitedKinds).toContain("BindingDeclaration");
    expect(visitedKinds).not.toContain("BinaryExpression");
    expect(visitedKinds).not.toContain("NumberLiteral");
  });
});
