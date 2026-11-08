import { describe, it, expect } from "vitest";
import prettier from "prettier";
import * as fs from "node:fs";
import * as path from "node:path";
import { format, checkFormat, extractComments } from "../src/formatter/index.js";
import prettierPlugin from "../src/formatter/prettier.js";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import { ASSOCIATIVITY, PRECEDENCE } from "../src/formatter/operator-precedence.js";
import {
  assertFormattingIdempotent,
  assertFormat,
  assertFormattingIdempotentFile,
} from "./helpers/index.js";

function operatorTree(source: string): unknown {
  const program = new Parser(new Lexer(source, "test.fun").tokenize(), "test.fun").parse();
  const declaration = program.body[0];
  if (declaration?.kind !== "ExportDeclaration" || declaration.declaration.kind !== "BindingDeclaration") {
    throw new Error("Expected an exported binding");
  }

  const withoutSpans = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(withoutSpans);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).filter(([key]) => key !== "span").map(([key, child]) => [key, withoutSpans(child)])
      );
    }
    return value;
  };

  return withoutSpans(declaration.declaration.init);
}

describe("FunScript Code Formatter", () => {
  it("preserves optional and defaulted parameters in binding functions", () => {
    for (const source of [
      'export read = (value?: String) => value',
      'export read = (value: Number = 5) => value',
      'export read = <A>(value?: A) => value',
    ]) {
      const formatted = format(source);
      expect(operatorTree(formatted)).toEqual(operatorTree(source));
      expect(format(formatted)).toBe(formatted);
    }
  });

  it("round-trips generic return annotations in fun and funx", () => {
    for (const filename of ["test.fun", "test.funx"]) {
      const source = 'export identity = <A>(value: A) => A { => value }';
      const formatted = format(source, { filename });
      expect(format(formatted, { filename })).toBe(formatted);
    }
  });
  it("lists a precedence for every binary operator and formats identifier operands", () => {
    const operators = Object.keys(PRECEDENCE);
    expect(operators).toEqual([
      "or", "and", "#=", "#!", "@=", "@!", "<", "<=", ">", ">=",
      "+", "-", "*", "/", "%", "**",
    ]);
    expect(Object.keys(ASSOCIATIVITY)).toEqual(operators);
    expect(ASSOCIATIVITY).toEqual(Object.fromEntries(operators.map(operator => [operator, operator === "**" ? "right" : "left"])));

    for (const operator of operators) {
      const source = `export result = left ${operator} right`;
      expect(operatorTree(format(source))).toEqual(operatorTree(source));
    }
  });

  it("matches parser grouping across adjacent precedence levels", () => {
    const expressions = [
      "a or b and c", "a and b #= c", "a #= b < c", "a < b + c",
      "a + b * c", "a * b ** c",
    ];

    for (const expression of expressions) {
      const source = `export result = ${expression}`;
      expect(operatorTree(format(source))).toEqual(operatorTree(source));
      expect(operatorTree(format(format(source)))).toEqual(operatorTree(source));
    }
  });

  it("preserves parser grouping across every ordered value-operator pair", () => {
    const operators = ["or", "and", "#=", "#!", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "**"];

    for (const first of operators) {
      for (const second of operators) {
        const source = `export result = left ${first} middle ${second} right`;
        expect(operatorTree(format(source))).toEqual(operatorTree(source));
      }
    }
  });

  it("preserves left and right associativity for equality and numeric comparison", () => {
    const expressions = [
      "a #= b #! c", "a #= (b #! c)",
      "a < b <= c", "a < (b <= c)",
    ];

    for (const expression of expressions) {
      const source = `export result = ${expression}`;
      expect(operatorTree(format(source))).toEqual(operatorTree(source));
      expect(operatorTree(format(format(source)))).toEqual(operatorTree(source));
    }
  });

  it("characterizes formatter output against parser grouping for operator families", () => {
    const cases = [
      // Equality binds less tightly than numeric comparison in both parser and formatter.
      ["a #= b < c", "a #= b < c"],
      ["a < b #= c", "a < b #= c"],
      ["(a #= b) < c", "(a #= b) < c"],
      ["a #= (b < c)", "a #= b < c"],
      // Multiplication binds more tightly than addition.
      ["a + b * c", "a + b * c"],
      ["(a + b) * c", "(a + b) * c"],
      ["a * (b + c)", "a * (b + c)"],
      // Exponentiation is right-associative in the parser and formatter.
      ["a ** b ** c", "a ** b ** c"],
      ["(a ** b) ** c", "(a ** b) ** c"],
      ["a ** (b ** c)", "a ** b ** c"],
    ] as const;

    for (const [expression, expected] of cases) {
      const source = `export result = ${expression}`;
      const formatted = format(source);
      expect(formatted).toBe(`export result = ${expected}\n`);
      expect(operatorTree(formatted)).toEqual(operatorTree(source));
      expect(operatorTree(format(formatted))).toEqual(operatorTree(source));
    }
  });

  it("formats basic bindings and expressions canonically", () => {
    const unformatted = `name = "Ada"\nage =   36\nisActive = true`;
    const formatted = format(unformatted);
    expect(formatted).toBe(`name = "Ada"\nage = 36\nisActive = true\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("formats .funx JSX punctuation with the source filename enabled", () => {
    const source = `export Message = () => <p>Done!</p>`;
    const formatted = format(source, { filename: "message.funx" });

    expect(formatted).toBe(`export Message = () => <p>Done!</p>\n`);
    expect(checkFormat(formatted, { filename: "message.funx" }).isFormatted).toBe(true);
  });

  it("preserves JSX source and comments across repeated formatting", () => {
    const source = `// greeting comment\nexport Message = (name: String) => <section class="message"><p>Hello, {name}!</p></section>`;
    const formatted = format(source, { filename: "message.funx" });
    expect(formatted).toContain('<section class="message">');
    expect(formatted).toContain("// greeting comment");
    expect(format(formatted, { filename: "message.funx" })).toBe(formatted);
  });

  it("formats single JSX element implicit return in .funx idempotently", () => {
    const source = `export Message = () =>\n  <p>Done!</p>`;
    const formatted = format(source, { filename: "message.funx" });
    expect(formatted).toBe(`export Message = () =>\n  <p>Done!</p>\n`);
    expect(format(formatted, { filename: "message.funx" })).toBe(formatted);
  });

  it("formats single JSX fragment implicit return in .funx idempotently", () => {
    const source = `export Message = () =>\n  <>\n    <span>Hello</span>\n  </>`;
    const formatted = format(source, { filename: "message.funx" });
    expect(formatted).toContain("<>");
    expect(formatted).toContain("<span>Hello</span>");
    expect(format(formatted, { filename: "message.funx" })).toBe(formatted);
  });

  it("formats single JSX self-closing element implicit return in .funx idempotently", () => {
    const source = `export Message = () =>\n  <input type="text" />`;
    const formatted = format(source, { filename: "message.funx" });
    expect(formatted).toBe(`export Message = () =>\n  <input type="text" />\n`);
    expect(format(formatted, { filename: "message.funx" })).toBe(formatted);
  });

  it("formats braced single JSX element in .funx into indented block preserving implicit return", () => {
    const source = `export Message = () => {\n  <p>Done!</p>\n}`;
    const formatted = format(source, { filename: "message.funx" });
    expect(formatted).toBe(`export Message = () =>\n  <p>Done!</p>\n`);
    expect(format(formatted, { filename: "message.funx" })).toBe(formatted);
  });

  it("preserves explicit => return in .funx function block across formatting", () => {
    const source = `export Message = () =>\n  => <p>Done!</p>`;
    const formatted = format(source, { filename: "message.funx" });
    expect(formatted).toBe(`export Message = () =>\n  => <p>Done!</p>\n`);
    expect(format(formatted, { filename: "message.funx" })).toBe(formatted);
  });

  it("formats export default declarations cleanly and idempotently", () => {
    const srcId = "export default App";
    const fmtId = format(srcId);
    expect(fmtId).toBe("export default App\n");
    expect(format(fmtId)).toBe(fmtId);
    expect(checkFormat(fmtId).isFormatted).toBe(true);

    const srcArrow = "export default () => <div />";
    const fmtArrow = format(srcArrow, { filename: "App.funx" });
    expect(fmtArrow).toBe("export default () => <div />\n");
    expect(format(fmtArrow, { filename: "App.funx" })).toBe(fmtArrow);
    expect(checkFormat(fmtArrow, { filename: "App.funx" }).isFormatted).toBe(true);

    const srcLit = "export default 42";
    const fmtLit = format(srcLit);
    expect(fmtLit).toBe("export default 42\n");
    expect(format(fmtLit)).toBe(fmtLit);
    expect(checkFormat(fmtLit).isFormatted).toBe(true);
  });

  it("formats Effect blocks and pipelines idempotently", () => {
    const source = `result =\n  effect\n    value <- fetch()\n    => value |> normalize`;
    const formatted = format(source);
    expect(formatted).toContain("effect {");
    expect(formatted).toContain("value |> normalize");
    expect(format(formatted)).toBe(formatted);
  });

  it("normalizes indentation to 2 spaces", () => {
    const unformatted = `
export greet = (name: String) =>
    // greeting message
    => "Hello, {name}!"
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(`export greet = (name: String) =>\n  // greeting message\n  => "Hello, {name}!"\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("formats imports canonically with normalized spacing", () => {
    const unformatted = `import {Console,   Effect,  Array as Arr} from "effect"`;
    const formatted = format(unformatted);
    expect(formatted).toBe(`import { Console, Effect, Array as Arr } from "effect"\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("formats schemas and tagged unions", () => {
    const unformatted = `
export schema User = {
    id: String
    name: String
    role: String = "user"
}

export schema Shape =
    | Circle(radius: Number)
    | Rect(width: Number, height: Number)
    | Point
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export schema User = {\n  id: String\n  name: String\n  role: String = "user"\n}\n\nexport schema Shape =\n  | Circle(radius: Number)\n  | Rect(width: Number, height: Number)\n  | Point\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats ts schema declaration modifier syntax and preserves idempotence", () => {
    const unformatted = `
ts schema User = UserType
export ts schema Admin = AdminType<String>
ts schema Point = { x: Number, y: Number }

ts schema Config = {
  timeout: Number
}
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `ts schema User = UserType\nexport ts schema Admin = AdminType<String>\nts schema Point = { x: Number, y: Number }\n\nts schema Config = {\n  timeout: Number\n}\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats imported TypeScript schema declarations idempotently", () => {
    const unformatted = `
import { User as UserType } from "./model"

schema User = from ts<UserType>
export schema Admin = from ts<AdminType>
schema Container<T> = from ts<ContainerType<T>>
schema Pair = from ts<FirstType, SecondType>
`.trim();

    const formatted = format(unformatted);
    expect(formatted).toBe(
      `import { User as UserType } from "./model"\n\nschema User = from ts<UserType>\nexport schema Admin = from ts<AdminType>\nschema Container<T> = from ts<ContainerType<T>>\nschema Pair = from ts<FirstType, SecondType>\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats error declarations and service declarations", () => {
    const unformatted = `
export error NotFound(id: String)
export error Empty

export service Greeter "greeter-v1"
    greet: (name: String) => Effect<String>
    farewell: (name: String) => Effect<Void, NotFound>
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export error NotFound(id: String)\nexport error Empty\n\nexport service Greeter "greeter-v1"\n  greet: (name: String) => Effect<String>\n  farewell: (name: String) => Effect<Void, NotFound>\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats match expressions with pattern types", () => {
    const unformatted = `
export classify = (shape: Shape) =>
  match shape
      | Circle(r) when r |> Number.isGreaterThan(10) => "large"
      | Circle(_) => "circle"
      | Rect(w, h) => "rect"
      | _ => "unknown"
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export classify = (shape: Shape) =>\n  match shape\n    | Circle(r) when r |> Number.isGreaterThan(10) => "large"\n    | Circle(_) => "circle"\n    | Rect(w, h) => "rect"\n    | _ => "unknown"\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats subjectless match expressions", () => {
    const unformatted = `
export checkNumber = (n: Number) =>
  match
      | n |> Number.isLessThan(0) => "negative"
      | n #= 0 => "zero"
      | _ => "positive"
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export checkNumber = (n: Number) =>\n  match\n    | n |> Number.isLessThan(0) => "negative"\n    | n #= 0 => "zero"\n    | _ => "positive"\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats effect blocks with bindings and discards", () => {
    const unformatted = `
export program =
  effect
      x <- fetchNumber()
      _ <- Console.log(x)
      y = x + 1
      => y
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export program =\n  effect {\n    x <- fetchNumber()\n    _ <- Console.log(x)\n    y = x + 1\n    => y\n  }\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats pipelines with proper alignment", () => {
    const unformatted = `
export main =
    [1, 2, 3]
    |> Array.map((x) => x * 2)
    |> Array.join(", ")
    |> Console.log
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export main =\n  [1, 2, 3]\n  |> Array.map((x) => x * 2)\n  |> Array.join(", ")\n  |> Console.log\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats copy-on-write mut draft blocks", () => {
    const unformatted = `
export appendTag = (p: Profile, tag: String) =>
  => p
  |> mut (draft) =>
      draft.tags.push(tag)
      => draft
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export appendTag = (p: Profile, tag: String) =>\n  => p\n  |> mut (draft) =>\n    draft.tags.push(tag)\n    => draft\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("normalizes TypeScript-style comments, indentation, and trailing comments", () => {
    const unformatted = `
//file header comment
export x = 10 //trailing comment on x

//another section
export y = 20
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toContain("// file header comment");
    expect(formatted).toContain("export x = 10  // trailing comment on x");
    expect(formatted).toContain("// another section");
    expect(format(formatted)).toBe(formatted);
  });

  it("respects operator precedence in binary expressions", () => {
    const unformatted = `export calc = (1 + 2) * 3 - (4 / 2)`;
    const formatted = format(unformatted);
    expect(formatted).toBe(`export calc = (1 + 2) * 3 - 4 / 2\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("preserves arithmetic grouping and formats it idempotently", () => {
    const expressions = [
      ["(1 + 2) * 3", "(1 + 2) * 3"],
      ["1 - (2 - 3)", "1 - (2 - 3)"],
      ["(2 ** 3) ** 2", "(2 ** 3) ** 2"],
    ] as const;

    for (const [expression, expected] of expressions) {
      const formatted = format(`export result = ${expression}`);
      expect(formatted).toBe(`export result = ${expected}\n`);
      expect(format(formatted)).toBe(formatted);
    }
  });

  it("formats numeric comparisons below arithmetic precedence", () => {
    const formatted = format(`export valid = (1 + 2) < 4 and 5 >= 3`);
    expect(formatted).toBe(`export valid = 1 + 2 < 4 and 5 >= 3\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("formats mixed comparison, equality, and logical operators idempotently", () => {
    const formatted = format(`export result = (4 + 5) * 6 < 60 #= true and ready or fallback`);
    expect(formatted).toBe(`export result = (4 + 5) * 6 < 60 #= true and ready or fallback\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("preserves operator grouping through formatting", () => {
    const expressions = [
      "1 + 2 * 3 - 4 / 2",
      "2 ** 3 ** 2",
      "1 + 2 #= 3 * 1",
      "(1 + 2) #= (3 * 1)",
      "1 + 2 < 4 * 2",
      "(1 < 2) #= (3 >= 2)",
      "ready or fallback and enabled",
      "(1 + 2) * 3",
      "1 - 2 - 3",
      "(1 - 2) - 3",
      "1 - (2 - 3)",
      "(2 ** 3) ** 2",
      "(ready or fallback) and enabled",
    ];

    for (const expression of expressions) {
      const source = `export result = ${expression}`;
      expect(operatorTree(format(source))).toEqual(operatorTree(source));
    }
  });

  it("keeps mixed equality, comparison, and arithmetic grouping through formatting", () => {
    const expressions = [
      ["1 + 2 * 3 < 8 #= true", "1 + 2 * 3 < 8 #= true"],
      ["(1 #= 2) < 3", "(1 #= 2) < 3"],
      ["1 #= (2 < 3)", "1 #= 2 < 3"],
      ["(1 + 2) * 3 < 10 #= true", "(1 + 2) * 3 < 10 #= true"],
    ] as const;

    for (const [expression, expected] of expressions) {
      const source = `export result = ${expression}`;
      const formatted = format(source);
      expect(formatted).toBe(`export result = ${expected}\n`);
      expect(operatorTree(formatted)).toEqual(operatorTree(source));
      expect(format(formatted)).toBe(formatted);
      expect(operatorTree(format(formatted))).toEqual(operatorTree(source));
    }
  });

  it("keeps subtraction and exponentiation associativity through formatting", () => {
    const expressions = [
      ["1 - 2 - 3", "1 - 2 - 3"],
      ["1 - (2 - 3)", "1 - (2 - 3)"],
      ["2 ** 3 ** 2", "2 ** 3 ** 2"],
      ["(2 ** 3) ** 2", "(2 ** 3) ** 2"],
    ] as const;

    for (const [expression, expected] of expressions) {
      const source = `export result = ${expression}`;
      const formatted = format(source);
      expect(formatted).toBe(`export result = ${expected}\n`);
      expect(operatorTree(formatted)).toEqual(operatorTree(source));
      expect(format(formatted)).toBe(formatted);
      expect(operatorTree(format(formatted))).toEqual(operatorTree(source));
    }
  });

  it("preserves equality and comparison grouping through formatting", () => {
    const expressions = [
      "left #= right < limit",
      "left < right #= limit",
      "(left #= right) < limit",
      "left #= (right < limit)",
      "left #= (right #! limit)",
      "left < (right <= limit)",
      "1 < 2 #= true",
      "1 #= 2 < 3",
      "(1 #= 2) < 3",
      "1 < (2 #= 3)",
      "(1 < 2) #= 3",
      "1 #= (2 < 3)",
      "(1 #= 2) #= 3",
      "1 #= (2 #= 3)",
      "(1 < 2) < 3",
      "1 < (2 < 3)",
    ];

    for (const expression of expressions) {
      const source = `export result = ${expression}`;
      const formatted = assertFormattingIdempotent(source);
      expect(operatorTree(formatted)).toEqual(operatorTree(source));
    }

    expect(format("export result = (1 #= 2) < 3")).toBe("export result = (1 #= 2) < 3\n");
    expect(format("export result = 1 < (2 #= 3)")).toBe("export result = 1 < (2 #= 3)\n");
  });

  it("preserves right-nested same-precedence operators through formatting", () => {
    const expressions = [
      "1 + (2 + 3)",
      "1 * (2 / 3)",
      "ready and (fallback and enabled)",
      "ready or (fallback or enabled)",
    ];

    for (const expression of expressions) {
      const source = `export result = ${expression}`;
      const formatted = format(source);
      expect(operatorTree(formatted)).toEqual(operatorTree(source));
      expect(operatorTree(format(formatted))).toEqual(operatorTree(source));
    }
  });

  it("preserves logical grouping around numeric comparisons through formatting", () => {
    const expressions = [
      "(1 < 2) and (3 >= 4)",
      "(1 < 2 and 3 >= 4) or 5 < 6",
      "1 < 2 and (3 >= 4 or 5 < 6)",
    ];

    for (const expression of expressions) {
      const source = `export result = ${expression}`;
      const formatted = assertFormattingIdempotent(source);
      expect(operatorTree(formatted)).toEqual(operatorTree(source));
    }
  });

  it("formats record literals with shorthand, spreads, and dot-paths", () => {
    const unformatted = `
export updated = {
    ...user
    address.city: "Paris"
    role
}
`.trim();
    assertFormat(
      unformatted,
      `export updated = {\n  ...user\n  address.city: "Paris"\n  role\n}\n`,
    );
  });

  it("checkFormat detects formatted and unformatted source", () => {
    const clean = `export x = 10\n`;
    expect(checkFormat(clean).isFormatted).toBe(true);

    const dirty = `export x =   10`;
    const check = checkFormat(dirty);
    expect(check.isFormatted).toBe(false);
    expect(check.formatted).toBe(clean);
  });

  it("is idempotent across all examples and sample programs", () => {
    const files = [
      "examples/hello.fun",
      "examples/shapes.fun",
      "examples/greeter-service.fun",
      "examples/todo-http.fun",
      "examples/fibonacci.fun",
      "examples/bank-account.fun",
      "examples/todo-service.fun",
      "examples/fixtures/01-basic-bindings.fun",
      "examples/fixtures/02-functions-and-pipelines.fun",
      "examples/fixtures/03-schemas-and-unions.fun",
      "examples/fixtures/04-pattern-matching.fun",
      "examples/fixtures/05-mutative-updates.fun",
      "examples/fixtures/06-effects-and-services.fun",
    ];

    for (const f of files) {
      assertFormattingIdempotentFile(f);
    }
  });

  describe("canonical showcase examples arrow syntax", () => {
    const showcaseFiles = [
      "examples/hello.fun",
      "examples/shapes.fun",
      "examples/greeter-service.fun",
      "examples/todo-http.fun",
    ];

    it("preserves canonical => arrows without rewriting to legacy syntax", () => {
      for (const relPath of showcaseFiles) {
        const filePath = path.resolve(relPath);
        const source = fs.readFileSync(filePath, "utf-8");
        const formatted = format(source, { filename: relPath });

        expect(formatted).not.toContain("->");
        expect(formatted).toContain("=>");
        expect(format(formatted, { filename: relPath })).toBe(formatted);
      }
    });

    it("ensures each showcase example is already formatted cleanly", () => {
      for (const relPath of showcaseFiles) {
        const filePath = path.resolve(relPath);
        const source = fs.readFileSync(filePath, "utf-8");
        const check = checkFormat(source, { filename: relPath });
        expect(check.isFormatted).toBe(true);
      }
    });
  });

  describe("Prettier Plugin Interface", () => {
    it("exposes valid languages, parsers, and printers", () => {
      expect(prettierPlugin.languages).toBeDefined();
      expect(prettierPlugin.languages?.[0]?.name).toBe("FunScript");
      expect(prettierPlugin.languages?.[0]?.extensions).toContain(".fun");
      expect(prettierPlugin.languages?.[0]?.extensions).toContain(".funx");

      expect(prettierPlugin.parsers).toBeDefined();
      expect(prettierPlugin.parsers?.funscript).toBeDefined();

      expect(prettierPlugin.printers).toBeDefined();
      expect(prettierPlugin.printers?.["funscript-ast"]).toBeDefined();
    });

    it("formats FunScript code using prettier.format with the plugin", async () => {
      const unformatted = `export greet = (name: String) => "Hello, {name}!"`;
      const result = await prettier.format(unformatted, {
        parser: "funscript",
        plugins: [prettierPlugin],
      });
      expect(result).toBe(`export greet = (name: String) => "Hello, {name}!"\n`);

      const pass2 = await prettier.format(result, {
        parser: "funscript",
        plugins: [prettierPlugin],
      });
      expect(pass2).toBe(result);
    });

    it("formats based on .fun file extension via filepath", async () => {
      const unformatted = `export add = (a: Number, b: Number) => a + b`;
      const result = await prettier.format(unformatted, {
        filepath: "math.fun",
        plugins: [prettierPlugin],
      });
      expect(result).toBe(`export add = (a: Number, b: Number) => a + b\n`);
    });

    it("formats JSX in .funx files while preserving JSX source", async () => {
      const result = await prettier.format("export Button = () => <button>hello</button>", {
        filepath: "Button.funx",
        plugins: [prettierPlugin],
      });
      expect(result).toBe("export Button = () => <button>hello</button>\n");
    });

    it("respects tabWidth option from Prettier", async () => {
      const code = `
export schema Config = {
  timeout: Number
  retries: Number
}
`.trim();
      const result = await prettier.format(code, {
        parser: "funscript",
        plugins: [prettierPlugin],
        tabWidth: 4,
      });
      expect(result).toContain("    timeout: Number");
      expect(result).toContain("    retries: Number");
    });

    it("formats abstract function pipelines and comparison shorthand consistently", () => {
      const source = "export isSmall = (score: Number, deadline: Number) => score |> lessThan(deadline)\n";
      const formatted = format(source);
      expect(formatted).toBe(source);
    });
  });
});
