import { describe, expect, it } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import type {
  BindingDeclaration,
  FunctionExpression,
  SchemaDeclaration,
  TypeSignatureSchema,
} from "../src/ast/types.js";
import { format } from "../src/formatter/index.js";
import {
  compile,
  execute,
  expectCompileError,
  expectDiagnostic,
  typeCheck,
} from "./helpers/index.js";
import { Effect, Option, Schema, SchemaAST } from "effect";
import { typeCheckVirtualFiles } from "../src/compiler/check.js";
import path from "node:path";

function parseAst(source: string, filename = "generics.fun") {
  return new Parser(
    new Lexer(source, filename).tokenize(),
    filename,
    source,
  ).parse();
}

describe("generic functions and constraints", () => {
  it("parses generic function expressions and constraints", () => {
    const ast = parseAst(`
identity = <A>(value: A) => A
  => value
connect = <Client extends RedisConnectableClient>(factory: () => Client) => factory()
`);
    const identity = ast.body[0] as BindingDeclaration;
    const connect = ast.body[1] as BindingDeclaration;

    const identityFn = identity.init as FunctionExpression;
    expect(identityFn.typeParams?.map((param) => param.name.name)).toEqual([
      "A",
    ]);
    expect(identityFn.typeParams?.[0].constraint).toBeUndefined();

    const connectFn = connect.init as FunctionExpression;
    expect(connectFn.typeParams?.[0].name.name).toBe("Client");
    expect(connectFn.typeParams?.[0].constraint?.kind).toBe(
      "TypeReferenceNode",
    );
    expect((connectFn.typeParams?.[0].constraint as any).name.name).toBe(
      "RedisConnectableClient",
    );
  });

  it("parses generic function type aliases", () => {
    const ast = parseAst("schema Identity = <A>(value: A) => A");
    const decl = ast.body[0] as SchemaDeclaration;
    const body = decl.body as TypeSignatureSchema;
    expect(body.kind).toBe("TypeSignatureSchema");
    expect(body.signature.kind).toBe("FunctionTypeNode");
    expect((body.signature as any).typeParams?.[0].name.name).toBe("A");
  });

  it("compiles generic lambdas without widening", async () => {
    const result = await compile(
      "export identity = <A>(value: A) => A\n  => value",
    );
    expect(result.typescript).toContain(
      "export const identity = <A,>(value: A): A => {\n  return (value);\n};",
    );
    const checked = await typeCheck(
      "export identity = <A>(value: A) => A\n  => value",
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("preserves constraints and accepts the constrained caller type", async () => {
    const source = `
ts { type RedisConnectableClient = { close: () => void } }
export connect = <Client extends RedisConnectableClient>(factory: () => Client) => factory()
export makeClient = () => ({ close: () => {} })
export client = connect(makeClient)
`;
    const result = await compile(source);
    expect(result.typescript).toContain(
      "export const connect = <Client extends RedisConnectableClient>(factory: () => Client) => factory();",
    );
    expect(result.typescript).toContain(
      "export const client = connect(makeClient);",
    );
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("supports generic parameters after the binding name", async () => {
    const source = `
ts { type RedisConnectableClient = { close: () => void } }
export connect<Client extends RedisConnectableClient> = (factory: () => Client) => factory()
`;
    const result = await compile(source);
    expect(result.typescript).toContain(
      "export const connect = <Client extends RedisConnectableClient>(factory: () => Client) => factory();",
    );
    expect(format(source)).toContain(
      "export connect = <Client extends RedisConnectableClient>(factory: () => Client) => factory()",
    );
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("reports a type error when the constraint is not satisfied", async () => {
    const source = `
ts { type RedisConnectableClient = { close: () => void } }
export connect = <Client extends RedisConnectableClient>(factory: () => Client) => factory()
export bad = connect(() => "not a client")
`;
    const checked = await typeCheck(source);
    expect(checked.success).toBe(false);
    const diagnostic = await expectDiagnostic(source, {
      file: "test.fun",
      line: 4,
      message: /not assignable to type 'RedisConnectableClient'/,
    });
    expect(diagnostic.frame).toContain(
      'export bad = connect(() => "not a client")',
    );
  });

  it("preserves union types in Effect channels", async () => {
    const source =
      "export keep = <A, E1, E2, R1, R2>(fx: Effect<A, E1 | E2, R1 | R2>) => fx";
    const result = await compile(source);
    expect(result.typescript).toContain(
      "export const keep = <A, E1, E2, R1, R2>(fx: Effect.Effect<A, E1 | E2, R1 | R2>) => fx;",
    );
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("lets TypeScript infer exact callback returns and imported generic types", async () => {
    const fixture = path.resolve("tests/fixtures/generic-types.js");
    const result = await typeCheck(`
import type { NamedValue } from "${fixture}"
export apply = <A>(factory: () => A) => factory()
export unwrap = <A>(box: NamedValue<A>) => box.value
ts {
  type Client = { close(): void; name: string };
  const client: Client = apply(() => ({ close() {}, name: "redis" }));
  const name: string = unwrap({ value: client }).name;
  // @ts-expect-error The inferred return must retain Client's name.
  const wrong: number = unwrap({ value: client }).name;
}
`);
    expect(result.success, result.formattedOutput).toBe(true);
  });

  it("emits generic function type aliases", async () => {
    const source = "export schema Identity = <A>(value: A) => A";
    const result = await compile(source);
    expect(result.typescript).toContain(
      "export type Identity = <A>(value: A) => A;",
    );
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("derives generic data schemas from explicit element schemas", async () => {
    const source = `
export schema Box<A> = { value: A }
export schema Country = { name: String }
export schema Envelope = { payload: Box<Number> }
export countryBox = Box(Country)
export numberBox = Box(Schema.NumberFromString)
export read = (box: Box<Number>): Number => box.value
`;
    const result = await compile(source);
    expect(result.typescript).toContain("SchemaAST as $funscriptSchemaAST");
    expect(result.typescript).toContain(
      'export const Box = <A extends Schema.Constraint & { readonly "~type.optionality": "required";',
    );
    expect(result.typescript).toContain(
      "export type Box<A> = { readonly value: A };",
    );
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
    const mod = await execute(source, {
      scope: { $funscriptSchemaAST: SchemaAST },
    });
    expect(
      Schema.decodeUnknownSync(mod.countryBox)({ value: { name: "Bulgaria" } }),
    ).toEqual({ value: { name: "Bulgaria" } });
    expect(() =>
      Schema.decodeUnknownSync(mod.countryBox)({ value: { name: 42 } }),
    ).toThrow();
    expect(Schema.decodeUnknownSync(mod.numberBox)({ value: "42" })).toEqual({
      value: 42,
    });
    expect(Schema.encodeSync(mod.numberBox)({ value: 42 })).toEqual({
      value: "42",
    });
    expect(mod.EnvelopeFromUnknown({ payload: { value: 5 } })).toEqual({
      payload: { value: 5 },
    });
    expect(() =>
      mod.EnvelopeFromUnknown({ payload: { value: "bad" } }),
    ).toThrow();
    expect(() => mod.Box(Schema.optional(Schema.String))).toThrow(
      /without optional-key or mutable-key modifiers/,
    );
    expect(() => mod.Box(Schema.mutableKey(Schema.String))).toThrow(
      /without optional-key or mutable-key modifiers/,
    );
    expect(() => mod.Box({})).toThrow(
      /without optional-key or mutable-key modifiers/,
    );
    expect(
      Schema.decodeUnknownSync(
        mod.Box(Schema.OptionFromOptional(Schema.String)),
      )({}),
    ).toEqual({ value: Option.none() });
    const invalid = await typeCheck(
      source + "\nexport invalid = Box(Schema.optional(Schema.String))",
    );
    expect(invalid.success).toBe(false);
  }, 60000);

  it("derives generic structural union schemas and composes them", async () => {
    const source = `
export schema Vote<A, B> =
  | { ok: true, data: A }
  | { ok: false, error: B }
export schema Country = { name: String }
export schema Envelope<T> = { value: Vote<T, String> }
export countryEnvelope = Envelope(Country)
`;
    const result = await compile(source);
    expect(result.typescript).toContain("Schema.Union([");
    expect(result.typescript).toContain(
      "export type Vote<A, B> = { readonly ok: true; readonly data: A } | { readonly ok: false; readonly error: B };",
    );
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
    const mod = await execute(source, {
      scope: { $funscriptSchemaAST: SchemaAST },
    });
    expect(
      Schema.decodeUnknownSync(mod.countryEnvelope)({
        value: { ok: true, data: { name: "Bulgaria" } },
      }),
    ).toEqual({
      value: { ok: true, data: { name: "Bulgaria" } },
    });
    expect(
      Schema.decodeUnknownSync(mod.countryEnvelope)({
        value: { ok: false, error: "failed" },
      }),
    ).toEqual({
      value: { ok: false, error: "failed" },
    });
    expect(() =>
      Schema.decodeUnknownSync(mod.countryEnvelope)({
        value: { ok: true, data: { name: 123 } },
      }),
    ).toThrow();
  }, 60000);

  it("keeps callback-bearing generic contracts compile-time only", async () => {
    const source =
      "export schema Handler<A> = { value: A, handle: (value: A) => Void }";
    const result = await compile(source);
    expect(result.typescript).toContain("export type Handler<A>");
    expect(result.typescript).not.toContain("export const Handler");
    await expectCompileError(
      source + "\nexport bad = Handler",
      /compile-time record contract/,
    );
  });

  it("lets a generic parameter shadow a same-named contract type", async () => {
    const result = await compile(
      "schema A = (value: String) => Void\nexport schema Box<A> = { value: A }",
    );
    expect(result.typescript).toContain(
      "export const Box = <A extends Schema.Constraint &",
    );
  });

  it("preserves optional data decoding and encoding in generic schemas", async () => {
    const source = `
export schema Page<A> = { items: Array<A>, next: Option<String> }
export schema OptionalBox<A> = { value: Option<A> }
export schema Country = { name: String }
export countryPage = Page(Country)
export optionalNumber = OptionalBox(Schema.NumberFromString)
export read = (page: Page<Country>): Option<String> => page.next
export names = (page: Page<Country>) => page.items |> Array.map((country) => country.name)
`;
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
    const mod = await execute(source, {
      scope: { $funscriptSchemaAST: SchemaAST },
    });
    const decoded = Schema.decodeUnknownSync(mod.countryPage)({
      items: [{ name: "Bulgaria" }],
    });
    expect(decoded).toEqual({
      items: [{ name: "Bulgaria" }],
      next: Option.none(),
    });
    expect(Schema.encodeSync(mod.countryPage)(decoded)).toEqual({
      items: [{ name: "Bulgaria" }],
    });
    expect(
      Schema.decodeUnknownSync(mod.countryPage)({ items: [], next: "cursor" }),
    ).toEqual({ items: [], next: Option.some("cursor") });
    const value = Schema.decodeUnknownSync(mod.optionalNumber)({ value: "42" });
    expect(value).toEqual({ value: Option.some(42) });
    expect(Schema.encodeSync(mod.optionalNumber)(value)).toEqual({
      value: "42",
    });
  }, 60000);

  it("uses a generic data-schema factory across modules", async () => {
    const files = {
      "generic-box.fun": "export schema Box<A> = { value: A }",
      "generic-app.fun":
        'import { Box } from "./generic-box.js"\nexport schema Country = { name: String }\nexport countryBox = Box(Country)\nexport read = (box: Box<Country>): String => box.value.name',
    };
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(files, {
        compilerOptions: { rootDir: process.cwd() },
      }),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
  }, 60000);

  it("composes a verified imported factory through renamed re-exports", async () => {
    const page =
      "export schema Page<A> = { items: Array<A>, next: Option<String> }";
    const app =
      'import { Listing as Page } from "./barrel.js"\nexport schema Country = { name: String }\nexport schema Response = { page: Page<Country> }';
    const files = {
      "page.fun": page,
      "barrel.fun": 'export { Page as Listing } from "./page.js"',
      "app.fun": app,
    };
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(files, {
        compilerOptions: { rootDir: process.cwd() },
      }),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
    const virtualSources = new Map(
      Object.entries(files).map(([name, source]) => [
        path.resolve(name),
        source,
      ]),
    );
    const pageModule = await execute(page, {
      scope: { $funscriptSchemaAST: SchemaAST },
    });
    const result = await execute(app, {
      filename: path.resolve("app.fun"),
      compileOptions: { virtualSources },
      scope: { Page: pageModule.Page },
    });
    expect(
      result.ResponseFromUnknown({ page: { items: [{ name: "Bulgaria" }] } }),
    ).toEqual({ page: { items: [{ name: "Bulgaria" }], next: Option.none() } });
    expect(() =>
      result.ResponseFromUnknown({ page: { items: [{ name: 42 }] } }),
    ).toThrow();
  }, 60000);

  it("composes generic factories locally and across modules", async () => {
    const files = {
      "page.fun":
        "export schema Page<A> = { items: Array<A>, next: Option<String> }",
      "result.fun":
        'import { Page } from "./page.js"\nexport schema Result<A> = { data: Page<A>, requestId: String }',
      "country-app.fun":
        'import { Result } from "./result.js"\nexport schema Country = { name: String }\nexport schema CountryResult = { result: Result<Country> }',
    };
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(files, {
        compilerOptions: { rootDir: process.cwd() },
      }),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
    const virtualSources = new Map(
      Object.entries(files).map(([name, source]) => [
        path.resolve(name),
        source,
      ]),
    );
    const page = await execute(files["page.fun"], {
      scope: { $funscriptSchemaAST: SchemaAST },
    });
    const result = await execute(files["result.fun"], {
      filename: path.resolve("result.fun"),
      compileOptions: { virtualSources },
      scope: { Page: page.Page, $funscriptSchemaAST: SchemaAST },
    });
    const app = await execute(files["country-app.fun"], {
      filename: path.resolve("country-app.fun"),
      compileOptions: { virtualSources },
      scope: { Result: result.Result },
    });
    expect(
      app.CountryResultFromUnknown({
        result: { data: { items: [{ name: "Bulgaria" }] }, requestId: "1" },
      }),
    ).toEqual({
      result: {
        data: { items: [{ name: "Bulgaria" }], next: Option.none() },
        requestId: "1",
      },
    });
    expect(() =>
      app.CountryResultFromUnknown({
        result: { data: { items: [{ name: 4 }] }, requestId: "1" },
      }),
    ).toThrow();
    const numbers = result.Result(Schema.NumberFromString);
    const value = Schema.decodeUnknownSync(numbers)({
      data: { items: ["42"] },
      requestId: "1",
    });
    expect(value).toEqual({
      data: { items: [42], next: Option.none() },
      requestId: "1",
    });
    expect(Schema.encodeSync(numbers)(value)).toEqual({
      data: { items: ["42"] },
      requestId: "1",
    });
    const local = await execute(
      "export schema Page<A> = { value: A }\nexport schema Result<A> = { page: Page<A> }\nexport number = Result(Schema.NumberFromString)",
      { scope: { $funscriptSchemaAST: SchemaAST } },
    );
    expect(
      Schema.decodeUnknownSync(local.number)({ page: { value: "42" } }),
    ).toEqual({ page: { value: 42 } });
  }, 60000);

  it("verifies named data dependencies across generic factories and imports", async () => {
    const files = {
      "metadata.fun":
        "export schema Metadata = { requestId: String, cursor: Option<String> }",
      "metadata-barrel.fun": 'export { Metadata as Info } from "./metadata.js"',
      "named-page.fun":
        'import { Info as Metadata } from "./metadata-barrel.js"\nschema Trace = { info: Metadata }\nexport schema Page<A> = { items: Array<A>, trace: Trace }',
      "named-app.fun":
        'import { Page } from "./named-page.js"\nimport { Metadata } from "./metadata.js"\nexport schema Response = { page: Page<Metadata> }',
    };
    const checked = await Effect.runPromise(
      typeCheckVirtualFiles(files, {
        compilerOptions: { rootDir: process.cwd() },
      }),
    );
    expect(checked.success, checked.formattedOutput).toBe(true);
    const virtualSources = new Map(
      Object.entries(files).map(([name, source]) => [
        path.resolve(name),
        source,
      ]),
    );
    const metadata = await execute(files["metadata.fun"]);
    const page = await execute(files["named-page.fun"], {
      filename: path.resolve("named-page.fun"),
      compileOptions: { virtualSources },
      scope: { Metadata: metadata.Metadata, $funscriptSchemaAST: SchemaAST },
    });
    const app = await execute(files["named-app.fun"], {
      filename: path.resolve("named-app.fun"),
      compileOptions: { virtualSources },
      scope: { Page: page.Page, Metadata: metadata.Metadata },
    });
    const decoded = app.ResponseFromUnknown({
      page: {
        items: [{ requestId: "a" }],
        trace: { info: { requestId: "b" } },
      },
    });
    expect(decoded).toEqual({
      page: {
        items: [{ requestId: "a", cursor: Option.none() }],
        trace: { info: { requestId: "b", cursor: Option.none() } },
      },
    });
    expect(() =>
      app.ResponseFromUnknown({
        page: {
          items: [{ requestId: 1 }],
          trace: { info: { requestId: "b" } },
        },
      }),
    ).toThrow();
    expect(Schema.encodeSync(app.Response)(decoded)).toEqual({
      page: {
        items: [{ requestId: "a" }],
        trace: { info: { requestId: "b" } },
      },
    });
  }, 60000);

  it("rejects unverified named schema dependency graphs", async () => {
    const filename = path.resolve("consumer.fun");
    const consumer =
      'import { Page } from "./named-page.js"\nexport schema Response = { page: Page<String> }';
    const page = (dependency: string) =>
      `schema Metadata = ${dependency}\nexport schema Page<A> = { item: A, meta: Metadata }`;
    const virtualSources = new Map([
      [path.resolve("named-page.fun"), page("{ value: Unknown }")],
    ]);
    await expectCompileError(
      consumer,
      /Cannot derive a runtime schema/,
      filename,
      { virtualSources },
    );
    virtualSources.set(
      path.resolve("named-page.fun"),
      page("{ call: (value: String) => Void }"),
    );
    await expectCompileError(
      consumer,
      /Cannot derive a runtime schema/,
      filename,
      { virtualSources },
    );
    virtualSources.set(
      path.resolve("named-page.fun"),
      "schema Metadata = { next: Other }\nschema Other = { next: Metadata }\nexport schema Page<A> = { item: A, meta: Metadata }",
    );
    await expectCompileError(
      consumer,
      /Cannot derive a runtime schema/,
      filename,
      { virtualSources },
    );
    virtualSources.set(
      path.resolve("named-page.fun"),
      'import type { Metadata } from "./metadata.js"\nexport schema Page<A> = { item: A, meta: Metadata }',
    );
    virtualSources.set(
      path.resolve("metadata.fun"),
      "export schema Metadata = { value: String }",
    );
    await expectCompileError(
      consumer,
      /Cannot derive a runtime schema/,
      filename,
      { virtualSources },
    );
    virtualSources.set(
      path.resolve("named-page.fun"),
      'import { Metadata } from "./metadata.js"\nexport schema Page<A> = { item: A, meta: Metadata }',
    );
    virtualSources.set(
      path.resolve("metadata.fun"),
      'export schema Metadata = { value: String = "x" }',
    );
    await expectCompileError(
      consumer,
      /Cannot derive a runtime schema/,
      filename,
      { virtualSources },
    );
  });

  it("rejects recursive and unverified nested generic factories", async () => {
    await expectCompileError(
      "export schema Box<A> = { value: Box<A> }",
      /recursive generic schema factories/,
    );
    await expectCompileError(
      "export schema BadUnion<A> =\n  | { value: A }\n  | { value: BadUnion<A> }",
      /recursive generic schema factories/,
    );
    await expectCompileError(
      "export schema First<A> = { value: Second<A> }\nexport schema Second<A> = { value: First<A> }",
      /recursive generic schema factories/,
    );
    await expectCompileError(
      "export schema Box<A> = { value: A }\nexport schema Bad<A> = { value: Box<A, String> }",
      /currently supports/,
    );
    await expectCompileError(
      'import { Page } from "./unknown.js"\nexport schema Bad<A> = { value: Page<A> }',
      /currently supports/,
    );
    const filename = path.resolve("consumer.fun");
    const virtualSources = new Map<string, string>([
      [
        path.resolve("one.fun"),
        'import { Two } from "./two.js"\nexport schema One<A> = { value: Two<A> }',
      ],
      [
        path.resolve("two.fun"),
        'import { One } from "./one.js"\nexport schema Two<A> = { value: One<A> }',
      ],
    ]);
    await expectCompileError(
      'import { One } from "./one.js"\nexport schema Response = { value: One<String> }',
      /Cannot derive a runtime schema/,
      filename,
      { virtualSources },
    );
  });

  it("rejects unverified imported factories and arguments", async () => {
    const filename = path.resolve("app.fun");
    const virtualSources = new Map<string, string>([
      [path.resolve("page.fun"), "export schema Page<A> = { value: A }"],
      [
        path.resolve("contract.fun"),
        "export schema Handler<A> = { value: A, call: (value: A) => Void }",
      ],
      [path.resolve("barrel.fun"), 'export { type Page } from "./page.js"'],
      [path.resolve("cycle.fun"), 'export { Page } from "./cycle.js"'],
    ]);
    const options = { virtualSources };
    await expectCompileError(
      'import { Page } from "./page.js"\nexport schema Bad = { value: Page<Unknown> }',
      /must name a runtime data schema/,
      filename,
      options,
    );
    await expectCompileError(
      'import { Page } from "./page.js"\nexport schema Bad = { value: Page<String, Number> }',
      /requires 1 schema argument/,
      filename,
      options,
    );
    await expectCompileError(
      'import { Page } from "./page.js"\nimport { Anything } from "./foreign.js"\nexport schema Bad = { value: Page<Anything> }',
      /must name a runtime data schema/,
      filename,
      options,
    );
    const contract = await compile(
      'import { Handler } from "./contract.js"\nexport schema Bad = { value: Handler<String> }',
      filename,
      options,
    );
    expect(contract.typescript).toContain("export type Bad");
    expect(contract.typescript).not.toContain("export const Bad");
    for (const source of ["barrel", "cycle"]) {
      await expectCompileError(
        `import { Page } from "./${source}.js"\nexport schema Bad = { value: Page<String> }`,
        /Cannot derive a runtime schema/,
        filename,
        options,
      );
    }
    virtualSources.set(
      path.resolve("page.fun"),
      "export schema Page<A> = { call: (value: A) => Void }",
    );
    const changed = await compile(
      'import { Page } from "./page.js"\nexport schema Bad = { value: Page<String> }',
      filename,
      options,
    );
    expect(changed.typescript).not.toContain("export const Bad");
  });

  it("rejects unsupported generic data shapes without widening", async () => {
    await expectCompileError(
      'export schema Box<A> = { value: A, label: String = "x" }',
      /Generic data schema 'Box' currently supports required or optional fields/,
    );
    await expectCompileError(
      "export schema Box<A> = { value: Unknown }",
      /Generic data schema 'Box' currently supports required or optional fields/,
    );
    await expectCompileError(
      "export schema Box<A> = { value: A }\nexport schema Bad = { item: Box<Unknown> }",
      /must name a runtime data schema/,
    );
    await expectCompileError("export schema Box<A> = { __proto__: A }");
    await expectCompileError(
      'import { Effect as Schema } from "effect"\nexport schema Box<A> = { value: A }',
      /require 'Schema' to refer to Effect Schema/,
    );
    await expectCompileError(
      'import type { ExternalBox } from "./types.js"\nexport schema Bad = { value: ExternalBox<Number> }',
      /Cannot derive a runtime schema for generic 'ExternalBox'/,
    );
    await expectCompileError(
      'import { Box } from "./generic-box.js"\nexport schema Bad = { value: Box<Number> }',
      /Cannot derive a runtime schema for imported generic 'Box'/,
    );
  });

  it("keeps generic arrows valid in funx output", async () => {
    const result = await compile(
      "export identity = <A>(value: A) => value",
      "generic.funx",
    );
    expect(result.typescript).toContain(
      "export const identity = <A,>(value: A) => value;",
    );
  });

  it("distinguishes generic components from JSX in funx files", async () => {
    const source =
      "export Identity = <A>(props: { value: A }) => <div>{props.value}</div>";
    const result = await compile(source, "component.funx");
    expect(result.typescript).toContain(
      "export const Identity = <A,>(props: { readonly value: A }) => <div>{props.value}</div>;",
    );
  });

  it("formats constraints idempotently", () => {
    const source =
      "export connect = <Client extends RedisConnectableClient, E>(factory: () => Client) => factory()";
    const once = format(source);
    expect(once).toContain("<Client extends RedisConnectableClient, E>");
    expect(format(once)).toBe(once);
  });

  it("rejects malformed generic declarations", async () => {
    await expectCompileError("export identity = <A(value: A) => value");
  });
});
