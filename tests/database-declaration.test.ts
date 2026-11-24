import { describe, expect, it } from "vitest";
import { format } from "../src/formatter/index.js";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";

const parse = (source: string) =>
  new Parser(new Lexer(source, "test.fun").tokenize(), "test.fun").parse();

describe("database declarations", () => {
  it("parses provider literals and formats the declaration", () => {
    const source = 'database App = sqlite<"./schema.db">';
    const declaration = parse(source).body[0];
    expect(declaration).toMatchObject({
      kind: "DatabaseDeclaration",
      provider: "sqlite",
      arguments: ["./schema.db"],
    });
    expect(declaration.span.start.column).toBe(1);
    expect(format(source)).toBe(`${source}\n`);
  });

  it("parses exported declarations", () => {
    expect(
      parse('export database App = sqlite<"./schema.db">').body[0],
    ).toMatchObject({
      kind: "ExportDeclaration",
      declaration: { kind: "DatabaseDeclaration", id: { name: "App" } },
    });
  });

  it("accepts other providers and static literal arguments", () => {
    expect(
      parse('database Other = custom<"path", 4, true, false>').body[0],
    ).toMatchObject({
      provider: "custom",
      arguments: ["path", 4, true, false],
    });
  });

  it.each([
    "database App = sqlite<path>",
    'database App = sqlite<"./${name}.db">',
    "database App = sqlite<>",
  ])("rejects invalid provider arguments: %s", (source) => {
    expect(() => parse(source)).toThrow();
  });
});
