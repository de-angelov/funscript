import { describe, it, expect } from "vitest";
import { Effect, Equal, Data, pipe } from "effect";
import { Lexer } from "../src/lexer/lexer.js";
import { TokenType } from "../src/lexer/tokens.js";
import { compileString, CompilerError } from "../src/compiler.js";

describe("Unified '=>' Arrow, 'when' Keyword Forms & Equality Operators", () => {
  describe("1. Lexer Tokenization", () => {
    it("tokenizes '=>' as FAT_ARROW", () => {
      const tokens = new Lexer("fn add(a, b) => Int => a + b").tokenize();
      const fatArrows = tokens.filter((t) => t.type === TokenType.FAT_ARROW);
      expect(fatArrows.length).toBe(2);
      expect(fatArrows[0].value).toBe("=>");
    });

    it("tokenizes '===' and '!==' as reference equality operators", () => {
      const tokens = new Lexer("a === b\nc !== d").tokenize();
      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQEQEQ,
        TokenType.IDENTIFIER,
        TokenType.NEWLINE,
        TokenType.IDENTIFIER,
        TokenType.NEQEQ,
        TokenType.IDENTIFIER,
        TokenType.EOF,
      ]);
    });

    it("disambiguates '=', '==', and '==='", () => {
      const tokens = new Lexer("x = a == b === c").tokenize();
      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.EQ,
        TokenType.IDENTIFIER,
        TokenType.EQEQ,
        TokenType.IDENTIFIER,
        TokenType.EQEQEQ,
        TokenType.IDENTIFIER,
        TokenType.EOF,
      ]);
    });

    it("disambiguates '!=' and '!=='", () => {
      const tokens = new Lexer("a != b !== c").tokenize();
      expect(tokens.map((t) => t.type)).toEqual([
        TokenType.IDENTIFIER,
        TokenType.NEQ,
        TokenType.IDENTIFIER,
        TokenType.NEQEQ,
        TokenType.IDENTIFIER,
        TokenType.EOF,
      ]);
    });
  });

  describe("2. Unified '=>' Arrow Semantics", () => {
    it("supports '=>' for function return types and block bodies", async () => {
      const code = `
export fn add(a: Number, b: Number) => Number {
  => a + b
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("export const add = (a: number, b: number): number => {");
      expect(res.typescript).toContain("return (a + b);");
    });

    it("supports '=>' for function return types with expression body", async () => {
      const code = `
export fn multiply(a: Number, b: Number) => Number => a * b
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("export const multiply = (a: number, b: number): number => (a * b);");
    });

    it("supports '=>' for arrow lambdas", async () => {
      const code = `
export square = (x: Number) => x * x
export getVal = () => 42
export combine = (a: Number, b: Number) => a + b
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("export const square = (x: number) => (x * x);");
      expect(res.typescript).toContain("export const getVal = () => 42;");
      expect(res.typescript).toContain("export const combine = (a: number, b: number) => (a + b);");
    });

    it("supports '=>' for match arms", async () => {
      const code = `
export schema Status =
  | Pending
  | Active(id: Number)

export label = (s: Status) =>
  match s
    | Pending => "waiting"
    | Active(id) => "active"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`.with({ _tag: "Pending" }, () => "waiting")`);
      expect(res.typescript).toContain(`.with({ _tag: "Active" },`);
    });

    it("supports explicit return statement '=> expr' emitted as 'return (expr);'", async () => {
      const code = `
export fn compute(x: Number) => Number {
  when (x == 0) => 0
  => x * 10
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("return (x * 10);");
    });
  });

  describe("3. The 'when' Keyword (Three Forms)", () => {
    it("Form 1 (Early return): emits 'if (cond) return expr;' inside functions", async () => {
      const code = `
export fn divide(a: Number, b: Number) => Number {
  when (b == 0) => 0
  => a / b
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("if ((b === 0)) return 0;");
      expect(res.typescript).toContain("return (a / b);");
    });

    it("Form 1 (Early return): compiler rejects outside function context", async () => {
      const code = `
when (true) => "cannot return at top level"
x = 10
`.trim();

      const failure = await Effect.runPromise(Effect.flip(compileString(code)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("rejected outside function context");
    });

    it("Form 2 (Conditional block): emits 'if (cond) { stmts }' with curly braces", async () => {
      const code = `
export fn test(x: Number) => Number {
  mut result = 0
  when (x == 10) {
    result = x * 2
  }
  => result
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("if ((x === 10)) {");
      expect(res.typescript).toContain("result = (x * 2);");
      expect(res.typescript).toContain("return (result);");
    });

    it("Form 2 (Conditional block): supports indented block", async () => {
      const code = `
export fn testIndented(x: Number) => Number {
  mut result = 0
  when (x == 5)
    result = 100
  => result
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("if ((x === 5)) {");
      expect(res.typescript).toContain("result = 100;");
      expect(res.typescript).toContain("return (result);");
    });

    it("Form 3 (Match arm guard): '| Pattern when condition => result'", async () => {
      const code = `
export schema Action =
  | Deposit(amount: Number)
  | Withdraw(amount: Number)

export apply = (act: Action) =>
  match act
    | Deposit(amount) when amount |> greaterThan(1000) => "large deposit"
    | Deposit(_) => "normal deposit"
    | Withdraw(amount) when amount |> greaterThan(500) => "large withdrawal"
    | _ => "other"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(".with({ _tag: \"Deposit\" }, ($matched) => {");
      expect(res.typescript).toContain("greaterThan(1000)");
      expect(res.typescript).toContain('"large deposit"');
      expect(res.typescript).toContain("greaterThan(500)");
      expect(res.typescript).toContain('"large withdrawal"');
    });
  });

  describe("4. Structural Equality vs Reference Identity", () => {
    it("lowers structural equality '==' to Effect's Equal.equals for structural types", async () => {
      const code = `
schema Point = { x: Number, y: Number }
export checkEqual = (p1: Point, p2: Point) => p1 == p2
export checkNotEqual = (p1: Point, p2: Point) => p1 != p2
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain('import { Equal, Schema } from "effect";');
      expect(res.typescript).toContain("Equal.equals(p1, p2)");
      expect(res.typescript).toContain("(!Equal.equals(p1, p2))");
    });

    it("lowers structural equality '==' on records to Equal.equals", async () => {
      const code = `
export compareRecords = (a, b) => a == b
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain('import { Equal } from "effect";');
      expect(res.typescript).toContain("Equal.equals(a, b)");
    });

    it("lowers primitive equality '==' to '==='", async () => {
      const code = `
export checkNums = (1 == 2)
export checkStrings = ("hello" == "world")
export checkBools = (true == false)
export checkIdentNum = (n: Number) => n == 0
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("(1 === 2)");
      expect(res.typescript).toContain('("hello" === "world")');
      expect(res.typescript).toContain("(true === false)");
      expect(res.typescript).toContain("(n === 0)");
    });

    it("lowers reference identity '===' and '!==' directly", async () => {
      const code = `
export checkRefEq = (a, b) => a === b
export checkRefNeq = (a, b) => a !== b
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("(a === b)");
      expect(res.typescript).toContain("(a !== b)");
    });
  });

  describe("5. End-to-End Execution Semantics", () => {
    it("executes structural equality with Effect Data tagged unions", () => {
      type Shape = Data.TaggedEnum<{
        Circle: { readonly radius: number };
        Point: {};
      }>;
      const $Shape = Data.taggedEnum<Shape>();

      const c1 = $Shape.Circle({ radius: 10 });
      const c2 = $Shape.Circle({ radius: 10 });
      const c3 = $Shape.Circle({ radius: 20 });

      // Structural equality via Equal.equals
      expect(Equal.equals(c1, c2)).toBe(true);
      expect(Equal.equals(c1, c3)).toBe(false);

      // Reference identity via ===
      expect(c1 === c2).toBe(false);
      expect(c1 === c1).toBe(true);
    });

    it("executes early return 'when' branching logic", async () => {
      const code = `
export fn safeDiv(num, den) => {
  when (den == 0) => -1
  => num / den
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      // Evaluate generated JS
      const fn = new Function(`${res.typescript.replace(/export /g, "")}; return safeDiv;`)();
      expect(fn(10, 2)).toBe(5);
      expect(fn(10, 0)).toBe(-1);
    });

    it("executes conditional block 'when' logic", async () => {
      const code = `
export fn threshold(x) => {
  mut bonus = 0
  when (x == 100) {
    bonus = 50
  }
  => x + bonus
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      const fn = new Function(`${res.typescript.replace(/export /g, "")}; return threshold;`)();
      expect(fn(50)).toBe(50);
      expect(fn(100)).toBe(150);
    });
  });

  describe("5. Pipeline Placeholder Expression Wrapping", () => {
    it("wraps placeholder binary expressions in generated arrow lambdas and evaluates", async () => {
      const code = `
export fn compute(x) => {
  res = x |> (_ + 1)
  => res
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`import { pipe } from "effect";`);
      expect(res.typescript).toContain(`pipe(\n  x,\n  (__p) => (__p + 1)\n)`);

      const fn = new Function("pipe", `${res.typescript.replace(/import .*\n/g, "").replace(/export /g, "")}; return compute;`)(pipe);
      expect(fn(5)).toBe(6);
      expect(fn(41)).toBe(42);
    });

    it("wraps placeholder member expressions in generated arrow lambdas and evaluates", async () => {
      const code = `
export fn getName(user) => {
  res = user |> _.profile.name
  => res
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`pipe(\n  user,\n  (__p) => __p.profile.name\n)`);

      const fn = new Function("pipe", `${res.typescript.replace(/import .*\n/g, "").replace(/export /g, "")}; return getName;`)(pipe);
      expect(fn({ profile: { name: "Antigravity" } })).toBe("Antigravity");
    });

    it("handles placeholder in unary, logical and equality expressions", async () => {
      const code = `
export fn isNotZero(x) => {
  => x |> not (_ == 0)
}
export fn checkInRange(x) => {
  => x |> (_ != 0 and _ != 100)
}
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`(__p) => (!(__p === 0))`);
      expect(res.typescript).toContain(`(__p) => ((__p !== 0) && (__p !== 100))`);

      const getFns = new Function("pipe", `${res.typescript.replace(/import .*\n/g, "").replace(/export /g, "")}; return { isNotZero, checkInRange };`);
      const { isNotZero, checkInRange } = getFns(pipe);
      expect(isNotZero(0)).toBe(false);
      expect(isNotZero(5)).toBe(true);
      expect(checkInRange(0)).toBe(false);
      expect(checkInRange(100)).toBe(false);
      expect(checkInRange(50)).toBe(true);
    });
  });
});
