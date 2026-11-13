import { describe, expect, it } from "vitest";
import { Lexer } from "../src/lexer/lexer.js";
import { Parser } from "../src/parser/parser.js";
import type { BindingDeclaration, FunctionExpression, SchemaDeclaration, TypeSignatureSchema } from "../src/ast/types.js";
import { format } from "../src/formatter/index.js";
import { compile, expectCompileError, expectDiagnostic, typeCheck } from "./helpers/index.js";
import path from "node:path";

function parseAst(source: string, filename = "generics.fun") {
  return new Parser(new Lexer(source, filename).tokenize(), filename, source).parse();
}

describe("generic functions and constraints", () => {
  it("parses generic function expressions and constraints", () => {
    const ast = parseAst(`
identity = <A>(value: A) => A { => value }
connect = <Client extends RedisConnectableClient>(factory: () => Client) => factory()
`);
    const identity = ast.body[0] as BindingDeclaration;
    const connect = ast.body[1] as BindingDeclaration;

    const identityFn = identity.init as FunctionExpression;
    expect(identityFn.typeParams?.map((param) => param.name.name)).toEqual(["A"]);
    expect(identityFn.typeParams?.[0].constraint).toBeUndefined();

    const connectFn = connect.init as FunctionExpression;
    expect(connectFn.typeParams?.[0].name.name).toBe("Client");
    expect(connectFn.typeParams?.[0].constraint?.kind).toBe("TypeReferenceNode");
    expect((connectFn.typeParams?.[0].constraint as any).name.name).toBe("RedisConnectableClient");
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
    const result = await compile("export identity = <A>(value: A) => A { => value }");
    expect(result.typescript).toContain("export const identity = <A,>(value: A): A =>");
    const checked = await typeCheck("export identity = <A>(value: A) => A { => value }");
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
    expect(result.typescript).toContain("export const client = connect(makeClient);");
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
    expect(diagnostic.frame).toContain('export bad = connect(() => "not a client")');
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
    expect(result.typescript).toContain("export type Identity = <A>(value: A) => A;");
    const checked = await typeCheck(source);
    expect(checked.success, checked.formattedOutput).toBe(true);
  });

  it("rejects unsupported generic runtime schemas", async () => {
    await expectCompileError("export schema Box<A> = { value: A }", /Generic runtime schemas are not supported/);
  });

  it("keeps generic arrows valid in funx output", async () => {
    const result = await compile("export identity = <A>(value: A) => value", "generic.funx");
    expect(result.typescript).toContain("export const identity = <A,>(value: A) => value;");
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
