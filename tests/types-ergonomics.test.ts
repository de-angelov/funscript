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
    expect(res.typescript).toContain("fromNullishOrElse");
    expect(res.typescript).toContain('fromNullishOrElse(raw, "default")');
    expect(res.typescript).toContain('fromNullishOrElse(opt, "fallback")');
  });

  it("forwards an Option into an optional parameter explicitly", () => {
    const src = `
export f = (x?: String) =>
  => x

export g = (x?: String) =>
  => f(Option.getOrUndefined(x))
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("($funscriptOptional0?: string)");
    expect(res.typescript).toContain("Option.fromUndefinedOr($funscriptOptional0)");
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
    expect(res.typescript).toContain("fromNullishOr(arr[0])");
    expect(res.typescript).toContain("fromNullishOr(arr[i])");
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

  it("supports record and tuple destructuring in function parameters", () => {
    const src = `
export getProps = ({ name, age }: { name: String, age: Number }) =>
  => name

export getPair = ([first, ...rest]: Array<String>) =>
  => first
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("({ name, age }: { readonly name: string; readonly age: number }) =>");
    expect(res.typescript).toContain("([first, ...rest]: ReadonlyArray<string>) =>");

    const getProps = evaluateTsFunction(res.typescript, "getProps");
    const getPair = evaluateTsFunction(res.typescript, "getPair");
    expect(getProps({ name: "Alice", age: 30 })).toBe("Alice");
    expect(getPair(["hello", "world"])).toBe("hello");
  });

  it("formats function parameter destructuring cleanly", () => {
    const src = `export getProps = ({ name, age }: { name: String, age: Number }) =>
  => name

export getPair = ([first, ...rest]: Array<String>) =>
  => first
`;
    const formatted = format(src);
    expect(formatted).toBe(src);
  });

  it("compiles and executes Option.try safely capturing throws and nulls", () => {
    const src = `
import { Option } from "effect"

export safeSuccess = (val: String) =>
  => Option.try(() => val)

export safeThrow = (invalidJson: String) =>
  => Option.try(() => JSON.parse(invalidJson))
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("optionTry(() => val)");
    expect(res.typescript).toContain("optionTry");

    const safeSuccess = evaluateTsFunction(res.typescript, "safeSuccess");
    const safeThrow = evaluateTsFunction(res.typescript, "safeThrow");
    expect(safeSuccess("ok")).toEqual(Option.some("ok"));
    expect(safeThrow("not json {")).toEqual(Option.none());
  });

  it("compiles and executes template literals and tagged templates with type arguments", () => {
    const src = `
export tagFn = (strings: Array<String>, id: Number) =>
  s0 = match strings[0] | Some(v) => v | None => ""
  s1 = match strings[1] | Some(v) => v | None => ""
  => s0 + id + s1

export query = (id: Number) =>
  => tagFn\`SELECT * FROM users WHERE id = \${id} LIMIT 1\`

export withGenericTag = (id: Number) =>
  => sql<{ id: Number }>\`INSERT INTO users (id) VALUES (\${id})\`
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("tagFn`SELECT * FROM users WHERE id = ${id} LIMIT 1`");
    expect(res.typescript).toContain("sql<{ readonly id: number }>`INSERT INTO users (id) VALUES (${id})`");

    const query = evaluateTsFunction(res.typescript, "query");
    expect(query(42)).toBe("SELECT * FROM users WHERE id = 42 LIMIT 1");
  });

  it("formats template literals and tagged template expressions cleanly", () => {
    const src = `export query = (id: Number) =>
  => tagFn\`SELECT * FROM users WHERE id = \${id} LIMIT 1\`

export typedQuery = (id: Number) =>
  => sql<{ id: Number }>\`INSERT INTO users VALUES (\${id})\`
`;
    const formatted = format(src);
    expect(formatted).toBe(src);
  });

  it("compiles and evaluates Unit type and Unit discard expressions", () => {
    const src = `
export fn logMessage(msg: String): Unit =>
  Console.log(msg)
  => Unit

export runEffect = effect {
  _ <- Effect.succeed("started")
  => Unit
}

export schema Task = Effect<Unit, Error>

export fn doNothing(): Unit =>
  Unit
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("export const logMessage = (msg: string): void =>");
    expect(res.typescript).toContain("export type Task = Effect.Effect<void, Error, never>;");
    expect(res.typescript).toContain("export const doNothing = (): void =>");
    expect(res.typescript).not.toContain("return Unit;");

    const doNothing = evaluateTsFunction(res.typescript, "doNothing");
    expect(doNothing()).toBeUndefined();

    const runEffect = evaluateTsFunction(res.typescript, "runEffect");
    expect(Effect.runSync(runEffect)).toBeUndefined();
  });

  it("emits standard numerical division and supports total division via Number.divide", () => {
    const src = `
export fn divide(a: Number, b: Number): Number => a / b
export fn half(a: Number): Number => a / 2
export fn totalDivide(a: Number, b: Number) => Number.divide(a, b)
`;
    const res = Effect.runSync(compileString(src));
    expect(res.typescript).toContain("(a / b)");
    expect(res.typescript).toContain("(a / 2)");
    expect(res.typescript).toContain("Number.divide(a, b)");

    const divide = evaluateTsFunction(res.typescript, "divide");
    const half = evaluateTsFunction(res.typescript, "half");
    const totalDivide = evaluateTsFunction(res.typescript, "totalDivide");

    expect(divide(10, 2)).toBe(5);
    expect(half(10)).toBe(5);
    expect(Option.isSome(totalDivide(10, 2))).toBe(true);
    expect(Option.getOrNull(totalDivide(10, 2))).toBe(5);
    expect(Option.isNone(totalDivide(10, 0))).toBe(true);
  });

  it("bans native Array prototype methods under Effect style guide", () => {
    const invalidMap = `
export fn doubleAll(items: Array<Number>) => items.map((x) => x * 2)
`;
    expect(() => Effect.runSync(compileString(invalidMap))).toThrow(
      "Native array method '.map()' is banned by the Effect style guide. Use 'Array.map(...)' or pipeline '|> Array.map(...)' instead."
    );

    const invalidFilter = `
export fn positive(items: Array<Number>) => items.filter((x) => x > 0)
`;
    expect(() => Effect.runSync(compileString(invalidFilter))).toThrow(
      "Native array method '.filter()' is banned by the Effect style guide. Use 'Array.filter(...)' or pipeline '|> Array.filter(...)' instead."
    );

    const invalidSort = `
export fn sortItems(items: Array<Number>) => items.sort((a, b) => a - b)
`;
    expect(() => Effect.runSync(compileString(invalidSort))).toThrow(
      "Native array method '.sort()' is banned by the Effect style guide. Use 'Array.sort(...)' or pipeline '|> Array.sort(...)' instead."
    );
  });

  it("allows companion calls like Array.map and pipeline companions cleanly", () => {
    const valid = `
export fn doubleArray(items: Array<Number>): Array<Number> =>
  items |> Array.map((x) => x * 2)

export fn doubleArrayDirect(items: Array<Number>): Array<Number> =>
  Array.map(items, (x) => x * 2)
`;
    const res = Effect.runSync(compileString(valid));
    expect(res.typescript).toMatch(/import \{.*Array.*\} from "effect";/);
    expect(res.typescript).toContain("Array.map");

    const doubleArray = evaluateTsFunction(res.typescript, "doubleArray");
    const doubleArrayDirect = evaluateTsFunction(res.typescript, "doubleArrayDirect");
    expect(doubleArray([1, 2, 3])).toEqual([2, 4, 6]);
    expect(doubleArrayDirect([1, 2, 3])).toEqual([2, 4, 6]);
  });

  it("bans native String prototype methods under Effect style guide", () => {
    const invalidTrim = `
export fn clean(s: String) => s.trim()
`;
    expect(() => Effect.runSync(compileString(invalidTrim))).toThrow(
      "Native string method '.trim()' is banned by the Effect style guide. Use 'String.trim(...)' or pipeline '|> String.trim' instead."
    );

    const invalidLower = `
export fn lower(s: String) => s.toLowerCase()
`;
    expect(() => Effect.runSync(compileString(invalidLower))).toThrow(
      "Native string method '.toLowerCase()' is banned by the Effect style guide. Use 'String.toLowerCase(...)' or pipeline '|> String.toLowerCase' instead."
    );

    const invalidSplit = `
export fn parts(s: String) => s.split(",")
`;
    expect(() => Effect.runSync(compileString(invalidSplit))).toThrow(
      "Native string method '.split()' is banned by the Effect style guide. Use 'String.split(...)' or pipeline '|> String.split(...)' instead."
    );
  });

  it("bans Object static methods under Effect style guide", () => {
    const invalidKeys = `
export fn getKeys(o: Object) => Object.keys(o)
`;
    expect(() => Effect.runSync(compileString(invalidKeys))).toThrow(
      "'Object.keys()' is banned by the Effect style guide. Use Record.keys(...) instead."
    );

    const invalidValues = `
export fn getValues(o: Object) => Object.values(o)
`;
    expect(() => Effect.runSync(compileString(invalidValues))).toThrow(
      "'Object.values()' is banned by the Effect style guide. Use Record.values(...) instead."
    );

    const invalidAssign = `
export fn merge(a: Object, b: Object) => Object.assign({}, a, b)
`;
    expect(() => Effect.runSync(compileString(invalidAssign))).toThrow(
      "'Object.assign()' is banned by the Effect style guide. Use Record.union(...) or object spread '{ ...a, ...b }' instead."
    );

    const invalidFreeze = `
export fn freezeObj(o: Object) => Object.freeze(o)
`;
    expect(() => Effect.runSync(compileString(invalidFreeze))).toThrow(
      "'Object.freeze()' is banned by the Effect style guide. Use plain record literals '{ ... }' (FunScript records are already immutable) instead."
    );
  });

  it("allows String and Record companion modules cleanly", () => {
    const valid = `
export fn cleanString(s: String): String =>
  s |> String.trim |> String.toUpperCase

export fn recordKeys(r: Object): Array<String> =>
  Record.keys(r)
`;
    const res = Effect.runSync(compileString(valid));
    expect(res.typescript).toMatch(/import \{.*Record.*String.*\} from "effect";|import \{.*String.*Record.*\} from "effect";/);
    expect(res.typescript).toContain("String.trim");
    expect(res.typescript).toContain("Record.keys");

    const cleanString = evaluateTsFunction(res.typescript, "cleanString");
    const recordKeys = evaluateTsFunction(res.typescript, "recordKeys");

    expect(cleanString("  funscript  ")).toBe("FUNSCRIPT");
    expect(recordKeys({ a: 1, b: 2 })).toEqual(["a", "b"]);
  });

  it("bans parseInt and parseFloat in favor of total Number.parse", () => {
    const invalidParseInt = `
export fn toNum(s: String) => parseInt(s)
`;
    expect(() => Effect.runSync(compileString(invalidParseInt))).toThrow(
      "'parseInt()' is banned by the Effect style guide because it produces NaN on invalid input. Use 'Number.parse(s)' instead for total parsing returning Option<number>."
    );

    const invalidParseFloat = `
export fn toFloat(s: String) => parseFloat(s)
`;
    expect(() => Effect.runSync(compileString(invalidParseFloat))).toThrow(
      "'parseFloat()' is banned by the Effect style guide because it produces NaN on invalid input. Use 'Number.parse(s)' instead for total parsing returning Option<number>."
    );

    const invalidNumberParseInt = `
export fn toNum(s: String) => Number.parseInt(s)
`;
    expect(() => Effect.runSync(compileString(invalidNumberParseInt))).toThrow(
      "'Number.parseInt()' is banned by the Effect style guide because it produces NaN on invalid input. Use 'Number.parse(s)' instead for total parsing returning Option<number>."
    );

    const validNumberParse = `
export fn parseTotal(s: String): Number =>
  match Number.parse(s)
    | Some(n) => n
    | None => 0
`;
    const res = Effect.runSync(compileString(validNumberParse));
    expect(res.typescript).toContain("Number.parse");
    const parseTotal = evaluateTsFunction(res.typescript, "parseTotal");
    expect(parseTotal("42")).toBe(42);
    expect(parseTotal("invalid")).toBe(0);
  });

  it("guards synchronous throwing globals (JSON.parse, URL)", () => {
    const directJson = `
export fn parsePayload(raw: String) => JSON.parse(raw)
`;
    expect(() => Effect.runSync(compileString(directJson))).toThrow(
      "'JSON.parse()' is unsafe because it throws on malformed input. Guard it with 'Result.try(() => JSON.parse(...))' or use 'Schema.decodeUnknown'."
    );

    const directUrl = `
export fn makeUrl(raw: String) => URL(raw)
`;
    expect(() => Effect.runSync(compileString(directUrl))).toThrow(
      "'URL(...)' is unsafe because URL constructors throw on malformed input. Guard it with 'Result.try(() => URL(...))' or 'Option.try(() => URL(...))'."
    );

    const guardedJson = `
export fn safeJson(raw: String) =>
  Result.try(() => JSON.parse(raw))
`;
    const res = Effect.runSync(compileString(guardedJson));
    expect(res.typescript).toContain("Result.try");
  });

  it("bans mutating collection methods on Map and Set while allowing web params", () => {
    const invalidSetAdd = `
export fn addItem(items: Object, item: String) => items.add(item)
`;
    expect(() => Effect.runSync(compileString(invalidSetAdd))).toThrow(
      "Native collection method '.add()' is banned by the Effect style guide"
    );

    const invalidCollectionClear = `
export fn reset(c: Object) => c.clear()
`;
    expect(() => Effect.runSync(compileString(invalidCollectionClear))).toThrow(
      "Native collection method '.clear()' is banned by the Effect style guide"
    );

    const invalidMapSet = `
export fn updateMap(map: Object, k: String, v: String) => map.set(k, v)
`;
    expect(() => Effect.runSync(compileString(invalidMapSet))).toThrow(
      "Native collection method '.set()' is banned by the Effect style guide"
    );

    const validWebParams = `
export fn updateQuery(searchParams: Object, q: String) =>
  searchParams.set("q", q)
`;
    const res = Effect.runSync(compileString(validWebParams));
    expect(res.typescript).toContain('searchParams.set("q", q)');
  });

  it("resolves bare pipeline combinators for String and Record", () => {
    const stringPipeline = `
export fn formatSlug(name: String): String =>
  name |> trim |> toLowerCase
`;
    const res = Effect.runSync(compileString(stringPipeline));
    expect(res.typescript).toContain("String.trim");
    expect(res.typescript).toContain("String.toLowerCase");

    const formatSlug = evaluateTsFunction(res.typescript, "formatSlug");
    expect(formatSlug("  Hello World  ")).toBe("hello world");
  });

  it("bans Math.random in favor of Effect.Random", () => {
    const invalidMathRandom = `
export fn roll() => Math.random()
`;
    expect(() => Effect.runSync(compileString(invalidMathRandom))).toThrow(
      "'Math.random()' is banned by the Effect style guide because it is unmanaged and non-deterministic. Use 'Random.next' or 'Random.nextIntBetween' instead."
    );
  });

  it("bans mutating Date prototype methods in favor of DateTime", () => {
    const invalidDateMutation = `
export fn updateYear(d: Object) => d.setFullYear(2026)
`;
    expect(() => Effect.runSync(compileString(invalidDateMutation))).toThrow(
      "Native date method '.setFullYear()' is banned by the Effect style guide"
    );
  });

  it("supports HashMap, HashSet, and DateTime companion modules and auto-imports", () => {
    const valid = `
export fn manageCollections(map: Object, set: Object) =>
  m2 = map |> HashMap.set("key", "val")
  s2 = set |> HashSet.add("item")
  => [m2, s2]
`;
    const res = Effect.runSync(compileString(valid));
    expect(res.typescript).toMatch(/HashMap/);
    expect(res.typescript).toMatch(/HashSet/);
    expect(res.typescript).toContain("HashMap.set");
    expect(res.typescript).toContain("HashSet.add");
  });
});
