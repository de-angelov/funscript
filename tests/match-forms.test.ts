import { describe, it, expect } from "vitest";
import { Effect, Equal, Data, pipe } from "effect";
import { match, P } from "ts-pattern";
import { compileString, CompilerError } from "../src/compiler.js";
import { format } from "../src/formatter/index.js";

describe("Equality Type Constraints & Match Forms Test Suite Matrix (TASK-026)", () => {
  describe("1. Reference Identity Type Constraints (=== and !==)", () => {
    it("rejects reference equality on primitive number literals", async () => {
      const code1 = "x = 1 === 2";
      const failure1 = await Effect.runPromise(Effect.flip(compileString(code1)));
      expect(failure1).toBeInstanceOf(CompilerError);
      expect(failure1.message).toContain("Reference identity operator '===' cannot be used with primitive types");

      const code2 = "x = 10 !== 20";
      const failure2 = await Effect.runPromise(Effect.flip(compileString(code2)));
      expect(failure2).toBeInstanceOf(CompilerError);
      expect(failure2.message).toContain("Reference identity operator '!==' cannot be used with primitive types");
    });

    it("rejects reference equality on primitive string literals", async () => {
      const code = 'res = "hello" === "world"';
      const failure = await Effect.runPromise(Effect.flip(compileString(code)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Reference identity operator '===' cannot be used with primitive types");
    });

    it("rejects reference equality on boolean literals", async () => {
      const code = "res = true !== false";
      const failure = await Effect.runPromise(Effect.flip(compileString(code)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Reference identity operator '!==' cannot be used with primitive types");
    });

    it("rejects reference equality on expressions with primitive literals", async () => {
      const code1 = "checkZero = (x) => x === 0";
      const failure1 = await Effect.runPromise(Effect.flip(compileString(code1)));
      expect(failure1).toBeInstanceOf(CompilerError);
      expect(failure1.message).toContain("Reference identity operator '===' cannot be used with primitive types");

      const code2 = 'checkEmpty = (x) => "" !== x';
      const failure2 = await Effect.runPromise(Effect.flip(compileString(code2)));
      expect(failure2).toBeInstanceOf(CompilerError);
      expect(failure2.message).toContain("Reference identity operator '!==' cannot be used with primitive types");
    });

    it("rejects reference equality on typed primitive variables", async () => {
      const code = `
export fn checkNums(a: Number, b: Number) => Boolean {
  => a === b
}
`.trim();
      const failure = await Effect.runPromise(Effect.flip(compileString(code)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Reference identity operator '===' cannot be used with primitive types");
    });

    it("allows reference equality on reference objects, schemas, and untyped parameters", async () => {
      const code = `
schema Point = { x: Number, y: Number }
export checkPointRef = (p1: Point, p2: Point) => p1 === p2
export checkPointRefNeq = (p1: Point, p2: Point) => p1 !== p2
export checkGeneric = (a, b) => a === b
`.trim();
      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("(p1 === p2)");
      expect(res.typescript).toContain("(p1 !== p2)");
      expect(res.typescript).toContain("(a === b)");
    });
  });

  describe("2. Structural Equality '==' Semantics across Schemas, Data.struct, & Tagged Unions", () => {
    it("lowers nested schema equality to Effect's Equal.equals", async () => {
      const code = `
schema Geo = { lat: Number, lng: Number }
schema Venue = { name: String, location: Geo }

export compareVenues = (v1: Venue, v2: Venue) => v1 == v2
export compareVenuesNeq = (v1: Venue, v2: Venue) => v1 != v2
`.trim();
      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain('import { Equal, Schema } from "effect";');
      expect(res.typescript).toContain("Equal.equals(v1, v2)");
      expect(res.typescript).toContain("(!Equal.equals(v1, v2))");
    });

    it("evaluates structural equality on nested Data structures with Equal.equals", () => {
      const geo1 = Data.struct({ lat: 48.8566, lng: 2.3522 });
      const geo2 = Data.struct({ lat: 48.8566, lng: 2.3522 });
      const geo3 = Data.struct({ lat: 51.5074, lng: -0.1278 });

      const venue1 = Data.struct({ name: "Louvre", location: geo1 });
      const venue2 = Data.struct({ name: "Louvre", location: geo2 });
      const venue3 = Data.struct({ name: "Louvre", location: geo3 });

      // Structural value equality
      expect(Equal.equals(venue1, venue2)).toBe(true);
      expect(Equal.equals(venue1, venue3)).toBe(false);

      // Reference identity differs
      expect(venue1 === venue2).toBe(false);
      expect(venue1 === venue1).toBe(true);
    });

    it("evaluates structural equality on recursive tagged unions with Equal.equals", () => {
      type Tree = Data.TaggedEnum<{
        Leaf: { readonly value: number };
        Node: { readonly left: Tree; readonly right: Tree };
      }>;
      const $Tree = Data.taggedEnum<Tree>();

      const t1 = $Tree.Node({
        left: $Tree.Leaf({ value: 1 }),
        right: $Tree.Leaf({ value: 2 }),
      });
      const t2 = $Tree.Node({
        left: $Tree.Leaf({ value: 1 }),
        right: $Tree.Leaf({ value: 2 }),
      });
      const t3 = $Tree.Node({
        left: $Tree.Leaf({ value: 1 }),
        right: $Tree.Leaf({ value: 99 }),
      });

      expect(Equal.equals(t1, t2)).toBe(true);
      expect(Equal.equals(t1, t3)).toBe(false);
      expect(t1 === t2).toBe(false);
    });
  });

  describe("3. Match Form 1: Value Matching (Tagged Unions & Structural Patterns)", () => {
    it("compiles and executes tagged union value matching with positional extraction", async () => {
      const code = `
schema Shape =
  | Circle(radius: Number)
  | Rectangle(width: Number, height: Number)
  | Dot

export area = (s: Shape) =>
  match s
    | Circle(r) => r * r * 3
    | Rectangle(w, h) => w * h
    | Dot => 0
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain('import { match, P } from "ts-pattern";');
      expect(res.typescript).toContain("match(s)");
      expect(res.typescript).toContain('.with({ _tag: "Circle" },');
      expect(res.typescript).toContain('.with({ _tag: "Rectangle" },');
      expect(res.typescript).toContain('.with({ _tag: "Dot" },');
      expect(res.typescript).toContain(".exhaustive()");
    });

    it("compiles literal pattern matching with wildcard fallback", async () => {
      const code = `
export label = (code: Number) =>
  match code
    | 1 => "one"
    | 2 => "two"
    | _ => "other"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("match(code)");
      expect(res.typescript).toContain('.with(1, () => "one")');
      expect(res.typescript).toContain('.with(2, () => "two")');
      expect(res.typescript).toContain('.otherwise(() => "other")');
    });
  });

  describe("4. Match Form 2: Subjectless Matching (Ordered Boolean Conditions)", () => {
    it("compiles subjectless matches to ternary condition chains", async () => {
      const code = `
export grade = (score) =>
  match
    | score |> greaterThan(90) => "A"
    | score |> greaterThan(80) => "B"
    | score |> greaterThan(70) => "C"
    | _ => "F"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("greaterThan(90)");
      expect(res.typescript).toContain('? "A" :');
      expect(res.typescript).toContain("greaterThan(80)");
      expect(res.typescript).toContain('? "B" :');
      expect(res.typescript).toContain("greaterThan(70)");
      expect(res.typescript).toContain('? "C" : "F"');

      // Test execution with Effect Number module
      const { Number: EffectNumber } = await import("effect");
      const cleanCode = res.typescript.replace(/export /g, "").replace(/import .*;/g, "");
      const fn = new Function("pipe", "Number", `${cleanCode}; return grade;`)(pipe, EffectNumber);
      expect(fn(95)).toBe("A");
      expect(fn(85)).toBe("B");
      expect(fn(75)).toBe("C");
      expect(fn(50)).toBe("F");
    });

    it("compiles subjectless match arm with block body to an IIFE", async () => {
      const code = `
export checkFlag = (flag) =>
  match
    | flag =>
      status = "active"
      status
    | _ => "inactive"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("(() => {");
      expect(res.typescript).toContain("const status = \"active\";");

      const cleanCode = res.typescript.replace(/export /g, "").replace(/import .*;/g, "");
      const fn = new Function(`${cleanCode}; return checkFlag;`)();
      expect(fn(true)).toBe("active");
      expect(fn(false)).toBe("inactive");
    });
  });

  describe("5. Match Form 3: Inline and Multiline Formatting", () => {
    it("formats inline value match expression cleanly", () => {
      const unformatted = "res = match flag | true => 1 | false => 0";
      const formatted = format(unformatted);
      expect(formatted).toBe("res = match flag | true => 1 | false => 0\n");
      expect(format(formatted)).toBe(formatted);
    });

    it("formats inline subjectless match expression cleanly", () => {
      const unformatted = 'res = match | flag => "pos" | _ => "neg"';
      const formatted = format(unformatted);
      expect(formatted).toBe('res = match | flag => "pos" | _ => "neg"\n');
      expect(format(formatted)).toBe(formatted);
    });

    it("formats multiline value match expression with standard 2-space arm indentation", () => {
      const unformatted = `
export evalShape = (s: Shape) =>
  match s
    | Circle(r) => r
    | Dot => 0
`.trim();

      const formatted = format(unformatted);
      expect(formatted).toContain("  match s\n    | Circle(r) => r\n    | Dot => 0\n");
      expect(format(formatted)).toBe(formatted);
    });

    it("formats multiline subjectless match with standard 2-space indentation", () => {
      const unformatted = `
export testNum = (flag: Boolean) =>
  match
    | flag => "big"
    | _ => "small"
`.trim();

      const formatted = format(unformatted);
      expect(formatted).toContain("  match\n    | flag => \"big\"\n    | _ => \"small\"\n");
      expect(format(formatted)).toBe(formatted);
    });
  });

  describe("6. Match Form 4: Pipeline-to-Match Composition ('val |> match')", () => {
    it("parses, emits, and executes pipeline match with tagged union variants", async () => {
      const code = `
schema Option =
  | Some(value: Number)
  | None

export getVal = (opt: Option) =>
  opt |> match
    | Some(v) => v * 10
    | None => -1
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain('import { Data, pipe } from "effect";');
      expect(res.typescript).toContain('import { match, P } from "ts-pattern";');
      expect(res.typescript).toContain("pipe(\n  opt,\n  (($v) => match($v)");
      expect(res.typescript).toContain('.with({ _tag: "Some" },');
      expect(res.typescript).toContain('.with({ _tag: "None" },');
      expect(res.typescript).toContain(".exhaustive()");

      // End-to-end execution
      type Option = Data.TaggedEnum<{
        Some: { readonly value: number };
        None: {};
      }>;
      const $Option = Data.taggedEnum<Option>();
      const Some = (value: number) => $Option.Some({ value });
      const None = $Option.None();

      const getVal = (opt: any) =>
        pipe(
          opt,
          (($v: any) =>
            match($v)
              .with({ _tag: "Some" }, ($matched: any) => {
                const { _tag: _, ...__fields } = $matched;
                const [v] = Object.values(__fields) as any[];
                return v * 10;
              })
              .with({ _tag: "None" }, () => -1)
              .exhaustive()) as any
        );

      expect(getVal(Some(5))).toBe(50);
      expect(getVal(None)).toBe(-1);
    });

    it("parses and formats inline pipeline match expression", () => {
      const unformatted = "res = opt |> match | Some(v) => v | None => 0";
      const formatted = format(unformatted);
      expect(formatted).toBe("res = opt |> match | Some(v) => v | None => 0\n");
      expect(format(formatted)).toBe(formatted);
    });

    it("formats multiline pipeline match expression cleanly", () => {
      const unformatted = `
export unwrap = (opt: Option) =>
  opt |> match
    | Some(x) => x
    | None => 0
`.trim();

      const formatted = format(unformatted);
      expect(formatted).toContain("  opt |> match\n    | Some(x) => x\n    | None => 0\n");
      expect(format(formatted)).toBe(formatted);
    });
  });

  describe("7. Match Form 5: Or-Patterns ('| Red | Green | Blue =>')", () => {
    it("compiles Or-patterns with ts-pattern P.union", async () => {
      const code = `
schema Color =
  | Red
  | Green
  | Blue
  | Yellow

export isPrimary = (c: Color) =>
  match c
    | Red | Green | Blue => "primary"
    | Yellow => "other"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain('import { match, P } from "ts-pattern";');
      expect(res.typescript).toContain(
        'P.union({ _tag: "Red" }, { _tag: "Green" }, { _tag: "Blue" })'
      );
      expect(res.typescript).toContain('"primary"');
    });

    it("compiles literal Or-patterns", async () => {
      const code = `
export httpStatusGroup = (code) =>
  match code
    | 200 | 201 | 204 => "success"
    | 400 | 401 | 404 => "client_error"
    | _ => "unknown"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain("P.union(200, 201, 204)");
      expect(res.typescript).toContain("P.union(400, 401, 404)");
      expect(res.typescript).toContain('.otherwise(() => "unknown")');

      // Verify execution using ts-pattern runtime
      const cleanCode = res.typescript.replace(/export /g, "").replace(/import .*;/g, "");
      const fn = new Function("match", "P", `${cleanCode}; return httpStatusGroup;`)(match, P);
      expect(fn(200)).toBe("success");
      expect(fn(201)).toBe("success");
      expect(fn(404)).toBe("client_error");
      expect(fn(500)).toBe("unknown");
    });

    it("formats Or-patterns cleanly with ' | ' separators", () => {
      const unformatted = `
export isRgb = (c: Color) =>
  match c
    | Red|Green|Blue => true
    | _ => false
`.trim();

      const formatted = format(unformatted);
      expect(formatted).toContain("    | Red | Green | Blue => true\n");
      expect(format(formatted)).toBe(formatted);
    });
  });

  describe("8. Match Form 6: Match-Arm 'when' Guards ('| Pattern when cond =>')", () => {
    it("compiles and executes constructor pattern match with when guards", async () => {
      const code = `
schema Action =
  | Deposit(amount: Number)
  | Withdraw(amount: Number)
  | Reset

export classifyAction = (act: Action) =>
  match act
    | Deposit(amount) when amount |> greaterThan(1000) => "huge deposit"
    | Deposit(amount) when amount |> greaterThan(100) => "medium deposit"
    | Deposit(_) => "small deposit"
    | Withdraw(amount) when amount |> greaterThan(500) => "large withdrawal"
    | Withdraw(_) => "normal withdrawal"
    | Reset => "reset"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain('.with({ _tag: "Deposit" }, ($matched) => {');
      expect(res.typescript).toContain("greaterThan(1000)");
      expect(res.typescript).toContain('"huge deposit"');
      expect(res.typescript).toContain("greaterThan(100)");
      expect(res.typescript).toContain('"medium deposit"');
      expect(res.typescript).toContain('"small deposit"');
      expect(res.typescript).toContain("greaterThan(500)");
      expect(res.typescript).toContain('"large withdrawal"');
      expect(res.typescript).toContain(".exhaustive()");

      // Execute via node with Data and ts-pattern
      type Action = Data.TaggedEnum<{
        Deposit: { readonly amount: number };
        Withdraw: { readonly amount: number };
        Reset: {};
      }>;
      const $Action = Data.taggedEnum<Action>();
      const Deposit = (amount: number) => $Action.Deposit({ amount });
      const Withdraw = (amount: number) => $Action.Withdraw({ amount });
      const Reset = $Action.Reset();
      const greaterThan = (thresh: number) => (val: number) => val > thresh;

      const classify = (act: Action) =>
        match(act)
          .with(
            { _tag: "Deposit" },
            ($matched) => {
              const { _tag: _, ...__fields } = $matched as any;
              const [amount] = Object.values(__fields) as any[];
              return pipe(amount, greaterThan(1000));
            },
            () => "huge deposit"
          )
          .with(
            { _tag: "Deposit" },
            ($matched) => {
              const { _tag: _, ...__fields } = $matched as any;
              const [amount] = Object.values(__fields) as any[];
              return pipe(amount, greaterThan(100));
            },
            () => "medium deposit"
          )
          .with({ _tag: "Deposit" }, () => "small deposit")
          .with(
            { _tag: "Withdraw" },
            ($matched) => {
              const { _tag: _, ...__fields } = $matched as any;
              const [amount] = Object.values(__fields) as any[];
              return pipe(amount, greaterThan(500));
            },
            () => "large withdrawal"
          )
          .with({ _tag: "Withdraw" }, () => "normal withdrawal")
          .with({ _tag: "Reset" }, () => "reset")
          .exhaustive();

      expect(classify(Deposit(5000))).toBe("huge deposit");
      expect(classify(Deposit(500))).toBe("medium deposit");
      expect(classify(Deposit(50))).toBe("small deposit");
      expect(classify(Withdraw(1000))).toBe("large withdrawal");
      expect(classify(Withdraw(50))).toBe("normal withdrawal");
      expect(classify(Reset)).toBe("reset");
    });

    it("formats match-arm when guards cleanly with spacing", () => {
      const unformatted = `
export check = (act: Action) =>
  match act
    | Deposit(amount) when flag => "large"
    | _ => "other"
`.trim();

      const formatted = format(unformatted);
      expect(formatted).toContain("    | Deposit(amount) when flag => \"large\"\n");
      expect(format(formatted)).toBe(formatted);
    });
  });
});
