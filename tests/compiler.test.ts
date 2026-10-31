import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import ts from "typescript";
import { compileString, checkString, CompilerError } from "../src/compiler.js";
import { typeCheckSource } from "../src/compiler/check.js";

describe("FunScript Compiler", () => {
  it("compiles basic bindings and arithmetic", async () => {
    const code = `
export name = "Ada"
export age = 36
export nextAge = age + 1
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`export const name = "Ada";`);
    expect(res.typescript).toContain(`export const age = 36;`);
    expect(res.typescript).toContain(`export const nextAge = (age + 1);`);
  });

  it("compiles lambdas and pipelines", async () => {
    const code = `
export add = (a: Number, b: Number) -> a + b
export res = 5 |> add(10, _)
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { pipe } from "effect";`);
    expect(res.typescript).toContain(`export const add = (a: number, b: number) => (a + b);`);
    expect(res.typescript).toContain(`(__p) => add(10, __p)`);
  });

  it("compiles pipeline placeholder binary, member, unary, and logical expressions", async () => {
    const code = `
export resAdd = 5 |> (_ + 1)
export resMember = user |> _.profile.name
export resUnary = true |> not _
export resLogical = 7 |> (_ == 7 and _ != 0)
export resChained = 5 |> (_ + 1) |> (_ * 2)
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { pipe } from "effect";`);
    expect(res.typescript).toContain(`pipe(\n  5,\n  (__p) => (__p + 1)\n)`);
    expect(res.typescript).toContain(`pipe(\n  user,\n  (__p) => __p.profile.name\n)`);
    expect(res.typescript).toContain(`pipe(\n  true,\n  (__p) => (!__p)\n)`);
    expect(res.typescript).toContain(`pipe(\n  7,\n  (__p) => ((__p === 7) && (__p !== 0))\n)`);
    expect(res.typescript).toContain(`pipe(\n  5,\n  (__p) => (__p + 1),\n  (__p) => (__p * 2)\n)`);

    const { pipe } = await import("effect");
    const evalCode = res.typescript.replace(/import .*\n/g, "").replace(/export const /g, "const ");
    const fn = new Function("pipe", "user", `${evalCode}; return { resAdd, resMember, resUnary, resLogical, resChained };`);
    const evaluated = fn(pipe, { profile: { name: "Alice" } });
    expect(evaluated.resAdd).toBe(6);
    expect(evaluated.resMember).toBe("Alice");
    expect(evaluated.resUnary).toBe(false);
    expect(evaluated.resLogical).toBe(true);
    expect(evaluated.resChained).toBe(12);
  });

  it("compiles record schemas and tagged union schemas", async () => {
    const code = `
export schema User = {
  id: String
  name: String
}

export schema Shape =
  | Circle(radius: Number)
  | Rect(width: Number, height: Number)
  | Point
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { Data, Schema } from "effect";`);
    expect(res.typescript).toContain(`export const User = Schema.Struct({`);
    expect(res.typescript).toContain(`id: Schema.String`);
    expect(res.typescript).toContain(`export type Shape = Data.TaggedEnum<{`);
    expect(res.typescript).toContain(`Circle: { readonly radius: number }`);
    expect(res.typescript).toContain(`export const Point: Shape = $Shape.Point();`);
  });

  it("emits Array schemas for fields in Schema.Struct", async () => {
    const res = await Effect.runPromise(compileString(`export schema Items = { items: Array<String> }`));
    expect(res.typescript).toContain(`items: Schema.Array(Schema.String)`);

    const { Schema } = await import("effect");
    const evalCode = ts.transpile(res.typescript, { module: ts.ModuleKind.ESNext })
      .replace(/import .*\n/g, "")
      .replace(/\bexport\s+/g, "");
    const decode = new Function("Schema", `${evalCode}; return Items;`)(Schema);
    expect(Schema.decodeUnknownSync(decode)({ items: ["a", "b"] })).toEqual({ items: ["a", "b"] });
  });

  it("compiles 'js' keyword for interop (export js, effect ingress, pipeline js)", async () => {
    const code = `
export js fetchUser = (id: String) ->
  effect
    res <- js fetch("https://api.com/users/" + id)
    payload <- js res.json()
    payload

export runPromiseTest = fetchUser("123") |> js
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { Effect, Schema, pipe } from "effect";`);
    expect(res.typescript).toContain(`export const fetchUser = (id: string) => {`);
    expect(res.typescript).toContain(`id = Schema.decodeUnknownSync(Schema.String)(id);`);
    expect(res.typescript).toContain(`const res = yield* Effect.tryPromise(() => fetch(("https://api.com/users/" + id)));`);
    expect(res.typescript).toContain(`const payload = yield* Effect.tryPromise(() => res.json());`);
    expect(res.typescript).toContain(`Effect.runPromise`);
  });

  it("compiles 'ts' keyword for TypeScript escape hatches", async () => {
    const code = `
ts "interface CustomBuffer { size: number }"

schema UserMap = ts "Record<string, unknown>"

export createBuffer = ts "Buffer.from('hello')"
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`interface CustomBuffer { size: number }`);
    expect(res.typescript).toContain(`Record<string, unknown>`);
    expect(res.typescript).toContain(`export const createBuffer = Buffer.from('hello');`);
  });

  it("compiles indented 'ts' block escape hatch", async () => {
    const code = `
ts
  interface MultiLineConfig {
    readonly host: string;
    readonly port: number;
  }

export host = "localhost"
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`interface MultiLineConfig {`);
    expect(res.typescript).toContain(`readonly host: string;`);
    expect(res.typescript).toContain(`readonly port: number;`);
  });

  it("compiles effect blocks with direct service calls", async () => {
    const code = `
export getUser = (id: String) ->
  effect
    user <- UserRepo.find(id)
    _ <- Console.log(user)
    user
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { Effect } from "effect";`);
    expect(res.typescript).toContain(`Effect.gen(function* () {`);
    expect(res.typescript).toContain(`const user = yield* (yield* UserRepo).find(id);`);
    expect(res.typescript).toContain(`yield* Console.log(user);`);
    expect(res.typescript).toContain(`return user;`);
  });

  it("compiles brace-delimited effects as pipeline expressions", async () => {
    const res = await Effect.runPromise(compileString(`result = effect {\n  user <- fetchUser()\n  user |> summarize\n}`));
    expect(res.typescript).toContain("Effect.gen(function* () {");
    expect(res.typescript).toContain("const user = yield* fetchUser();");
    expect(res.typescript).toContain("summarize");
  });

  it("compiles when statements inside effect blocks", async () => {
    const code = `
export earlyValue = (skip: Boolean) ->
  effect
    when (skip) => "early"
    "done"

export failEarly = (shouldFail: Boolean) ->
  effect
    when (shouldFail) => Effect.fail("failed")
    "done"

export conditionalBlock = (enabled: Boolean) ->
  effect
    when (enabled) {
      selected = "inside"
    }
    "done"
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`if (skip) return "early";`);
    expect(res.typescript).toContain(`if (shouldFail) return yield* Effect.fail("failed");`);
    expect(res.typescript).toContain(`if (enabled) {\n  const selected = "inside";\n}`);
    expect(res.typescript).toContain(`return "done";`);
  });

  it("compiles deep Mutative spreads", async () => {
    const code = `
export updateCity = (user: User, city: String) ->
  {
    ...user
    address.city: city
  }
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { create } from "mutative";`);
    expect(res.typescript).toContain(`create(user, (draft) => {`);
    expect(res.typescript).toContain(`draft.address.city = city;`);
  });

  it("checks pipeline mut recipes without returning the draft proxy", async () => {
    const code = `
tasks = ["existing"]
item = "new"
updated = tasks |> mut (draft) ->
  draft.push(item)
  draft
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain("draft.push(item);");
    expect(res.typescript).not.toContain("return draft;");

    const checked = await Effect.runPromise(typeCheckSource(code, "mut-recipe.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("supports member and index assignments in mut draft blocks", async () => {
    const code = `
profile = { name: "Ada", tags: ["old"] }
updated = profile |> mut (draft) ->
  draft.name = "Grace"
  draft.tags[0] = "new"
  draft
`.trim();
    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain('draft.name = "Grace";');
    expect(res.typescript).toContain('draft.tags[0] = "new";');
    const checked = await Effect.runPromise(typeCheckSource(code, "mut-assignment.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("deduplicates generated Effect imports against user imports during checking", async () => {
    const code = `
import { Effect } from "effect"
export task = Effect.succeed(1)
`.trim();
    const result = await Effect.runPromise(typeCheckSource(code, "effect-import-dedup.fun"));
    expect(result.success, result.formattedOutput).toBe(true);
    expect(result.formattedOutput).not.toContain("TS2300");
  });

  describe("Complex pattern matching code generation", () => {
    it("compiles constructor pattern matching with field unpack and guards using ts-pattern", async () => {
      const code = `
export describeShape = (shape: Shape) ->
  match shape
    | Circle(r) when r |> Number.greaterThan(0) -> r * 2
    | Rect(w, h) -> w * h
    | Point -> 0
    | _ -> -1
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`import { match, P } from "ts-pattern";`);
      expect(res.typescript).toContain(`match(shape)`);
      expect(res.typescript).toContain(`.with({ _tag: "Circle" }`);
      expect(res.typescript).toContain(`const [r] = Object.values(__fields) as any[];`);
      expect(res.typescript).toContain(`.with({ _tag: "Rect" }`);
      expect(res.typescript).toContain(`const [w, h] = Object.values(__fields) as any[];`);
      expect(res.typescript).toContain(`.with({ _tag: "Point" }, () => 0)`);
      expect(res.typescript).toContain(`.otherwise(() => (-1))`);
    });

    it("compiles exhaustive pattern matching without otherwise arm", async () => {
      const code = `
export getArea = (shape: Shape) ->
  match shape
    | Circle(r) -> r * r
    | Rect(w, h) -> w * h
    | Point -> 0
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`.exhaustive()`);
      expect(res.typescript).not.toContain(`.otherwise`);
    });

    it("compiles literal pattern matching (numbers and booleans)", async () => {
      const code = `
export httpStatus = (code: Number) ->
  match code
    | 200 -> "ok"
    | 404 -> "not found"
    | _ -> "error"

export boolToString = (flag: Boolean) ->
  match flag
    | true -> "yes"
    | false -> "no"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`.with(200, () => "ok")`);
      expect(res.typescript).toContain(`.with(404, () => "not found")`);
      expect(res.typescript).toContain(`.otherwise(() => "error")`);
      expect(res.typescript).toContain(`.with(true, () => "yes")`);
      expect(res.typescript).toContain(`.with(false, () => "no")`);
      expect(res.typescript).toContain(`.exhaustive()`);
    });

    it("compiles subjectless boolean match expressions to ternary chains", async () => {
      const code = `
export classify = (score: Number) ->
  match
    | score |> Number.greaterThan(90) -> "A"
    | score |> Number.greaterThan(80) -> "B"
    | _ -> "C"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`Number.greaterThan(90)`);
      expect(res.typescript).toContain(`? "A" :`);
      expect(res.typescript).toContain(`Number.greaterThan(80)`);
      expect(res.typescript).toContain(`? "B" : "C"`);
    });

    it("compiles subjectless match arm with block body to an IIFE", async () => {
      const code = `
export check = (flag: Boolean) ->
  match
    | flag ->
      step1 = 1
      step1 + 10
    | _ -> 0
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`(() => {`);
      expect(res.typescript).toContain(`const step1 = 1;`);
      expect(res.typescript).toContain(`return (step1 + 10);`);
    });
  });

  describe("Error declarations, services, and typed holes code generation", () => {
    it("compiles error declarations to Schema.TaggedError", async () => {
      const code = `
export error UserNotFound(id: String, code: Number)
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`import { Schema } from "effect";`);
      expect(res.typescript).toContain(
        `export class UserNotFound$Class extends Schema.TaggedError<UserNotFound$Class>()("UserNotFound", {\n  id: Schema.String,\n  code: Schema.Number\n}) {}`
      );
      expect(res.typescript).toContain(`export const UserNotFound = (function(args: ConstructorParameters<typeof UserNotFound$Class>[0]): UserNotFound { return new UserNotFound$Class(args); }) as { (args: ConstructorParameters<typeof UserNotFound$Class>[0]): UserNotFound; new (args: ConstructorParameters<typeof UserNotFound$Class>[0]): UserNotFound };`);

      const { Schema } = await import("effect");
      const evalCode = res.typescript.replace(/import .*\n/g, "").replace(/<UserNotFound\$Class>\(\)/g, "()").replace(/\(function\(args: ConstructorParameters<typeof UserNotFound\$Class>\[0\]\): UserNotFound \{ return new UserNotFound\$Class\(args\); \}\) as \{[^}]+\}/, "function(args) { return new UserNotFound$Class(args); }").replace(/export type .*\n/g, "").replace(/export const /g, "const ").replace(/export class /g, "class ");
      const makeError = new Function("Schema", `${evalCode}; return UserNotFound;`)(Schema);
      const error = makeError({ id: "u1", code: 404 });
      expect(error).toBeInstanceOf(Error);
      expect(error.id).toBe("u1");
    });

    it("compiles service declarations with custom tag to Context.Tag", async () => {
      const code = `
export service PaymentGateway "custom/payment/gateway"
  charge: (amount: Number) -> Effect<Receipt, PaymentFailed>
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`import { Context, Effect } from "effect";`);
      expect(res.typescript).toContain(`export class PaymentGateway extends Context.Tag("custom/payment/gateway")<PaymentGateway, {`);
      expect(res.typescript).toContain(`readonly charge: (amount: number) => Effect.Effect<Receipt, PaymentFailed, never>;`);
    });

    it("compiles typed holes to runtime throw expressions", async () => {
      const code = `
export unfinished = () -> ??? "implement later"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`throw new Error("Typed hole reached: implement later");`);
    });
  });

  describe("Compiler Error Diagnostics", () => {
    it("fails with CompilerError diagnostic when encountering banned keywords", async () => {
      const failure = await Effect.runPromise(Effect.flip(compileString(`let x = 10`)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("FunScript has no 'let'");
    });

    it("fails with CompilerError diagnostic when encountering banned symbols", async () => {
      const failure1 = await Effect.runPromise(Effect.flip(compileString(`res = a && b`)));
      expect(failure1).toBeInstanceOf(CompilerError);
      expect(failure1.message).toContain("FunScript logical AND is 'and'");

      const failure2 = await Effect.runPromise(Effect.flip(compileString(`res = !a`)));
      expect(failure2).toBeInstanceOf(CompilerError);
      expect(failure2.message).toContain("FunScript logical NOT is 'not'");
    });

    it("fails with CompilerError diagnostic when encountering tabs", async () => {
      const failure = await Effect.runPromise(Effect.flip(compileString(`x\t= 1`)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Tabs are not allowed");
    });

    it("fails with CompilerError diagnostic when encountering syntax errors in parser", async () => {
      const failure = await Effect.runPromise(Effect.flip(compileString(`schema User`)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Expected '=' after schema name");
    });

    it("fails with CompilerError diagnostic for non-final bare expression in effect block", async () => {
      const code = `
getUser = () ->
  effect
    Console.log("test")
    "done"
`;
      const failure = await Effect.runPromise(Effect.flip(compileString(code)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Non-final bare expression in effect block is not executed");
    });

    it("fails with CompilerError diagnostic when effect block misses return expression", async () => {
      const code = `
getUser = () ->
  effect
    user <- UserRepo.find("123")
`;
      const failure = await Effect.runPromise(Effect.flip(compileString(code)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Effect block must end with a return expression");
    });

    it("verifies checkString returns AST on success and CompilerError on failure", async () => {
      const validCode = `x = 42\ny = x + 1`;
      const ast = await Effect.runPromise(checkString(validCode));
      expect(ast.kind).toBe("Program");
      expect(ast.body.length).toBe(2);

      const invalidCode = `var x = 42`;
      const failure = await Effect.runPromise(Effect.flip(checkString(invalidCode)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("FunScript has no 'var'");
    });
  });
});
