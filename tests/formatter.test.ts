import { describe, it, expect } from "vitest";
import prettier from "prettier";
import * as fs from "node:fs";
import * as path from "node:path";
import { format, checkFormat, extractComments } from "../src/formatter/index.js";
import prettierPlugin from "../src/formatter/prettier.js";

describe("FunScript Code Formatter", () => {
  it("formats basic bindings and expressions canonically", () => {
    const unformatted = `name = "Ada"\nage =   36\nisActive = true`;
    const formatted = format(unformatted);
    expect(formatted).toBe(`name = "Ada"\nage = 36\nisActive = true\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("normalizes indentation to 2 spaces", () => {
    const unformatted = `
export greet = (name: String) ->
    # greeting message
    "Hello, {name}!"
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(`export greet = (name: String) ->\n  # greeting message\n  "Hello, {name}!"\n`);
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

  it("formats error declarations and service declarations", () => {
    const unformatted = `
export error NotFound(id: String)
export error Empty

export service Greeter "greeter-v1"
    greet: (name: String) -> Effect<String>
    farewell: (name: String) -> Effect<Void, NotFound>
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export error NotFound(id: String)\nexport error Empty\n\nexport service Greeter "greeter-v1"\n  greet: (name: String) -> Effect<String>\n  farewell: (name: String) -> Effect<Void, NotFound>\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats match expressions with pattern types", () => {
    const unformatted = `
export classify = (shape: Shape) ->
  match shape
      | Circle(r) when r |> Number.greaterThan(10) -> "large"
      | Circle(_) -> "circle"
      | Rect(w, h) -> "rect"
      | _ -> "unknown"
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export classify = (shape: Shape) ->\n  match shape\n    | Circle(r) when r |> Number.greaterThan(10) -> "large"\n    | Circle(_) -> "circle"\n    | Rect(w, h) -> "rect"\n    | _ -> "unknown"\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats subjectless match expressions", () => {
    const unformatted = `
export checkNumber = (n: Number) ->
  match
      | n |> Number.lessThan(0) -> "negative"
      | n == 0 -> "zero"
      | _ -> "positive"
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export checkNumber = (n: Number) ->\n  match\n    | n |> Number.lessThan(0) -> "negative"\n    | n == 0 -> "zero"\n    | _ -> "positive"\n`
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
      y
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export program =\n  effect\n    x <- fetchNumber()\n    _ <- Console.log(x)\n    y = x + 1\n    y\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats pipelines with proper alignment", () => {
    const unformatted = `
export main =
    [1, 2, 3]
    |> Array.map((x) -> x * 2)
    |> Array.join(", ")
    |> Console.log
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export main =\n  [1, 2, 3]\n  |> Array.map((x) -> x * 2)\n  |> Array.join(", ")\n  |> Console.log\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("formats copy-on-write mut draft blocks", () => {
    const unformatted = `
export appendTag = (p: Profile, tag: String) ->
  p
  |> mut (draft) ->
      draft.tags.push(tag)
      draft
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(
      `export appendTag = (p: Profile, tag: String) ->\n  p\n  |> mut (draft) ->\n    draft.tags.push(tag)\n    draft\n`
    );
    expect(format(formatted)).toBe(formatted);
  });

  it("normalizes comments (#without-space -> # with-space, indentation, trailing)", () => {
    const unformatted = `
#file header comment
export x = 10 #trailing comment on x

#another section
export y = 20
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toContain("# file header comment");
    expect(formatted).toContain("export x = 10  # trailing comment on x");
    expect(formatted).toContain("# another section");
    expect(format(formatted)).toBe(formatted);
  });

  it("respects operator precedence in binary expressions", () => {
    const unformatted = `export calc = (1 + 2) * 3 - (4 / 2)`;
    const formatted = format(unformatted);
    expect(formatted).toBe(`export calc = (1 + 2) * 3 - 4 / 2\n`);
    expect(format(formatted)).toBe(formatted);
  });

  it("formats record literals with shorthand, spreads, and dot-paths", () => {
    const unformatted = `
export updated = {
    ...user
    address.city: "Paris"
    role
}
`.trim();
    const formatted = format(unformatted);
    expect(formatted).toBe(`export updated = {\n  ...user\n  address.city: "Paris"\n  role\n}\n`);
    expect(format(formatted)).toBe(formatted);
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
      "programs/01-fibonacci.fun",
      "programs/02-bank-account.fun",
      "programs/03-todo-service.fun",
      "examples/fixtures/01-basic-bindings.fun",
      "examples/fixtures/02-functions-and-pipelines.fun",
      "examples/fixtures/03-schemas-and-unions.fun",
      "examples/fixtures/04-pattern-matching.fun",
      "examples/fixtures/05-mutative-updates.fun",
      "examples/fixtures/06-effects-and-services.fun",
    ];

    for (const f of files) {
      const src = fs.readFileSync(path.resolve(f), "utf-8");
      const pass1 = format(src);
      const pass2 = format(pass1);
      expect(pass2, `Idempotency failure for ${f}`).toBe(pass1);
    }
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
      const unformatted = `export greet = (name: String) -> "Hello, {name}!"`;
      const result = await prettier.format(unformatted, {
        parser: "funscript",
        plugins: [prettierPlugin],
      });
      expect(result).toBe(`export greet = (name: String) -> "Hello, {name}!"\n`);

      const pass2 = await prettier.format(result, {
        parser: "funscript",
        plugins: [prettierPlugin],
      });
      expect(pass2).toBe(result);
    });

    it("formats based on .fun file extension via filepath", async () => {
      const unformatted = `export add = (a: Number, b: Number) -> a + b`;
      const result = await prettier.format(unformatted, {
        filepath: "math.fun",
        plugins: [prettierPlugin],
      });
      expect(result).toBe(`export add = (a: Number, b: Number) -> a + b\n`);
    });

    it("formats JSX in .funx files while preserving JSX source", async () => {
      const result = await prettier.format("export Button = () => <button>hello</button>", {
        filepath: "Button.funx",
        plugins: [prettierPlugin],
      });
      expect(result).toBe("export Button = () -> <button>hello</button>\n");
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
  });
});
