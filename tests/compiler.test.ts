import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import ts from "typescript";
import { compileString, checkString, CompilerError } from "../src/compiler.js";
import { typeCheckSource } from "../src/compiler/check.js";
import {
  compile,
  compileFailure,
  expectCompileError,
  execute,
  evalTypescript,
} from "./helpers/index.js";

describe("FunScript Compiler", () => {
  it("compiles basic bindings and arithmetic", async () => {
    const code = `
export name = "Ada"
export age = 36
export nextAge = age + 1
`.trim();

    const res = await compile(code);
    expect(res.typescript).toContain(`export const name = "Ada";`);
    expect(res.typescript).toContain(`export const age = 36;`);
    expect(res.typescript).toContain(`export const nextAge = (age + 1);`);
  });

  it("preserves numeric separators while evaluating their numeric value", async () => {
    const result = await compile("export total = 110_110 + 0.5_0");
    expect(result.typescript).toContain("110_110");
    expect(result.typescript).toContain("0.5_0");
  });

  it("uses Effect v4 Number.is* comparison names without legacy aliases", async () => {
    const result = await compile("export valid = 5 |> isGreaterThan(3)");
    expect(result.typescript).toContain("Number.isGreaterThan(3)");
    expect(result.typescript).not.toContain("Number.greaterThan");
  });

  it("emits native ordering operators for number comparisons", async () => {
    const result = await compile("export valid = 5 >= 3 and 2 < 4");
    expect(result.typescript).toContain("((5 >= 3) && (2 < 4))");
  });

  it("rejects native ordering operators for strings with an Effect Order diagnostic and doc link", async () => {
    const code = "export valid = (left: String, right: String) => left < right";
    const failure = await expectCompileError(
      code,
      "< is only available for numbers; this operand has type string. Use Order.isLessThan(String.Order)(...) or an explicit domain Order. See docs/syntax.md#42-equality-and-comparisons.",
    );

    expect((failure as any).span).toMatchObject({
      start: { offset: 48, line: 1, column: 49 },
      end: { offset: 48, line: 1, column: 49 },
    });
  });

  it("rejects unknown values in native ordering operators", async () => {
    await expectCompileError(
      "export valid = (value: Unknown) => value >= 0",
      ">= is only available for numbers; this operand has type unknown",
    );
  });

  it("suggests inclusive Effect predicates for inclusive operators", async () => {
    for (const [operator, method] of [[">=", "isGreaterThanOrEqualTo"], ["<=", "isLessThanOrEqualTo"]]) {
      await expect(Effect.runPromise(compileString(`export invalid = (value: String) => value ${operator} "x"`)))
        .rejects.toThrow(`Order.${method}(String.Order)`);
    }
  });

  it("infers pipeline companions in funx files", async () => {
    const source = "ts { declare function numbers(): ReadonlyArray<number> }\nexport result = numbers() |> map((x) => x + 1)";
    const result = await Effect.runPromise(compileString(source, "inference.funx"));
    expect(result.typescript).toContain("Array.map");
  });

  it("rejects ambiguous pipeline stages on mixed unions", async () => {
    const source = "ts { declare const value: ReadonlyArray<number> | string }\nexport result = value |> map((x) => x)";
    await expect(Effect.runPromise(compileString(source, "union.fun"))).rejects.toThrow("map is ambiguous");
    const optional = "ts { declare const value: import('effect').Option.Option<number> | undefined }\nexport result = value |> map((x) => x)";
    await expect(Effect.runPromise(compileString(optional, "optional-union.fun"))).rejects.toThrow("map is ambiguous");
  });

  it("enforces numeric ordering in funx files", async () => {
    const result = await Effect.runPromise(compileString("export valid = 1 < 2", "comparison.funx"));
    expect(result.typescript).toContain("(1 < 2)");
    await expect(Effect.runPromise(compileString('export invalid = "a" < "b"', "comparison.funx")))
      .rejects.toThrow("< is only available for numbers");
  });

  it("preserves checker facts across comparison, pipeline, and interop passes", async () => {
    const code = `
ts { declare function nativeValue(): Promise<number | null> }
values = [1, 2]
export result = effect {
  value <- js nativeValue()
  => values |> Array.filter((n: Number) => n > 0)
}
`.trim();
    const result = await Effect.runPromise(compileString(code, "mixed-checks.fun"));
    expect(result.typescript).toContain("__funscriptJs(() => nativeValue(), true)");
    expect(result.typescript).toContain("Array.filter");
    expect(result.typescript).toContain("(n > 0)");
  });

  it("compiles lambdas and pipelines", async () => {
    const code = `
export add = (a: Number, b: Number) => a + b
export res = 5 |> add(10, _)
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { pipe } from "effect";`);
    expect(res.typescript).toContain(`export const add = (a: number, b: number) => (a + b);`);
    expect(res.typescript).toContain(`(__p) => add(10, __p)`);
  });

  it("auto-resolves mapError as an Effect pipeline stage", async () => {
    const code = `export safe = Effect.fail("network") |> mapError((reason) => "mapped")`;

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`Effect.mapError((reason) => "mapped")`);

    const checked = await Effect.runPromise(typeCheckSource(code, "map-error.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("keeps Effect compatibility aliases available as bare Effect stages", async () => {
    const result = await Effect.runPromise(compileString(`export recovered = Effect.fail("nope") |> catchAll(() => Effect.succeed("ok"))`));
    expect(result.typescript).toContain(`Effect.catch(() => Effect.succeed("ok"))`);
  });

  it("resolves Schedule and Layer stages from their proven sources", async () => {
    const source = `
export schedule = Schedule.recurs(1) |> map((metadata) => metadata.output)
export layer = Layer.empty |> fresh
`.trim();
    const result = await Effect.runPromise(compileString(source));
    expect(result.typescript).toContain("Schedule.map((metadata) => metadata.output)");
    expect(result.typescript).toContain("Layer.fresh");
    const checked = await Effect.runPromise(typeCheckSource(source, "schedule-layer.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("resolves Stream stages from a proven Stream source", async () => {
    const source = `export values = Stream.succeed(1) |> map((value) => value + 1) |> flatMap((value) => Stream.succeed(value))`;
    const result = await Effect.runPromise(compileString(source));
    expect(result.typescript).toContain("Stream.map((value) => (value + 1))");
    expect(result.typescript).toContain("Stream.flatMap((value) => Stream.succeed(value))");
    const checked = await Effect.runPromise(typeCheckSource(source, "stream.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("resolves schema-to-schema combinators from a proven Schema source", async () => {
    const source = `export Named = Schema.String |> annotate({ title: "Name" })`;
    const result = await Effect.runPromise(compileString(source));
    expect(result.typescript).toContain(`Schema.annotate({ title: "Name" })`);
    const checked = await Effect.runPromise(typeCheckSource(source, "schema-pipeline.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("auto-resolves Effect operations, including names shared with Array, in Effect pipelines", async () => {
    const code = `
export transformed =
  Effect.succeed(1)
  |> map((value) => value + 1)
  |> flatMap((value) => Effect.succeed(value * 2))
  |> as("done")
  |> timeout("1 second")
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`Effect.map((value) => (value + 1))`);
    expect(res.typescript).toContain(`Effect.flatMap((value) => Effect.succeed((value * 2)))`);
    expect(res.typescript).toContain(`Effect.as("done")`);
    expect(res.typescript).toContain(`Effect.timeout("1 second")`);

    const checked = await Effect.runPromise(typeCheckSource(code, "effect-pipeline.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("uses a proven array source to resolve an otherwise ambiguous bare operation", async () => {
    const res = await Effect.runPromise(compileString(`export values = [1, 2] |> map((value) => value + 1)`));
    expect(res.typescript).toContain(`Array.map((value) => (value + 1))`);
  });

  it("proves companion modules through local pipeline bindings", async () => {
    const res = await Effect.runPromise(compileString(`
export value = Option.some(1)
export mapped = value |> map((item) => item + 1)
`.trim()));
    expect(res.typescript).toContain(`Option.map((item) => (item + 1))`);
    const checked = await Effect.runPromise(typeCheckSource(`
export value = Option.some(1)
export mapped = value |> map((item) => item + 1)
`.trim(), "option-binding.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("uses TypeScript inference for a pipeline source returned by a function", async () => {
    const source = "export make = () => Option.some(1)\nexport mapped = make() |> map((item) => item + 1)";
    const result = await Effect.runPromise(compileString(source, "function-result.fun"));
    expect(result.typescript).toContain("Option.map((item) => (item + 1))");
  });

  it("uses TypeScript inference for an imported pipeline source", async () => {
    const source = 'import { importedOption } from "./fixtures/pipeline-companion-source.js"\nexport mapped = importedOption |> map((item) => item + 1)';
    const result = await Effect.runPromise(compileString(source, "tests/imported-pipeline.fun"));
    expect(result.typescript).toContain("Option.map((item) => (item + 1))");
  });

  it("reports an actionable diagnostic for an unproven ambiguous bare operation", async () => {
    await expect(Effect.runPromise(compileString(`export apply = (value) => value |> map((item) => item)`)))
      .rejects.toThrow("map is ambiguous for this pipeline; write Array.map(...) or Option.map(...)");
  });

  it("compiles pipeline placeholder binary, member, unary, and logical expressions", async () => {
    const code = `
export resAdd = 5 |> (_ + 1)
export resMember = user |> _.profile.name
export resUnary = true |> not _
export resLogical = 7 |> (_ #= 7 and _ #! 0)
export resChained = 5 |> (_ + 1) |> (_ * 2)
`.trim();

    const res = await compile(code);
    expect(res.typescript).toContain(`import { pipe } from "effect";`);
    expect(res.typescript).toContain(`pipe(\n  5,\n  (__p) => (__p + 1)\n)`);
    expect(res.typescript).toContain(`pipe(\n  user,\n  (__p) => __p.profile.name\n)`);
    expect(res.typescript).toContain(`pipe(\n  true,\n  (__p) => (!__p)\n)`);
    expect(res.typescript).toContain(`pipe(\n  7,\n  (__p) => ((__p === 7) && (__p !== 0))\n)`);
    expect(res.typescript).toContain(`pipe(\n  5,\n  (__p) => (__p + 1),\n  (__p) => (__p * 2)\n)`);

    const evaluated = evalTypescript(res.typescript, {
      scope: { user: { profile: { name: "Alice" } } },
    }).exports;
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
    const res = await compile(`export schema Items = { items: Array<String> }`);
    expect(res.typescript).toContain(`items: Schema.Array(Schema.String)`);

    const { Items } = evalTypescript(res.typescript).exports;
    const { Schema } = await import("effect");
    expect(Schema.decodeUnknownSync(Items)({ items: ["a", "b"] })).toEqual({ items: ["a", "b"] });
  });

  it("compiles ts schema declarations for imported TypeScript types and structural types", async () => {
    const code = `
export ts schema User = UserType
export ts schema Config = { timeout: Number }
`.trim();

    const res = await compile(code);
    expect(res.typescript).toContain(`import { Schema } from "effect";`);
    expect(res.typescript).toContain(`export const User = (Schema.Unknown as unknown as Schema.Schema<UserType>);`);
    expect(res.typescript).toContain(`export type User = typeof User.Type;`);
    expect(res.typescript).toContain(`export const UserFromUnknown = (input: unknown): User => Schema.decodeUnknownSync(User)(input);`);
    expect(res.typescript).toContain(`export const Config = Schema.Struct({`);
    expect(res.typescript).toContain(`timeout: Schema.Number`);

    const { ConfigFromUnknown } = evalTypescript(res.typescript).exports;
    expect(ConfigFromUnknown({ timeout: 5000 })).toEqual({ timeout: 5000 });
  });

  it("compiles 'js' keyword for interop (export js, effect ingress, pipeline js)", async () => {
    const code = `
export js fetchUser = (id: String) =>
  effect
    res <- js fetch("https://api.com/users/" + id)
    payload <- js res.json()
    => payload

export runPromiseTest = fetchUser("123") |> js
`.trim();

    const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`import { Effect, Option, Schema, pipe } from "effect";`);
    expect(res.typescript).toContain(`export const fetchUser = (id: string) => {`);
    expect(res.typescript).toContain(`id = Schema.decodeUnknownSync(Schema.String)(id);`);
      expect(res.typescript).toContain(`const res = yield* __funscriptJs(() => fetch(("https://api.com/users/" + id)), false);`);
      expect(res.typescript).toContain(`const payload = yield* __funscriptJs(() => res.json(), "unknown");`);
    expect(res.typescript).toContain(`Effect.runPromise`);
  });

  it("uses TypeScript return types to normalize nullable js results to Option", async () => {
    const code = `
ts {
declare function nullableNative(): Promise<string | null | undefined>
declare function requiredNative(): Promise<string>
declare function untrustedNative(): Promise<any>
}

export nullable = effect {
  value <- js nullableNative()
  => value
}

export required = effect {
  value <- js requiredNative()
  => value
}

export untrusted = effect {
  value <- js untrustedNative()
  => value
}
`.trim();

    const res = await Effect.runPromise(compileString(code, "native-interop.fun"));
    expect(res.typescript).toContain('import { Effect, Option } from "effect";');
    expect(res.typescript).toContain('class JsInteropError extends Error');
    expect(res.typescript).toContain("__funscriptJs(() => nullableNative(), true)");
    expect(res.typescript).toContain("__funscriptJs(() => requiredNative(), false)");
    expect(res.typescript).toContain('__funscriptJs(() => untrustedNative(), "unknown")');
    expect(res.typescript).toContain("Option.fromNullishOr");
    expect(res.typescript).toContain("catch: (cause) => new JsInteropError(cause)");

    const checked = await Effect.runPromise(typeCheckSource(code, "native-interop.fun"));
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("compiles 'ts' keyword for TypeScript escape hatches", async () => {
    const code = `
ts { interface CustomBuffer { size: number } }

schema UserMap = ts { Record<string, unknown> }

export createBuffer = ts { Buffer.from('hello') }
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`interface CustomBuffer { size: number }`);
    expect(res.typescript).toContain(`Record<string, unknown>`);
    expect(res.typescript).toContain(`export const createBuffer = Buffer.from('hello');`);
  });

  it("compiles brace-delimited 'ts' block escape hatches", async () => {
    const code = `
ts {
  interface MultiLineConfig {
    readonly host: string;
    readonly port: number;
  }
}

export host = "localhost"
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`interface MultiLineConfig {`);
    expect(res.typescript).toContain(`readonly host: string;`);
    expect(res.typescript).toContain(`readonly port: number;`);
  });

  it("rejects removed quoted and indentation-based ts escapes", async () => {
    await expect(Effect.runPromise(compileString('schema Legacy = ts "Record<string, unknown>"'))).rejects.toThrow("Expected '{ ... }' after 'ts'");
    await expect(Effect.runPromise(compileString("ts\n  interface Legacy {}"))).rejects.toThrow("Expected '{ ... }' after 'ts'");
  });

  it("compiles effect blocks with direct service calls", async () => {
    const code = `
export getUser = (id: String) =>
  effect
    user <- UserRepo.find(id)
    _ <- Console.log(user)
    => user
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`import { Effect } from "effect";`);
    expect(res.typescript).toContain(`Effect.gen(function* () {`);
    expect(res.typescript).toContain(`const user = yield* (yield* UserRepo).find(id);`);
    expect(res.typescript).toContain(`yield* Console.log(user);`);
    expect(res.typescript).toContain(`return user;`);
  });

  it("does not resolve Effect submodule APIs as services", async () => {
    const code = `
import { HttpClient } from "effect/http"

export fetch =
  effect
    response <- HttpClient.get("https://example.com")
    => response
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`const response = yield* HttpClient.get("https://example.com");`);
    expect(res.typescript).not.toContain("yield* (yield* HttpClient)");
  });

  it("compiles brace-delimited effects as pipeline expressions", async () => {
    const res = await Effect.runPromise(compileString(`result = effect {\n  user <- fetchUser()\n  => user |> summarize\n}`));
    expect(res.typescript).toContain("Effect.gen(function* () {");
    expect(res.typescript).toContain("const user = yield* fetchUser();");
    expect(res.typescript).toContain("summarize");
  });

  it("keeps explicitly qualified non-companion pipeline stages intact", async () => {
    const result = await Effect.runPromise(compileString("export result = value |> Custom.transform(1)"));
    expect(result.typescript).toContain("Custom.transform(1)");
  });

  it("compiles when statements inside effect blocks", async () => {
    const code = `
export earlyValue = (skip: Boolean) =>
  effect
    when (skip) => "early"
    => "done"

export failEarly = (shouldFail: Boolean) =>
  effect
    when (shouldFail) => Effect.fail("failed")
    => "done"

export conditionalBlock = (enabled: Boolean) =>
  effect
    when (enabled) {
      selected = "inside"
    }
    => "done"
`.trim();

    const res = await Effect.runPromise(compileString(code));
    expect(res.typescript).toContain(`if (skip) return "early";`);
    expect(res.typescript).toContain(`if (shouldFail) return yield* Effect.fail("failed");`);
    expect(res.typescript).toContain(`if (enabled) {\n  const selected = "inside";\n}`);
    expect(res.typescript).toContain(`return "done";`);
  });

  it("compiles deep Mutative spreads", async () => {
    const code = `
export updateCity = (user: User, city: String) =>
  => {
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
updated = tasks |> mut (draft) =>
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
updated = profile |> mut (draft) =>
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
export describeShape = (shape: Shape) =>
  match shape
    | Circle(r) when r |> Number.isGreaterThan(0) => r * 2
    | Rect(w, h) => w * h
    | Point => 0
    | _ => -1
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
export getArea = (shape: Shape) =>
  match shape
    | Circle(r) => r * r
    | Rect(w, h) => w * h
    | Point => 0
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`.exhaustive()`);
      expect(res.typescript).not.toContain(`.otherwise`);
    });

    it("compiles literal pattern matching (numbers and booleans)", async () => {
      const code = `
export httpStatus = (code: Number) =>
  match code
    | 200 => "ok"
    | 404 => "not found"
    | _ => "error"

export boolToString = (flag: Boolean) =>
  match flag
    | true => "yes"
    | false => "no"
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
export classify = (score: Number) =>
  match
    | score |> Number.isGreaterThan(90) => "A"
    | score |> Number.isGreaterThan(80) => "B"
    | _ => "C"
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`Number.isGreaterThan(90)`);
      expect(res.typescript).toContain(`? "A" :`);
      expect(res.typescript).toContain(`Number.isGreaterThan(80)`);
      expect(res.typescript).toContain(`? "B" : "C"`);
    });

    it("compiles subjectless match arm with block body to an IIFE", async () => {
      const code = `
export check = (flag: Boolean) =>
  match
    | flag =>
      step1 = 1
      step1 + 10
    | _ => 0
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

      const res = await compile(code);
      expect(res.typescript).toContain(`import { Schema } from "effect";`);
      expect(res.typescript).toContain(
        `export class UserNotFound$Class extends Schema.TaggedError<UserNotFound$Class>()("UserNotFound", {\n  id: Schema.String,\n  code: Schema.Number\n}) {}`
      );
      expect(res.typescript).toContain(`export const UserNotFound = (function(args: ConstructorParameters<typeof UserNotFound$Class>[0]): UserNotFound { return new UserNotFound$Class(args); }) as { (args: ConstructorParameters<typeof UserNotFound$Class>[0]): UserNotFound; new (args: ConstructorParameters<typeof UserNotFound$Class>[0]): UserNotFound };`);

      const { UserNotFound } = evalTypescript(res.typescript).exports;
      const error = UserNotFound({ id: "u1", code: 404 });
      expect(error).toBeInstanceOf(Error);
      expect(error.id).toBe("u1");
    });

    it("compiles service declarations with custom tag to Context.Service", async () => {
      const code = `
export service PaymentGateway "custom/payment/gateway"
  charge: (amount: Number) => Effect<Receipt, PaymentFailed>
`.trim();

      const res = await Effect.runPromise(compileString(code));
      expect(res.typescript).toContain(`import { Context, Effect } from "effect";`);
      expect(res.typescript).toContain(`export class PaymentGateway extends Context.Service<PaymentGateway, {`);
      expect(res.typescript).toContain(`}>()("custom/payment/gateway") {}`);
      expect(res.typescript).toContain(`readonly charge: (amount: number) => Effect.Effect<Receipt, PaymentFailed, never>;`);
    });

    it("compiles typed holes to runtime throw expressions", async () => {
      const code = `
export unfinished = () => ??? "implement later"
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
getUser = () =>
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
getUser = () =>
  effect
    user <- UserRepo.find("123")
`;
      const failure = await Effect.runPromise(Effect.flip(compileString(code)));
      expect(failure).toBeInstanceOf(CompilerError);
      expect(failure.message).toContain("Effect block must end with an explicit");
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
