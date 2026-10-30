import { describe, it, expect } from "vitest";
import { Effect, Schema, String, Struct, Duration, Option, pipe } from "effect";
import ts from "typescript";
import { compileString } from "../src/compiler.js";
import { typeCheckSource } from "../src/compiler/check.js";
import { format } from "../src/formatter/index.js";

const compile = (source: string) => Effect.runPromise(compileString(source));

function evaluate(typescript: string, expression: string) {
  const javascript = ts.transpileModule(typescript, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^import .*;\n/gm, "").replace(/\bexport /g, "");
  return new Function("Schema", "String", "Struct", "Duration", "pipe", `${javascript}\nreturn ${expression};`)(
    Schema, String, Struct, Duration, pipe,
  );
}

describe("PascalCase types", () => {
  it.each(["string", "number", "boolean", "void", "unknown", "never", "user"])(
    "rejects lowercase type %s, including nested annotations",
    async (name) => {
      await expect(compile(`value: ${name} = 1`)).rejects.toThrow("Type names must begin with an uppercase letter");
      await expect(compile(`value: Array<${name}> = []`)).rejects.toThrow("Type names must begin with an uppercase letter");
    },
  );

  it("lowers all primitive annotations to TypeScript primitives", async () => {
    const { typescript } = await compile(`schema Signature = (s: String, n: Number, b: Boolean, v: Void, u: Unknown, x: Never) => Void`);
    expect(typescript).toContain("type Signature = (s: string, n: number, b: boolean, v: void, u: unknown, x: never) => void;");
  });

  it("uses native Effect container types and readonly arrays", async () => {
    const result = await Effect.runPromise(typeCheckSource(`
export schema Signature = (items: Array<String>, value: Option<Number>, lookup: Record<String, Boolean>, delay: Duration) => Effect<Void, Never>
`, "native-types.fun"));
    expect(result.diagnostics).toEqual([]);
    const { typescript } = await compile(`schema Signature = (items: Array<String>, value: Option<Number>, lookup: Record<String, Boolean>, delay: Duration) => Effect<Void, Never>`);
    expect(typescript).toContain("ReadonlyArray<string>");
    expect(typescript).toContain("Option.Option<number>");
    expect(typescript).toContain("Record.ReadonlyRecord<string, boolean>");
    expect(typescript).toContain("Duration.Duration");
    expect(typescript).toContain("Effect.Effect<void, never, never>");
  });

  it("validates values using native primitive and nested container schemas", async () => {
    const { typescript } = await compile(`
schema Payload = {
  name: String
  count: Number
  active: Boolean
  empty: Void
  anything: Unknown
  tags: Array<String>
  choice: Option<Number>
  flags: Record<String, Boolean>
  delay: Duration
}
schema Impossible = { value: Never }
schema Positive = Number |> Schema.positive()
`);
    const payload = { name: "Ada", count: 2, active: true, empty: undefined, anything: {}, tags: ["ok"], choice: Option.none(), flags: { ok: true }, delay: Duration.seconds(1) };
    const { Payload, Impossible, Positive } = evaluate(typescript, "({ Payload, Impossible, Positive })");
    expect(Schema.is(Payload)(payload)).toBe(true);
    expect(Schema.is(Payload)({ ...payload, count: "2" })).toBe(false);
    expect(Schema.is(Payload)({ ...payload, tags: [2] })).toBe(false);
    expect(Schema.is(Impossible)({ value: 1 })).toBe(false);
    expect(Schema.is(Positive)(1)).toBe(true);
    expect(Schema.is(Positive)(-1)).toBe(false);
  });

  it("resolves String, Record, and Duration pipeline companions", async () => {
    const { typescript } = await compile(`
trimmed = "  hello  " |> trim
parts = "a,b" |> split(",")
textLines = "a" |> lines
picked = { a: 1, b: 2 } |> pick("a")
omitted = { a: 1, b: 2 } |> omit("b")
delay = 2 |> seconds
shortDelay = 3 |> millis
`);
    const values = evaluate(typescript, "({ trimmed, parts, textLines: Array.from(textLines), picked, omitted, delay, shortDelay })");
    expect(values.trimmed).toBe("hello");
    expect(values.parts).toEqual(["a", "b"]);
    expect(values.textLines).toEqual(["a"]);
    expect(values.picked).toEqual({ a: 1 });
    expect(values.omitted).toEqual({ a: 1 });
    expect(Duration.toMillis(values.delay)).toBe(2000);
    expect(Duration.toMillis(values.shortDelay)).toBe(3);
  });

  it("preserves PascalCase formatting and raw TypeScript escape types", () => {
    const source = 'schema Signature = (name: String, value: Option<Unknown>) => Array<Number>\nschema Foreign = ts "Record<string, unknown>"';
    const formatted = format(source);
    expect(formatted).toContain("(name: String, value: Option<Unknown>)");
    expect(formatted).toContain("Array<Number>");
    expect(formatted).toContain('ts "Record<string, unknown>"');
    expect(format(formatted)).toBe(formatted);
  });
});
