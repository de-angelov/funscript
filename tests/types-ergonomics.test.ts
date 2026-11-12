import { describe, it, expect } from "vitest";
import { Effect, Option } from "effect";
import { match, P } from "ts-pattern";
import ts from "typescript";
import { compileString } from "../src/compiler.js";
import { format } from "../src/formatter/index.js";

function evaluateTsFunction(tsCode: string, fnName: string) {
  const cjs = ts.transpileModule(tsCode, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} as any };
  const fn = new Function("exports", "require", "module", "match", "P", cjs);
  fn(
    module.exports,
    (mod: string) => {
      if (mod === "effect") return require("effect");
      if (mod === "ts-pattern") return require("ts-pattern");
      return require(mod);
    },
    module,
    match,
    P,
  );
  return module.exports[fnName];
}

describe("Type Ergonomics & Non-Escaping Types", () => {
  it("compiles typeof expressions in type positions", () => {
    const src = `
export buttonVariants = { variant: "default" }
export schema ButtonProps = VariantProps<typeof buttonVariants>
export fn cn(...inputs: Parameters<typeof cx>): String => ""
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("typeof buttonVariants");
    expect(res.typescript).toContain("Parameters<typeof cx>");
  });

  it("compiles indexed access types and parenthesized type queries", () => {
    const src = `
supportedLogLevels = ["debug", "info"]
export schema SupportedLogLevel = (typeof supportedLogLevels)[Number]
export schema DebugParams = Parameters<PinoLogger["debug"]>
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("(typeof supportedLogLevels)[number]");
    expect(res.typescript).toContain('PinoLogger["debug"]');
  });

  it("compiles generic record contracts with qualified types without throwing", () => {
    const src = `
export schema RedisClientProviderOptions<Client> = {
  env?: NodeJS.ProcessEnv
  clientFactory: (config: RedisConfig) => Client
}
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("export type RedisClientProviderOptions<Client> = { readonly env?: NodeJS.ProcessEnv; readonly clientFactory: (config: RedisConfig) => Client }");
  });

  it("compiles Any, Null, and Undefined primitive types", () => {
    const src = `
export schema FlexibleError = Any
export schema NullableResult = String | Null
export schema OptionalParam = Number | Undefined
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("export type FlexibleError = any;");
    expect(res.typescript).toContain("string | null");
    expect(res.typescript).toContain("number | undefined");
  });

  it("compiles Option.fromNullishOrElse with eager values", () => {
    const src = `
import { Option } from "effect"

export testFn = (raw: Unknown, opt: Option<String>) =>
  a = Option.fromNullishOrElse(raw, "default")
  b = Option.fromNullishOrElse(opt, "fallback")
  => [a, b]
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("__funscriptOptionFromNullishOrElse");
    expect(res.typescript).toContain('__funscriptOptionFromNullishOrElse(raw, "default")');
    expect(res.typescript).toContain('__funscriptOptionFromNullishOrElse(opt, "fallback")');
  });

  it("transparently forwards Option into optional parameters without double wrapping", () => {
    const src = `
export f = (x?: String) =>
  => x

export g = (x?: String) =>
  => f(x)
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("($funscriptOptional0?: string | Option.Option<string>)");
    expect(res.typescript).toContain("Option.isOption($funscriptOptional0) ? $funscriptOptional0 : Option.fromUndefinedOr($funscriptOptional0)");
  });

  it("supports default values on record contract schemas and defaulted record parameter", () => {
    const src = `
export defaultNumber = 42

export schema MyConfig = {
  timeout: Number = defaultNumber
  handler: () => Void
}

export run = (config: MyConfig = {}) =>
  => config.timeout
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("readonly timeout?: number;");
    expect(res.typescript).toContain("config: MyConfig = {  }");
  });

  it("supports record destructuring in variable bindings", () => {
    const src = `
export run = (opts: { a: String, b: Number }) =>
  { a, b } = opts
  => a
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("const { a, b } = opts;");
  });

  it("supports renamed fields and rest fields in record destructuring", () => {
    const src = `
export run = (opts: { a: String, b: Number, c: Boolean }) =>
  { a: customA, ...rest } = opts
  => customA
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("const { a: customA, ...rest } = opts;");
  });

  it("supports tuple and array destructuring with wildcards and rest", () => {
    const src = `
export run = (pair: Array<String>) =>
  [first, second] = pair
  [head, ...tail] = pair
  [a, _, c] = pair
  => first
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("const [first, second] = pair;");
    expect(res.typescript).toContain("const [head, ...tail] = pair;");
    expect(res.typescript).toContain("const [a, , c] = pair;");
  });

  it("supports destructuring in effect blocks", () => {
    const src = `
export getPair = () => Effect.succeed(["hello", 123])
export getRecord = () => Effect.succeed({ name: "world", count: 1 })

export run = () =>
  effect {
    [greeting, code] <- getPair()
    { name, count } <- getRecord()
    { name: customName } = { name: "test" }
    => greeting
  }
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("const [greeting, code] = yield* getPair();");
    expect(res.typescript).toContain("const { name, count } = yield* getRecord();");
    expect(res.typescript).toContain("const { name: customName } = { name: \"test\" };");
  });

  it("supports mutable destructuring and top-level export destructuring", () => {
    const src = `
export { a, b } = { a: 1, b: 2 }

export run = () =>
  mut [x, y] = [10, 20]
  x = 30
  => x
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("export const { a, b } = { a: 1, b: 2 };");
    expect(res.typescript).toContain("let [x, y] = [10, 20];");
    expect(res.typescript).toContain("x = 30;");
  });

  it("formats destructuring bindings cleanly", () => {
    const src = `export run = (opts: { a: String, b: Number }) =>
  { a, b } = opts
  [first, ...rest] = [1, 2, 3]
  => a
`;
    const formatted = format(src);
    expect(formatted).toBe(src);
  });

  it("safely indexes arrays into Option without undefined leaks", () => {
    const src = `
export run = (arr: Array<Number>, i: Number) =>
  first = arr[0]
  dyn = arr[i]
  => [first, dyn]
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("__funscriptOptionFromNullishOr(arr[0])");
    expect(res.typescript).toContain("__funscriptOptionFromNullishOr(arr[i])");
    expect(res.typescript).toContain("import { Option } from \"effect\";");
  });

  it("preserves raw property indexing for string literal keys and mutable assignment targets", () => {
    const src = `
export run = (obj: Any) =>
  method = obj["toLocaleString"]
  mut arr = [1, 2]
  arr[0] = 99
  => method
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain('method = obj["toLocaleString"]');
    expect(res.typescript).toContain("arr[0] = 99");
  });

  it("supports head/tail list pattern matching with rest patterns in match", () => {
    const src = `
export describeList = (list: Array<Number>) =>
  match list
    | [] => 0
    | [head, ...tail] => head
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain(".with([], ($matched: any) => {");
    expect(res.typescript).toContain(".with([P._, ...P.array()], ($matched: any) => {");
    expect(res.typescript).toContain("const [head, ...tail] = $matched;");
  });

  it("executes safe indexing and list pattern matching at runtime correctly", () => {
    const src = `
export testIndexing = (arr: Array<Number>, i: Number) =>
  => arr[i]

export sumList = (list: Array<Number>) =>
  match list
    | [] => 0
    | [head, ...tail] => head + sumList(tail)
`;
    const res = Effect.runSync(compileString(src));
    const testIndexing = evaluateTsFunction(res.typescript, "testIndexing");
    const sumList = evaluateTsFunction(res.typescript, "sumList");

    expect(testIndexing([10, 20], 0)).toEqual(Option.some(10));
    expect(testIndexing([10, 20], 1)).toEqual(Option.some(20));
    expect(testIndexing([10, 20], 5)).toEqual(Option.none());

    expect(sumList([])).toBe(0);
    expect(sumList([1, 2, 3, 4])).toBe(10);
  });
});
